/**
 * Page request — send one HTTP request from a page with that page's login session, like the page's own code would.
 *
 * Sites often keep their auth token in page storage rather than a cookie, so a request made from outside the page
 * cannot authenticate. Here the caller names where each session value lives (`localStorage:<key>#<field>`,
 * `sessionStorage:<key>`, `cookie:<name>`) and writes `${name}` in the request; the page reads the values, fills
 * them in and sends the request with its cookies. Values listed as secrets never leave the page: every echo of them
 * in the response or the URL is masked before it is returned.
 */
import type { RuntimePage } from '../backends/page-types.js';
import { ActionError } from './errors.js';

/** Replacement for a secret session value in anything returned. */
export const MASK = '******';

export interface PageRequestSpec {
  method: string;
  /** Path (or URL) resolved against the page's origin. */
  path: string;
  query?: Record<string, unknown>;
  headers?: Record<string, string>;
  /** Sent as JSON; a content-type header defaults to application/json. */
  body?: unknown;
}

export interface PageRequestOptions {
  /** Session values by name, read in the page: `localStorage:<key>`, `localStorage:<key>#<field>` (JSON field), `sessionStorage:…`, `cookie:<name>`. */
  values?: Record<string, string>;
  /** Names of values masked in the response and URL. */
  secrets?: string[];
  /** Without a request, only check that every value resolves. */
  request?: PageRequestSpec;
  timeoutMs?: number;
  /** Tries in total; 502/503/504 and network errors are retried with a growing delay. */
  attempts?: number;
  /** Response text is cut to this many characters. */
  maxChars?: number;
}

export interface PageResponse { status: number; contentType: string; text: string; ms: number; attempts: number; url: string }

const SOURCE_RE = /^(localStorage|sessionStorage|cookie):([^#]+)(?:#(.+))?$/;
const RETRY_STATUSES = new Set([502, 503, 504]);

// Runs in the page for every attempt, so a session that changes between attempts (token refresh) is read fresh.
const PAGE_SCRIPT = `
  const readValue = (source) => {
    const m = /^(localStorage|sessionStorage|cookie):([^#]+)(?:#(.+))?$/.exec(source);
    if (!m) return null;
    let raw = null;
    if (m[1] === 'cookie') {
      const hit = document.cookie.split('; ').find((c) => c.startsWith(m[2] + '='));
      raw = hit ? decodeURIComponent(hit.slice(m[2].length + 1)) : null;
    } else raw = (m[1] === 'localStorage' ? localStorage : sessionStorage).getItem(m[2]);
    if (raw == null || !m[3]) return raw;
    try { const parsed = JSON.parse(raw); return parsed && typeof parsed === 'object' ? parsed[m[3]] : null; } catch { return null; }
  };
  const values = {}, missing = [];
  for (const [name, source] of Object.entries(spec.values)) {
    let value = null;
    try { value = readValue(source); } catch { value = null; }
    if (value === null || value === undefined || value === '') missing.push(name); else values[name] = String(value);
  }
  if (missing.length) return { kind: 'missing', missing, origin: location.origin };
  if (!spec.request) return { kind: 'ready', origin: location.origin };
  const unknown = new Set();
  const fill = (v) => {
    if (typeof v === 'string') return v.replace(/\\$\\{(\\w+)\\}/g, (s, k) => (k in values ? values[k] : (unknown.add(k), s)));
    if (Array.isArray(v)) return v.map(fill);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]));
    return v;
  };
  const req = fill(spec.request);
  if (unknown.size) return { kind: 'unknown', names: [...unknown] };
  const secrets = spec.secrets.map((n) => values[n]).filter(Boolean);
  const mask = (t) => secrets.reduce((acc, s) => acc.split(s).join(spec.mask), String(t));
  const url = new URL(req.path, location.origin);
  for (const [k, v] of Object.entries(req.query || {})) url.searchParams.set(k, String(v));
  const shown = mask(url.origin === location.origin ? url.pathname + url.search : url.href);
  const headers = { ...(req.headers || {}) };
  const init = { method: req.method, headers, credentials: 'include' };
  if ('body' in req) {
    init.body = JSON.stringify(req.body);
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), spec.timeoutMs);
  try {
    const res = await fetch(url.href, { ...init, signal: ctrl.signal });
    const text = await res.text();
    return { kind: 'response', status: res.status, contentType: res.headers.get('content-type') || '', text: mask(text).slice(0, spec.maxChars), url: shown };
  } catch (e) {
    return { kind: 'error', message: mask((e && e.message) || e), url: shown };
  } finally { clearTimeout(timer); }
`;

type Attempt =
  | { kind: 'missing'; missing: string[]; origin: string }
  | { kind: 'ready'; origin: string }
  | { kind: 'unknown'; names: string[] }
  | { kind: 'response'; status: number; contentType: string; text: string; url: string }
  | { kind: 'error'; message: string; url: string };

function check(opts: PageRequestOptions): void {
  for (const [name, source] of Object.entries(opts.values ?? {})) {
    if (!/^\w+$/.test(name)) throw new ActionError('invalid_args', `value name "${name}" must be a word (letters, digits, _)`);
    if (!SOURCE_RE.test(source)) throw new ActionError('invalid_args', `value ${name}: "${source}" is not a storage source`, 'Write localStorage:<key>, localStorage:<key>#<field>, sessionStorage:<key> or cookie:<name>.');
  }
  const unknown = (opts.secrets ?? []).filter((name) => !(name in (opts.values ?? {})));
  if (unknown.length) throw new ActionError('invalid_args', `secrets not among values: ${unknown.join(', ')}`);
}

/**
 * Send `opts.request` from the page. Without a request, only resolves the values ({ ready: true, origin }).
 * Throws `session_missing` when a value is absent (logged out), `request_failed` when every attempt failed on the network.
 * HTTP error statuses are a normal response.
 */
export async function pageRequest(page: RuntimePage, opts: PageRequestOptions): Promise<PageResponse | { ready: true; origin: string }> {
  check(opts);
  const attempts = Math.max(1, opts.attempts ?? 1);
  const spec = {
    values: opts.values ?? {}, secrets: opts.secrets ?? [], request: opts.request ?? null, mask: MASK,
    timeoutMs: opts.timeoutMs ?? 30_000, maxChars: opts.maxChars ?? 200_000,
  };
  const started = Date.now();
  for (let attempt = 1; ; attempt++) {
    const r = await page.evaluateWithArgs(PAGE_SCRIPT, { spec }) as Attempt;
    const ms = Date.now() - started;
    if (r.kind === 'missing') throw new ActionError('session_missing', `the page at ${r.origin} has no ${r.missing.join(', ')}`, 'Log in on this page first; the values are read from its storage.', { missing: r.missing, origin: r.origin });
    if (r.kind === 'ready') return { ready: true, origin: r.origin };
    if (r.kind === 'unknown') throw new ActionError('invalid_args', `undefined variables: ${r.names.join(', ')}`, 'Every ${name} in the request must be one of values.', { names: r.names });
    const retry = attempt < attempts && (r.kind === 'error' || RETRY_STATUSES.has(r.status));
    if (retry) { await new Promise((resolve) => setTimeout(resolve, 1000 * attempt)); continue; }
    if (r.kind === 'error') throw new ActionError('request_failed', r.message, undefined, { url: r.url, ms, attempts: attempt });
    return { status: r.status, contentType: r.contentType, text: r.text, ms, attempts: attempt, url: r.url };
  }
}
