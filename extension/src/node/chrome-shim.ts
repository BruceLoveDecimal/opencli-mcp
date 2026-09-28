/**
 * The slice of the extension `chrome.*` API that the page engine (cdp.ts, world.ts, act.ts, identity.ts) uses,
 * implemented over one CDP connection so the same engine runs in Node against any CDP endpoint.
 *
 * Tabs are CDP page targets. Two shapes of endpoint:
 *   - browser: a browser socket. Every page target is a tab with its own flat root session; tabs can be created.
 *   - page: one page's socket (e.g. an app relaying a single embedded view). It is tab 1, commands without a
 *     sessionId go to it, and no other tab exists.
 * Out-of-process iframes arrive as flat child sessions (Target.setAutoAttach on the tab session) in both shapes.
 *
 * Only what the engine relies on is modelled: tab url/title/status from Page events, webNavigation for the main
 * frame (frameId 0), debugger events routed to `{tabId}` / `{tabId, sessionId}` / `{targetId}` debuggees.
 */
import type { CdpConnection } from './connection';

type Listener<A extends unknown[]> = (...args: A) => unknown;

class ChromeEvent<A extends unknown[]> {
  private readonly listeners = new Set<Listener<A>>();
  addListener(listener: Listener<A>): void { this.listeners.add(listener); }
  removeListener(listener: Listener<A>): void { this.listeners.delete(listener); }
  hasListener(listener: Listener<A>): boolean { return this.listeners.has(listener); }
  emit(...args: A): void {
    for (const listener of [...this.listeners]) {
      try {
        const result = listener(...args);
        if (result instanceof Promise) result.catch(() => {});
      } catch { /* a listener's failure must not stop the others */ }
    }
  }
}

export interface ShimTab {
  id: number;
  targetId: string;
  /** Flat root session (browser endpoint); undefined for the page endpoint's single page. */
  sessionId?: string;
  url: string;
  title: string;
  status: 'loading' | 'complete';
  pendingUrl?: string;
  mainFrameId?: string;
  openerTargetId?: string;
}

type Debuggee = { tabId?: number; sessionId?: string; targetId?: string };

const PAGE_TAB_ID = 1;

export class ChromeShim {
  readonly tabs = new Map<number, ShimTab>();
  private readonly byTarget = new Map<string, number>();
  private readonly bySession = new Map<string, number>();
  /** Child (OOPIF) sessions → owning tab. */
  private readonly childSessions = new Map<string, number>();
  /** Sessions opened by `debugger.attach({targetId})` → targetId. */
  private readonly directSessions = new Map<string, string>();
  private nextTabId = PAGE_TAB_ID;
  private pageData = '';

  readonly onTabCreated = new ChromeEvent<[ShimTab]>();
  readonly api: typeof chrome;

  private readonly debuggerEvent = new ChromeEvent<[Debuggee, string, unknown]>();
  private readonly debuggerDetach = new ChromeEvent<[Debuggee, string]>();
  private readonly tabUpdated = new ChromeEvent<[number, Record<string, unknown>, ShimTab]>();
  private readonly tabRemoved = new ChromeEvent<[number, Record<string, unknown>]>();
  private readonly navBefore = new ChromeEvent<[Record<string, unknown>]>();
  private readonly navCommitted = new ChromeEvent<[Record<string, unknown>]>();
  private readonly navCompleted = new ChromeEvent<[Record<string, unknown>]>();
  private readonly navError = new ChromeEvent<[Record<string, unknown>]>();

  constructor(readonly conn: CdpConnection, readonly mode: 'browser' | 'page') {
    conn.onEvent((method, params, sessionId) => this.onCdpEvent(method, params, sessionId));
    conn.onClose(() => { for (const id of [...this.tabs.keys()]) this.removeTab(id); });
    this.api = this.buildApi();
  }

