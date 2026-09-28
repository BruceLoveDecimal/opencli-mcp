/**
 * The CDP backend: the extension's page engine (cdp.ts, world.ts, act.ts) running in Node against a CDP endpoint
 * instead of inside Chrome. The host drives it with the same commands it sends the extension; this module answers
 * them in-process (see src/host/cdp-bridge.ts).
 *
 * Differences from the extension: the browser is the caller's (a headless Chrome, an app's embedded view), not the
 * user's, so there are no user tabs to list or claim, no tab groups, no cursor overlay and no visibility toggle. Every
 * tab a session touches is its own; finalize closes agent-opened tabs. A page endpoint has exactly one page, which
 * `tabs new` adopts (and navigates) instead of opening another.
 */
import type { BrowserEvent, BrowserFeature, Command, Result } from '../../../src/protocol.js';
import * as executor from '../cdp';
import * as identity from '../identity';
import { performAct, ActError } from '../act';
import { evaluateInEngine, evaluateMain, registerFrameTracking, forgetTab as forgetEngineTab } from '../world';
import { CdpConnection, resolveEndpoint } from './connection';
import { ChromeShim, type ShimTab } from './chrome-shim';

export const FEATURES: BrowserFeature[] = ['cdp', 'network', 'frames', 'dialogs', 'console', 'viewport'];

const CDP_ALLOWLIST = new Set([
  'Accessibility.enable', 'Accessibility.getFullAXTree', 'Accessibility.getPartialAXTree',
  'DOM.enable', 'DOM.getDocument', 'DOM.getBoxModel', 'DOM.getContentQuads', 'DOM.focus', 'DOM.querySelector', 'DOM.querySelectorAll', 'DOM.scrollIntoViewIfNeeded', 'DOM.describeNode', 'DOM.getNodeForLocation',
  'DOMSnapshot.captureSnapshot',
  'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText', 'Input.dispatchTouchEvent',
  'Page.getLayoutMetrics', 'Page.captureScreenshot', 'Page.getFrameTree', 'Page.handleJavaScriptDialog', 'Page.getNavigationHistory',
  'Runtime.enable', 'Runtime.getHeapUsage',
  'Emulation.setDeviceMetricsOverride', 'Emulation.clearDeviceMetricsOverride',
  'Network.enable', 'Network.getCookies', 'Performance.getMetrics',
]);

type Origin = 'agent' | 'user';
interface Lease { tabId: number; origin: Origin; mark: 'deliverable' | 'handoff' | null }
interface Session { key: string; surface: 'browser' | 'adapter'; name: string | null; leases: Map<number, Lease>; preferredTabId: number | null }
type ChildTab = { page?: string; tabId: number; url?: string; title?: string; pending?: true };

class BackendError extends Error { constructor(readonly code: string, message: string, readonly hint?: string) { super(message); } }

export interface CdpBackendOptions {
  endpoint: string;
  /** Source of extension/dist/page.js (the page-side engine module). */
  pageModule: string;
  /** Origins pages may navigate to; empty allows every http(s) origin. Navigation elsewhere is blocked in the browser. */
  allowedOrigins?: string[];
  onEvent?: (event: BrowserEvent) => void;
  onClose?: (reason: string) => void;
}

export interface CdpBackend {
  mode: 'browser' | 'page';
  features: BrowserFeature[];
  handle(cmd: Command): Promise<Result>;
  close(): Promise<void>;
}

