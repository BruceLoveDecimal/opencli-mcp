/**
 * Session journal: every goto/act/expect/site/network step an agent performs, with its intent, recorded as a
 * replayable flow step. Steps keep durable locators (the engine's generated selector), never snapshot refs (`eN`),
 * so an exported flow replays after the page re-renders. Adapter sessions (site:*) are not journaled.
 */
import type { WebFlow, WebSeed, WebStep } from './schema.js';

export interface JournalEntry {
  seq: number;
  at: string;
  ms: number;
  tab?: string;
  intent?: string;
  step?: string;
  ok: boolean;
  /** The replayable step, or null when it cannot be replayed (e.g. a ref whose element had no selector). */
  record: WebStep | null;
  error?: { code: string; message: string };
  note?: string;
}

export interface StepMeta { intent?: string; step?: string }

const MAX_ENTRIES = 1000;
const SECRET_ARG = /pass(word)?|passwd|secret|token|otp|captcha_code|verification_code/i;

export class Journal {
  private seq = 0;
  private entries: JournalEntry[] = [];

  /** Sequence of the last recorded entry; pass it as `since` to read or export only what follows. */
  get cursor(): number { return this.seq; }

  add(entry: Omit<JournalEntry, 'seq' | 'at'> & { at?: string }): JournalEntry {
    const full: JournalEntry = { ...entry, seq: ++this.seq, at: entry.at ?? new Date().toISOString() };
    if (full.record) full.record = { ...full.record, ...(entry.intent !== undefined && { intent: entry.intent }), ...(entry.step !== undefined && { step: entry.step }) } as WebStep;
    this.entries.push(full);
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();
    return full;
  }

  read(opts: { since?: number; limit?: number } = {}): { cursor: number; entries: JournalEntry[]; dropped: boolean } {
    const since = opts.since ?? 0;
    const all = this.entries.filter((e) => e.seq > since);
    const limit = opts.limit ?? 200;
    return { cursor: this.seq, entries: all.slice(-limit), dropped: this.entries.length > 0 && this.entries[0].seq > since + 1 };
  }

  clear(): number { const n = this.entries.length; this.entries = []; return n; }

  /** Successful replayable steps after `since`, in order. Failed and non-replayable steps are reported, not exported. */
  toFlow(opts: { name: string; since?: number; case?: string; site?: string; seed?: WebSeed }): { flow: WebFlow; skipped: Array<{ seq: number; intent?: string; reason: string }> } {
    const skipped: Array<{ seq: number; intent?: string; reason: string }> = [];
    const steps: WebStep[] = [];
    for (const e of this.read({ since: opts.since, limit: MAX_ENTRIES }).entries) {
      if (!e.ok) { skipped.push({ seq: e.seq, intent: e.intent, reason: `failed: ${e.error?.code ?? 'error'}` }); continue; }
      if (!e.record) { skipped.push({ seq: e.seq, intent: e.intent, reason: e.note ?? 'not replayable' }); continue; }
      steps.push(e.record);
    }
    return { flow: { flow: 1, platform: 'web', name: opts.name, ...(opts.case && { case: opts.case }), ...(opts.site && { site: opts.site }), ...(opts.seed && { seed: opts.seed }), steps }, skipped };
  }
}

/** Site command args as they go into a flow: credentials become `${name}` placeholders filled by flow_run vars. */
export function maskArgs(args: Record<string, unknown>): { args: Record<string, unknown>; masked: string[] } {
  const masked: string[] = [];
  const out = Object.fromEntries(Object.entries(args).map(([k, v]) => {
    if (SECRET_ARG.test(k) && v !== undefined && v !== null && v !== '') { masked.push(k); return [k, `\${${k}}`]; }
    return [k, v];
  }));
  return { args: out, masked };
}

/** Time a step and journal it, whether it succeeds or fails; the step's own result or error passes through. */
export async function journaled<T>(journal: Journal | undefined, meta: StepMeta & { tab?: string }, run: () => Promise<T>, toRecord: (result: T) => { record: WebStep | null; note?: string }, failedRecord?: WebStep | null): Promise<T> {
  const started = Date.now();
  try {
    const result = await run();
    if (journal) { const { record, note } = toRecord(result); journal.add({ ...meta, ok: true, ms: Date.now() - started, record, ...(note && { note }) }); }
    return result;
  } catch (err) {
    const e = err as { code?: string; message?: string };
    journal?.add({ ...meta, ok: false, ms: Date.now() - started, record: failedRecord ?? null, error: { code: e.code ?? 'error', message: String(e.message ?? err).slice(0, 500) } });
    throw err;
  }
}

/** A site command as a flow step; credential args become `${name}` placeholders. */
export function siteRecord(site: string, command: string, args: Record<string, unknown>, access?: 'read' | 'write'): { record: WebStep; note?: string } {
  const { args: safe, masked } = maskArgs(args);
  return { record: { do: 'site', site, command, args: safe, ...(access && { access }) }, ...(masked.length && { note: `masked args: ${masked.join(', ')} (pass them as flow_run vars)` }) };
}
