/**
 * Page-side locators and the recorder in a real Chromium, installed the way the extension installs them: Playwright's
 * injected script + the page module in the `opencli-mcp-engine` isolated world, the record binding scoped to that
 * world, and the install script re-run in every new document. User input is real CDP input (trusted events).
 * Skips when no Chromium is available (set OPENCLI_TEST_CHROMIUM to point at one).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { build } from 'esbuild';
import { chromium, type Browser, type CDPSession, type Page } from 'playwright-core';
import { INJECTED_SOURCE } from '../src/shared/injected-source.js';
import { installEngineJs, pageCallJs } from '../src/shared/engine.js';
import { RECORD_BINDING, type RecordedAction } from '../src/shared/page-contract.js';

const WORLD = 'opencli-mcp-engine';

function findChromium(): string | undefined {
  if (process.env.OPENCLI_TEST_CHROMIUM) return process.env.OPENCLI_TEST_CHROMIUM;
  try { const p = chromium.executablePath(); if (existsSync(p)) return p; } catch { /* no bundled browser */ }
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  if (!existsSync(root)) return undefined;
  for (const dir of readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()) {
    for (const sub of ['chrome-linux64/chrome', 'chrome-linux/chrome']) { const p = join(root, dir, sub); if (existsSync(p)) return p; }
  }
  return undefined;
}
const executablePath = findChromium();

const PAGES: Record<string, string> = {
  '/': `<!doctype html><title>form</title>
    <label>Email <input id=email></label>
    <label>Password <input type=password id=pw></label>
    <label><input type=checkbox id=agree> I agree</label>
    <select aria-label=Size><option value=s>Small</option><option value=l>Large</option></select>
    <button><span>Save draft</span></button>
    <div contenteditable=true aria-label=Notes></div>
    <iframe src="/child"></iframe>
    <a href="/next">Next page</a>`,
  '/child': `<!doctype html><button>Inner</button>`,
  '/next': `<!doctype html><title>next</title><button>Done</button>`,
};

describe.skipIf(!executablePath)('page recorder and locators (Chromium)', () => {
  let server: http.Server; let base = '';
  let browser: Browser; let page: Page; let cdp: CDPSession;
  let install = '';
  const recorded: RecordedAction[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(PAGES[req.url ?? '/'] ?? 'not found'); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const out = await build({ entryPoints: [resolve(import.meta.dirname, '../extension/src/page/index.ts')], bundle: true, format: 'iife', target: 'chrome120', platform: 'browser', write: false, logLevel: 'silent' });
    install = installEngineJs(INJECTED_SOURCE, out.outputFiles[0].text);
    browser = await chromium.launch({ executablePath });
    page = await browser.newPage();
    cdp = await page.context().newCDPSession(page);
    cdp.on('Runtime.bindingCalled', (e) => { if (e.name === RECORD_BINDING) recorded.push(JSON.parse(e.payload)); });
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await page.goto(base + '/');
  }, 60_000);
  afterAll(async () => { await browser?.close(); server?.close(); });

  /** Evaluate in the engine world of the main frame (Page.createIsolatedWorld reuses the world by name). */
  async function engine(expression: string): Promise<unknown> {
    const { frameTree } = await cdp.send('Page.getFrameTree');
    const { executionContextId } = await cdp.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: WORLD });
    const r = await cdp.send('Runtime.evaluate', { expression, contextId: executionContextId, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
  const settle = () => new Promise((r) => setTimeout(r, 150));

  it('returns Playwright locator code with every resolved and found element', async () => {
    await engine(install);
    const found = await engine(pageCallJs('find', { selector: 'internal:role=button', fallback: null, limit: 5 })) as { entries: Array<{ selector: string; locator: string }> };
    expect(found.entries[0]).toMatchObject({ locator: `getByRole('button', { name: 'Save draft' })` });
    const pw = await engine(pageCallJs('resolve', { selector: '#pw', fallback: null, strict: true, states: ['visible'], align: { block: 'center', inline: 'center' } })) as { locator: { javascript: string; python: string }; secret?: boolean };
    expect(pw.locator).toEqual({ javascript: `getByRole('textbox', { name: 'Password' })`, python: `get_by_role("textbox", name="Password")` });
    expect(pw.secret).toBe(true);
    await engine(pageCallJs('clearActMark', undefined));
    const email = await engine(pageCallJs('locatorFor', { selector: '#email' })) as { locator: { javascript: string } };
    expect(email.locator.javascript).toBe(`locator('#email')`);
  });

  it('records trusted user actions across frames and navigations, without secret values', async () => {
    const script = `${install};globalThis.__opencliPage.recordStart();`;
    await cdp.send('Runtime.addBinding', { name: RECORD_BINDING, executionContextName: WORLD });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: script, worldName: WORLD, runImmediately: true });
    await engine(script);

    await page.fill('#email', 'a@b.c');
    await page.locator('#email').press('Tab');
    await page.locator('#pw').pressSequentially('hunter2');
    await page.getByText('I agree').click(); // label click: recorded once, as a check
    await page.focus('select');
    await page.keyboard.press('ArrowDown'); // a real selection change; selectOption() dispatches untrusted events
    await page.getByText('Save draft').click(); // the span retargets to its button
    await page.locator('[contenteditable]').click();
    await page.keyboard.type('hi');
    await page.frameLocator('iframe').getByRole('button').click();
    await page.getByText('Next page').click();
    await page.waitForURL('**/next');
    await page.getByRole('button', { name: 'Done' }).click({ clickCount: 2 });
    await page.evaluate(() => (document.querySelector('button') as HTMLButtonElement).click()); // untrusted: not recorded
    await settle();

    const steps = recorded.map((a) => [a.name, a.locator.javascript, a.text ?? a.key ?? a.options?.join(',') ?? (a.clickCount && a.clickCount > 1 ? `x${a.clickCount}` : ''), a.frame ? a.frame.join('/') : '']);
    expect(steps).toEqual([
      ['fill', `getByRole('textbox', { name: 'Email' })`, 'a@b.c', ''],
      ['press', `getByRole('textbox', { name: 'Email' })`, 'Tab', ''],
      ...Array(7).fill(['fill', `getByRole('textbox', { name: 'Password' })`, '', '']),
      ['check', `getByRole('checkbox', { name: 'I agree' })`, '', ''],
      ['press', `getByLabel('Size')`, 'ArrowDown', ''],
      ['select', `getByLabel('Size')`, 'l', ''],
      ['click', `getByRole('button', { name: 'Save draft' })`, '', ''],
      ['click', `getByLabel('Notes')`, '', ''],
      ['fill', `getByLabel('Notes')`, 'h', ''],
      ['fill', `getByLabel('Notes')`, 'hi', ''],
      ['click', `getByRole('button', { name: 'Inner' })`, '', '0'],
      ['click', `getByRole('link', { name: 'Next page' })`, '', ''],
      ['click', `getByRole('button', { name: 'Done' })`, '', ''],
      ['click', `getByRole('button', { name: 'Done' })`, 'x2', ''],
    ]);
    expect(recorded.filter((a) => a.secret).every((a) => a.text === '')).toBe(true);
    expect(JSON.stringify(recorded)).not.toContain('hunter2');
  });
});
