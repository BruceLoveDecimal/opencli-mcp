// Isolated real-extension E2E for code generation and recording: a throwaway Chromium profile loads extension/dist,
// Chrome spawns the real native host (throwaway HOME), and a real MCP client drives it over the stdio launcher.
// Playwright's own input on the same tab plays the person demonstrating a flow. Needs `npm run build` and a Chromium
// that allows --load-extension (Playwright's Chromium; set CHROMIUM=/path/to/chrome to choose one).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const R = path.resolve(import.meta.dirname, '..');
const EXTENSION_ID = 'lnaoghmfcdnbhgcihkakfobckmfhllkg';

function findChromium() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  try { const p = chromium.executablePath(); if (fs.existsSync(p)) return p; } catch { /* not downloaded */ }
  const dir = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  if (!fs.existsSync(dir)) return undefined;
  for (const d of fs.readdirSync(dir).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()) {
    for (const sub of ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) { const p = path.join(dir, d, sub); if (fs.existsSync(p)) return p; }
  }
  return undefined;
}
const executablePath = findChromium();
if (!executablePath) { console.error('No Chromium found. Set CHROMIUM=/path/to/chrome.'); process.exit(2); }
if (!fs.existsSync(path.join(R, 'dist/src/main.js')) || !fs.existsSync(path.join(R, 'extension/dist/manifest.json'))) { console.error('Run `npm run build` first.'); process.exit(2); }

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencli-recorder-e2e-'));
const home = path.join(root, 'home'); const profile = path.join(root, 'profile');
fs.mkdirSync(home); fs.mkdirSync(path.join(profile, 'NativeMessagingHosts'), { recursive: true });
const launcher = path.join(root, 'host.sh');
fs.writeFileSync(launcher, `#!/bin/sh\nexport HOME="${home}"\nexec "${process.execPath}" "${R}/dist/src/main.js" host 2>>"${root}/host.log"\n`, { mode: 0o755 });
fs.writeFileSync(path.join(profile, 'NativeMessagingHosts', 'com.opencli.mcp.json'), JSON.stringify({ name: 'com.opencli.mcp', description: 'opencli-mcp recorder e2e', path: launcher, type: 'stdio', allowed_origins: [`chrome-extension://${EXTENSION_ID}/`] }));

const PAGES = {
  '/': `<!doctype html><title>Login</title><label>Email <input id=email></label><label>Password <input type=password id=pw></label>
    <label><input type=checkbox> Remember me</label><button onclick="location.href='/home'">Log in</button>
    <a href="/popup" target=_blank>Help</a><button onclick="confirm('Delete?') && (document.body.dataset.deleted=1)">Delete</button>`,
  // localhost is another site than 127.0.0.1: an out-of-process iframe that appears after the recording started
  '/home': `<!doctype html><title>Home</title><h1>Welcome</h1><input aria-label=Search><button>Go</button><iframe src="http://localhost:PORT/pay"></iframe>`,
  '/pay': `<!doctype html><button>Pay now</button>`,
  '/popup': `<!doctype html><title>Help</title><button>Close help</button>`,
};
const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end((PAGES[req.url] ?? 'not found').replace('PORT', String(server.address().port))); }).listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

const context = await chromium.launchPersistentContext(profile, { executablePath, headless: process.env.HEADED ? false : true, env: { ...process.env, HOME: home }, args: [`--disable-extensions-except=${R}/extension/dist`, `--load-extension=${R}/extension/dist`] });
const transport = new StdioClientTransport({ command: process.execPath, args: [`${R}/dist/src/main.js`, 'stdio'], env: { ...process.env, HOME: home }, stderr: 'pipe' });
const client = new Client({ name: 'smoke-recorder', version: '0.0.0' }, { capabilities: {} });
const texts = (r) => r.content.filter((c) => c.type === 'text').map((c) => c.text);
async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const t = texts(r);
  console.log(`▶ ${name} ${r.isError ? 'ERROR' : 'ok'}`);
  if (r.isError) throw new Error(`${name} failed: ${t.join('\n')}`);
  return { json: JSON.parse(t[0]), code: t[1] };
}

