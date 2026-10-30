// Journal → export → replay → pause, end to end through the MCP tools, on a scripted page.
import { afterEach, describe, expect, it } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { Runtime } from '../src/runtime/runtime.js';
import { createMcpServer } from '../src/mcp/server.js';
import type { RuntimePage } from '../src/backends/page-types.js';
import { runFlow, type FlowHost } from '../src/flows/runner.js';
import { networkExpect } from '../src/flows/network-expect.js';
import { runSuite, parseSuite } from '../src/flows/suite.js';
import { candidateSelectors, locatorCandidates } from '../src/flows/locator.js';
import type { Tab } from '../src/api/tab.js';
import type { FindEntry } from '../src/shared/page-contract.js';

const SAVE = 'internal:role=button[name="Save"i]';
const PASSWORD = 'internal:label="Password"i';

/** A page that knows two elements and records what it was asked to do. */
function scriptedPage(opts: { broken?: Set<string> } = {}) {
  const calls: Array<{ kind: string; target?: unknown; value?: string }> = [];
  const net: Array<Record<string, unknown>> = [];
  let requests = 0;
  const resolve = (target: Record<string, unknown>): string => {
    if (target.ref === 'e3' || target.selector === SAVE) return SAVE;
    if (target.ref === 'e4' || target.selector === PASSWORD || target.label === 'Password') return PASSWORD;
    throw Object.assign(new Error(`no element matches ${JSON.stringify(target)}`), { code: 'not_found' });
  };
  const entry = (selector: string): FindEntry => selector === PASSWORD
    ? { nth: 0, ref: 'e4', selector: PASSWORD, tag: 'input', role: 'textbox', name: 'Password', text: '', attrs: { type: 'password', name: 'pwd' }, visible: true, enabled: true, editable: true, box: { x: 0, y: 40, w: 100, h: 20 } }
    : { nth: 0, ref: 'e3', selector: SAVE, tag: 'button', role: 'button', name: 'Save', text: 'Save', attrs: { 'data-testid': 'save' }, visible: true, enabled: true, editable: false, box: { x: 0, y: 0, w: 80, h: 20 } };
  const page = {
    surface: 'browser',
    async goto(url: string) { calls.push({ kind: 'goto', target: url }); },
    async getCurrentUrl() { return 'https://shop.test/form'; },
    async evaluate() { return 'Form'; },
    async readNetworkCapture() { const out = net.splice(0); return out; },
    async history() { return {}; },
    async act(spec: { kind: string; target: Record<string, unknown>; value?: string }) {
      calls.push({ kind: spec.kind, target: spec.target, value: spec.value });
      const selector = resolve(spec.target);
      if (opts.broken?.has(selector) && !('ref' in spec.target)) throw Object.assign(new Error(`no element matches ${selector}`), { code: 'not_found', hint: 'observe again' });
      if (spec.kind === 'click') net.push({ requestId: `r${++requests}`, url: 'https://shop.test/api/save', method: 'POST', requestBodyPreview: '{"name":"Ann"}', responsePreview: '{"code":0,"data":{"id":"w1"}}', responseStatus: 200, done: true });
      return { ok: true, kind: spec.kind, ref: null, matches_n: 1, visible_n: 1, match_level: 'exact', point: { x: 1, y: 1 }, method: 'cdp', hit: 'target', tag: 'button', waitedMs: 1, selector, ...(spec.kind === 'fill' && { filled: true, verified: true, actual: spec.value }) };
    },
    async expect(what: Record<string, unknown>) { calls.push({ kind: 'expect', target: what }); return { ok: true, failed: [], url: 'https://shop.test/form', title: 'Form' }; },
    async pageCall(fn: string, args: { selector?: string }) {
      if (fn === 'find') {
        // every locator naming one of the two elements finds it
        const sel = args.selector!;
        const hit = sel === 'aria-ref=e3' || /save/i.test(sel) ? SAVE : sel === 'aria-ref=e4' || /password|pwd/i.test(sel) ? PASSWORD : null;
        return hit ? { matches_n: 1, visible_n: 1, selector: sel, entries: [entry(hit)] } : { matches_n: 0, visible_n: 0, selector: sel, entries: [] };
      }
      if (fn === 'aria') return '- button "Save" [ref=e3]';
      return null;
    },
    async consoleLogs() { return { entries: [{ level: 'error', text: 'boom' }], cursor: 1 }; },
  };
  return { page: page as unknown as RuntimePage, calls };
}