  /** The engine page module (extension/dist/page.js), served to world.ts through `chrome.runtime.getURL`. */
  setPageModule(source: string): void { this.pageData = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`; }

  async init(): Promise<void> {
    if (this.mode === 'page') {
      const tab: ShimTab = { id: this.nextTabId++, targetId: 'page', url: '', title: '', status: 'complete' };
      this.tabs.set(tab.id, tab);
      this.byTarget.set(tab.targetId, tab.id);
      await this.prepareTab(tab);
      // the page's own target id, when the endpoint exposes it
      const info = await this.conn.send<{ targetInfo?: { targetId: string } }>('Target.getTargetInfo').catch(() => ({ targetInfo: undefined }));
      if (info.targetInfo?.targetId) { this.byTarget.delete(tab.targetId); tab.targetId = info.targetInfo.targetId; this.byTarget.set(tab.targetId, tab.id); }
      return;
    }
    await this.conn.send('Target.setDiscoverTargets', { discover: true });
    const { targetInfos } = await this.conn.send<{ targetInfos: Array<{ targetId: string; type: string; url: string; title: string; openerId?: string }> }>('Target.getTargets');
    for (const info of targetInfos) if (info.type === 'page') await this.adoptTarget(info);
  }

  /** Create a tab (browser endpoint only). Resolves once its root session is ready. */
  async createTab(url = 'about:blank'): Promise<ShimTab> {
    if (this.mode === 'page') throw Object.assign(new Error('this endpoint exposes a single page; navigate it instead of opening a tab'), { code: 'single_page' });
    const { targetId } = await this.conn.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    const tab = await this.waitForTab(targetId);
    if (url !== 'about:blank') tab.pendingUrl = url;
    return tab;
  }

  async closeTab(tabId: number): Promise<void> {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error(`No tab with id: ${tabId}.`);
    if (this.mode === 'page') throw Object.assign(new Error('the single page of this endpoint cannot be closed'), { code: 'single_page' });
    await this.conn.send('Target.closeTarget', { targetId: tab.targetId });
    this.removeTab(tabId);
  }

  /** Send a command to the tab's root session. */
  send<T = unknown>(tabId: number, method: string, params: Record<string, unknown> = {}): Promise<T> {
    const tab = this.tabs.get(tabId);
    if (!tab) return Promise.reject(new Error(`No tab with id: ${tabId}.`));
    return this.conn.send<T>(method, params, tab.sessionId);
  }

  private async waitForTab(targetId: string, timeoutMs = 10_000): Promise<ShimTab> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const id = this.byTarget.get(targetId);
      const tab = id === undefined ? undefined : this.tabs.get(id);
      if (tab?.sessionId) return tab;
      if (Date.now() > deadline) throw new Error(`target ${targetId} did not become a tab`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  private adopting = new Map<string, Promise<void>>();

  private adoptTarget(info: { targetId: string; url: string; title: string; openerId?: string }): Promise<void> {
    if (this.byTarget.has(info.targetId)) return Promise.resolve();
    const inFlight = this.adopting.get(info.targetId);
    if (inFlight) return inFlight;
    const run = (async () => {
      const { sessionId } = await this.conn.send<{ sessionId: string }>('Target.attachToTarget', { targetId: info.targetId, flatten: true });
      const tab: ShimTab = { id: this.nextTabId++, targetId: info.targetId, sessionId, url: info.url, title: info.title, status: 'complete', ...(info.openerId && { openerTargetId: info.openerId }) };
      this.tabs.set(tab.id, tab);
      this.byTarget.set(tab.targetId, tab.id);
      this.bySession.set(sessionId, tab.id);
      await this.prepareTab(tab);
      this.onTabCreated.emit(tab);
    })().catch(() => { /* the target went away while attaching */ }).finally(() => this.adopting.delete(info.targetId));
    this.adopting.set(info.targetId, run);
    return run;
  }

  /** Page events drive tab status and webNavigation; the engine enables its own domains again on attach. */
  private async prepareTab(tab: ShimTab): Promise<void> {
    await this.conn.send('Page.enable', {}, tab.sessionId).catch(() => {});
    const tree = await this.conn.send<{ frameTree: { frame: { id: string; url: string } } }>('Page.getFrameTree', {}, tab.sessionId).catch(() => null);
    if (tree) { tab.mainFrameId = tree.frameTree.frame.id; tab.url = tree.frameTree.frame.url || tab.url; }
    const history = await this.conn.send<{ currentIndex: number; entries: Array<{ url: string; title: string }> }>('Page.getNavigationHistory', {}, tab.sessionId).catch(() => null);
    const current = history?.entries[history.currentIndex];
    if (current) { tab.title = current.title; tab.url = current.url || tab.url; }
  }

  private removeTab(tabId: number): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    this.tabs.delete(tabId);
    this.byTarget.delete(tab.targetId);
    if (tab.sessionId) this.bySession.delete(tab.sessionId);
    for (const [session, owner] of [...this.childSessions]) if (owner === tabId) this.childSessions.delete(session);
    this.tabRemoved.emit(tabId, { windowId: 1, isWindowClosing: false });
  }

  private tabOfSession(sessionId: string | undefined): { tabId: number; child?: string } | null {
    if (sessionId === undefined) return this.mode === 'page' ? { tabId: PAGE_TAB_ID } : null;
    const root = this.bySession.get(sessionId);
    if (root !== undefined) return { tabId: root };
    const owner = this.childSessions.get(sessionId);
    if (owner !== undefined) return { tabId: owner, child: sessionId };
    return null;
  }

  private onCdpEvent(method: string, params: Record<string, unknown>, sessionId: string | undefined): void {
    // browser-level target bookkeeping (browser endpoint: events without a session)
    if (this.mode === 'browser' && sessionId === undefined) {
      const info = params.targetInfo as { targetId: string; type: string; url: string; title: string; openerId?: string } | undefined;
      if (method === 'Target.targetCreated' && info?.type === 'page') void this.adoptTarget(info);
      else if (method === 'Target.targetInfoChanged' && info) {
        const id = this.byTarget.get(info.targetId); const tab = id === undefined ? undefined : this.tabs.get(id);
        if (tab && info.title !== tab.title) { tab.title = info.title; this.tabUpdated.emit(tab.id, { title: tab.title }, tab); }
      } else if (method === 'Target.targetDestroyed') {
        const id = this.byTarget.get(String(params.targetId)); if (id !== undefined) this.removeTab(id);
      } else if (method === 'Target.detachedFromTarget') {
        const id = this.bySession.get(String(params.sessionId)); if (id !== undefined) this.removeTab(id);
      }
      return;
    }
    const direct = sessionId === undefined ? undefined : this.directSessions.get(sessionId);
    if (direct) {
      if (method === 'Inspector.detached') { this.directSessions.delete(sessionId!); this.debuggerDetach.emit({ targetId: direct }, 'target_closed'); }
      else this.debuggerEvent.emit({ targetId: direct }, method, params);
      return;
    }
    const owner = this.tabOfSession(sessionId);
    if (!owner) return;
    const tab = this.tabs.get(owner.tabId);
    if (!tab) return;
    if (owner.child === undefined) this.trackTab(tab, method, params);
    if (method === 'Target.attachedToTarget' && params.sessionId) this.childSessions.set(String(params.sessionId), tab.id);
    if (method === 'Target.detachedFromTarget' && params.sessionId) {
      const child = String(params.sessionId);
      if (this.childSessions.delete(child)) this.debuggerDetach.emit({ tabId: tab.id, sessionId: child }, 'target_closed');
    }
    this.debuggerEvent.emit(owner.child ? { tabId: tab.id, sessionId: owner.child } : { tabId: tab.id }, method, params);
  }

  /** Main-frame Page events → tab url/title/status and webNavigation (frameId 0 is the main frame). */
  private trackTab(tab: ShimTab, method: string, params: Record<string, unknown>): void {
    const frame = params.frame as { id: string; parentId?: string; url: string; unreachableUrl?: string } | undefined;
    const frameId = (params.frameId as string | undefined) ?? frame?.id;
    const isMain = frameId !== undefined && (frameId === tab.mainFrameId || (frame !== undefined && !frame.parentId));
    if (!isMain) return;
    if (method === 'Page.frameStartedLoading' || method === 'Page.frameRequestedNavigation') {
      if (params.url) tab.pendingUrl = String(params.url);
      if (tab.status !== 'loading') {
        tab.status = 'loading';
        this.navBefore.emit({ tabId: tab.id, frameId: 0, url: tab.pendingUrl ?? tab.url });
        this.tabUpdated.emit(tab.id, { status: 'loading' }, tab);
      }
    } else if (method === 'Page.frameNavigated' && frame) {
      tab.mainFrameId = frame.id;
      tab.url = frame.url;
      tab.pendingUrl = undefined;
      if (frame.unreachableUrl) this.navError.emit({ tabId: tab.id, frameId: 0, url: frame.unreachableUrl, error: 'net::ERR_FAILED' });
      this.navCommitted.emit({ tabId: tab.id, frameId: 0, url: tab.url });
      this.tabUpdated.emit(tab.id, { url: tab.url }, tab);
    } else if (method === 'Page.navigatedWithinDocument') {
      tab.url = String(params.url ?? tab.url);
      this.tabUpdated.emit(tab.id, { url: tab.url }, tab);
    } else if (method === 'Page.frameStoppedLoading') {
      tab.status = 'complete';
      tab.pendingUrl = undefined;
      this.navCompleted.emit({ tabId: tab.id, frameId: 0, url: tab.url });
      this.tabUpdated.emit(tab.id, { status: 'complete', url: tab.url }, tab);
    }
  }

  private tabInfo(tab: ShimTab): chrome.tabs.Tab {
    return { id: tab.id, url: tab.url, title: tab.title, status: tab.status, ...(tab.pendingUrl && { pendingUrl: tab.pendingUrl }), windowId: 1, active: true, index: tab.id, pinned: false, highlighted: false, incognito: false, selected: true, discarded: false, autoDiscardable: false, groupId: -1, frozen: false } as chrome.tabs.Tab;
  }

  private sessionFor(target: Debuggee): string | undefined {
    if (target.targetId !== undefined && target.tabId === undefined) {
      for (const [session, targetId] of this.directSessions) if (targetId === target.targetId) return session;
      throw new Error(`Debugger is not attached to the target with id: ${target.targetId}.`);
    }
    if (target.sessionId) return target.sessionId;
    const tab = target.tabId === undefined ? undefined : this.tabs.get(target.tabId);
    if (!tab) throw new Error(`No tab with id: ${target.tabId}.`);
    return tab.sessionId;
  }

  private buildApi(): typeof chrome {
    const shim = this;
    const getTab = async (tabId: number): Promise<chrome.tabs.Tab> => {
      const tab = shim.tabs.get(tabId);
      if (!tab) throw new Error(`No tab with id: ${tabId}.`);
      if (!tab.title) {
        const history = await shim.conn.send<{ currentIndex: number; entries: Array<{ title: string }> }>('Page.getNavigationHistory', {}, tab.sessionId).catch(() => null);
        tab.title = history?.entries[history.currentIndex]?.title ?? '';
      }
      return shim.tabInfo(tab);
    };
    const api = {
      debugger: {
        // the root session of a tab lives as long as the tab; attach and detach only manage direct frame targets
        attach: async (target: Debuggee): Promise<void> => {
          if (target.tabId !== undefined) { if (!shim.tabs.has(target.tabId)) throw new Error(`No tab with id: ${target.tabId}.`); return; }
          if (target.targetId === undefined) throw new Error('attach needs a tabId or targetId');
          if ([...shim.directSessions.values()].includes(target.targetId)) throw new Error('Another debugger is already attached to the target');
          const { sessionId } = await shim.conn.send<{ sessionId: string }>('Target.attachToTarget', { targetId: target.targetId, flatten: true });
          shim.directSessions.set(sessionId, target.targetId);
        },
        detach: async (target: Debuggee): Promise<void> => {
          if (target.targetId === undefined || target.tabId !== undefined) return;
          for (const [session, targetId] of shim.directSessions) {
            if (targetId !== target.targetId) continue;
            shim.directSessions.delete(session);
            await shim.conn.send('Target.detachFromTarget', { sessionId: session }).catch(() => {});
          }
        },
        sendCommand: (target: Debuggee, method: string, params?: Record<string, unknown>): Promise<unknown> => {
          let session: string | undefined;
          try { session = shim.sessionFor(target); } catch (error) { return Promise.reject(error); }
          return shim.conn.send(method, params ?? {}, session);
        },
        getTargets: async () => [...shim.tabs.values()].map((tab) => ({ id: tab.targetId, tabId: tab.id, type: 'page', url: tab.url, title: tab.title, attached: true })),
        onEvent: shim.debuggerEvent,
        onDetach: shim.debuggerDetach,
      },
      tabs: {
        get: getTab,
        onUpdated: shim.tabUpdated,
        onRemoved: shim.tabRemoved,
      },
      webNavigation: {
        onBeforeNavigate: shim.navBefore,
        onCommitted: shim.navCommitted,
        onCompleted: shim.navCompleted,
        onErrorOccurred: shim.navError,
      },
      runtime: {
        getURL: (path: string) => {
          if (path !== 'page.js') throw new Error(`no packaged resource ${path}`);
          return shim.pageData;
        },
        getManifest: () => ({ version: 'cdp' }),
      },
      // downloads go to the browser's own directory; completion is not tracked by this backend
      downloads: {
        onCreated: new ChromeEvent<[chrome.downloads.DownloadItem]>(),
        search: async () => [],
      },
    };
    return api as unknown as typeof chrome;
  }
}
