/**
 * network_expect: wait for a captured request matching a URL (and method/status) whose JSON request and response
 * bodies satisfy JSON assertions. The matched entry's seq is the evidence; network_inspect detail shows it in full.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { ActionError } from '../api/errors.js';
import type { Tab } from '../api/tab.js';
import { checkAll, parseBody, type ExpectFailure } from './json-expect.js';
import type { NetworkMatch } from './schema.js';

type Entry = Record<string, unknown> & { seq: number };

export interface NetworkEvidence { seq: number; url: string; method: string; status: number | null; checked: number }

const str = (v: unknown): string => typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v);
const header = (headers: unknown, name: string): string => {
  if (!headers || typeof headers !== 'object') return '';
  const hit = Object.entries(headers as Record<string, unknown>).find(([k]) => k.toLowerCase() === name);
  return hit ? str(hit[1]) : '';
};

/** Assertions of one match against one captured entry; null when the entry is not a candidate (or not finished yet). */
export function evaluateEntry(entry: Entry, match: NetworkMatch, vars: Record<string, unknown> = {}): { failures: ExpectFailure[]; pending?: boolean } | null {
  const method = str(entry.method || 'GET').toUpperCase();
  if (match.method && method !== match.method.toUpperCase()) return null;
  if (!str(entry.url ?? entry.name).includes(match.url)) return null;
  const done = entry.done !== false;
  const status = (entry.responseStatus ?? entry.status) as number | undefined;
  if (!done && (match.status !== undefined || match.response?.length)) return { failures: [], pending: true };
  const failures: ExpectFailure[] = [];
  if (match.status !== undefined && status !== match.status) failures.push({ path: '(status)', op: 'equals', expected: match.status, actual: status ?? null });
  if (match.request?.length) {
    const body = parseBody(str(entry.requestBodyPreview), 'auto', header(entry.requestHeaders, 'content-type'));
    const r = checkAll(body, match.request, vars);
    failures.push(...r.failures.map((f) => ({ ...f, path: `request.${f.path}` })));
    if (!r.ok && entry.requestBodyTruncated) failures.push({ path: 'request', op: 'complete', expected: 'full body', actual: 'capture truncated' });
  }
  if (match.response?.length) {
    const body = parseBody(str(entry.responsePreview), 'auto', str(entry.responseContentType ?? entry.mimeType));
    const r = checkAll(body, match.response, vars);
    failures.push(...r.failures.map((f) => ({ ...f, path: `response.${f.path}` })));
    if (!r.ok && entry.responseBodyTruncated) failures.push({ path: 'response', op: 'complete', expected: 'full body', actual: 'capture truncated' });
  }
  return { failures };
}

export async function networkExpect(tab: Tab, match: NetworkMatch, opts: { afterSequence?: number; timeoutMs?: number; vars?: Record<string, unknown>; signal?: AbortSignal } = {}): Promise<NetworkEvidence> {
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
  const after = opts.afterSequence ?? 0;
  let checked = 0;
  const near = new Map<number, { seq: number; url: string; status: unknown; failures: ExpectFailure[] }>();
  for (;;) {
    if (opts.signal?.aborted) throw new ActionError('cancelled', 'network_expect was cancelled');
    let cursor = after;
    for (;;) {
      const page = await tab.network.read({ pattern: match.url, afterSequence: cursor, limit: 200 });
      for (const entry of page.entries as Entry[]) {
        const outcome = evaluateEntry(entry, match, opts.vars);
        if (!outcome || outcome.pending) continue;
        checked++;
        if (!outcome.failures.length) return { seq: entry.seq, url: str(entry.url ?? entry.name), method: str(entry.method || 'GET').toUpperCase(), status: (entry.responseStatus ?? entry.status ?? null) as number | null, checked };
        near.set(entry.seq, { seq: entry.seq, url: str(entry.url ?? entry.name).slice(0, 300), status: entry.responseStatus ?? entry.status, failures: outcome.failures.slice(0, 8) });
      }
      if (!page.hasMore) break;
      cursor = page.cursor;
    }
    if (Date.now() >= deadline) break;
    await sleep(Math.min(500, Math.max(1, deadline - Date.now())));
  }
  const candidates = [...near.values()].sort((a, b) => a.failures.length - b.failures.length).slice(0, 5);
  throw new ActionError('expectation_failed', candidates.length ? `${candidates.length} request(s) to ${match.url} did not satisfy the assertions` : `no request to ${match.url} after sequence ${after}`,
    candidates.length ? 'Compare the failures with network_inspect detail of the candidate seq.' : 'Check the cursor (use the afterSequence of the action that should send it) and the URL substring.',
    { details: { afterSequence: after, candidates } });
}