async function connect(page: RuntimePage) {
  const rt = new Runtime({ log: () => {} });
  await rt.init();
  rt.browserAvailable = () => true;
  rt.backend = () => 'extension';
  rt.hasFeature = (f) => f === 'network' || f === 'console';
  rt.pageFor = async () => page;
  const id = `flow-${Math.random()}`;
  const session = createMcpServer(rt, id, { persistent: true });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await session.server.connect(serverT);
  const client = new Client({ name: 'test', version: '1' }, { capabilities: {} });
  await client.connect(clientT);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as Array<{ type: string; text?: string }>).find((c) => c.type === 'text')?.text ?? '{}';
    return { ...JSON.parse(text), isError: Boolean(r.isError) } as Record<string, any>;
  };
  return { rt, call, close: async () => { await client.close(); await rt.shutdown(); } };
}

let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanup) await c(); cleanup = []; });

describe('journal, export and replay through MCP', () => {
  it('records durable steps, exports flow and spec, and replays them', async () => {
    const { page, calls } = scriptedPage();
    const s = await connect(page);
    cleanup.push(s.close);
    await s.call('tab_goto', { tab: 'p1', url: 'https://shop.test/form', observe: false, intent: 'open the form', step: '1' });
    await s.call('tab_act', { tab: 'p1', action: 'fill', target: { ref: 'e4' }, value: 'hunter2', intent: 'enter the password', step: '2' });
    const click = await s.call('tab_act', { tab: 'p1', action: 'click', target: { ref: 'e3' }, intent: 'save', step: '3' });
    expect(click.ok).toBe(true);
    await s.call('tab_expect', { tab: 'p1', ref: 'e3', intent: 'save is still there', step: '3' });
    const net = await s.call('network_expect', { tab: 'p1', url: '/api/save', method: 'POST', afterSequence: click.network.afterSequence, request: [{ path: 'name', equals: 'Ann' }], response: [{ path: 'data.id', type: 'string' }], intent: 'save request', step: '3' });
    expect(net).toMatchObject({ ok: true, method: 'POST', status: 200 });
    const missing = await s.call('tab_act', { tab: 'p1', action: 'click', target: { text: 'Nope' }, intent: 'bad step' });
    expect(missing.isError).toBe(true);

    const read = await s.call('journal', { action: 'read' });
    expect(read.entries.map((e: { ok: boolean }) => e.ok)).toEqual([true, true, true, true, true, false]);

    const exported = await s.call('journal', { action: 'export', name: 'save form', site: 'shop', save: true });
    expect(exported.flow.steps).toEqual([
      { do: 'goto', url: 'https://shop.test/form', intent: 'open the form', step: '1' },
      { do: 'act', action: 'fill', target: { selector: PASSWORD }, value: '${pwd}', intent: 'enter the password', step: '2' },
      { do: 'act', action: 'click', target: { selector: SAVE }, intent: 'save', step: '3' },
      { do: 'expect', expect: { selector: SAVE }, timeout: 5, intent: 'save is still there', step: '3' },
      { do: 'network', match: { url: '/api/save', method: 'POST', request: [{ path: 'name', equals: 'Ann' }], response: [{ path: 'data.id', type: 'string' }] }, timeout: 10, intent: 'save request', step: '3' },
    ]);
    expect(exported.skipped).toEqual([{ seq: 6, intent: 'bad step', reason: 'failed: not_found' }]);
    expect(exported.file).toMatch(/flows[/\\]save-form\.flow\.json$/);
    expect(JSON.stringify(exported)).not.toContain('hunter2');

    const spec = await s.call('journal', { action: 'export', name: 'save form', format: 'playwright' });
    expect(spec.code).toContain("await page.getByLabel('Password').fill('${pwd}');");
    expect(spec.code).toContain("await page.getByRole('button', { name: 'Save' }).click();");

    expect((await s.call('flows_list', {})).flows).toEqual(['save-form']);
    calls.length = 0;
    const replay = await s.call('flow_run', { name: 'save form', tab: 'p1', vars: { pwd: 'hunter2' } });
    expect(replay, JSON.stringify(replay)).toMatchObject({ ok: true, status: 'passed', tab: 'p1' });
    expect(calls.find((c) => c.kind === 'fill')).toMatchObject({ value: 'hunter2', target: { selector: PASSWORD } });
    // the replay is journaled with its placeholders, not the secret
    const again = await s.call('journal', { action: 'export', name: 'again', since: replay.journalFrom });
    expect(again.flow.steps[1].value).toBe('${pwd}');

    const noVar = await s.call('flow_run', { name: 'save form', tab: 'p1' });
    expect(noVar).toMatchObject({ status: 'paused', failedAt: 1, error: { code: 'missing_var' }, resume: { from: 2, retry: 1 } });
  });

  it('pauses on a failing step with evidence and resumes from the next one', async () => {
    const { page } = scriptedPage({ broken: new Set([SAVE]) });
    const s = await connect(page);
    cleanup.push(s.close);
    const flow = { flow: 1, platform: 'web', name: 'broken', steps: [
      { do: 'goto', url: 'https://shop.test/form' },
      { do: 'act', action: 'click', target: { selector: SAVE }, intent: 'save' },
      { do: 'expect', expect: { text: 'Saved' }, intent: 'confirmation' },
    ] };
    const paused = await s.call('flow_run', { flow, tab: 'p1' });
    expect(paused.isError).toBe(true);
    expect(paused).toMatchObject({ status: 'paused', failedAt: 1, error: { code: 'not_found', hint: 'observe again' }, page: { url: 'https://shop.test/form', state: '- button "Save" [ref=e3]' }, console: [{ level: 'error', text: 'boom' }], resume: { from: 2, retry: 1 } });
    // the agent repairs the step by hand with the same intent, then continues
    await s.call('tab_act', { tab: 'p1', action: 'click', target: { ref: 'e3' }, intent: 'save' });
    const resumed = await s.call('flow_run', { flow, tab: 'p1', from: 2 });
    expect(resumed.status).toBe('passed');
    const healed = await s.call('journal', { action: 'export', name: 'healed', since: paused.journalFrom });
    expect(healed.flow.steps.map((st: { do: string; intent?: string }) => st.intent ?? st.do)).toEqual(['goto', 'save', 'confirmation']);

    const locators = await s.call('tab_locator', { tab: 'p1', target: { ref: 'e3' } });
    expect(locators.recommended).toMatchObject({ kind: 'testid', unique: true, sameElement: true, locator: "page.getByTestId('save')" });
  });
});

