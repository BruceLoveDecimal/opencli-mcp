import { describe, expect, it } from 'vitest';
import { keyFromSpec, playwrightKey, renderScript, stepCode, type CodeStep } from '../src/codegen/playwright.js';
import { actStep } from '../src/api/script.js';
import type { ActResult } from '../src/protocol.js';

const save = { javascript: `getByRole('button', { name: 'Save' })`, python: `get_by_role("button", name="Save")` };
const email = { javascript: `getByLabel('Email')`, python: `get_by_label("Email")` };
const act = (s: Partial<Extract<CodeStep, { kind: 'act' }>>): CodeStep => ({ kind: 'act', page: 'p1', action: 'click', target: { locator: save }, ...s });
const result = (r: Partial<ActResult>): ActResult => ({ ok: true, kind: 'click', matches_n: 1, visible_n: 1, match_level: 'exact', point: { x: 1, y: 1 }, method: 'cdp', hit: 'target', tag: 'button', waitedMs: 0, ...r });

describe('step code', () => {
  it('renders actions in both languages', () => {
    expect(stepCode(act({}))).toBe(`await page.getByRole('button', { name: 'Save' }).click();`);
    expect(stepCode(act({}), 'python')).toBe(`page.get_by_role("button", name="Save").click()`);
    expect(stepCode(act({ action: 'fill', target: { locator: email }, value: "it's \"me\"" }))).toBe(`await page.getByLabel('Email').fill('it\\'s "me"');`);
    expect(stepCode(act({ action: 'fill', target: { locator: email }, value: "it's \"me\"" }), 'python')).toBe(`page.get_by_label("Email").fill("it's \\"me\\"")`);
    expect(stepCode(act({ action: 'type', value: 'abc' }), 'python')).toBe(`page.get_by_role("button", name="Save").press_sequentially("abc")`);
    expect(stepCode(act({ action: 'select', values: ['a', 'b'] }))).toBe(`await page.getByRole('button', { name: 'Save' }).selectOption(['a', 'b']);`);
    expect(stepCode(act({ action: 'upload', files: ['/tmp/a.png'] }), 'python')).toBe(`page.get_by_role("button", name="Save").set_input_files(["/tmp/a.png"])`);
    expect(stepCode(act({ action: 'drag', to: { locator: email } }))).toBe(`await page.getByRole('button', { name: 'Save' }).dragTo(page.getByLabel('Email'));`);
    expect(stepCode(act({ dom: true }))).toBe(`await page.getByRole('button', { name: 'Save' }).evaluate(el => el.click());`);
    expect(stepCode(act({ button: 'right', modifiers: 2 }), 'python')).toBe(`page.get_by_role("button", name="Save").click(button="right", modifiers=["Control"])`);
    expect(stepCode(act({ clickCount: 2 }))).toBe(`await page.getByRole('button', { name: 'Save' }).dblclick();`);
  });

  it('never writes secret values', () => {
    expect(stepCode(act({ action: 'fill', value: 'hunter2', secret: true }))).toBe(`await page.getByRole('button', { name: 'Save' }).fill(process.env.SECRET_1 ?? '');`);
    const py = renderScript([act({ action: 'fill', value: 'hunter2', secret: true })], 'python');
    expect(py).toContain('import os');
    expect(py).toContain('fill(os.environ.get("SECRET_1", ""))');
    expect(py).not.toContain('hunter2');
  });

  it('enters frames and falls back to selectors and points', () => {
    expect(stepCode(act({ target: { locator: save, frame: ['#pay', 0] } }))).toBe(`await page.locator('#pay').contentFrame().locator('iframe, frame').nth(0).contentFrame().getByRole('button', { name: 'Save' }).click();`);
    expect(stepCode(act({ target: { locator: save, frame: [1] } }), 'python')).toBe(`page.locator("iframe, frame").nth(1).content_frame.get_by_role("button", name="Save").click()`);
    expect(stepCode(act({ target: { locator: save, frameUrl: 'https://pay.example/checkout?x=1' } }))).toBe(`await page.locator('iframe[src*="pay.example/checkout"]').contentFrame().getByRole('button', { name: 'Save' }).click();`);
    expect(stepCode(act({ target: { selector: 'internal:role=button[name="Go"i]' } }))).toBe(`await page.locator('internal:role=button[name="Go"i]').click();`);
    expect(stepCode(act({ target: { point: { x: 10.4, y: 20 } } }))).toBe(`await page.mouse.click(10, 20);`);
    expect(stepCode(act({ action: 'scroll', target: { point: { x: 5, y: 6 } }, direction: 'up', amount: 300 }))).toBe(`await page.mouse.move(5, 6);\nawait page.mouse.wheel(0, -300);`);
  });

  it('waits for the popup and download an action triggers', () => {
    expect(stepCode(act({ popups: ['p2'], download: true }))).toBe([
      `const downloadPromise = page.waitForEvent('download');`,
      `const page1Promise = page.waitForEvent('popup');`,
      `await page.getByRole('button', { name: 'Save' }).click();`,
      `const download = await downloadPromise;`,
      `const page1 = await page1Promise;`,
    ].join('\n'));
    expect(stepCode(act({ popups: ['p2'] }), 'python')).toBe([
      `with page.expect_popup() as page1_info:`,
      `    page.get_by_role("button", name="Save").click()`,
      `page1 = page1_info.value`,
    ].join('\n'));
  });

  it('maps keys to Playwright names', () => {
    expect(keyFromSpec('enter')).toBe('Enter');
    expect(keyFromSpec('ctrl+shift+a')).toBe('Control+Shift+a');
    expect(keyFromSpec('space')).toBe('Space');
    expect(playwrightKey('k', 4)).toBe('Meta+k');
  });

  it('renders expectations', () => {
    const step: CodeStep = { kind: 'expect', page: 'p1', text: 'Saved', url: 'example.com/a?b', target: { locator: save }, visible: false };
    expect(stepCode(step)).toBe([
      `await expect(page.locator('body')).toContainText('Saved');`,
      `await expect(page).toHaveURL(/example\\.com\\/a\\?b/);`,
      `await expect(page.getByRole('button', { name: 'Save' })).toBeHidden();`,
    ].join('\n'));
    expect(renderScript([step], 'python')).toContain(`expect(page).to_have_url(re.compile("example\\\\.com\\\\/a\\\\?b"))`);
  });
});

