/**
 * One CDP WebSocket with flat sessions: every target session (tab, out-of-process iframe) shares the socket and is
 * addressed by `sessionId`. Uses Node's global WebSocket (Node 22+), so the backend has no native dependencies.
 */

export type CdpEventListener = (method: string, params: Record<string, unknown>, sessionId: string | undefined) => void;

export class CdpError extends Error {
  constructor(message: string, readonly method: string) { super(message); this.name = 'CdpError'; }
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; method: string };

export class CdpConnection {
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<CdpEventListener>();
  private readonly closeListeners = new Set<(reason: string) => void>();
  private nextId = 1;
  closed = false;

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => this.onMessage(String(event.data)));
    socket.addEventListener('close', () => this.shutdown('the CDP connection closed'));
    socket.addEventListener('error', () => this.shutdown('the CDP connection failed'));
  }

  static open(url: string, timeoutMs = 10_000): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => { socket.close(); reject(new Error(`could not connect to ${url} within ${timeoutMs / 1000}s`)); }, timeoutMs);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(new CdpConnection(socket)); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`could not connect to ${url}`)); }, { once: true });
    });
  }

  /** A command that gets no answer within `timeoutMs` fails instead of hanging its caller (the browser may be wedged). */
  send<T = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 90_000): Promise<T> {
    if (this.closed) return Promise.reject(new CdpError('Debugger is not attached: the CDP connection is closed', method));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`CDP command ${method} got no answer within ${timeoutMs / 1000}s`, method));
      }, timeoutMs);
      const settle = <A,>(fn: (arg: A) => void) => (arg: A) => { clearTimeout(timer); fn(arg); };
      this.pending.set(id, { resolve: settle(resolve as (value: unknown) => void), reject: settle(reject), method });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
    });
  }

  onEvent(listener: CdpEventListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  onClose(listener: (reason: string) => void): void { this.closeListeners.add(listener); }

  close(): void { try { this.socket.close(); } catch { /* already closed */ } this.shutdown('closed by the backend'); }

  private shutdown(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new CdpError(`Target closed: ${reason}`, p.method));
    this.pending.clear();
    for (const listener of this.closeListeners) listener(reason);
  }

  private onMessage(raw: string): void {
    let msg: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: Record<string, unknown>; sessionId?: string };
    try { msg = JSON.parse(raw); } catch { return; }
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new CdpError(msg.error.message ?? `${p.method} failed`, p.method));
      else p.resolve(msg.result ?? {});
      return;
    }
    if (msg.method) for (const listener of this.listeners) listener(msg.method, msg.params ?? {}, msg.sessionId);
  }
}

/**
 * Resolve an endpoint to a WebSocket URL. `http(s)://host:port` asks the DevTools HTTP API for the browser socket;
 * a `ws(s)://` URL is used as is — a browser socket (`/devtools/browser/…`) or a single page's socket (any other path,
 * e.g. an embedding app's relay for one view).
 */
export async function resolveEndpoint(endpoint: string): Promise<{ url: string; mode: 'browser' | 'page' }> {
  if (/^wss?:\/\//.test(endpoint)) return { url: endpoint, mode: /\/devtools\/browser\//.test(endpoint) ? 'browser' : 'page' };
  if (/^https?:\/\//.test(endpoint)) {
    const response = await fetch(new URL('/json/version', endpoint));
    if (!response.ok) throw new Error(`${endpoint}/json/version answered HTTP ${response.status}`);
    const { webSocketDebuggerUrl } = await response.json() as { webSocketDebuggerUrl?: string };
    if (!webSocketDebuggerUrl) throw new Error(`${endpoint}/json/version has no webSocketDebuggerUrl`);
    return { url: webSocketDebuggerUrl, mode: 'browser' };
  }
  throw new Error(`unsupported CDP endpoint ${endpoint}: use http(s)://host:port or a ws(s):// URL`);
}
