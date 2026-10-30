import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
// @ts-expect-error Adapters are runtime JavaScript modules.
import { probeMedia } from '../adapters/dreamface/_generation.js';

const CHROME = process.env.CHROME_PATH ?? [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => fs.existsSync(p));

const PAGE = `<!doctype html><title>Sign up</title>
<form id="f"><label>Name <input name="name"></label> <button style="cursor:pointer">Submit</button></form>
<p id="out"></p><a href="https://example.com/">Leave</a>
<section role="group" aria-label="Image editor"><button type="button" onclick="document.getElementById('out').textContent='Image selected'">Run</button></section>
<section role="group" aria-label="Video editor"><button type="button" onclick="document.getElementById('out').textContent='Video selected'">Run</button></section>
<script>
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await fetch('/api/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: e.target.name.value }) });
  document.getElementById('out').textContent = (await r.json()).message;
  console.error('signup done');
});
</script>`;

/** A logged-in page: the token lives in localStorage, as many single-page apps keep it. */
const APP = `<!doctype html><title>App</title><p>Home</p>
<script>localStorage.setItem('auth', JSON.stringify({ token: 'tok-123' })); console.warn('app ready');</script>`;

const UPLOAD = `<!doctype html><title>Uploads</title>
<form><input id="files" aria-label="Files" type="file" accept="image/png" multiple hidden>
<input aria-label="Single" id="single" type="file" hidden>
<input aria-label="Disabled" id="disabled" type="file" disabled hidden></form><p id="out">waiting</p>
<script>
let events = 0;
const input = document.getElementById('files');
input.addEventListener('input', () => events++);
input.addEventListener('change', async () => {
 const files = [...input.files];
 if (location.hash === '#clear') input.value = '';
 const texts = await Promise.all(files.map(file => file.text()));
 document.getElementById('out').textContent = 'handled events=' + events + ' bytes=' + texts.join('|');
});
</script>`;

const RESPONSIVE = `<!doctype html><title>Responsive editor</title>
<section id="history">${Array.from({ length: 900 }, (_, n) => `<p>Historical record ${n}: ${'previous work '.repeat(12)}</p>`).join('')}</section>
<section id="composer"></section>
<style>#composer { position:fixed; bottom:10px; left:5%; width:90%; background:white; } input,textarea { width:95%; } dialog { position:fixed; top:10px; } </style>
<script>
const media = matchMedia('(max-width:700px)');
function editor(parent) {
 const input = document.createElement(media.matches ? 'textarea' : 'input');
 input.placeholder = 'Describe a scene'; parent.append(input); input.focus();
}
function render() {
 const root = document.getElementById('composer'); root.replaceChildren();
 if (!media.matches) { editor(root); return; }
 const entry = document.createElement('div'); entry.textContent='Describe a scene'; entry.tabIndex=0;
 entry.onclick=()=>{ const dialog=document.createElement('dialog'); root.replaceChildren(dialog); dialog.showModal(); editor(dialog); };
 root.append(entry);
}
media.addEventListener('change',render); render();
</script>`;

/** A small shop: state assertions, a JSON order request and a token-protected API for suite_run. */
const SHOP = `<!doctype html><title>Shop</title>
<ul id="items"><li class="item">Apple</li><li class="item">Banana</li><li class="item">Cherry</li></ul>
<label>Name <input id="name" name="name"></label>
<label><input type="checkbox" id="agree"> I agree</label>
<button id="buy" disabled>Buy</button><p id="out"></p>
<script>
localStorage.setItem('auth', JSON.stringify({ token: 'tok-123' }));
const agree = document.getElementById('agree'), buy = document.getElementById('buy');
agree.addEventListener('change', () => { buy.disabled = !agree.checked; });
buy.addEventListener('click', async () => {
  const r = await fetch('/api/order', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: document.getElementById('name').value, items: 3 }) });
  document.getElementById('out').textContent = 'Order placed ' + (await r.json()).orderId;
});
</script>`;