describe('session script', () => {
  it('names pages in order and opens later tabs from the context', () => {
    const steps: CodeStep[] = [
      { kind: 'open', page: 'a', url: 'https://example.com/' },
      act({ page: 'a', popups: ['c'] }),
      { kind: 'open', page: 'b', url: 'https://example.org/' },
      act({ page: 'c', action: 'press', target: { locator: email }, value: 'Enter' }),
      { kind: 'close', page: 'b' },
    ];
    expect(renderScript(steps, 'javascript', { title: 'Checkout' })).toBe([
      `import { test, expect } from '@playwright/test';`,
      '',
      `test('Checkout', async ({ page, context }) => {`,
      `  await page.goto('https://example.com/');`,
      `  const page1Promise = page.waitForEvent('popup');`,
      `  await page.getByRole('button', { name: 'Save' }).click();`,
      `  const page1 = await page1Promise;`,
      `  const page2 = await context.newPage();`,
      `  await page2.goto('https://example.org/');`,
      `  await page1.getByLabel('Email').press('Enter');`,
      `  await page2.close();`,
      '});',
      '',
    ].join('\n'));
    const py = renderScript(steps, 'python', { title: '🔎 Checkout flow' });
    expect(py).toContain('def test_checkout_flow(page: Page) -> None:');
    expect(py).toContain('    page2 = page.context.new_page()');
  });
});

describe('act → step', () => {
  it('uses the locator of the element the engine touched, in the frames the target named', () => {
    const step = actStep('p1', { action: 'fill', target: { ref: 'e3', frame: '#f >> 0' } as never, value: 'x' }, result({ kind: 'fill', selector: 'internal:label="Email"i', locator: email, secret: true }));
    expect(step).toEqual({ kind: 'act', page: 'p1', action: 'fill', target: { locator: email, selector: 'internal:label="Email"i', frame: ['#f', 0] }, value: '', secret: true });
    expect(actStep('p1', { action: 'press', target: { ref: 'e1' }, value: 'ctrl+enter' }, result({ kind: 'press' }))).toMatchObject({ value: 'Control+Enter' });
    expect(actStep('p1', { action: 'click', target: { ref: 'e1' } }, result({ openedTabs: [{ page: 'p9', tabId: 9 }], download: { afterSequence: 0, started: [{ seq: 1, url: 'u', suggestedFilename: 'f' }] } }))).toMatchObject({ popups: ['p9'], download: true });
    expect(actStep('p1', { action: 'reload' }, result({}))).toEqual({ kind: 'history', page: 'p1', op: 'reload' });
    expect(stepCode(actStep('p1', { action: 'select', target: { label: 'Size' }, value: '1' }, result({ kind: 'select', locator: email, selected: ['l'] }))!)).toBe(`await page.getByLabel('Email').selectOption('l');`);
  });
});
