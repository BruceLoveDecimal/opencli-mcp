/**
 * MCP server per session: typed core tools, dynamic site tools, the `js` code-mode tool,
 * resources (docs, sites) and prompts — all backed by the same object model.
 */
import { McpServer, ResourceTemplate, type RegisteredTool } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Runtime } from '../runtime/runtime.js';
import { createAgentApi, Tab, type AgentApi, type ActAction } from '../api/agent.js';
import { ActionError, errorEnvelope } from '../api/errors.js';
import { JsSession, safeStringify } from './js-session.js';
import { buildInstructions, listDocs, readDocForContext, type DocContext } from '../docs/manifest.js';
import { argsToShape, argSpec, coerceArgs } from '../sites/schema.js';
import { listDefinedTools } from '../sites/define.js';
import { checkActInput, checkExpect, type ActToolInput } from './act-input.js';
import { actionSchema, targetSchema } from './action-schema.js';
import { siteRecord, journaled, type StepMeta } from '../flows/journal.js';
import { flowToPlaywright } from '../flows/playwright.js';
import { networkMatchSchema, planMarkdown, planSchema, webFlowSchema, webSeedSchema, type WebFlow } from '../flows/schema.js';
import { runFlow } from '../flows/runner.js';
import { networkExpect } from '../flows/network-expect.js';
import { locatorCandidates } from '../flows/locator.js';
import { parseSuite, runSuite } from '../flows/suite.js';
import { flowsDir, listSavedFlows, plansDir, readSavedFlow, safeName, writeFile } from '../flows/store.js';

/** Optional on every recorded step: what the call does in test terms. */
const stepMeta = {
  intent: z.string().max(300).optional().describe('the test step this call performs (e.g. the plan step text); recorded in the journal'),
  step: z.string().max(40).optional().describe('case step id, e.g. "2"'),
};

type Content = Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
type ToolResult = { content: Content; structuredContent?: Record<string, unknown>; isError?: boolean };

function text(s: string): Content[number] { return { type: 'text', text: s }; }
// One result envelope everywhere: success is `{ ok:true, …data }`, failure is `{ ok:false, error:{…} }` — compact JSON,
// in-band `ok` (the agent reads content text), no duplicate structuredContent. Raw strings (docs/markdown) pass through.
function ok(data: unknown, images: Array<{ mimeType: string; base64: string }> = []): ToolResult {
  const content: Content = [];
  if (typeof data === 'string') content.push(text(data));
  else if (Array.isArray(data)) content.push(text(safeStringify({ ok: true, value: data }, 120_000)));
  else if (data && typeof data === 'object') content.push(text(safeStringify({ ok: true, ...(data as Record<string, unknown>) }, 120_000)));
  else content.push(text(safeStringify({ ok: true }, 120_000)));
  for (const img of images) content.push({ type: 'image', data: img.base64, mimeType: img.mimeType });
  return { content };
}
function fail(err: unknown): ToolResult {
  return { content: [text(safeStringify(errorEnvelope(err)))], isError: true };
}
function stripImage<T extends Record<string, unknown>>(o: T): { data: Record<string, unknown>; images: Array<{ mimeType: string; base64: string }> } {
  const images: Array<{ mimeType: string; base64: string }> = [];
  const data: Record<string, unknown> = { ...o };
  const img = o.image as { __image?: boolean; mimeType: string; base64: string } | undefined;
  if (img && img.__image) { images.push({ mimeType: img.mimeType, base64: img.base64 }); data.image = `${img.mimeType} attached`; }
  return { data, images };
}

export interface SessionServer { server: McpServer; api: AgentApi; close(): Promise<void> }