describe('runner rules', () => {
  const fakeTab = (log: string[]): Tab => ({
    id: 't1',
    goto: async (url: string) => { log.push(`goto ${url}`); return { url, title: null }; },
    act: async (o: { action: string }) => { log.push(`act ${o.action}`); return { network: { afterSequence: 7 } }; },
    expect: async () => { log.push('expect'); return { ok: true, failed: [], url: '', title: '' }; },
    observe: async () => ({ url: 'u', title: 't', state: 's' }),
    url: async () => 'u', title: async () => 't',
    console: { read: async () => ({ entries: [] }) },
    network: { list: async () => ({ entries: [] }), read: async () => ({ cursor: 0, entries: [], hasMore: false }) },
  }) as unknown as Tab;

  it('runs the seed, opens the tab and blocks writes without allowWrites', async () => {
    const log: string[] = [];
    const host: FlowHost = {
      openTab: async (url) => { log.push(`open ${url}`); return fakeTab(log); },
      runSite: async (site, command, args) => { log.push(`site ${site}/${command} ${JSON.stringify(args)}`); return command === 'seed' ? { url: 'https://shop.test/home' } : { credits: 3 }; },
      access: async (_site, command) => command === 'buy' ? 'write' : 'read',
    };
    const flow = { flow: 1 as const, platform: 'web' as const, name: 'f', site: 'shop', seed: { command: 'seed', args: { who: '${user}' } }, steps: [
      { do: 'act' as const, action: 'click' as const, target: { text: 'Buy' } },
      { do: 'site' as const, site: 'shop', command: 'credits', args: {}, expect: [{ path: 'credits', minItems: 1 }] },
    ] };
    const failed = await runFlow(flow, host, { vars: { user: 'ann' } });
    expect(log.slice(0, 3)).toEqual(['site shop/seed {"who":"ann"}', 'open https://shop.test/home', 'act click']);
    expect(failed).toMatchObject({ status: 'paused', failedAt: 1, error: { code: 'expectation_failed', details: { failures: [{ path: 'credits', op: 'minItems' }] } } });

    const blocked = await runFlow({ ...flow, seed: undefined, steps: [{ do: 'goto', url: 'https://shop.test/' }, { do: 'site', site: 'shop', command: 'buy', args: {} }] }, host);
    expect(blocked).toMatchObject({ status: 'paused', failedAt: 1, error: { code: 'write_blocked' } });
    const allowed = await runFlow({ ...flow, seed: undefined, steps: [{ do: 'goto', url: 'https://shop.test/' }, { do: 'site', site: 'shop', command: 'buy', args: {} }] }, host, { allowWrites: true });
    expect(allowed.status).toBe('passed');

    const noPage = await runFlow({ ...flow, seed: undefined, steps: [{ do: 'expect', expect: { text: 'x' } }] }, host);
    expect(noPage.error?.code).toBe('no_tab');
  });
});

