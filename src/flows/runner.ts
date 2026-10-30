/**
 * flow_run: replay a web flow through the same Tab API the agent uses, step by step. A failing step pauses the run:
 * the tab stays in the session and the report carries the error, the page state, console errors and recent requests,
 * so the agent can repair the page or the step and continue with `from`. Replayed steps are journaled with their
 * intents, so after a repair `journal export {since: journalFrom}` is the repaired flow.
 * Write site commands pause with write_blocked unless allowWrites; a delivered write is never retried here.
 */
import { ActionError } from '../api/errors.js';
import type { Tab, Target, ActOptions } from '../api/tab.js';
import type { Expectation } from '../shared/page-contract.js';
import { checkAll, substitute } from './json-expect.js';
import type { Journal, StepMeta } from './journal.js';
import { networkExpect } from './network-expect.js';
import type { WebFlow, WebStep } from './schema.js';

export interface FlowHost {
  openTab(url: string, meta: StepMeta): Promise<Tab>;
  runSite(site: string, command: string, args: Record<string, unknown>, meta: StepMeta): Promise<unknown>;
  access(site: string, command: string): Promise<'read' | 'write' | undefined>;
  journal?: Journal;
  signal?: AbortSignal;
}

export interface FlowRunOptions { tab?: Tab; from?: number; until?: number; allowWrites?: boolean; skipSeed?: boolean; vars?: Record<string, unknown>; stepTimeoutMs?: number }

export interface StepOutcome { index: number; do: WebStep['do'] | 'seed'; intent?: string; ok: boolean; ms: number; value?: unknown }

export interface FlowRunReport {
  status: 'passed' | 'paused';
  flow: string;
  tab?: string;
  steps: StepOutcome[];
  journalFrom: number;
  ms: number;
  failedAt?: number;
  step?: WebStep | { do: 'seed' };
  error?: { code: string; message: string; hint?: string; details?: unknown };
  page?: { url: string | null; title: string | null; state?: string; snapshotId?: string };
  console?: unknown[];
  network?: unknown[];
  resume?: { from: number; retry: number; note: string };
}

const UNRESOLVED = /\$\{([^}]+)\}/;

function unresolved(value: unknown): string | null {
  if (typeof value === 'string') { const m = UNRESOLVED.exec(value); return m ? m[1] : null; }
  if (Array.isArray(value)) { for (const v of value) { const n = unresolved(v); if (n) return n; } return null; }
  if (value && typeof value === 'object') { for (const v of Object.values(value)) { const n = unresolved(v); if (n) return n; } }
  return null;
}

async function evidence(tab: Tab | undefined): Promise<Pick<FlowRunReport, 'page' | 'console' | 'network'>> {
  if (!tab) return {};
  const out: Pick<FlowRunReport, 'page' | 'console' | 'network'> = {};
  try {
    const o = await tab.observe();
    out.page = { url: o.url, title: o.title, state: o.state, snapshotId: o.snapshotId };
  } catch {
    out.page = { url: await tab.url().catch(() => null), title: await tab.title().catch(() => null) };
  }
  try {
    const logs = await tab.console.read({ levels: ['error'], limit: 500 }) as { entries?: unknown[] };
    if (Array.isArray(logs.entries)) out.console = logs.entries.slice(-10);
  } catch { /* console capture not available */ }
  try {
    const net = await tab.network.list({ limit: 1000 });
    out.network = net.entries.slice(-10);
  } catch { /* network capture not available */ }
  return out;
}