function originOf(url: string): string | null { try { return new URL(url).origin.toLowerCase(); } catch { return null; } }
function isSafeNavigationUrl(url: string): boolean { return url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:text/html'); }
function normalizeUrl(url?: string): string {
  if (!url) return '';
  try { const p = new URL(url); if ((p.protocol === 'https:' && p.port === '443') || (p.protocol === 'http:' && p.port === '80')) p.port = ''; return `${p.protocol}//${p.host}${p.pathname === '/' ? '' : p.pathname}${p.search}${p.hash}`; } catch { return url; }
}
function commandTimeoutMs(cmd: Command): number | undefined { return cmd.deadlineAt ? Math.max(1000, cmd.deadlineAt - Date.now() - 500) : undefined; }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let active = false;

export async function startCdpBackend(opts: CdpBackendOptions): Promise<CdpBackend> {
  // the engine modules reach the browser through the `chrome` global, so one backend per process
  if (active) throw new Error('a CDP backend is already running in this process');
  const { url, mode } = await resolveEndpoint(opts.endpoint);
  const conn = await CdpConnection.open(url);
  const shim = new ChromeShim(conn, mode);
  shim.setPageModule(opts.pageModule);
  (globalThis as { chrome?: unknown }).chrome = shim.api;
  active = true;
  executor.registerListeners();
  registerFrameTracking();
  shim.api.tabs.onRemoved.addListener((tabId) => { forgetEngineTab(tabId); identity.evictTab(tabId); });
  shim.api.webNavigation.onCommitted.addListener((d) => { if (d.frameId === 0) forgetEngineTab(d.tabId); });
  await shim.init();

  const allowed = new Set((opts.allowedOrigins ?? []).map(originOf).filter((o): o is string => o !== null));
  const allows = (target: string): boolean => allowed.size === 0 || target.startsWith('about:') || target.startsWith('data:') || allowed.has(originOf(target) ?? '');
  const emit = (event: BrowserEvent) => opts.onEvent?.(event);
  conn.onClose((reason) => { active = false; opts.onClose?.(reason); });

  const sessions = new Map<string, Session>();
  const childObservers = new Map<number, Set<(child: Promise<ChildTab | null>) => void>>();
  const guarded = new Set<number>();

  /** Block main-frame navigation to origins outside the allowlist, in the browser itself (links, redirects, scripts). */
  async function guardTab(tab: ShimTab): Promise<void> {
    if (allowed.size === 0 || guarded.has(tab.id)) return;
    guarded.add(tab.id);
    await shim.send(tab.id, 'Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] }).catch(() => guarded.delete(tab.id));
  }
  shim.api.debugger.onEvent.addListener((source, method, params) => {
    if (method !== 'Fetch.requestPaused' || source.tabId === undefined) return;
    const p = params as { requestId: string; request: { url: string } };
    const debuggee = source.sessionId ? { tabId: source.tabId, sessionId: source.sessionId } : { tabId: source.tabId };
    const reply = allows(p.request.url)
      ? shim.api.debugger.sendCommand(debuggee, 'Fetch.continueRequest', { requestId: p.requestId })
      // Aborted cancels the navigation and keeps the current document; BlockedByClient would replace it with an error page
      : shim.api.debugger.sendCommand(debuggee, 'Fetch.failRequest', { requestId: p.requestId, errorReason: 'Aborted' });
    void reply.catch(() => {});
  });

  // popups: a new tab whose opener is a session tab joins that session, and the running action reports it
  shim.onTabCreated.addListener((tab) => {
    void guardTab(tab);
    if (!tab.openerTargetId) return;
    const sourceId = [...shim.tabs.values()].find((t) => t.targetId === tab.openerTargetId)?.id;
    if (sourceId === undefined) return;
    const owner = ownerOf(sourceId);
    if (owner) {
      owner.leases.set(tab.id, { tabId: tab.id, origin: 'agent', mark: null });
      emit({ kind: 'tab_created', session: owner.key, page: tab.targetId, tabId: tab.id, url: tab.url, origin: 'agent' });
    }
    for (const observe of childObservers.get(sourceId) ?? []) observe(Promise.resolve({ page: tab.targetId, tabId: tab.id, url: tab.pendingUrl ?? tab.url, title: tab.title }));
  });
  shim.api.tabs.onRemoved.addListener((tabId) => {
    guarded.delete(tabId);
    for (const s of sessions.values()) if (s.leases.delete(tabId) && s.preferredTabId === tabId) s.preferredTabId = null;
  });

  function sessionFor(cmd: Command): Session {
    const key = cmd.session ?? 'default';
    let s = sessions.get(key);
    if (!s) { s = { key, surface: cmd.surface ?? 'browser', name: null, leases: new Map(), preferredTabId: null }; sessions.set(key, s); }
    return s;
  }
  function ownerOf(tabId: number): Session | null { for (const s of sessions.values()) if (s.leases.has(tabId)) return s; return null; }
  /** An adapter session using the single page of a page endpoint without owning it. */
  function borrows(s: Session, tabId: number): boolean { return mode === 'page' && s.surface === 'adapter' && s.preferredTabId === tabId && !s.leases.has(tabId); }

  async function lease(s: Session, url?: string): Promise<ShimTab> {
    let tab: ShimTab;
    if (mode === 'page') {
      tab = shim.tabs.get(1)!;
      const owner = ownerOf(tab.id);
      if (owner && owner !== s) {
        // site commands (adapter sessions) borrow the one page the agent is using; they never own or close it
        if (s.surface !== 'adapter') throw new BackendError('page_not_in_session', `the page belongs to session ${owner.key}`, 'This endpoint has one page; finalize the other session first.');
        s.preferredTabId = tab.id;
        if (url) {
          const result = await navigate(tab.id, url);
          if (result.error) throw new BackendError('page_not_loaded', `navigation to ${url} did not load: ${result.error}`, 'Check that the URL is reachable from this browser and allowed for this session.');
        }
        return tab;
      }
    } else {
      tab = await shim.createTab();
    }
    await guardTab(tab);
    // attach as a browser surface first: that arms request capture from the first navigation on
    await executor.ensureAttached(tab.id, s.surface === 'browser');
    s.leases.set(tab.id, { tabId: tab.id, origin: 'agent', mark: null });
    s.preferredTabId = tab.id;
    emit({ kind: 'tab_created', session: s.key, page: tab.targetId, tabId: tab.id, url: tab.url, origin: 'agent' });
    if (url) {
      const result = await navigate(tab.id, url);
      if (result.error) {
        if (mode === 'browser') await endTab(s, tab.id, 'close').catch(() => {});
        throw new BackendError('page_not_loaded', `navigation to ${url} did not load: ${result.error}`, 'Check that the URL is reachable from this browser and allowed for this session.');
      }
    }
    return tab;
  }

  async function resolveTab(s: Session, page?: string): Promise<number> {
    if (page) {
      let tabId: number;
      try { tabId = await identity.resolveTabId(page); } catch { throw new BackendError('stale_page', `stale page identity ${page}`, 'The tab was closed; open a fresh tab.'); }
      if (!s.leases.has(tabId) && !borrows(s, tabId)) throw new BackendError('page_not_in_session', `page ${page} is not controlled by this session`, 'List tabs, then open the intended tab.');
      s.preferredTabId = tabId;
      return tabId;
    }
    if (s.preferredTabId !== null && shim.tabs.has(s.preferredTabId)) return s.preferredTabId;
    for (const l of s.leases.values()) { s.preferredTabId = l.tabId; return l.tabId; }
    if (s.surface === 'adapter') return (await lease(s)).id;
    throw new BackendError('no_tab', 'No tab is controlled by this session', 'Use tab_open before a browser operation.');
  }

  async function endTab(s: Session, tabId: number, op: 'close' | 'release'): Promise<{ page: string; closed: boolean; released: boolean }> {
    const l = s.leases.get(tabId);
    if (!l) throw new BackendError('page_not_in_session', `tab ${tabId} is not controlled by this session`);
    const page = await identity.resolveTargetId(tabId).catch(() => String(tabId));
    s.leases.delete(tabId);
    if (s.preferredTabId === tabId) s.preferredTabId = null;
    // the single page of a page endpoint belongs to the embedding app: it is released, never closed
    if (op === 'close' && mode === 'browser') {
      await shim.closeTab(tabId).catch((error: unknown) => { if (shim.tabs.has(tabId)) { s.leases.set(tabId, l); throw new BackendError('tab_close_failed', `Could not close tab ${tabId}: ${String(error)}`); } });
      emit({ kind: 'tab_closed', session: s.key, page, tabId, origin: l.origin });
      return { page, closed: true, released: false };
    }
    emit({ kind: 'tab_released', session: s.key, page, tabId, origin: l.origin });
    return { page, closed: false, released: true };
  }

  async function finalize(s: Session, keep: Array<{ page: string; status: 'deliverable' | 'handoff' }>): Promise<{ closed: string[]; kept: string[]; failed: Array<{ page: string; reason: string }> }> {
    const closed: string[] = []; const kept: string[] = []; const failed: Array<{ page: string; reason: string }> = [];
    const keepByTab = new Map<number, 'deliverable' | 'handoff'>();
    for (const k of keep) { try { keepByTab.set(await identity.resolveTabId(k.page), k.status); } catch { /* gone */ } }
    for (const l of [...s.leases.values()]) {
      const status = keepByTab.get(l.tabId) ?? l.mark;
      try {
        const r = await endTab(s, l.tabId, status ? 'release' : 'close');
        (r.closed ? closed : kept).push(r.page);
      } catch (error) { failed.push({ page: String(l.tabId), reason: error instanceof Error ? error.message : String(error) }); }
    }
    s.preferredTabId = null;
    if (s.leases.size === 0) sessions.delete(s.key);
    if (failed.length === 0) emit({ kind: 'session_released', session: s.key, reason: 'finalize' });
    return { closed, kept, failed };
  }

  async function withChildTabs<T>(sourceTabId: number, action: () => Promise<T>): Promise<{ result?: T; error?: unknown; openedTabs: ChildTab[] }> {
    const children: Array<Promise<ChildTab | null>> = [];
    const observe = (child: Promise<ChildTab | null>) => { children.push(child); };
    if (!childObservers.has(sourceTabId)) childObservers.set(sourceTabId, new Set());
    childObservers.get(sourceTabId)!.add(observe);
    try {
      let result: T | undefined; let error: unknown;
      try { result = await action(); } catch (caught) { error = caught; }
      const openedTabs = (await Promise.all(children)).filter((child): child is ChildTab => child !== null);
      return { result, error, openedTabs };
    } finally {
      childObservers.get(sourceTabId)?.delete(observe);
    }
  }

  async function waitForLoad(tabId: number, timeoutMs: number): Promise<ShimTab | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const tab = shim.tabs.get(tabId);
      if (!tab || (tab.status === 'complete' && tab.url)) return tab;
      if (Date.now() > deadline) return tab;
      await sleep(50);
    }
  }

  async function isErrorDocument(tabId: number): Promise<string | null> {
    try {
      const uri = await executor.evaluate(tabId, 'document.documentURI', false, 2_000);
      return typeof uri === 'string' && uri.startsWith('chrome-error://') ? uri : null;
    } catch { return null; }
  }

  /** Page.navigate plus a bounded wait for the load; `error` is set when the document did not load. */
  async function navigate(tabId: number, target: string): Promise<{ error?: string; timedOut: boolean }> {
    if (!allows(target)) return { error: `${originOf(target) ?? target} is not an allowed origin for this browser`, timedOut: false };
    const nav = await shim.send<{ errorText?: string; loaderId?: string }>(tabId, 'Page.navigate', { url: target });
    if (nav.errorText) return { error: nav.errorText, timedOut: false };
    if (!nav.loaderId) return { timedOut: false }; // same-document navigation: nothing to load
    const tab = shim.tabs.get(tabId);
    if (tab) tab.status = 'loading';
    const loaded = await waitForLoad(tabId, 15_000);
    const errDoc = await isErrorDocument(tabId);
    if (errDoc) return { error: `the browser shows its error page (${errDoc})`, timedOut: false };
    return { timedOut: loaded?.status !== 'complete' };
  }

  async function pageScoped(id: string, tabId: number, data: unknown): Promise<Result> {
    const page = await identity.resolveTargetId(tabId).catch(() => undefined);
    return { id, ok: true, data, page };
  }

  function errorResult(id: string, err: unknown): Result {
    if (err instanceof BackendError) return { id, ok: false, error: err.message, errorCode: err.code, errorHint: err.hint };
    if (err instanceof ActError) return { id, ok: false, error: err.message, errorCode: err.code, errorHint: err.hint, data: err.extra };
    const e = err as { message?: string; code?: string; hint?: string; dialog?: unknown };
    const message = e?.message ?? String(err);
    const code = e?.code ?? (/No tab with id|no longer exists/i.test(message) ? 'stale_page' : 'command_failed');
    return { id, ok: false, error: message, errorCode: code, errorHint: e?.hint, ...(e?.dialog ? { data: { dialog: e.dialog } } : {}) };
  }

  const unsupported = (id: string, what: string): Result => ({ id, ok: false, error: `${what} is not available with a CDP endpoint`, errorCode: 'not_supported', errorHint: 'This browser is not the user\'s Chrome: open tabs with tab_open instead.' });

  async function handle(cmd: Command): Promise<Result> {
    const s = sessionFor(cmd);
    const aggressive = s.surface === 'browser';
    try {
      switch (cmd.action) {
        case 'ping': return { id: cmd.id, ok: true, data: { pong: true, version: 'cdp' } };
        case 'exec': {
          if (!cmd.code) return { id: cmd.id, ok: false, error: 'Missing code' };
          const tabId = await resolveTab(s, cmd.page);
          if (cmd.world === 'engine') return pageScoped(cmd.id, tabId, await evaluateInEngine(tabId, cmd.code, aggressive, commandTimeoutMs(cmd)));
          if (cmd.frameIndex != null) {
            const frames = await executor.listFrames(tabId);
            const f = frames[cmd.frameIndex];
            if (!f) return { id: cmd.id, ok: false, error: `Frame index ${cmd.frameIndex} out of range (${frames.length})`, errorCode: 'frame_not_found' };
            return pageScoped(cmd.id, tabId, await evaluateMain(tabId, f.frameId, cmd.code, aggressive, commandTimeoutMs(cmd)));
          }
          return pageScoped(cmd.id, tabId, await executor.evaluate(tabId, cmd.code, aggressive, commandTimeoutMs(cmd)));
        }
        case 'act': {
          if (!cmd.act) return { id: cmd.id, ok: false, error: 'Missing act spec', errorCode: 'invalid_target' };
          const tabId = await resolveTab(s, cmd.page);
          const downloadFrom = executor.downloadCursor(tabId);
          const { result, error, openedTabs } = await withChildTabs(tabId, () => performAct(tabId, { ...cmd.act!, timeoutMs: Math.min(cmd.act!.timeoutMs ?? 3000, 60_000) }, { aggressive }));
          const started = executor.pageDownloadsAfter(tabId, downloadFrom).map(({ seq, guid, url, suggestedFilename }) => ({ seq, ...(guid && { guid }), url, suggestedFilename }));
          if (error) {
            const failure = errorResult(cmd.id, error);
            failure.data = { ...(typeof failure.data === 'object' && failure.data !== null ? failure.data : {}), ...(openedTabs.length && { openedTabs: openedTabs.map(({ page, tabId: id, url, title, pending }) => ({ ...(page && { tab: page }), tabId: id, url, title, ...(pending && { pending }) })) }), download: { afterSequence: downloadFrom, started } };
            return failure;
          }
          return pageScoped(cmd.id, tabId, { ...result, ...(openedTabs.length && { openedTabs }), download: { afterSequence: downloadFrom, started } });
        }
        case 'navigate': {
          if (!cmd.url) return { id: cmd.id, ok: false, error: 'Missing url' };
          if (!isSafeNavigationUrl(cmd.url)) return { id: cmd.id, ok: false, error: 'Blocked URL scheme — only http:// and https:// are allowed', errorCode: 'invalid_url' };
          const tabId = cmd.page || s.leases.size > 0 ? await resolveTab(s, cmd.page) : (await lease(s)).id;
          const before = shim.tabs.get(tabId);
          if (before && normalizeUrl(before.url) === normalizeUrl(cmd.url)) {
            const t = await waitForLoad(tabId, 15_000);
            return pageScoped(cmd.id, tabId, { title: t?.title, url: t?.url, timedOut: t?.status !== 'complete' });
          }
          const r = await navigate(tabId, cmd.url);
          if (r.error) return { id: cmd.id, ok: false, errorCode: 'page_not_loaded', error: `navigation to ${cmd.url} did not load: ${r.error}`, errorHint: 'Check that the URL is reachable from this browser and allowed for this session.' };
          const after = await shim.api.tabs.get(tabId);
          return pageScoped(cmd.id, tabId, { title: after.title, url: after.url, timedOut: r.timedOut });
        }
        case 'tabs': {
          if (cmd.op === 'list') {
            const out = [];
            let index = 0;
            for (const l of s.leases.values()) {
              const tab = shim.tabs.get(l.tabId);
              if (!tab) continue;
              const info = await shim.api.tabs.get(l.tabId);
              out.push({ index: index++, tabId: l.tabId, page: tab.targetId, url: info.url, title: info.title, active: true, selected: l.tabId === s.preferredTabId, origin: l.origin, state: 'active' });
            }
            return { id: cmd.id, ok: true, data: out };
          }
          if (cmd.op === 'new') {
            if (cmd.url && !isSafeNavigationUrl(cmd.url)) return { id: cmd.id, ok: false, error: 'Blocked URL scheme', errorCode: 'invalid_url' };
            const tab = await lease(s, cmd.url);
            const info = await shim.api.tabs.get(tab.id);
            return { id: cmd.id, ok: true, page: tab.targetId, data: { url: info.url, title: info.title } };
          }
          if (cmd.op === 'close' || cmd.op === 'release') {
            const tabId = cmd.page ? await identity.resolveTabId(cmd.page).catch(() => undefined) : s.preferredTabId ?? undefined;
            if (tabId === undefined) return { id: cmd.id, ok: false, error: 'Page no longer exists', errorCode: 'stale_page' };
            return { id: cmd.id, ok: true, data: await endTab(s, tabId, cmd.op) };
          }
          return { id: cmd.id, ok: false, error: `Unknown tabs op: ${String(cmd.op)}` };
        }
        case 'cookies': {
          if (!cmd.domain && !cmd.url) return { id: cmd.id, ok: false, error: 'Cookie scope required: domain or url', errorCode: 'cookie_scope_required' };
          const tabId = await resolveTab(s, cmd.page);
          const { cookies } = await shim.send<{ cookies: Array<{ name: string; value: string; domain: string; path: string; secure: boolean; httpOnly: boolean; expires: number }> }>(tabId, 'Network.getCookies', cmd.url ? { urls: [cmd.url] } : {});
          const domain = cmd.domain?.replace(/^\./, '');
          return { id: cmd.id, ok: true, data: cookies.filter((c) => !domain || c.domain.replace(/^\./, '').endsWith(domain)).map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, expirationDate: c.expires > 0 ? c.expires : undefined })) };
        }
        case 'screenshot': { const tabId = await resolveTab(s, cmd.page); return pageScoped(cmd.id, tabId, await executor.screenshot(tabId, { format: cmd.format, quality: cmd.quality, fullPage: cmd.fullPage, width: cmd.width, height: cmd.height })); }
        case 'cdp': {
          if (!cmd.cdpMethod) return { id: cmd.id, ok: false, error: 'Missing cdpMethod' };
          if (!CDP_ALLOWLIST.has(cmd.cdpMethod)) return { id: cmd.id, ok: false, error: `CDP method not permitted: ${cmd.cdpMethod}`, errorCode: 'cdp_not_allowed' };
          const tabId = await resolveTab(s, cmd.page);
          await executor.ensureAttached(tabId, aggressive);
          const params = cmd.cdpParams ?? {};
          const routeFrameId = typeof params.frameId === 'string' && params.sessionId === 'target' ? params.frameId : undefined;
          const { sessionId: _sid, frameId: _fid, targetUrl: _url, ...rest } = params as Record<string, unknown>;
          const data = routeFrameId
            ? await executor.sendCommandInFrameTarget(tabId, routeFrameId, cmd.cdpMethod, rest, aggressive, commandTimeoutMs(cmd) ?? 30_000)
            : await executor.sendDebuggerCommand({ tabId }, cmd.cdpMethod, _fid !== undefined ? { ...rest, frameId: _fid } : rest, commandTimeoutMs(cmd));
          return pageScoped(cmd.id, tabId, data);
        }
        case 'frames': { const tabId = await resolveTab(s, cmd.page); return { id: cmd.id, ok: true, data: await executor.listFrames(tabId) }; }
        case 'network-capture-start': { const tabId = await resolveTab(s, cmd.page); await executor.startNetworkCapture(tabId, cmd.pattern); return pageScoped(cmd.id, tabId, { started: true }); }
        case 'network-capture-read': { const tabId = await resolveTab(s, cmd.page); return pageScoped(cmd.id, tabId, await executor.readNetworkCapture(tabId)); }
        case 'session-name': { if (!cmd.name) return { id: cmd.id, ok: false, error: 'Missing name' }; s.name = cmd.name; return { id: cmd.id, ok: true, data: { name: cmd.name } }; }
        case 'mark': {
          if (!cmd.page) return { id: cmd.id, ok: false, error: 'Missing page' };
          const l = s.leases.get(await identity.resolveTabId(cmd.page));
          if (!l) throw new BackendError('page_not_in_session', `page ${cmd.page} is not part of session ${s.key}`);
          l.mark = cmd.mark ?? null;
          return { id: cmd.id, ok: true, data: { mark: l.mark } };
        }
        case 'session-finalize': return { id: cmd.id, ok: true, data: await finalize(s, cmd.keep ?? []) };
        case 'dialog': {
          const tabId = await resolveTab(s, cmd.page);
          const op = cmd.dialogOp ?? 'get';
          if (op === 'get') return pageScoped(cmd.id, tabId, { dialog: executor.getDialog(tabId) });
          if (!executor.getDialog(tabId)) return { id: cmd.id, ok: false, error: 'No native dialog is open on this tab', errorCode: 'no_dialog' };
          return pageScoped(cmd.id, tabId, { handled: op, dialog: await executor.handleDialog(tabId, op === 'accept', cmd.text) });
        }
        case 'console': { const tabId = await resolveTab(s, cmd.page); await executor.ensureAttached(tabId, aggressive); return pageScoped(cmd.id, tabId, executor.readConsole(tabId, { afterSequence: cmd.afterSequence, limit: cmd.limit, levels: cmd.levels, filter: cmd.filter })); }
        case 'history': {
          const tabId = await resolveTab(s, cmd.page);
          const op = cmd.historyOp ?? 'reload';
          if (op === 'reload') await shim.send(tabId, 'Page.reload');
          else {
            const { currentIndex, entries } = await shim.send<{ currentIndex: number; entries: Array<{ id: number }> }>(tabId, 'Page.getNavigationHistory');
            const entry = entries[currentIndex + (op === 'back' ? -1 : 1)];
            if (!entry) return { id: cmd.id, ok: false, error: `No ${op} history entry`, errorCode: 'no_history' };
            await shim.send(tabId, 'Page.navigateToHistoryEntry', { entryId: entry.id });
          }
          await sleep(300); // let the navigation start before polling status
          const t = await waitForLoad(tabId, 15_000);
          return pageScoped(cmd.id, tabId, { op, url: t?.url, title: t?.title, timedOut: t?.status !== 'complete' });
        }
        case 'cursor': { const tabId = await resolveTab(s, cmd.page); return pageScoped(cmd.id, tabId, { arrived: false }); }
        case 'visibility': return { id: cmd.id, ok: true, data: { visible: false } };
        case 'user-tabs': return { id: cmd.id, ok: true, data: [] };
        case 'claim': return unsupported(cmd.id, 'Claiming a user tab');
        case 'close-user-tabs': return unsupported(cmd.id, 'Closing user tabs');
        case 'wait-download': return unsupported(cmd.id, 'Download tracking');
        default: return { id: cmd.id, ok: false, error: `Unknown action: ${String(cmd.action)}`, errorCode: 'unknown_action' };
      }
    } catch (err) {
      return errorResult(cmd.id, err);
    }
  }

  return {
    mode,
    features: FEATURES,
    handle,
    close: async () => {
      for (const s of [...sessions.values()]) await finalize(s, []).catch(() => {});
      conn.close();
      active = false;
    },
  };
}