export function createMcpServer(rt: Runtime, sessionId: string, opts: { version?: string; persistent?: boolean } = {}): SessionServer {
  const persistent = opts.persistent !== false; // stateless HTTP creates a fresh server per request: no long-lived rt listeners, and close() must not finalize the shared runtime session
  const api = createAgentApi(rt, sessionId);
  const state = rt.session(sessionId);
  const docCtx = (): DocContext => ({ backend: rt.backend(), capabilities: rt.features() });
  const server = new McpServer({ name: 'opencli-mcp', version: opts.version ?? '0.0.0' }, {
    capabilities: { tools: { listChanged: true }, resources: { listChanged: true }, prompts: {}, logging: {} },
    instructions: buildInstructions(docCtx()),
  });

  const tabOf = async (id?: string): Promise<Tab> => {
    const b = await api.agent.browsers.getDefault();
    if (id) return b.tabs.get(id);
    // selected is the last tab this session touched, not a disambiguator. The lease list is the only source.
    const tabs = (await b.tabs.list()).filter((t) => t.state === 'active');
    const ready = tabs.filter((t): t is typeof t & { id: string } => Boolean(t.id));
    if (tabs.length > 1) throw new ActionError('tab_required', `This session has ${tabs.length} tabs. Pass tab.`, 'Copy a ready tab id from this list; pending tabs have only tabId until their page is ready.', { details: { tabs: tabs.map((t) => ({ tab: t.id, tabId: t.tabId, pending: t.pending, url: t.url, title: t.title })) } });
    if (ready.length === 1) return b.tabs.get(ready[0].id);
    if (tabs.length === 1) throw new ActionError('tab_pending', `Tab ${tabs[0].tabId} has no page handle yet.`, 'Call tab_list again and match this tabId after its page becomes ready.', { details: { tabId: tabs[0].tabId } });
    throw new ActionError('no_tab', 'No tab is open in this session', 'Call tab_open first (or tab_claim a user tab).');
  };
  const run = async (fn: () => Promise<ToolResult>): Promise<ToolResult> => { try { return await fn(); } catch (err) { return fail(err); } };
  type Extra = { signal?: AbortSignal; _meta?: { progressToken?: string | number }; sendNotification?: (n: { method: 'notifications/progress'; params: { progressToken: string | number; progress: number; total?: number; message?: string } }) => Promise<void> };
  // v2 ServerContext carries request state under `mcpReq` (signal, _meta, notify) — lift the pieces we use.
  const ctxExtra = (ctx: unknown): Extra => {
    const m = (ctx as { mcpReq?: { signal?: AbortSignal; _meta?: { progressToken?: string | number }; notify?: (n: unknown) => Promise<void> } }).mcpReq ?? {};
    return { signal: m.signal, _meta: m._meta, sendNotification: m.notify ? (n) => m.notify!(n) : undefined };
  };
  /** Run a long site command with progress heartbeats (when the host passed a progressToken) and cancellation; journaled. */
  const runSiteWithProgress = async (site: string, command: string, args: Record<string, unknown>, extra: Extra, meta: StepMeta = {}): Promise<ToolResult> => {
    const r = await siteCall(site, command, args, extra, meta);
    return ok(r.rows !== undefined ? { rows: r.rows, ...(r.nextCursor ? { nextCursor: r.nextCursor } : {}) } : { value: r.value });
  };
  const siteCall = async (site: string, command: string, args: Record<string, unknown>, extra: Extra, meta: StepMeta = {}): Promise<{ rows?: unknown[]; nextCursor?: unknown; value?: unknown }> => {
    const cmd = await rt.registry.resolve(site, command);
    const coerced = coerceArgs(cmd.args, args);
    const started = Date.now();
    const journal = (ok: boolean, error?: { code: string; message: string }): void => {
      const { record, note } = siteRecord(site, command, coerced, cmd.access);
      state.journal?.add({ ...meta, ok, ms: Date.now() - started, record, ...(note && { note }), ...(error && { error }) });
    };
    const token = extra._meta?.progressToken;
    let beat: NodeJS.Timeout | undefined;
    if (token !== undefined && extra.sendNotification) {
      beat = setInterval(() => { void extra.sendNotification!({ method: 'notifications/progress', params: { progressToken: token, progress: Math.round((Date.now() - started) / 1000), message: `${site} ${command} running (${Math.round((Date.now() - started) / 1000)}s)` } }).catch(() => {}); }, 5000);
    }
    try {
      const r = await rt.runSite(site, command, coerced, { signal: extra.signal });
      if (!r.ok) {
        const { code, message, hint, ...restErr } = r.error;
        journal(false, { code, message: String(message).slice(0, 500) });
        throw new ActionError(code, message, hint, { site, command, ...restErr });
      }
      journal(true);
      return r.rows !== undefined ? { rows: r.rows, ...(r.nextCursor && { nextCursor: r.nextCursor }) } : { value: r.value };
    } finally { if (beat) clearInterval(beat); }
  };
  // ── the entry surface: the few typed tools for the core loop; everything else lives in the object model behind `js` ──
  // ── diagnostics & discovery ──
  server.registerTool('doctor', { title: 'Doctor', description: 'Runtime status: backend (extension/none), extension version, site/command counts, sessions.', inputSchema: {}, annotations: { readOnlyHint: true } }, async () => run(async () => ok(rt.doctor())));

  // ── session ──
  server.registerTool('session_finalize', { title: 'Finalize session tabs', description: 'End-of-task cleanup. Agent-created tabs not listed in keep are closed; deliverable tabs leave the group and stay open; handoff tabs stay in the group for a later turn. Claimed user tabs are only released.',
    inputSchema: { keep: z.array(z.object({ tab: z.string().describe('tab id'), status: z.enum(['deliverable', 'handoff']) })).default([]) },
    annotations: { destructiveHint: true },
  }, async ({ keep }) => run(async () => ok(await (await api.agent.browsers.getDefault()).tabs.finalize({ keep }))));

  // ── tabs ──
  server.registerTool('tab_list', { title: 'List tabs', description: 'List this session’s active and handoff tabs and, when user:true, user tabs available to claim. Session tabs include numeric tabId; id is the page handle when ready, or pending:true until ready. Match a pending popup by tabId on a later call. User tabs include tabId for tab_claim.',
    inputSchema: { user: z.boolean().default(false).describe('also list user tabs available to claim'), query: z.string().optional().describe('filter user tabs by title or URL'), limit: z.number().int().min(1).max(100).default(20).describe('maximum user tabs returned') }, annotations: { readOnlyHint: true },
  }, async ({ user, query, limit }) => run(async () => { const b = await api.agent.browsers.getDefault(); return ok({ tabs: await b.tabs.list(), ...(user ? { userTabs: await b.user.openTabs({ query, limit }) } : {}) }); }));
  server.registerTool('tab_open', { title: 'Open a tab', description: 'Open a URL in a new agent tab (background, in this session’s tab group) and return its id plus the initial page state.',
    inputSchema: { url: z.string().optional().describe('http(s) URL, or data:text/html,… for a scratch page'), observe: z.boolean().default(true), session: z.string().min(1).max(60).optional().describe('name this browser session (short, emoji-prefixed; becomes the Chrome tab-group title) — give it with the first tab'), ...stepMeta },
    annotations: { openWorldHint: true },
  }, async ({ url, observe, session: sessionName, intent, step }) => run(async () => {
    const b = await api.agent.browsers.getDefault();
    if (sessionName) await b.nameSession(sessionName);
    const tab = await b.tabs.new(url, { intent, step });
    if (!observe) return ok({ tab: tab.id, url });
    const { data, images } = stripImage({ tab: tab.id, ...(await tab.observe()) });
    return ok(data, images);
  }));
  server.registerTool('tab_goto', { title: 'Navigate a tab', description: 'Load a URL in an existing session tab and return the new page state (observe:false returns only url and title). Use tab_open for a new tab.',
    inputSchema: { tab: z.string().optional().describe('required when the session has more than one tab'), url: z.string().describe('http(s) URL'), observe: z.boolean().default(true), ...stepMeta },
    annotations: { openWorldHint: true },
  }, async ({ tab, url, observe, intent, step }) => run(async () => {
    const t = await tabOf(tab);
    const page = await t.goto(url, { intent, step });
    if (!observe) return ok({ tab: t.id, ...page });
    const { data, images } = stripImage({ tab: t.id, ...(await t.observe()) });
    return ok(data, images);
  }));
  server.registerTool('tab_claim', { title: 'Claim a user tab', description: 'Claim active:true, a tabId from tab_list, or a unique fuzzy url/title lookup. For a specific tab mentioned by the user, pass exact expectedUrl/expectedTitle from its current listing; changed identity fails instead of claiming another tab. Returns page handle and numeric tabId. Claimed user tabs are released by session_finalize.',
    inputSchema: { tabId: z.number().int().positive().optional(), active: z.boolean().optional().describe('foreground tab of the last focused normal Chrome window'), title: z.string().optional().describe('fuzzy lookup only; omit with tabId or active'), url: z.string().optional().describe('fuzzy lookup only; omit with tabId or active'), expectedTitle: z.string().optional().describe('exact title guard for the selected tab'), expectedUrl: z.string().optional().describe('exact URL guard for the selected tab'), observe: z.boolean().default(true) },
    annotations: { openWorldHint: true },
  }, async ({ tabId, active, title, url, expectedTitle, expectedUrl, observe }) => run(async () => {
    const b = await api.agent.browsers.getDefault();
    const tab = await b.user.claimTab({ tabId, active, title, url, expectedTitle, expectedUrl });
    if (!observe) return ok({ tab: tab.id, tabId: tab.tabId });
    const { data, images } = stripImage({ tab: tab.id, tabId: tab.tabId, ...(await tab.observe()) });
    return ok(data, images);
  }));
  server.registerTool('tab_close', { title: 'Close tabs', description: 'Close one session tab with tab, or close explicit user tabs with tabIds:[...]. Numeric tabIds of unclaimed user tabs are closed directly without loading the pages. Inspect complete and the per-id closed/failed results. To keep a controlled tab open, use tab_release.',
    inputSchema: { tab: z.string().optional().describe('page handle for one session tab; omit when only one session tab is active'), tabIds: z.array(z.number().int().positive()).min(1).optional().describe('Chrome tabIds of user tabs to close in one call; cannot be combined with tab') },
    annotations: { destructiveHint: true },
  }, async ({ tab, tabIds }) => run(async () => {
    if (tab !== undefined && tabIds !== undefined) throw new ActionError('invalid_args', 'Pass tab or tabIds, not both.');
    const b = await api.agent.browsers.getDefault();
    if (tabIds) return ok(await b.user.closeTabs(tabIds));
    const t = await tabOf(tab);
    await t.close();
    return ok({ tab: t.id, closed: true });
  }));
  server.registerTool('tab_release', { title: 'Release a tab', description: 'Keep a controlled tab open and give up this session’s control. Works for both agent-created and claimed user tabs.',
    inputSchema: { tab: z.string().optional().describe('required when the session has more than one tab') },
  }, async ({ tab }) => run(async () => { const t = await tabOf(tab); await t.release(); return ok({ tab: t.id, released: true }); }));
  server.registerTool('tab_observe', { title: 'Observe a tab', description: 'Action map with [ref=eN] refs, or a screenshot. Returns snapshotId. Pass since with an id you still have to receive a diff against exactly that state; otherwise a full state is returned. Long document text is tab_read. A collapsed branch keeps its ref; pass ref to open it.',
    inputSchema: { tab: z.string().optional().describe('required when the session has more than one tab'), mode: z.enum(['state', 'screenshot', 'both']).default('state'), since: z.string().optional().describe('snapshotId from the state still in your context'), viewport: z.boolean().optional().describe('only the subtree on screen right now'), ref: z.string().optional().describe('open one collapsed branch (eN); ignores viewport'), annotate: z.boolean().default(false).describe('overlay eN labels on the screenshot'), fullPage: z.boolean().default(false) },
    annotations: { readOnlyHint: true },
  }, async ({ tab, ...o }) => run(async () => { const t = await tabOf(tab); const { data, images } = stripImage({ tab: t.id, ...(await t.observe(o)) }); return ok(data, images); }));
  server.registerTool('tab_read', { title: 'Read page text', description: 'Linear rendered text of one bounded page scan. No action refs; use tab_observe to act. To continue, pass both readId and nextStart from the previous result, so a changing page cannot shift the offset. When no nextStart remains, scan_limit or unbounded means the scan stopped before the page ended.',
    inputSchema: { tab: z.string().optional().describe('required when the session has more than one tab'), maxChars: z.number().int().min(200).max(80_000).optional().describe('maximum characters in this response (default 60000)'), start: z.number().int().min(0).optional().describe('nextStart from the previous result'), readId: z.string().optional().describe('readId from the same previous result') },
    annotations: { readOnlyHint: true },
  }, async ({ tab, maxChars, start, readId }) => run(async () => { const t = await tabOf(tab); return ok({ tab: t.id, ...(await t.read({ maxChars, start, readId })) }); }));
  server.registerTool('tab_find', { title: 'Find page elements', description: 'Use query to search the action map by accessible text and get replayable refs plus ancestor context; or use target to inspect exact locator candidates with the same engine as tab_act. Pass exactly one.',
    inputSchema: { tab: z.string().optional(), query: z.string().min(1).optional(), target: targetSchema.optional(), limit: z.number().int().min(1).max(50).default(20) }, annotations: { readOnlyHint: true },
  }, async ({ tab, query, target, limit }) => run(async () => {
    if (Boolean(query) === Boolean(target)) throw new ActionError('invalid_args', 'tab_find needs exactly one of query or target.');
    const t = await tabOf(tab);
    return ok({ tab: t.id, result: await t.find(query ? { query, limit } : { ...target, limit } as Parameters<Tab['find']>[0]) });
  }));
  const networkTool = server.registerTool('network_inspect', { title: 'Inspect captured requests', description: 'list returns compact request summaries; detail returns headers and a bounded request or response body for one seq. Capture starts when a session tab is attached. Use list after the page performs the operation, then detail on the relevant seq. Copy body.nextStart to continue reading.',
    inputSchema: { tab: z.string().optional(), action: z.enum(['list', 'detail']).default('list'), filter: z.string().optional().describe('URL substring for list'), afterSequence: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).default(30), seq: z.number().int().positive().optional().describe('required for detail; copy from list'), part: z.enum(['request', 'response']).default('response'), start: z.number().int().min(0).default(0), maxChars: z.number().int().min(200).max(100_000).default(8_000) }, annotations: { readOnlyHint: true },
  }, async ({ tab, action, filter, afterSequence, limit, seq, part, start, maxChars }) => run(async () => {
    if (!rt.hasFeature('network')) throw new ActionError('capability_unavailable', 'The connected extension does not advertise Network capture.', 'Run doctor to inspect its features and update the extension.');
    const t = await tabOf(tab);
    if (action === 'list') return ok({ tab: t.id, ...(await t.network.list({ filter, afterSequence, limit })) });
    if (seq === undefined) throw new ActionError('invalid_args', 'detail requires seq.', 'Call network_inspect action:list and copy an entry seq.');
    return ok({ tab: t.id, ...(await t.network.detail({ seq, part, start, maxChars })) });
  }));
  if (!rt.hasFeature('network')) networkTool.disable();
  const downloadTool = server.registerTool('tab_download_wait', { title: 'Wait for a download', description: 'Wait for the download begun after one tab_act. Copy download.afterSequence from that action and use the same tab. downloaded:true means Chrome completed the file; not_started, unconfirmed, ambiguous, and cursor_expired do not prove completion.',
    inputSchema: { tab: z.string().optional().describe('same page handle used by tab_act; required when the session has multiple tabs'), afterSequence: z.number().int().min(0).describe('download.afterSequence from tab_act'), timeoutMs: z.number().int().min(1).max(120_000).default(30_000) }, annotations: { readOnlyHint: true },
  }, async ({ tab, afterSequence, timeoutMs }) => run(async () => {
    const t = await tabOf(tab);
    return ok({ tab: t.id, ...(await t.download(afterSequence, timeoutMs)) });
  }));
  if (!rt.hasFeature('downloads')) downloadTool.disable();
  const consoleTool = server.registerTool('console_read', { title: 'Read console messages', description: 'Console messages the tab logged since capture started (when the tab was attached), oldest first. Pass cursor from the previous result as afterSequence to read only newer ones.',
    inputSchema: { tab: z.string().optional().describe('required when the session has more than one tab'), levels: z.array(z.enum(['debug', 'info', 'log', 'warn', 'error'])).optional().describe('default: every level'), filter: z.string().optional().describe('substring of the message'), afterSequence: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(500).default(100) }, annotations: { readOnlyHint: true },
  }, async ({ tab, levels, filter, afterSequence, limit }) => run(async () => {
    const t = await tabOf(tab);
    return ok({ tab: t.id, ...(await t.console.read({ levels, filter, afterSequence, limit })) });
  }));
  if (!rt.hasFeature('console')) consoleTool.disable();
  server.registerTool('page_request', { title: 'Request with the page session', description: 'Send one HTTP request from the tab\'s page with its cookies and login session, as the page\'s own code would. values names where session values live in the page (localStorage:<key>, localStorage:<key>#<field>, sessionStorage:<key>, cookie:<name>); write ${name} in path, query, headers or body to use them. Values named in secrets are masked (******) in the returned text and url and never leave the page. Without path, only checks every value resolves. session_missing means the page is not logged in; request_failed means no attempt got a response. HTTP error statuses are ordinary results.',
    inputSchema: {
      tab: z.string().optional().describe('required when the session has more than one tab'),
      values: z.record(z.string(), z.string()).default({}),
      secrets: z.array(z.string()).default([]),
      method: z.string().default('GET'),
      path: z.string().optional().describe('path or URL, resolved against the page origin'),
      query: z.record(z.string(), z.unknown()).optional(),
      headers: z.record(z.string(), z.string()).optional(),
      body: z.unknown().optional().describe('sent as JSON'),
      timeoutMs: z.number().int().min(100).max(600_000).default(30_000).describe('per attempt'),
      attempts: z.number().int().min(1).max(5).default(1).describe('502/503/504 and network errors are retried'),
      maxChars: z.number().int().min(200).max(1_000_000).default(200_000),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  }, async ({ tab, values, secrets, method, path, query, headers, body, timeoutMs, attempts, maxChars }) => run(async () => {
    const t = await tabOf(tab);
    const request = path === undefined ? undefined : { method, path, ...(query && { query }), ...(headers && { headers }), ...(body !== undefined && { body }) };
    return ok({ tab: t.id, ...(await t.request({ values, secrets, request, timeoutMs, attempts, maxChars })) });
  }));
  const onFeaturesChanged = (): void => {
    if (networkTool.enabled !== rt.hasFeature('network')) networkTool.update({ enabled: rt.hasFeature('network') });
    if (consoleTool.enabled !== rt.hasFeature('console')) consoleTool.update({ enabled: rt.hasFeature('console') });
    if (downloadTool.enabled !== rt.hasFeature('downloads')) downloadTool.update({ enabled: rt.hasFeature('downloads') });
    if (server.isConnected()) server.sendResourceListChanged();
  };
  if (persistent) rt.on('features-changed', onFeaturesChanged);
  server.registerTool('tab_act', { title: 'Act on a tab', description: 'One action. The result separates input delivery from verified control state. openedTabs identifies popups seen during the action: use tab directly, or match tabId in tab_list when pending:true. If expecting a download, pass download.afterSequence to tab_download_wait. A click does not prove the site completed the task; check the cheapest authoritative state with tab_expect or tab_observe. If an action has no effect, inspect before retrying. method:"dom" is a click-only fallback after not_delivered or no box.',
    inputSchema: actionSchema,
    annotations: { destructiveHint: true, openWorldHint: true },
  }, async (input) => run(async () => {
    const { tab, action, target, to, observe, value, files, direction, amount, settleMs, method, intent, step } = input as unknown as ActToolInput & StepMeta & { tab?: string; observe?: boolean; settleMs?: number };
    const checked = checkActInput({ action: action as ActAction, target, to, value, files, direction, amount, method });
    const t = await tabOf(tab);
    const r = await t.act({ action: action as ActAction, target: checked.target, to: checked.to, value, files, direction, amount, settleMs, method: checked.method, intent, step });
    if (!observe) return ok({ tab: t.id, ...r });
    try {
      const { data, images } = stripImage({ tab: t.id, ...r, after: await t.observe() });
      return ok(data, images);
    } catch (error) {
      // The input has already reached the page. A failed follow-up read must not invite another submission.
      return ok({ tab: t.id, ...r, observationError: errorEnvelope(error).error, hint: 'Action already delivered. Observe read-only for the current state; do not replay the action.' });
    }
  }));
  server.registerTool('tab_expect', { title: 'Expect', description: 'Assert what the page must show now. At least one of text / notText / url / title / selector / ref is required (visible:false requires absence, and needs selector or ref). value, count, enabled, checked and hasText check the selector/ref match (count: exact number of matches; the others: the first visible match). Polls up to timeout seconds; fails with expectation_failed.',
    inputSchema: { tab: z.string().optional().describe('required when the session has more than one tab'), text: z.string().optional(), notText: z.string().optional(), url: z.string().optional(), title: z.string().optional(), selector: z.string().optional(), ref: z.string().optional(), visible: z.boolean().optional().describe('with selector or ref; false requires absence'),
      value: z.string().optional().describe('input/textarea/contenteditable value equals'), count: z.number().int().min(0).optional().describe('exact number of matching elements'), enabled: z.boolean().optional(), checked: z.boolean().optional(), hasText: z.string().optional().describe('element text includes'),
      timeout: z.number().default(5), ...stepMeta }, annotations: { readOnlyHint: true } },
    async ({ tab, timeout, intent, step, ...what }) => run(async () => { checkExpect(what); const t = await tabOf(tab); return ok({ tab: t.id, ...(await t.expect(what, { timeoutMs: timeout * 1000, intent, step })) }); }));

  // ── flows: journal, replay, locators, network assertions, suites, plans ──
  server.registerTool('journal', { title: 'Step journal', description: 'This session\'s recorded steps (tab_open/goto/act/expect, site_run, network_expect, flow_run), each with its intent and a replayable form that uses durable locators, never eN refs. read: entries after since. export: a flow of the successful replayable steps (format flow) or a @playwright/test spec (format playwright); save:true also writes it under ~/.opencli-mcp/flows/. clear: empty it.',
    inputSchema: { action: z.enum(['read', 'export', 'clear']).default('read'), since: z.number().int().min(0).optional().describe('journal cursor (e.g. journalFrom of flow_run); only later entries'), limit: z.number().int().min(1).max(1000).default(100),
      format: z.enum(['flow', 'playwright']).default('flow'), name: z.string().max(120).optional().describe('flow name (export)'), case: z.string().optional().describe('plan case id the flow implements'), site: z.string().optional(), seed: webSeedSchema.optional(), save: z.boolean().default(false) },
  }, async ({ action, since, limit, format, name, case: caseId, site, seed, save }) => run(async () => {
    const journal = state.journal;
    if (!journal) throw new ActionError('journal_unavailable', 'This session keeps no journal.');
    if (action === 'clear') return ok({ cleared: journal.clear(), cursor: journal.cursor });
    if (action === 'read') return ok(journal.read({ since, limit }));
    if (!name) throw new ActionError('invalid_args', 'export needs name.', 'Name the flow after the case or task, e.g. "ai-image-generate".');
    const { flow, skipped } = journal.toFlow({ name, since, case: caseId, site, seed });
    if (!flow.steps.length) throw new ActionError('journal_empty', 'No successful replayable steps to export.', 'Perform the steps with tab_act/tab_expect (pass intent), then export; journal read shows why steps were skipped.', { details: { skipped } });
    const text = format === 'playwright' ? flowToPlaywright(flow) : `${JSON.stringify(flow, null, 2)}\n`;
    const file = save ? writeFile(flowsDir(), `${safeName(name)}${format === 'playwright' ? '.spec.ts' : '.flow.json'}`, text) : undefined;
    return ok({ format, ...(format === 'flow' ? { flow } : { code: text }), steps: flow.steps.length, skipped, ...(file && { file }), cursor: journal.cursor });
  }));

  const loadFlow = (flow: unknown, name?: string): WebFlow => {
    if ((flow === undefined) === (name === undefined)) throw new ActionError('invalid_args', 'Pass exactly one of flow or name.');
    const parsed = webFlowSchema.safeParse(flow ?? readSavedFlow(name!));
    if (!parsed.success) throw new ActionError('invalid_flow', 'The flow does not match the flow format.', 'docs_get {name:"flows"} describes it.', { details: { issues: parsed.error.issues.slice(0, 10).map((i) => ({ path: i.path.join('.'), message: i.message })) } });
    return parsed.data;
  };
  server.registerTool('flow_run', { title: 'Replay a flow', description: 'Replay a recorded web flow (flow object or a saved name) step by step with the same engine as tab_act/tab_expect. On a failing step the run pauses: the tab stays in the session and the result has the error, page state, console errors, recent requests and resume {from, retry}. Repair with the usual tools (the step\'s intent keeps the journal aligned), then call again with from. Write site commands pause with write_blocked unless allowWrites. Replayed steps are journaled; journal export {since: journalFrom} returns the repaired flow.',
    inputSchema: { flow: z.unknown().optional().describe('flow object (see docs flows)'), name: z.string().optional().describe('saved flow name'), tab: z.string().optional().describe('existing session tab to run in; default: the seed url or first goto opens one'),
      from: z.number().int().min(0).optional(), until: z.number().int().min(0).optional(), allowWrites: z.boolean().default(false), skipSeed: z.boolean().default(false),
      vars: z.record(z.string(), z.unknown()).default({}).describe('values for ${name} placeholders (masked credentials, ids)'), stepTimeout: z.number().min(1).max(120).optional().describe('seconds per step (default 10)') },
    annotations: { destructiveHint: true, openWorldHint: true },
  }, async ({ flow, name, tab, from, until, allowWrites, skipSeed, vars, stepTimeout }, ctx) => run(async () => {
    const f = loadFlow(flow, name);
    const b = await api.agent.browsers.getDefault();
    const extra = ctxExtra(ctx);
    const report = await runFlow(f, {
      openTab: (url, meta) => b.tabs.new(url, meta),
      runSite: async (site, command, args, meta) => { const r = await siteCall(site, command, args, extra, meta); return r.rows !== undefined ? { rows: r.rows } : r.value; },
      access: async (site, command) => (await rt.registry.resolve(site, command).catch(() => undefined))?.access,
      journal: state.journal, signal: extra.signal,
    }, { tab: tab ? b.tabs.get(tab) : undefined, from, until, allowWrites, skipSeed, vars, stepTimeoutMs: stepTimeout !== undefined ? stepTimeout * 1000 : undefined });
    return report.status === 'passed' ? ok(report) : { ...ok(report), isError: true };
  }));
  server.registerTool('flows_list', { title: 'List saved flows', description: 'Names of flows saved with journal export save:true (run them with flow_run {name}).', inputSchema: {}, annotations: { readOnlyHint: true } }, async () => run(async () => ok({ dir: flowsDir(), flows: listSavedFlows() })));

  server.registerTool('tab_locator', { title: 'Locator candidates', description: 'Durable locators for one element, most durable first (testid, stable id, href, name, role+name, label, placeholder, text, generated), each run through the engine: matches, unique and sameElement say whether it still finds exactly this element. Use it to repair a failed flow step or to choose a stable target.',
    inputSchema: { tab: z.string().optional(), target: targetSchema }, annotations: { readOnlyHint: true },
  }, async ({ tab, target }) => run(async () => {
    const t = await tabOf(tab);
    const checked = checkActInput({ action: 'click', target });
    return ok({ tab: t.id, ...(await locatorCandidates(t, checked.target!)) });
  }));

  const networkExpectTool = server.registerTool('network_expect', { title: 'Expect a request', description: 'Wait until a captured request to url (substring) after afterSequence matches method/status and JSON assertions on its request and response bodies (SSE responses parse to {events:[{event,data}]}). Paths: a.b, a[0], a[*].b, a[?k=v]; operators equals, notEquals, exists, type, minItems, maxItems, contains, matches, jsonHas. Pass the afterSequence of the tab_act that should send it. Returns the matching seq (network_inspect detail shows it in full); fails with expectation_failed and the closest candidates.',
    inputSchema: { tab: z.string().optional(), ...networkMatchSchema.shape, afterSequence: z.number().int().min(0).optional().describe('network.afterSequence from the tab_act that sends the request'), timeout: z.number().min(0.5).max(120).default(10), ...stepMeta },
    annotations: { readOnlyHint: true },
  }, async ({ tab, url, method, status, request, response, afterSequence, timeout, intent, step }, ctx) => run(async () => {
    if (!rt.hasFeature('network')) throw new ActionError('capability_unavailable', 'The connected extension does not advertise Network capture.', 'Run doctor to inspect its features and update the extension.');
    const t = await tabOf(tab);
    const match = { url, ...(method && { method }), ...(status !== undefined && { status }), ...(request && { request }), ...(response && { response }) };
    const evidence = await journaled(state.journal, { tab: t.id, intent, step }, () => networkExpect(t, match, { afterSequence, timeoutMs: timeout * 1000, signal: ctxExtra(ctx).signal }), () => ({ record: { do: 'network', match, timeout } }), { do: 'network', match, timeout });
    return ok({ tab: t.id, ...evidence });
  }));
  if (!rt.hasFeature('network')) networkExpectTool.disable();

  server.registerTool('suite_run', { title: 'Run a site regression suite', description: 'Run <site>/suite.json: fixed requests to the endpoints the site\'s commands depend on, sent from a logged-in page of the site (page_request rules: session values, masked secrets) and judged by code. Uses tab (already on the site) or opens origin + the suite page. Returns per-check results, failures with path/op/expected/actual, skipped checks (missing capture) and affectedAdapters. Some checks may be writes the suite marks as probes; read the suite before running it against production.',
    inputSchema: { site: z.string(), tab: z.string().optional().describe('a session tab already on the site'), origin: z.string().optional().describe('front end to test, e.g. https://testm.example.com; opens origin + suite page in a new tab'),
      only: z.array(z.string()).optional().describe('check ids'), adapters: z.array(z.string()).optional().describe('only checks that these commands depend on'), timeout: z.number().min(1).max(120).default(30).describe('seconds per request') },
    annotations: { openWorldHint: true },
  }, async ({ site, tab, origin, only, adapters, timeout }, ctx) => run(async () => {
    const found = rt.registry.suite(site);
    if (!found) throw new ActionError('suite_not_found', `site "${site}" has no suite.json`, 'sites_search lists sites; a suite lives in <site>/suite.json of an adapter source.');
    const suite = parseSuite(found.suite);
    if (!tab && !origin) throw new ActionError('invalid_args', 'Pass tab (on the site) or origin.', 'origin is the front end under test; the suite page is opened there.');
    const b = await api.agent.browsers.getDefault();
    let t: Tab;
    if (tab) t = b.tabs.get(tab);
    else {
      let start: string;
      try { start = new URL(suite.page ?? '/', origin).href; } catch { throw new ActionError('invalid_url', `origin ${origin} is not a URL`); }
      t = await b.tabs.new(start);
    }
    const report = await runSuite(t, suite, { only, adapters, timeoutMs: timeout * 1000, signal: ctxExtra(ctx).signal });
    return { ...ok({ tab: t.id, source: found.source, ...report }), ...(report.failed > 0 && { isError: true }) };
  }));

  server.registerTool('plan_save', { title: 'Save a test plan', description: 'Validate a structured test plan (suites → cases → steps with perform and expect[{kind: page|server|network, text}], optional seed and write budget) and save it as JSON and Markdown under ~/.opencli-mcp/plans/. Case ids (e.g. "1.2") are what flows reference as case; step ids are what intent-carrying calls pass as step.',
    inputSchema: { fileName: z.string().max(120), plan: planSchema },
  }, async ({ fileName, plan }) => run(async () => {
    const base = safeName(fileName);
    const json = writeFile(plansDir(), `${base}.json`, `${JSON.stringify(plan, null, 2)}\n`);
    const md = writeFile(plansDir(), `${base}.md`, planMarkdown(plan));
    return ok({ files: { json, markdown: md }, suites: plan.suites.length, cases: plan.suites.reduce((n, s) => n + s.cases.length, 0) });
  }));

  // ── sites ──
  server.registerTool('sites_search', { title: 'Find site capabilities', description: 'No query: list available sites with sample commands. With a task, site, or domain as query: find matching commands. Results include args[{name,type,required,help,default,choices}] for site_run. Do not invent parameters.', inputSchema: { query: z.string().optional().describe('task, site, or domain; omit to browse available sites'), limit: z.number().int().min(1).max(100).default(20) }, annotations: { readOnlyHint: true } }, async ({ query, limit }) => run(async () => query?.trim() ? ok({ results: await api.sites.search(query, limit) }) : ok({ sites: rt.registry.sites().slice(0, limit) })));
  server.registerTool('site_run', { title: 'Run a site command', description: 'Run one site command. args must match the args list from sites_search. Invalid args return invalid_args with details.expected. Valid commands execute directly, including writes.', inputSchema: { site: z.string(), command: z.string(), args: z.record(z.string(), z.unknown()).default({}), ...stepMeta }, annotations: { openWorldHint: true } }, async ({ site, command, args, intent, step }, extra) => run(() => runSiteWithProgress(site, command, args, ctxExtra(extra), { intent, step })));

  // ── capabilities ──

  // ── recon & tools ──
  const valueDef: z.ZodType<import('opencli-mcp/adapter-sdk').ArgValue> = z.lazy(() => z.object({
    type: z.enum(['string', 'int', 'number', 'boolean', 'array', 'object']).optional(), nullable: z.boolean().optional(),
    choices: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
    items: valueDef.optional(), properties: z.record(z.string(), valueDef.and(z.object({ required: z.boolean().optional(), help: z.string().optional() }))).optional(),
    min: z.number().optional(), max: z.number().optional(), minLength: z.number().int().min(0).optional(), maxLength: z.number().int().min(0).optional(), example: z.unknown().optional(),
  }));
  const argDef = valueDef.and(z.object({ name: z.string(), default: z.unknown().optional(), required: z.boolean().optional(), help: z.string().optional() }));
  server.registerTool('tools_define', { title: 'Draft a site adapter', description: 'Read docs_get {name:"define-tools"} before authoring. Create an inactive draft of a host-side JavaScript adapter. `func` is the source of `async ({ tab, args, sites, recon }) => {…}`. Then run tools_try with real sample args and an output assertion; tools_activate publishes a passing draft.',
    inputSchema: { site: z.string(), name: z.string(), description: z.string(), access: z.enum(['read', 'write']), domain: z.string().optional(), result: z.object({ kind: z.enum(['rows', 'value']), description: z.string(), fields: z.record(z.string(), z.string()).optional(), paginated: z.boolean().optional() }).optional(), args: z.array(argDef).optional(), func: z.string() },
  }, async (def) => run(async () => {
    const draft = await api.tools.define(def);
    return ok({ ...draft, status: 'draft', next: { tool: 'tools_try', requiredArgs: argSpec(def.args).filter((a) => a.required).map((a) => a.name), note: 'Provide real sample args and an assertion on the returned value or row count. The active adapter is unchanged.' } });
  }));
  server.registerTool('tools_try', { title: 'Verify an adapter draft', description: 'Execute an inactive adapter draft against the real logged-in site and assert its output. This may perform writes when the draft is a write command. A passing trial makes the draft eligible for tools_activate; inspect the returned result before activating.',
    inputSchema: { draftId: z.string().uuid(), args: z.record(z.string(), z.unknown()).default({}), expect: z.object({ path: z.string().optional().describe('dot path in rows or value, e.g. rows.0.id or value.success'), equals: z.unknown().optional().describe('expected value at path; omit to assert existence'), minRows: z.number().int().min(1).optional() }) }, annotations: { openWorldHint: true },
  }, async ({ draftId, args, expect }) => run(async () => {
    const trial = await api.tools.try(draftId, args, expect);
    return ok({ ...trial, next: trial.verification.passed ? { tool: 'tools_activate', draftId, note: 'Inspect the trial result before publishing.' } : { tool: 'tools_try', draftId, note: 'Revise the draft or use a different assertion; a failed trial cannot be activated.' } });
  }));
  server.registerTool('tools_activate', { title: 'Activate a verified adapter', description: 'Atomically publish a draft that passed tools_try. It becomes available through site_run; enabled site tools receive a tool-list change.',
    inputSchema: { draftId: z.string().uuid() },
  }, async ({ draftId }) => run(async () => {
    const active = await api.tools.activate(draftId);
    await syncSiteTools();
    return ok({ ...active, status: 'active', next: { tool: 'site_run', note: 'The verified adapter is now available.' } });
  }));
  server.registerTool('tools_discard', { title: 'Discard an adapter draft', description: 'Delete an inactive adapter draft without changing the active adapter.',
    inputSchema: { draftId: z.string().uuid() },
  }, async ({ draftId }) => run(async () => ok(api.tools.discard(draftId))));

  // ── docs ──
  server.registerTool('docs_list', { title: 'List docs', description: 'Documentation available for this backend.', inputSchema: {}, annotations: { readOnlyHint: true } }, async () => run(async () => ok({ docs: listDocs(docCtx()).filter((d) => d.available).map(({ name, mode, description }) => ({ name, mode, description })) })));
  server.registerTool('docs_get', { title: 'Read a doc', description: 'Read an available documentation page by name (see docs_list).', inputSchema: { name: z.string() }, annotations: { readOnlyHint: true } }, async ({ name }) => run(async () => {
    if (!listDocs(docCtx()).some((entry) => entry.name === name && entry.available)) throw new ActionError('unknown_doc', `no available doc "${name}"`, 'Call docs_list to see docs for the connected runtime.');
    const d = readDocForContext(name, docCtx());
    if (!d) throw new ActionError('unknown_doc', `no doc "${name}"`, 'Call docs_list to see available docs.');
    return ok(d);
  }));

  // ── code mode ──
  const jsGlobals = { agent: api.agent, browser: api.agent.browser, sites: api.sites, recon: api.recon, tools: api.tools, session: api.session, Tab };
  server.registerTool('js', {
    title: 'JavaScript session', description: 'Host-side JavaScript against the object model, not page JavaScript. Page scripts go through tab.evaluate. Pre-bound: browser, agent, sites, recon, tools, session. Top-level const/let persist; function declarations do not. Use const fn = (...) => ... for reusable helpers. The last expression is returned. Batch loops in one js call; browser.user.closeTabs(ids) closes explicit user-tab ids. User-tab lookup: browser.user.openTabs({query,limit}). For the full API, call docs_get {name:"api-reference"} when needed.',
    inputSchema: { code: z.string(), timeoutMs: z.number().int().max(1_800_000).default(300_000) },
    annotations: { openWorldHint: true, destructiveHint: true },
  }, async ({ code, timeoutMs }) => run(async () => {
    if (!state.js) state.js = new JsSession(jsGlobals);
    const r = await state.js.run(code, { timeoutMs });
    const content: Content = [];
    if (r.error) {
      // Same coded envelope as every other tool: branchable code/hint/data when the throw was an ActionError, else a generic js_error.
      const e = r.error;
      const env = { ok: false as const, error: { code: e.code ?? 'js_error', message: e.message, ...(e.hint && { hint: e.hint }), ...(e.data && { ...e.data }), ...(!e.code && e.stack && { stack: e.stack }) } };
      content.push(text(safeStringify(env, 120_000)));
    } else if (r.value !== undefined) content.push(text(safeStringify({ ok: true, value: r.value }, 120_000)));
    else content.push(text(safeStringify({ ok: true, value: null }, 120_000)));
    if (r.writes.length) {
      const joined = r.writes.join('\n');
      content.push(text(joined.length > 24_000 ? `${joined.slice(0, 24_000)}\n…(truncated ${joined.length - 24_000} chars)` : joined));
    }
    for (const img of r.images) content.push({ type: 'image', data: img.base64, mimeType: img.mimeType });
    return { content, isError: Boolean(r.error) };
  }));
  server.registerTool('js_reset', { title: 'Reset JavaScript session', description: 'Discard all JavaScript bindings (tabs and browser state are untouched).', inputSchema: {} }, async () => run(async () => { state.js?.reset(); return ok({ reset: true }); }));

  // ── dynamic site tools ──
  const siteTools = new Map<string, { reg: RegisteredTool; metadata: string }>();
  const performSiteToolSync = async (): Promise<void> => {
    const wanted = new Set<string>();
    let changed = false;
    for (const [site, { write }] of state.enabledSites) {
      for (const cmd of await rt.registry.commands(site)) {
        if (!write && cmd.access === 'write') continue;
        const name = `${site}_${cmd.name}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
        wanted.add(name);
        const descriptor = {
          title: `${site} ${cmd.name}`,
          description: `${cmd.description}${cmd.domain ? ` (${cmd.domain})` : ''} [${cmd.access}]${cmd.result ? ` Returns ${cmd.result.kind}: ${cmd.result.description}` : ''}`,
          inputSchema: z.object(argsToShape(cmd.args)).strict(),
          annotations: { readOnlyHint: cmd.access === 'read', destructiveHint: cmd.access === 'write', openWorldHint: true },
          icons: cmd.domain ? [{ src: `https://${cmd.domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '')}/favicon.ico` }] : [],
        };
        const metadata = JSON.stringify({ description: cmd.description, access: cmd.access, domain: cmd.domain, args: cmd.args, result: cmd.result });
        const current = siteTools.get(name);
        if (current) {
          if (current.metadata !== metadata) {
            current.reg.update({ title: descriptor.title, description: descriptor.description, paramsSchema: descriptor.inputSchema, annotations: descriptor.annotations, icons: descriptor.icons });
            current.metadata = metadata;
            changed = true;
          }
          continue;
        }
        const reg = server.registerTool(name, descriptor, async (args, extra) => run(() => runSiteWithProgress(site, cmd.name, args as Record<string, unknown>, ctxExtra(extra))));
        siteTools.set(name, { reg, metadata });
        changed = true;
      }
    }
    for (const [name, { reg }] of siteTools) if (!wanted.has(name)) { reg.remove(); siteTools.delete(name); changed = true; }
    if (changed && server.isConnected()) server.sendToolListChanged();
  };
  let syncTail: Promise<void> = Promise.resolve();
  const syncSiteTools = (): Promise<void> => {
    const next = syncTail.then(performSiteToolSync);
    syncTail = next.catch(() => {});
    return next;
  };
  const onToolsChanged = (): void => { void syncSiteTools().catch((err) => rt.emit('log', `syncSiteTools failed: ${(err as Error).message}`)); };
  if (persistent) rt.on('tools-changed', onToolsChanged);
  const onLog = (msg: string): void => { if (server.isConnected()) void server.sendLoggingMessage({ level: 'info', logger: 'opencli-mcp', data: msg }).catch(() => {}); };
  if (persistent) rt.on('log', onLog);
  const onBrowserEvent = (e: { kind: string; session?: string }): void => {
    if (!server.isConnected()) return;
    if (e.session && e.session !== `mcp:${sessionId}`) return;
    // tabs are not exposed as a resource, so tab events don't change any resource list — just relay them on the browser log channel.
    void server.sendLoggingMessage({ level: 'info', logger: 'browser', data: e }).catch(() => {});
  };
  if (persistent) rt.on('browser-event', onBrowserEvent);
  // sites pre-enabled by config apply to every session
  for (const site of rt.configSites) if (rt.registry.has(site)) state.enabledSites.set(site, { write: rt.configSitesWrite.includes(site) });
  if (state.enabledSites.size) queueMicrotask(onToolsChanged);

  // ── resources ──
  server.registerResource('docs', new ResourceTemplate('opencli://docs/{name}', { list: async () => ({ resources: listDocs(docCtx()).filter((d) => d.available).map((d) => ({ uri: `opencli://docs/${d.name}`, name: d.name, description: d.description, mimeType: 'text/markdown' })) }) }), { title: 'Documentation', description: 'Agent-facing docs' }, async (uri, { name }) => {
    if (!listDocs(docCtx()).some((entry) => entry.name === String(name) && entry.available)) throw new ActionError('unknown_doc', `no available doc "${String(name)}"`);
    return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: readDocForContext(String(name), docCtx()) ?? `no doc ${String(name)}` }] };
  });
  server.registerResource('sites', 'opencli://sites', { title: 'Sites', description: 'All sites with command counts', mimeType: 'application/json' }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(api.sites.list(), null, 2) }] }));
  server.registerResource('site', new ResourceTemplate('opencli://sites/{site}', { list: undefined }), { title: 'Site commands', mimeType: 'application/json' }, async (uri, { site }) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify((await rt.registry.commands(String(site))).map((c) => ({ name: c.name, description: c.description, access: c.access, domain: c.domain, args: c.args, result: c.result })), null, 2) }] }));

  // ── prompts ──
  server.registerPrompt('browse', { title: 'Browse a site for a goal', description: 'Use the browser service to observe, act, verify, and finalize.', argsSchema: { goal: z.string(), url: z.string().optional() } }, ({ goal, url }) => ({ messages: [{ role: 'user', content: { type: 'text', text: `Goal: ${goal}${url ? `\nStart at: ${url}` : ''}\n\n1. Open or claim a tab, then use tab_observe → tab_act → tab_expect as needed.\n2. If a verified site adapter fits this task, you may use site_run instead of repeating the workflow.\n3. Finish with session_finalize, keeping only deliverable/handoff tabs.` } }] }));
  server.registerPrompt('write-tool', { title: 'Turn a flow into a tool', description: 'Explore and verify an API, then define an explicit adapter.', argsSchema: { site: z.string(), goal: z.string() } }, ({ site, goal }) => ({ messages: [{ role: 'user', content: { type: 'text', text: `Create a reusable ${site} adapter for: ${goal}\n\n1. Open the site and perform the flow once. Use network_inspect list/detail and recon.discover(tab) to identify candidate endpoints.\n2. Verify the chosen endpoint through the logged-in page, including authentication, arguments, pagination, and errors.\n3. Read docs_get {name:"define-tools"}, create a draft with tools_define, verify it with tools_try using sample args and an output assertion, then publish with tools_activate.` } }] }));

  return {
    server, api,
    close: async () => { if (!persistent) return; rt.off('tools-changed', onToolsChanged); rt.off('features-changed', onFeaturesChanged); rt.off('log', onLog); rt.off('browser-event', onBrowserEvent); await rt.closeSession(sessionId); },
  };
}