describe('network_expect', () => {
  it('waits for a matching request and reports the closest misses', async () => {
    let entries: Array<Record<string, unknown> & { seq: number }> = [
      { seq: 1, url: 'https://x.test/api/chat', method: 'POST', requestBodyPreview: '{"scene_type":"CHAT","model":"m1"}', responsePreview: 'event: done\ndata: {"success":true}\n\n', responseContentType: 'text/event-stream', responseStatus: 200, done: true },
    ];
    const tab = { network: { read: async ({ afterSequence }: { afterSequence: number }) => { const page = entries.filter((e) => e.seq > afterSequence); return { cursor: page.at(-1)?.seq ?? afterSequence, entries: page, hasMore: false }; } } } as unknown as Tab;
    const hit = await networkExpect(tab, { url: '/api/chat', request: [{ path: 'scene_type', equals: 'CHAT' }], response: [{ path: 'events[?event=done].data.success', equals: true }] }, { timeoutMs: 100 });
    expect(hit).toMatchObject({ seq: 1, status: 200 });
    await expect(networkExpect(tab, { url: '/api/chat', request: [{ path: 'scene_type', equals: 'INFINITE_CANVAS' }] }, { timeoutMs: 100 })).rejects.toMatchObject({ code: 'expectation_failed', data: { details: { candidates: [{ seq: 1, failures: [{ path: 'request.scene_type', op: 'equals' }] }] } } });
    setTimeout(() => { entries = [...entries, { seq: 2, url: 'https://x.test/api/chat', method: 'POST', requestBodyPreview: '{"scene_type":"INFINITE_CANVAS"}', done: true, responseStatus: 200 }]; }, 50);
    expect((await networkExpect(tab, { url: '/api/chat', request: [{ path: 'scene_type', equals: 'INFINITE_CANVAS' }] }, { afterSequence: 1, timeoutMs: 2000 })).seq).toBe(2);
  });
});