/** Only the fixture's viewport changes through CDP; every page interaction still uses typed MCP tools. */
async function resizePage(endpoint: string, url: string, width: number, height: number, existing?: WebSocket): Promise<WebSocket> {
  const pages = await (await fetch(`${endpoint}/json/list`)).json() as Array<{ url: string; webSocketDebuggerUrl: string }>;
  const page = pages.find((p) => p.url === url)!;
  const socket = existing ?? new WebSocket(page.webSocketDebuggerUrl);
  try {
    if (!existing) await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('viewport resize timed out')), 3000);
      const receive = (raw: WebSocket.RawData) => {
        const response = JSON.parse(String(raw));
        if (response.id !== 1) return;
        clearTimeout(timer);
        socket.off('message', receive);
        if (response.error) reject(new Error(JSON.stringify(response.error))); else resolve();
      };
      socket.on('message', receive);
      socket.send(JSON.stringify({ id: 1, method: 'Emulation.setDeviceMetricsOverride', params: { width, height, deviceScaleFactor: 1, mobile: false } }));
    });
    // Disconnecting the controlling session resets Chrome's emulation; retain it across the whole flow.
    return socket;
  } catch (error) { socket.close(); throw error; }
}

async function startSite(): Promise<{ url: string; close: () => Promise<void> }> {
  let flaky = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/pixel.gif') {
      res.writeHead(200, { 'content-type': 'image/gif' }).end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64'));
      return;
    }
    if (req.url === '/api/signup' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ message: `Welcome, ${JSON.parse(body).name}` })); });
      return;
    }
    if (req.url?.startsWith('/api/me')) {
      if (req.headers.token !== 'tok-123') { res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"login"}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ user: 'ada', echo: req.headers.token }));
      return;
    }
    if (req.url === '/api/flaky') {
      flaky += 1;
      res.writeHead(flaky === 1 ? 503 : 200, { 'content-type': 'application/json' }).end(JSON.stringify({ try: flaky }));
      return;
    }
    if (req.url === '/api/order' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 0, orderId: `o-${JSON.parse(body).name}` })); });
      return;
    }
    if (req.url?.startsWith('/api/items')) {
      if (req.headers.token !== 'tok-123') { res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"login"}'); return; }
      const items = [{ id: 'i1', name: 'Apple' }, { id: 'i2', name: 'Banana' }, { id: 'i3', name: 'Cherry' }];
      const id = req.url.split('/')[3];
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(id ? items.find((i) => i.id === id) ?? {} : { items }));
      return;
    }
    if (req.url === '/shop') { res.writeHead(200, { 'content-type': 'text/html' }).end(SHOP); return; }
    if (req.url === '/app') { res.writeHead(200, { 'content-type': 'text/html' }).end(APP); return; }
    if (req.url === '/responsive') { res.writeHead(200, { 'content-type': 'text/html' }).end(RESPONSIVE); return; }
    if (req.url === '/upload') { res.writeHead(200, { 'content-type': 'text/html' }).end(UPLOAD); return; }
    res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

async function startChrome(): Promise<{ endpoint: string; proc: ChildProcess; profile: string }> {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'opencli-cdp-chrome-'));
  const proc = spawn(CHROME!, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--window-size=1280,800', 'about:blank'], {
    stdio: 'ignore',
    // vitest points HOME at an empty directory; headless Chrome on macOS stalls without the real one (keychain)
    env: { ...process.env, HOME: os.userInfo().homedir },
  });
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 200 && !fs.existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 50));
  const [port] = fs.readFileSync(portFile, 'utf8').split('\n');
  return { endpoint: `http://127.0.0.1:${port}`, proc, profile };
}

