import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const CHROME = process.env.CHROME_PATH ?? [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => fs.existsSync(p));

const PAGE = `<!doctype html><title>Sign up</title>
<form id="f"><label>Name <input name="name"></label> <button>Submit</button></form>
<p id="out"></p><a href="https://example.com/">Leave</a>
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

async function startSite(): Promise<{ url: string; close: () => Promise<void> }> {
  let flaky = 0;
  const server = http.createServer((req, res) => {
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
    if (req.url === '/app') { res.writeHead(200, { 'content-type': 'text/html' }).end(APP); return; }
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
  afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

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
    expect(parse(await client.callTool({ name: 'tab_act', arguments: { action: 'click', target: { role: 'button', name: 'Submit' } } })).ok).toBe(true);
    expect(parse(await client.callTool({ name: 'tab_expect', arguments: { text: 'Welcome, Ada' } })).ok).toBe(true);

    const failedExpect = await client.callTool({ name: 'tab_expect', arguments: { text: 'Goodbye', timeout: 1 } });
    expect(failedExpect.isError).toBe(true);
    expect(JSON.stringify(failedExpect.content)).toContain('expectation_failed');

    const requests = parse(await client.callTool({ name: 'network_inspect', arguments: { action: 'list', filter: '/api/signup' } }));
    expect(JSON.stringify(requests)).toContain('POST');

    const logs = parse(await client.callTool({ name: 'js', arguments: { code: 'const t = await browser.tabs.selected(); (await t.console.read()).entries.map((e) => e.message)' } }));
    expect(JSON.stringify(logs)).toContain('signup done');

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