describe('suite_run', () => {
  it('judges checks, carries captures and names affected adapters', async () => {
    const suite = parseSuite({ name: 'shop', match: ['shop.test'], session: { token: 'localStorage:auth#token' }, secrets: ['token'], headers: { token: '${token}' }, checks: [
      { id: 'list', path: '/api/list', expect: [{ path: 'data', minItems: 1 }], capture: { firstId: 'data[0].id' }, adapters: ['list'] },
      { id: 'detail', path: '/api/item/${firstId}', expect: [{ path: 'id', equals: '${firstId}' }], adapters: ['detail', 'list'] },
      { id: 'needs', path: '/api/x/${never}', adapters: ['x'] },
      { id: 'chat', method: 'POST', path: '/api/chat', body: {}, response: 'sse', expect: [{ path: 'events[0].event', equals: 'error' }], adapters: ['chat'] },
      { id: 'broken', path: '/api/broken', expect: [{ path: 'ok', equals: true }], adapters: ['broken', 'list'] },
    ] });
    const sent: Array<Record<string, unknown>> = [];
    const responses: Record<string, string> = { '/api/list': '{"data":[{"id":"a1"}]}', '/api/item/a1': '{"id":"a1"}', '/api/chat': 'event: error\ndata: {"error":"Parameter Illegal"}\n\n', '/api/broken': '{"ok":false}' };
    const tab = { url: async () => 'https://shop.test/home' } as unknown as Tab;
    const report = await runSuite(tab, suite, { request: async (o) => { sent.push(o as never); return { status: 200, contentType: 'application/json', text: responses[o.request!.path], ms: 3, attempts: 1, url: o.request!.path }; } });
    expect(report).toMatchObject({ passed: 3, failed: 1, skipped: 1, affectedAdapters: ['broken', 'list'] });
    expect(report.checks.find((c) => c.id === 'needs')?.skipped).toContain('never');
    expect(sent[0]).toMatchObject({ values: { token: 'localStorage:auth#token' }, secrets: ['token'], request: { method: 'GET', headers: { token: '${token}' } } });
    expect(sent[1]).toMatchObject({ request: { path: '/api/item/a1' } });
    expect((await runSuite(tab, suite, { only: ['broken'], request: async () => ({ status: 200, contentType: '', text: '{"ok":true}', ms: 1, attempts: 1, url: '' }) })).passed).toBe(1);
    await expect(runSuite({ url: async () => 'https://other.test/' } as unknown as Tab, suite)).rejects.toMatchObject({ code: 'wrong_site' });
  });
});

describe('locator candidates', () => {
  it('orders durable kinds first and skips generated ids', () => {
    const kinds = candidateSelectors({ nth: 0, ref: 'e1', selector: '#x', tag: 'input', role: 'textbox', name: 'Email', text: '', attrs: { id: 'radix-123', name: 'email', placeholder: 'you@x' }, visible: true, enabled: true, editable: true, box: { x: 0, y: 0, w: 1, h: 1 } }).map((c) => c.kind);
    expect(kinds).toEqual(['name', 'role', 'role-exact', 'placeholder', 'generated']);
  });
  it('rejects ambiguous targets', async () => {
    const tab = { find: async () => ({ matches_n: 2, visible_n: 2, selector: 'x', entries: [{ ref: 'e1' }, { ref: 'e2' }] }) } as unknown as Tab;
    await expect(locatorCandidates(tab, { text: 'Save' })).rejects.toMatchObject({ code: 'selector_ambiguous' });
  });
});
