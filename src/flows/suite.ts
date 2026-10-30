/**
 * suite_run: a site's regression suite (`<site>/suite.json`) — fixed requests to the endpoints its adapters depend on,
 * sent from the logged-in page with page_request and judged by code. `capture` feeds later checks; a check that needs
 * a value no earlier check captured is skipped, not failed. Failed checks name the adapter commands they put at risk.
 */
import { ActionError } from '../api/errors.js';
import type { Tab } from '../api/tab.js';
import type { PageRequestOptions, PageResponse } from '../api/page-request.js';
import { capture, checkAll, parseBody, parseSse, substitute, type ExpectFailure, type JsonExpect } from './json-expect.js';

export interface SuiteCheck {
  id: string; name?: string; method?: string; path: string;
  query?: Record<string, unknown>; headers?: Record<string, string>; body?: unknown;
  response?: 'json' | 'sse' | 'text';
  expect?: JsonExpect[]; capture?: Record<string, string>; adapters?: string[];
}
export interface Suite {
  name: string; title?: string; match?: string[]; page?: string;
  session?: Record<string, string>; secrets?: string[]; headers?: Record<string, string>;
  checks: SuiteCheck[];
}
export interface CheckOutcome { id: string; name?: string; ok: boolean; skipped?: string; status?: number; ms?: number; failures?: ExpectFailure[]; error?: { code: string; message: string }; adapters: string[] }
export interface SuiteReport { suite: string; url: string | null; passed: number; failed: number; skipped: number; ms: number; checks: CheckOutcome[]; affectedAdapters: string[] }

export function parseSuite(raw: unknown): Suite {
  const s = raw as Suite;
  if (!s || typeof s !== 'object' || typeof s.name !== 'string' || !Array.isArray(s.checks)) throw new ActionError('invalid_suite', 'suite.json needs name and checks[]');
  const ids = new Set<string>();
  for (const c of s.checks) {
    if (!c || typeof c.id !== 'string' || typeof c.path !== 'string') throw new ActionError('invalid_suite', 'every check needs id and path');
    if (ids.has(c.id)) throw new ActionError('invalid_suite', `duplicate check id ${c.id}`);
    ids.add(c.id);
  }
  return s;
}

const PLACEHOLDER = /\$\{([^}]+)\}/g;
/** Names a check refers to that neither the page session nor an earlier capture provides. */
function missingVars(c: SuiteCheck, suite: Suite, vars: Record<string, unknown>): string[] {
  const text = JSON.stringify([c.path, c.query, c.headers, c.body, suite.headers, c.expect]);
  const names = new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]));
  return [...names].filter((n) => !(n in vars) && !(suite.session && n in suite.session));
}

export function selectChecks(suite: Suite, opts: { only?: string[]; adapters?: string[] } = {}): SuiteCheck[] {
  return suite.checks.filter((c) => (!opts.only?.length || opts.only.includes(c.id)) && (!opts.adapters?.length || (c.adapters ?? []).some((a) => opts.adapters!.includes(a))));
}

export async function runSuite(tab: Tab, suite: Suite, opts: { only?: string[]; adapters?: string[]; timeoutMs?: number; signal?: AbortSignal; request?: (o: PageRequestOptions) => Promise<PageResponse | { ready: true; origin: string }> } = {}): Promise<SuiteReport> {
  const started = Date.now();
  const url = await tab.url().catch(() => null);
  if (suite.match?.length && url && !suite.match.some((m) => url.includes(m))) {
    throw new ActionError('wrong_site', `the tab is on ${url}, not a ${suite.name} page (${suite.match.join(', ')})`, 'Open the site (origin + suite page) in the tab, logged in, and run again.');
  }
  const send = opts.request ?? ((o: PageRequestOptions) => tab.request(o));
  const vars: Record<string, unknown> = {};
  const checks: CheckOutcome[] = [];
  for (const c of selectChecks(suite, opts)) {
    const adapters = c.adapters ?? [];
    if (opts.signal?.aborted) { checks.push({ id: c.id, name: c.name, ok: false, skipped: 'cancelled', adapters }); continue; }
    const missing = missingVars(c, suite, vars);
    if (missing.length) { checks.push({ id: c.id, name: c.name, ok: false, skipped: `needs ${missing.join(', ')} from an earlier capture`, adapters }); continue; }
    const req = substitute({ path: c.path, query: c.query, headers: { ...suite.headers, ...c.headers }, body: c.body }, vars);
    const t0 = Date.now();
    let res: PageResponse;
    try {
      const r = await send({ values: suite.session ?? {}, secrets: suite.secrets ?? [], timeoutMs: opts.timeoutMs ?? 30_000, attempts: 2, maxChars: 2_000_000,
        request: { method: (c.method ?? 'GET').toUpperCase(), path: req.path, ...(req.query && { query: req.query }), ...(Object.keys(req.headers).length && { headers: req.headers }), ...(req.body !== undefined && { body: req.body }) } });
      if (!('status' in r)) throw new ActionError('request_failed', 'no request was sent');
      res = r;
    } catch (err) {
      const e = err as { code?: string; message?: string };
      // not logged in: every remaining check would fail the same way
      if (e.code === 'session_missing') throw err;
      checks.push({ id: c.id, name: c.name, ok: false, ms: Date.now() - t0, error: { code: e.code ?? 'request_failed', message: String(e.message ?? err).slice(0, 300) }, adapters });
      continue;
    }
    const body = c.response === 'sse' ? parseSse(res.text) : c.response === 'text' ? res.text : parseBody(res.text, 'auto', res.contentType);
    const report = checkAll(body, c.expect ?? [], vars);
    Object.assign(vars, capture(body, c.capture));
    checks.push({ id: c.id, name: c.name, ok: report.ok, status: res.status, ms: res.ms ?? Date.now() - t0, ...(!report.ok && { failures: report.failures }), adapters });
  }
  const failed = checks.filter((c) => !c.ok && !c.skipped);
  return {
    suite: suite.name, url, passed: checks.filter((c) => c.ok).length, failed: failed.length, skipped: checks.filter((c) => c.skipped).length, ms: Date.now() - started, checks,
    affectedAdapters: [...new Set(failed.flatMap((c) => c.adapters))].sort(),
  };
}