export async function runFlow(flow: WebFlow, host: FlowHost, opts: FlowRunOptions = {}): Promise<FlowRunReport> {
  const started = Date.now();
  const vars = opts.vars ?? {};
  const from = opts.from ?? 0;
  const until = Math.min(opts.until ?? flow.steps.length - 1, flow.steps.length - 1);
  if (from < 0 || from > flow.steps.length) throw new ActionError('invalid_args', `from must be between 0 and ${flow.steps.length}`);
  const journalFrom = host.journal?.cursor ?? 0;
  const steps: StepOutcome[] = [];
  let tab = opts.tab;
  /** network cursor before the latest action: what a following network step searches after */
  let netCursor: number | undefined;
  const timeoutMs = (s?: number): number => s !== undefined ? s * 1000 : opts.stepTimeoutMs ?? 10_000;

  const pause = async (index: number, step: WebFlow['steps'][number] | { do: 'seed' }, err: unknown): Promise<FlowRunReport> => {
    const e = err as { code?: string; message?: string; hint?: string; data?: Record<string, unknown> };
    const code = e.code ?? 'error';
    // the page state is reported once, below; keep the error's own findings (failed checks, candidates)
    const { state: _state, ...data } = e.data && typeof e.data === 'object' ? e.data : {};
    const details = 'details' in data ? data.details : Object.keys(data).length ? data : undefined;
    const delivered = code === 'command_outcome_unknown';
    return {
      status: 'paused', flow: flow.name, ...(tab && { tab: tab.id }), steps, journalFrom, ms: Date.now() - started,
      failedAt: index, step, error: { code, message: String(e.message ?? err), ...(e.hint && { hint: e.hint }), ...(details !== undefined && { details }) },
      ...(await evidence(tab)),
      resume: index < 0 ? { from: 0, retry: 0, note: 'The seed failed: repair the starting state, then run again (skipSeed:true when you prepared it yourself).' } : {
        from: index + 1, retry: index,
        note: delivered
          ? 'The step may already have reached the site: observe before deciding; never retry it blindly. Continue with from = failedAt + 1 once its effect is confirmed.'
          : 'Repair with the existing tools (tab_observe, tab_locator, tab_act with the same intent), then flow_run with from: resume.from to continue after it, or from: resume.retry to run the step again.',
      },
    };
  };

  // ── seed ──
  if (flow.seed && from === 0 && !opts.skipSeed) {
    const seed = substitute(flow.seed, vars);
    const t0 = Date.now();
    try {
      let url = seed.url;
      if (seed.command) {
        const site = seed.site ?? flow.site;
        if (!site) throw new ActionError('invalid_flow', 'seed.command needs seed.site or flow.site');
        const missing = unresolved(seed.args);
        if (missing) throw new ActionError('missing_var', `seed args need the variable "${missing}"`, 'Pass it in vars.');
        if (await host.access(site, seed.command) === 'write' && !opts.allowWrites) throw new ActionError('write_blocked', `seed ${site}/${seed.command} is a write command`, 'Pass allowWrites:true to run write commands, or prepare the state and pass skipSeed:true.');
        const value = await host.runSite(site, seed.command, seed.args ?? {}, { intent: 'seed' });
        const seededUrl = value && typeof value === 'object' ? (value as { url?: unknown }).url : undefined;
        if (!url && typeof seededUrl === 'string') url = seededUrl;
      }
      if (url) { if (tab) await tab.goto(url, { intent: 'seed' }); else tab = await host.openTab(url, { intent: 'seed' }); }
      steps.push({ index: -1, do: 'seed', intent: 'seed', ok: true, ms: Date.now() - t0 });
    } catch (err) {
      steps.push({ index: -1, do: 'seed', intent: 'seed', ok: false, ms: Date.now() - t0 });
      return pause(-1, { do: 'seed' }, err);
    }
  }

  for (let i = from; i <= until; i++) {
    if (host.signal?.aborted) return pause(i, flow.steps[i], new ActionError('cancelled', 'flow_run was cancelled'));
    const step = substitute(flow.steps[i], vars);
    const meta: StepMeta = { intent: step.intent, step: step.step };
    const t0 = Date.now();
    let value: unknown;
    try {
      const missing = unresolved(step.do === 'site' ? step.args : step.do === 'act' ? [step.value, step.files] : step.do === 'goto' ? step.url : undefined);
      if (missing) throw new ActionError('missing_var', `step needs the variable "${missing}"`, 'Pass it in vars (credentials are recorded as ${name} placeholders).');
      if (step.do === 'site') {
        const access = step.access ?? await host.access(step.site, step.command);
        if (access === 'write' && !opts.allowWrites) throw new ActionError('write_blocked', `${step.site}/${step.command} is a write command`, 'Pass allowWrites:true to replay write commands; each replay spends what the command spends.');
        value = await host.runSite(step.site, step.command, step.args ?? {}, meta);
        if (step.expect?.length) {
          const r = checkAll(value, step.expect, vars);
          if (!r.ok) throw new ActionError('expectation_failed', `${step.site}/${step.command} result did not satisfy ${r.failures.length} assertion(s)`, undefined, { details: { failures: r.failures } });
        }
      } else if (!tab) {
        if (step.do !== 'goto') throw new ActionError('no_tab', 'The flow has no page yet', 'Start the flow with a goto step or a seed url, or pass tab.');
        tab = await host.openTab(step.url, meta);
      } else if (step.do === 'goto') {
        await tab.goto(step.url, meta);
      } else if (step.do === 'act') {
        const { do: _do, intent: _intent, step: _step, ...act } = step;
        const original = flow.steps[i] as typeof step;
        const recordValue = original.value !== undefined && original.value !== act.value ? original.value : undefined;
        const r = await tab.act({ ...act, target: act.target as Target | undefined, to: act.to as Target | undefined, timeoutMs: opts.stepTimeoutMs, ...meta, ...(recordValue !== undefined && { recordValue }) } as ActOptions);
        const network = r.network as { afterSequence?: number } | undefined;
        if (network?.afterSequence !== undefined) netCursor = network.afterSequence;
      } else if (step.do === 'expect') {
        value = await tab.expect(step.expect as Expectation, { timeoutMs: timeoutMs(step.timeout), ...meta });
      } else if (step.do === 'network') {
        value = await networkExpectJournaled(tab, step, netCursor, timeoutMs(step.timeout), host, vars, meta);
      }
      steps.push({ index: i, do: step.do, intent: step.intent, ok: true, ms: Date.now() - t0, ...(value !== undefined && step.do === 'site' && { value }) });
    } catch (err) {
      steps.push({ index: i, do: step.do, intent: step.intent, ok: false, ms: Date.now() - t0 });
      return pause(i, flow.steps[i], err);
    }
  }
  return { status: 'passed', flow: flow.name, ...(tab && { tab: tab.id }), steps, journalFrom, ms: Date.now() - started };
}

async function networkExpectJournaled(tab: Tab, step: Extract<WebStep, { do: 'network' }>, after: number | undefined, timeoutMs: number, host: FlowHost, vars: Record<string, unknown>, meta: StepMeta): Promise<unknown> {
  const t0 = Date.now();
  const record: WebStep = { do: 'network', match: step.match, ...(step.timeout !== undefined && { timeout: step.timeout }) };
  try {
    const r = await networkExpect(tab, step.match, { afterSequence: after, timeoutMs, vars, signal: host.signal });
    host.journal?.add({ tab: tab.id, ...meta, ok: true, ms: Date.now() - t0, record });
    return r;
  } catch (err) {
    const e = err as { code?: string; message?: string };
    host.journal?.add({ tab: tab.id, ...meta, ok: false, ms: Date.now() - t0, record, error: { code: e.code ?? 'error', message: String(e.message ?? err).slice(0, 500) } });
    throw err;
  }
}