let failed = false;
try {
  await client.connect(transport);
  for (let i = 0; ; i++) {
    const d = JSON.parse(texts(await client.callTool({ name: 'doctor', arguments: {} }))[0]);
    if (d.backend === 'extension') { assert.ok(d.extension.features.includes('recorder'), 'extension advertises the recorder'); break; }
    if (i > 60) throw new Error(`the extension never connected\n${fs.existsSync(`${root}/host.log`) ? fs.readFileSync(`${root}/host.log`, 'utf8') : ''}`);
    await new Promise((r) => setTimeout(r, 500));
  }

  // ── per-step code ──
  const { json: opened } = await call('tab_open', { url: `${base}/`, session: 'recorder e2e', observe: false });
  const tab = opened.tab;
  const { json: found } = await call('tab_find', { tab, target: { role: 'button' } });
  assert.equal(found.result.entries[0].locator, `getByRole('button', { name: 'Log in' })`);
  assert.equal((await call('tab_act', { tab, action: 'fill', target: { label: 'Email' }, value: 'agent@x.io' })).json.code, `await page.getByRole('textbox', { name: 'Email' }).fill('agent@x.io');`);
  const pw = (await call('tab_act', { tab, action: 'fill', target: { label: 'Password' }, value: 's3cret' })).json.code;
  assert.equal(pw, `await page.getByRole('textbox', { name: 'Password' }).fill(process.env.SECRET_1 ?? '');`);
  assert.equal((await call('tab_act', { tab, action: 'check', target: { role: 'checkbox' } })).json.code, `await page.getByRole('checkbox', { name: 'Remember me' }).check();`);
  assert.equal((await call('tab_expect', { tab, selector: 'internal:role=button[name="Log in"i]' })).json.code, `await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();`);

  // ── the person demonstrates; the agent's own action in between is not recorded ──
  await call('record_start', { tab });
  const page = context.pages().find((p) => p.url().startsWith(base));
  await page.locator('#email').fill('');
  await page.locator('#email').pressSequentially('user@x.io');
  await page.locator('#pw').pressSequentially('hunter2');
  page.once('dialog', (d) => d.accept());
  await page.getByText('Delete').click();
  const popupOpened = context.waitForEvent('page');
  await page.getByText('Help').click();
  const popup = await popupOpened;
  await popup.waitForLoadState();
  await new Promise((r) => setTimeout(r, 800)); // the extension arms the popup
  await popup.getByText('Close help').click();
  await call('tab_act', { tab, action: 'hover', target: { role: 'checkbox' } });
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.waitForURL('**/home');
  await page.getByLabel('Search').fill('shoes');
  await page.getByLabel('Search').press('Enter');
  // Headless Chromium may route a click to the parent while a just-loaded out-of-process frame is not hit-testable yet
  // (a person is never that fast). The recorder ignores clicks on the <iframe> box, so click until the frame received one.
  const pay = page.frameLocator('iframe').getByRole('button', { name: 'Pay now' });
  await pay.waitFor();
  const payFrame = page.frames().find((f) => f.url().includes('/pay'));
  await payFrame.evaluate(() => document.addEventListener('click', () => { window.__clicked = true; }, true));
  for (let i = 0; i < 20 && !(await payFrame.evaluate(() => window.__clicked === true)); i++) { await pay.click(); await new Promise((r) => setTimeout(r, 250)); }
  await new Promise((r) => setTimeout(r, 500));
  const { json: rec, code } = await call('record_stop', { tab, title: 'demo' });
  console.log(code);
  if (process.env.SAVE_CODE) fs.writeFileSync(process.env.SAVE_CODE, code); // keep the generated test, e.g. to run it under @playwright/test
  assert.ok(!JSON.stringify(rec).includes('hunter2') && !code.includes('hunter2'), 'secret values are never recorded');
  assert.deepEqual(rec.steps.map((s) => [s.tab === tab ? 'page' : 'popup', s.action, s.value ?? (s.secret ? '<secret>' : '')]), [
    ['page', 'fill', 'user@x.io'], ['page', 'fill', '<secret>'], ['page', 'click', ''], ['page', 'click', ''],
    ['popup', 'click', ''], ['page', 'click', ''], ['page', 'fill', 'shoes'], ['page', 'press', 'Enter'], ['page', 'click', ''],
  ]);
  for (const line of [
    `  await page.goto('${base}/');`,
    `  page.once('dialog', dialog => dialog.accept().catch(() => {}));`,
    `  const page1 = await page1Promise;`,
    `  await page1.getByRole('button', { name: 'Close help' }).click();`,
    `  await page.getByRole('textbox', { name: 'Search' }).press('Enter');`,
    `  await page.locator('iframe[src*="localhost:${server.address().port}/pay"]').contentFrame().getByRole('button', { name: 'Pay now' }).click();`,
  ]) assert.ok(code.includes(line), `code has: ${line}`);
  assert.ok(!code.includes('hover()'), 'the agent’s hover is not part of the recording');
  assert.ok(!code.includes("goto('" + base + "/home')"), 'the click’s navigation is not a goto');

  const { code: script } = await call('session_export_script', { language: 'python' });
  console.log(script);
  assert.ok(script.includes('page.get_by_role("textbox", name="Email").fill("agent@x.io")') && script.includes('page1.get_by_role("button", name="Close help").click()'), 'the session script has the agent’s and the person’s steps');
  console.log('\nrecorder e2e passed');
} catch (err) {
  failed = true;
  console.error(err);
  if (fs.existsSync(`${root}/host.log`)) console.error(`host log:\n${fs.readFileSync(`${root}/host.log`, 'utf8').slice(-4000)}`);
} finally {
  await client.close().catch(() => {});
  await context.close().catch(() => {});
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