/** A user adapter in the test HOME: reports the page it runs on. */
function writeDemoAdapter(): void {
  const dir = path.join(os.homedir(), '.opencli-mcp', 'adapters', 'demo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'page.js'), `import { defineAdapter } from 'opencli-mcp/adapter-sdk';
export default defineAdapter({
  description: 'The page this command runs on',
  access: 'read',
  args: [{ name: 'timeout_sec', type: 'int', default: 5 }],
  async run({ tab }) { return { title: await tab.title(), url: await tab.url() }; },
});
`);
}

function parse(result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
  const first = (result.content as Array<{ type: string; text?: string }>)[0];
  return JSON.parse(first.text ?? '{}') as Record<string, unknown>;
}

describe.skipIf(!CHROME)('cdp backend', () => {
  const cleanup: Array<() => Promise<void> | void> = [];

  it.each(['browser', 'page'])('uploads hidden file controls through a %s endpoint', async (endpointKind) => {
    const site = await startSite(); cleanup.push(site.close);
    const chrome = await startChrome();
    cleanup.push(async () => { chrome.proc.kill(); await new Promise((r) => chrome.proc.once('exit', r)); fs.rmSync(chrome.profile, { recursive: true, force: true, maxRetries: 5 }); });
    const filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-fixtures-'));
    cleanup.push(() => fs.rmSync(filesDir, { recursive: true, force: true }));
    const files = [path.join(filesDir, 'one.txt'), path.join(filesDir, 'two.txt')];
    files.forEach((file, index) => fs.writeFileSync(file, `data${index}`));
    const pages = await (await fetch(`${chrome.endpoint}/json/list`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
    const endpoint = endpointKind === 'page' ? pages.find((p) => p.type === 'page')!.webSocketDebuggerUrl : chrome.endpoint;
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', path.resolve('src/main.ts'), 'cdp', '--endpoint', endpoint, '--allow-origin', site.url], stderr: 'ignore' });
    const client = new Client({ name: 'upload-test', version: '1' }, { capabilities: {} });
    await client.connect(transport); cleanup.push(() => client.close());
    const opened = parse(await client.callTool({ name: 'tab_open', arguments: { url: `${site.url}/upload` } }));
    const ref = /file-input "Files" \[ref=(e\d+)\]/.exec(String(opened.state))![1];
    const act = async (target: Record<string, unknown>, paths: string[]) => parse(await client.callTool({ name: 'tab_act', arguments: { action: 'upload', target, files: paths, observe: true } }));
    const uploaded = await act({ ref }, files);
    expect(uploaded, JSON.stringify(uploaded)).toMatchObject({ ok: true, delivery: 'applied', controlState: 'verified', files: 2,
      fileSelection: [{ name: 'one.txt', size: 5, type: 'text/plain' }, { name: 'two.txt', size: 5, type: 'text/plain' }] });
    expect(parse(await client.callTool({ name: 'tab_expect', arguments: { text: 'handled events=1 bytes=data0|data1', timeout: 3 } })).ok).toBe(true);
    expect(await act({ selector: '#single' }, files)).toMatchObject({ ok: false, error: { code: 'invalid_args' } });
    expect(await act({ selector: '#disabled' }, [files[0]])).toMatchObject({ ok: false, error: { code: 'not_enabled' } });
    expect(await act({ selector: 'input[type=file]' }, [files[0]])).toMatchObject({ ok: false, error: { code: 'selector_ambiguous' } });
    expect(await act({ ref }, [path.join(filesDir, 'missing.txt')])).toMatchObject({ ok: false, error: { code: 'upload_file_unavailable' } });
    expect(await act({ ref }, ['relative.txt'])).toMatchObject({ ok: false, error: { code: 'invalid_args' } });
    await client.callTool({ name: 'tab_goto', arguments: { url: `${site.url}/upload#clear` } });
    const cleared = await act({ selector: '#files' }, [files[0]]);
    expect(cleared).toMatchObject({ ok: true, delivery: 'applied', controlState: 'unverified', files: 0, fileSelection: [] });
    expect(parse(await client.callTool({ name: 'tab_expect', arguments: { text: 'handled events=2 bytes=data0', timeout: 3 } })).ok).toBe(true);
  }, 60_000);

  it('discovers the live editor across viewport changes without guessing coordinates', async () => {
    const site = await startSite(); cleanup.push(site.close);
    const chrome = await startChrome();
    cleanup.push(async () => { chrome.proc.kill(); await new Promise((r) => chrome.proc.once('exit', r)); fs.rmSync(chrome.profile, { recursive: true, force: true, maxRetries: 5 }); });
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', path.resolve('src/main.ts'), 'cdp', '--endpoint', chrome.endpoint, '--allow-origin', site.url], stderr: 'ignore' });
    const client = new Client({ name: 'responsive-test', version: '1' }, { capabilities: {} });
    await client.connect(transport); cleanup.push(() => client.close());
    const url = `${site.url}/responsive`;
    expect(parse(await client.callTool({ name: 'tab_open', arguments: { url } })).ok).toBe(true);
    let previousRef: string | undefined;
    let viewport: WebSocket | undefined;
    cleanup.push(() => { viewport?.close(); });
    for (const [width, height] of [[1280, 900], [360, 740], [1650, 960], [604, 856]]) {
      viewport = await resizePage(chrome.endpoint, url, width, height, viewport);
      // Wait for the fixture's responsive transition, rather than sleeping or assuming the old DOM survived.
      const settled = parse(await client.callTool({ name: 'tab_expect', arguments: { selector: width <= 700 ? '#composer > div' : '#composer > input', timeout: 3 } }));
      expect(settled.ok, JSON.stringify({ width, settled })).toBe(true);
      if (width <= 700) {
        const found = parse(await client.callTool({ name: 'tab_find', arguments: { target: { text: 'Describe a scene' } } }));
        const entries = (found.result as { entries: Array<{ ref: string; tag: string; visible: boolean; editable: boolean | null }> }).entries;
        const entry = entries.find((e) => e.visible && e.tag === 'div')!;
        expect(entry, JSON.stringify(found)).toBeDefined();
        expect(entry.editable).not.toBe(true);
        expect(parse(await client.callTool({ name: 'tab_act', arguments: { action: 'click', target: { ref: entry.ref }, observe: true } })).ok).toBe(true);
      }
      const fields = parse(await client.callTool({ name: 'tab_find', arguments: { target: { selector: 'input, textarea, [contenteditable]' } } }));
      const entries = (fields.result as { entries: Array<{ ref: string; visible: boolean; editable: boolean }> }).entries;
      const field = entries.find((e) => e.visible && e.editable)!;
      expect(field).toBeDefined();
      if (previousRef) expect(parse(await client.callTool({ name: 'tab_act', arguments: { action: 'fill', target: { ref: previousRef }, value: 'must not land' } })).ok).toBe(false);
      const filled = parse(await client.callTool({ name: 'tab_act', arguments: { action: 'fill', target: { ref: field.ref }, value: `scene ${width}`, observe: true } }));
      expect(filled, JSON.stringify(filled)).toMatchObject({ ok: true, verified: true, actual: `scene ${width}` });
      expect(String((filled.after as Record<string, unknown>).state)).toContain(`ref=${field.ref}`);
      previousRef = field.ref;
    }
  }, 60_000);
  afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

  it('records a test with intents, exports it, replays it, repairs a stale step and runs the site suite', async () => {
    const site = await startSite(); cleanup.push(site.close);
    const chrome = await startChrome();
    cleanup.push(async () => { chrome.proc.kill(); await new Promise((r) => chrome.proc.once('exit', r)); fs.rmSync(chrome.profile, { recursive: true, force: true, maxRetries: 5 }); });
    const suiteDir = path.join(os.homedir(), '.opencli-mcp', 'adapters', 'shopx');
    fs.mkdirSync(suiteDir, { recursive: true });
    fs.writeFileSync(path.join(suiteDir, 'suite.json'), JSON.stringify({ name: 'shopx', match: ['127.0.0.1'], page: '/shop', session: { token: 'localStorage:auth#token' }, secrets: ['token'], headers: { token: '${token}' }, checks: [
      { id: 'items', path: '/api/items', expect: [{ path: 'items', minItems: 3 }, { path: 'items[*].id', type: 'string' }], capture: { firstId: 'items[0].id' }, adapters: ['items'] },
      { id: 'item', path: '/api/items/${firstId}', expect: [{ path: 'id', equals: '${firstId}' }, { path: 'name', equals: 'Apple' }], adapters: ['item'] },
    ] }));
    cleanup.push(() => fs.rmSync(suiteDir, { recursive: true, force: true }));
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', path.resolve('src/main.ts'), 'cdp', '--endpoint', chrome.endpoint, '--allow-origin', site.url], stderr: 'ignore' });
    const client = new Client({ name: 'flow-test', version: '1' }, { capabilities: {} });
    await client.connect(transport); cleanup.push(() => client.close());
    const call = async (name: string, args: Record<string, unknown>) => parse(await client.callTool({ name, arguments: args }));

    const opened = await call('tab_open', { url: `${site.url}/shop`, intent: 'open the shop', step: '1' });
    const tab = opened.tab as string;
    expect(await call('tab_expect', { selector: '#buy', enabled: false, intent: 'buy starts disabled', step: '1' })).toMatchObject({ ok: true });
    expect(await call('tab_expect', { selector: 'li.item', count: 3, intent: 'three items', step: '1' })).toMatchObject({ ok: true });
    expect(await call('tab_expect', { selector: '#items', hasText: 'Banana', timeout: 1 })).toMatchObject({ ok: true });
    expect(await call('tab_expect', { selector: 'li.item', count: 2, timeout: 1 })).toMatchObject({ ok: false, error: { code: 'expectation_failed' } });
    expect(await call('tab_act', { action: 'fill', target: { label: 'Name' }, value: 'Ada', intent: 'enter the name', step: '2' })).toMatchObject({ ok: true, verified: true });
    expect(await call('tab_expect', { selector: '#name', value: 'Ada', intent: 'name kept', step: '2' })).toMatchObject({ ok: true });
    expect(await call('tab_act', { action: 'check', target: { role: 'checkbox', name: 'I agree' }, intent: 'accept the terms', step: '2' })).toMatchObject({ ok: true });
    expect(await call('tab_expect', { selector: '#agree', checked: true, intent: 'terms accepted', step: '2' })).toMatchObject({ ok: true });
    const state = await call('tab_observe', {});
    const buyRef = /button "Buy".*?\[ref=(e\d+)\]/.exec(String(state.state))![1];
    const bought = await call('tab_act', { action: 'click', target: { ref: buyRef }, intent: 'buy', step: '3' });
    expect(bought.ok, JSON.stringify(bought)).toBe(true);
    const order = await call('network_expect', { url: '/api/order', method: 'POST', afterSequence: (bought.network as { afterSequence: number }).afterSequence, request: [{ path: 'name', equals: 'Ada' }], response: [{ path: 'orderId', equals: 'o-Ada' }], intent: 'order sent', step: '3' });
    expect(order, JSON.stringify(order)).toMatchObject({ ok: true, method: 'POST', status: 200 });
    expect(await call('tab_expect', { text: 'Order placed o-Ada', intent: 'confirmation', step: '3' })).toMatchObject({ ok: true });

    const exported = await call('journal', { action: 'export', name: 'shop buy', case: '1.1', save: true });
    const flow = exported.flow as { steps: Array<Record<string, unknown>> };
    expect(flow.steps.map((st) => st.intent)).toEqual(['open the shop', 'buy starts disabled', 'three items', undefined, 'enter the name', 'name kept', 'accept the terms', 'terms accepted', 'buy', 'order sent', 'confirmation']);
    expect(JSON.stringify(flow)).not.toMatch(/"ref"|\be\d+\b/);
    expect(flow.steps[8]).toMatchObject({ do: 'act', action: 'click', target: { selector: expect.stringContaining('Buy') } });
    const spec = await call('journal', { action: 'export', name: 'shop buy', format: 'playwright' });
    expect(spec.code).toContain("await expect(page.locator('li.item')).toHaveCount(3");
    expect(spec.code).toContain('.toBeChecked(');

    // replay in a fresh tab opened by the flow's first goto
    const replay = await call('flow_run', { name: 'shop buy' });
    expect(replay, JSON.stringify(replay)).toMatchObject({ ok: true, status: 'passed' });
    expect(replay.tab).not.toBe(tab);

    // a stale locator pauses the run on the live page; repair it by hand with the same intent and continue
    const stale = { ...flow, steps: flow.steps.map((st, i) => i === 8 ? { ...st, target: { selector: 'internal:role=button[name="Purchase"i]' } } : st) };
    const paused = await call('flow_run', { flow: stale, stepTimeout: 2 });
    expect(paused, JSON.stringify(paused).slice(0, 2000)).toMatchObject({ ok: true, status: 'paused', failedAt: 8, resume: { from: 9, retry: 8 } });
    expect(String((paused.page as { state: string }).state)).toContain('button "Buy"');
    const locators = await call('tab_locator', { tab: paused.tab, target: { role: 'button', name: 'Buy' } });
    expect(locators.recommended, JSON.stringify(locators)).toMatchObject({ kind: 'id', selector: '#buy', unique: true, sameElement: true });
    expect(await call('tab_act', { tab: paused.tab, action: 'click', target: { selector: '#buy' }, intent: 'buy', step: '3' })).toMatchObject({ ok: true });
    const resumed = await call('flow_run', { flow: stale, tab: paused.tab, from: 9 });
    expect(resumed, JSON.stringify(resumed).slice(0, 2000)).toMatchObject({ ok: true, status: 'passed' });
    const healed = await call('journal', { action: 'export', name: 'shop buy healed', since: paused.journalFrom });
    expect((healed.flow as { steps: Array<{ target?: { selector?: string } }> }).steps[8].target).toEqual({ selector: '#buy' });

    const suite = await call('suite_run', { site: 'shopx', origin: site.url });
    expect(suite, JSON.stringify(suite)).toMatchObject({ ok: true, suite: 'shopx', passed: 2, failed: 0, skipped: 0, affectedAdapters: [] });
    const plan = await call('plan_save', { fileName: 'shop', plan: { name: 'Shop', overview: 'Buying', suites: [{ name: 'Buy', cases: [{ id: '1.1', title: 'Buy with terms', steps: [{ id: '1', perform: 'Open the shop', expect: [{ kind: 'page', text: 'Buy is disabled' }] }] }] }] } });
    expect(String((plan.files as { markdown: string }).markdown)).toMatch(/plans[/\\]shop\.md$/);
  }, 90_000);

  it('drives a headless Chrome through the MCP tools, captures its requests and keeps it on allowed origins', async () => {
    const site = await startSite();
    cleanup.push(site.close);
    const chrome = await startChrome();
    cleanup.push(async () => { chrome.proc.kill(); await new Promise((r) => chrome.proc.once('exit', r)); fs.rmSync(chrome.profile, { recursive: true, force: true, maxRetries: 5 }); });

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', path.resolve('src/main.ts'), 'cdp', '--endpoint', chrome.endpoint, '--allow-origin', site.url],
      stderr: 'ignore',
    });
    const client = new Client({ name: 'cdp-test', version: '1' }, { capabilities: {} });
    await client.connect(transport);
    cleanup.push(() => client.close());

    const opened = parse(await client.callTool({ name: 'tab_open', arguments: { url: `${site.url}/` } }));
    expect(opened.ok).toBe(true);
    expect(String(opened.state)).toContain('button "Submit"');

    const filled = parse(await client.callTool({ name: 'tab_act', arguments: { action: 'fill', target: { label: 'Name' }, value: 'Ada' } }));
    expect(filled).toMatchObject({ ok: true, verified: true });
    const state = parse(await client.callTool({ name: 'tab_observe', arguments: {} }));
    const submit = /button \"Submit\".*?\[ref=(e\d+)\]/.exec(String(state.state));
    expect(submit).not.toBeNull();
    expect(parse(await client.callTool({ name: 'tab_act', arguments: { action: 'click', target: { ref: submit![1] } } })).ok).toBe(true);
    expect(parse(await client.callTool({ name: 'tab_expect', arguments: { text: 'Welcome, Ada' } })).ok).toBe(true);

    // Stable refs used as a scope must resolve in the same identity space as direct targets.
    await client.callTool({ name: 'js', arguments: { code: `const t = await browser.tabs.selected(); await t.evaluate('document.querySelectorAll(\'[role=group]\').forEach(el => el.replaceWith(el.cloneNode(true)))', { allowWrite: true })` } });
    await client.callTool({ name: 'tab_find', arguments: { target: { selector: 'section[aria-label="Video editor"]' } } });
    const scoped = parse(await client.callTool({ name: 'tab_observe', arguments: {} }));
    const imageGroup = /group "Image editor".*?\[ref=(e\d+)\]/.exec(String(scoped.state));
    expect(imageGroup).not.toBeNull();
    const selected = parse(await client.callTool({ name: 'tab_act', arguments: { action: 'click', target: { role: 'button', name: 'Run', within: imageGroup![1] }, observe: true } }));
    expect(selected.ok, JSON.stringify(selected)).toBe(true);
    expect(String((selected.after as Record<string, unknown>).state)).toContain('Image selected');
    const missingScope = parse(await client.callTool({ name: 'tab_act', arguments: { action: 'click', target: { role: 'button', name: 'Run', within: 'e999999' } } }));
    expect(missingScope).toMatchObject({ ok: false, error: { code: 'stale_ref' } });

    const failedExpect = await client.callTool({ name: 'tab_expect', arguments: { text: 'Goodbye', timeout: 1 } });
    expect(failedExpect.isError).toBe(true);
    expect(JSON.stringify(failedExpect.content)).toContain('expectation_failed');

    const requests = parse(await client.callTool({ name: 'network_inspect', arguments: { action: 'list', filter: '/api/signup' } }));
    expect(JSON.stringify(requests)).toContain('POST');

    const logs = parse(await client.callTool({ name: 'js', arguments: { code: 'const t = await browser.tabs.selected(); (await t.console.read()).entries.map((e) => e.message)' } }));
    expect(JSON.stringify(logs)).toContain('signup done');

    const mediaTab = { evaluate: async (code: string) => {
      const result = parse(await client.callTool({ name: 'js', arguments: { code: `const mediaTab = await browser.tabs.selected(); await mediaTab.evaluate(${JSON.stringify(code)})` } }));
      if (!result.ok) throw new Error(JSON.stringify(result));
      return result.value;
    } };
    expect(await probeMedia(mediaTab, `${site.url}/pixel.gif`, 'image', 2000)).toMatchObject({ readable: true, verification: 'image_decoded', width: 1, height: 1 });
    expect(await probeMedia(mediaTab, `${site.url}/`, 'image', 2000)).toMatchObject({ readable: false });
    expect(await probeMedia(mediaTab, `${site.url}/pixel.gif`, 'video', 2000)).toMatchObject({ readable: false });

    // links and tab_open to other origins are blocked in the browser itself
    await client.callTool({ name: 'tab_act', arguments: { action: 'click', target: { role: 'link', name: 'Leave' } } });
    expect(parse(await client.callTool({ name: 'tab_expect', arguments: { url: site.url } })).ok).toBe(true);
    const outside = await client.callTool({ name: 'tab_open', arguments: { url: 'https://example.com/' } });
    expect(outside.isError).toBe(true);
    expect(JSON.stringify(outside.content)).toContain('not an allowed origin');

    const finalized = parse(await client.callTool({ name: 'session_finalize', arguments: {} }));
    expect(finalized.ok).toBe(true);
  }, 60_000);

  it('launches its own headless Chrome, navigates, reads the console and sends requests with the page session', async () => {
    const site = await startSite();
    cleanup.push(site.close);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', path.resolve('src/main.ts'), 'cdp', '--launch', '--chrome', CHROME!, '--allow-origin', site.url],
      // vitest points HOME at an empty directory; headless Chrome on macOS stalls without the real one (keychain)
      env: { ...process.env, HOME: os.userInfo().homedir } as Record<string, string>,
      stderr: 'ignore',
    });
    const client = new Client({ name: 'cdp-launch-test', version: '1' }, { capabilities: {} });
    await client.connect(transport);
    cleanup.push(() => client.close());

    const opened = parse(await client.callTool({ name: 'tab_open', arguments: { url: `${site.url}/` } }));
    expect(opened.ok).toBe(true);

    // before login: the value is missing
    const loggedOut = await client.callTool({ name: 'page_request', arguments: { values: { token: 'localStorage:auth#token' } } });
    expect(loggedOut.isError).toBe(true);
    expect(parse(loggedOut)).toMatchObject({ ok: false, error: { code: 'session_missing', missing: ['token'] } });

    const moved = parse(await client.callTool({ name: 'tab_goto', arguments: { url: `${site.url}/app` } }));
    expect(moved).toMatchObject({ ok: true, title: 'App' });
    expect(String(moved.state)).toContain('Home');
    const outside = await client.callTool({ name: 'tab_goto', arguments: { url: 'https://example.com/' } });
    expect(parse(await client.callTool({ name: 'tab_expect', arguments: { url: `${site.url}/app` } })).ok, JSON.stringify(outside.content)).toBe(true);

    const logs = parse(await client.callTool({ name: 'console_read', arguments: { levels: ['warn'] } }));
    expect(JSON.stringify(logs.entries)).toContain('app ready');

    expect(parse(await client.callTool({ name: 'page_request', arguments: { values: { token: 'localStorage:auth#token' } } }))).toMatchObject({ ok: true, ready: true, origin: site.url });
    const me = parse(await client.callTool({ name: 'page_request', arguments: {
      values: { token: 'localStorage:auth#token' }, secrets: ['token'], path: '/api/me?t=${token}', headers: { token: '${token}' },
    } }));
    expect(me).toMatchObject({ ok: true, status: 200, contentType: 'application/json', url: '/api/me?t=******', attempts: 1 });
    expect(JSON.parse(String(me.text))).toEqual({ user: 'ada', echo: '******' });

    const unknown = await client.callTool({ name: 'page_request', arguments: { path: '/api/me', headers: { token: '${nope}' } } });
    expect(parse(unknown)).toMatchObject({ ok: false, error: { code: 'invalid_args', names: ['nope'] } });

    const retried = parse(await client.callTool({ name: 'page_request', arguments: { method: 'POST', path: '/api/flaky', body: { a: 1 }, attempts: 2 } }));
    expect(retried).toMatchObject({ ok: true, status: 200, attempts: 2 });
  }, 60_000);

  // An app relaying one embedded view exposes a single page's socket, like Chrome's /devtools/page/<id>.
  it('drives a single page endpoint without opening or closing tabs', async () => {
    const site = await startSite();
    cleanup.push(site.close);
    const chrome = await startChrome();
    cleanup.push(async () => { chrome.proc.kill(); await new Promise((r) => chrome.proc.once('exit', r)); fs.rmSync(chrome.profile, { recursive: true, force: true, maxRetries: 5 }); });
    const pages = await (await fetch(`${chrome.endpoint}/json/list`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
    const page = pages.find((p) => p.type === 'page')!;

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', path.resolve('src/main.ts'), 'cdp', '--endpoint', page.webSocketDebuggerUrl],
      stderr: 'ignore',
    });
    const client = new Client({ name: 'cdp-page-test', version: '1' }, { capabilities: {} });
    await client.connect(transport);
    cleanup.push(() => client.close());

    const first = parse(await client.callTool({ name: 'tab_open', arguments: { url: `${site.url}/` } }));
    expect(first.ok).toBe(true);
    await client.callTool({ name: 'tab_act', arguments: { action: 'fill', target: { label: 'Name' }, value: 'Lin' } });
    await client.callTool({ name: 'tab_act', arguments: { action: 'click', target: { role: 'button', name: 'Submit' } } });
    expect(parse(await client.callTool({ name: 'tab_expect', arguments: { text: 'Welcome, Lin' } })).ok).toBe(true);

    // site commands borrow the agent's page instead of failing on a page they do not own
    writeDemoAdapter();
    const borrowed = parse(await client.callTool({ name: 'site_run', arguments: { site: 'demo', command: 'page', args: {} } }));
    expect(borrowed).toMatchObject({ ok: true, value: { title: 'Sign up', url: `${site.url}/` } });

    const captured = await client.callTool({ name: 'tab_observe', arguments: { mode: 'both' } });
    expect(captured.isError).not.toBe(true);
    expect((captured.content as Array<{ type: string }>).some((block) => block.type === 'image')).toBe(true);

    // a second tab_open reuses the one page
    const second = parse(await client.callTool({ name: 'tab_open', arguments: { url: `${site.url}/?again` } }));
    expect(second.tab).toBe(first.tab);
    expect(parse(await client.callTool({ name: 'tab_list', arguments: {} })).tabs).toHaveLength(1);

    // finalize releases the page instead of closing it: it belongs to the embedding app
    expect(parse(await client.callTool({ name: 'session_finalize', arguments: {} })).ok).toBe(true);
    const after = await (await fetch(`${chrome.endpoint}/json/list`)).json() as Array<{ type: string; url: string }>;
    expect(after.filter((p) => p.type === 'page').map((p) => p.url)).toContain(`${site.url}/?again`);
  }, 60_000);
});
