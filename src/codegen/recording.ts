/**
 * A recording (the ordered RecordEvents of record_stop) as CodeSteps and as tab_act-shaped replay steps.
 * The merging rules follow Playwright's RecorderSignalProcessor: keystroke fills of one field collapse into the last
 * value, a click superseded by a double click on the same element becomes that double click, a navigation right after
 * a click/press/fill is that action's effect (no goto), and popups, downloads and dialogs attach to the action that
 * raised them.
 */
import type { RecordEvent } from '../protocol.js';
import type { RecordedAction } from '../shared/page-contract.js';
import { playwrightKey, type CodeAction, type CodeStep, type CodeTarget } from './playwright.js';

/** A navigation later than this after the last action is the person's own (address bar, bookmark): it becomes a goto. */
const NAVIGATION_SIGNAL_MS = 5_000;
/** A popup, download or dialog attaches to an action at most this old. */
const EFFECT_WINDOW_MS = 10_000;

type ActStep = Extract<CodeStep, { kind: 'act' }>;

/** How to replay a recorded step with opencli-mcp itself. */
export interface ReplayStep {
  tab: string;
  action: 'goto' | 'click' | 'dblclick' | 'fill' | 'press' | 'select' | 'check' | 'uncheck' | 'upload';
  url?: string;
  /** a tab_act target: the recorded Playwright selector, inside the recorded iframe path */
  target?: { selector: string; frame?: number[] };
  value?: string;
  /** a password/OTP/card field: the value was never recorded */
  secret?: true;
  /** upload: the page only reports file names */
  files?: string[];
  /** what tab_act cannot reproduce: right/middle button, modifier keys, a frame reached through a cross-origin parent */
  note?: string;
}

function targetOf(a: RecordedAction): CodeTarget {
  return { locator: a.locator, selector: a.selector, ...(a.frame?.length && { frame: a.frame }), ...(a.frame === null && a.frameUrl && { frameUrl: a.frameUrl }) };
}

function stepOf(page: string, a: RecordedAction): ActStep | null {
  const base = { kind: 'act' as const, page, target: targetOf(a) };
  switch (a.name) {
    case 'click': return { ...base, action: 'click', ...(a.button && a.button !== 'left' && { button: a.button }), ...(a.modifiers && { modifiers: a.modifiers }), ...(a.clickCount && a.clickCount > 1 && { clickCount: a.clickCount }) };
    case 'check': case 'uncheck': return { ...base, action: a.name };
    case 'fill': return { ...base, action: 'fill', value: a.secret ? '' : a.text ?? '', ...(a.secret && { secret: true }) };
    case 'select': return { ...base, action: 'select', values: a.options ?? [] };
    case 'press': return a.key ? { ...base, action: 'press', value: playwrightKey(a.key, a.modifiers) } : null;
    case 'setInputFiles': return { ...base, action: 'upload' as CodeAction, files: a.files ?? [], fileNamesOnly: true };
    default: return null;
  }
}

const sameTarget = (x: ActStep, y: ActStep) => x.page === y.page && x.target?.selector === y.target?.selector && JSON.stringify(x.target?.frame ?? x.target?.frameUrl ?? null) === JSON.stringify(y.target?.frame ?? y.target?.frameUrl ?? null);

/**
 * CodeSteps for a recording. `start` names the recorded tab and the URL it showed when recording began, so the script
 * starts where the person started.
 */
export function recordingSteps(events: RecordEvent[], start: { page: string; url?: string }): CodeStep[] {
  const steps: CodeStep[] = [{ kind: 'open', page: start.page, ...(start.url && { url: start.url }) }];
  // `as`: assignments happen inside the loop, and a plain `= null` would narrow `last` to null for the checker
  let last = null as { step: ActStep; ts: number; name: RecordedAction['name'] } | null;
  const lastByPage = new Map<string, { step: ActStep; ts: number }>();
  /** popups and pages whose first navigations are their own loading, not something the person typed */
  const quietUntilAction = new Set<string>();
  const lastUrl = new Map<string, string>([[start.page, start.url ?? '']]);
  const pageOf = (e: RecordEvent) => e.page ?? `tab:${e.tabId}`;

  for (const e of events) {
    const page = pageOf(e);
    if (e.type === 'action') {
      const step = stepOf(page, e.action);
      if (!step) continue;
      quietUntilAction.delete(page);
      const prev: ActStep | undefined = last?.step;
      // one field typed key by key: keep the final value
      if (prev && step.action === 'fill' && prev.action === 'fill' && sameTarget(prev, step)) { Object.assign(prev, { value: step.value, secret: step.secret }); if (!step.secret) delete prev.secret; last = { step: prev, ts: e.ts, name: 'fill' }; continue; }
      // a double click arrives as click(1) then click(2) on the same element
      if (prev && step.action === 'click' && prev.action === 'click' && sameTarget(prev, step) && (step.clickCount ?? 1) > (prev.clickCount ?? 1)) { prev.clickCount = step.clickCount; last = { step: prev, ts: e.ts, name: 'click' }; continue; }
      steps.push(step);
      last = { step, ts: e.ts, name: e.action.name };
      lastByPage.set(page, { step, ts: e.ts });
      continue;
    }
    if (e.type === 'navigation') {
      if (quietUntilAction.has(page)) { lastUrl.set(page, e.url); continue; }
      if (lastUrl.get(page) === e.url) continue; // a second commit of the URL we already have
      lastUrl.set(page, e.url);
      const caused = last && last.step.page === page && ['click', 'press', 'fill'].includes(last.name) && e.ts - last.ts <= NAVIGATION_SIGNAL_MS;
      if (caused) continue;
      const prevStep = steps[steps.length - 1];
      if (prevStep?.kind === 'goto' && prevStep.page === page) { prevStep.url = e.url; continue; } // redirects: keep the final URL
      steps.push({ kind: 'goto', page, url: e.url });
      last = null;
      continue;
    }
    const recent = lastByPage.get(page);
    const target = recent && e.ts - recent.ts <= EFFECT_WINDOW_MS ? recent.step : null;
    if (e.type === 'popup') {
      const child = e.childPage ?? `tab:${e.childTabId}`;
      quietUntilAction.add(child);
      if (target) (target.popups ??= []).push(child);
      else steps.push({ kind: 'open', page: child, ...(e.url && { url: e.url }) });
    } else if (e.type === 'download') {
      if (target) target.download = true;
    } else if (e.type === 'dialog') {
      if (target) target.dialog = { accept: e.accepted ?? false, ...(e.promptText !== undefined && { promptText: e.promptText }) };
    }
  }
  return steps;
}

/** The act/goto steps of a recording, as calls to replay with tab_act / tab navigation. */
export function replaySteps(steps: CodeStep[]): ReplayStep[] {
  const out: ReplayStep[] = [];
  for (const s of steps) {
    if (s.kind === 'goto') { out.push({ tab: s.page, action: 'goto', url: s.url }); continue; }
    if (s.kind !== 'act' || !s.target?.selector) continue;
    const target = { selector: s.target.selector, ...(s.target.frame?.length && { frame: s.target.frame.filter((f): f is number => typeof f === 'number') }) };
    const action = s.action === 'click' && (s.clickCount ?? 1) === 2 ? 'dblclick' : s.action;
    if (!['click', 'dblclick', 'fill', 'press', 'select', 'check', 'uncheck', 'upload'].includes(action)) continue;
    const r: ReplayStep = { tab: s.page, action: action as ReplayStep['action'], target };
    if (s.action === 'fill') { if (s.secret) r.secret = true; else r.value = s.value ?? ''; }
    if (s.action === 'press') r.value = s.value;
    if (s.action === 'select') r.value = (s.values ?? [])[0];
    if (s.action === 'upload') r.files = s.files;
    const extra = [s.button && s.button !== 'left' ? `${s.button} button` : '', s.modifiers ? 'modifier keys' : '', s.target.frameUrl ? `inside a frame with no known path (${s.target.frameUrl}); pass its <iframe> as target.frame` : ''].filter(Boolean);
    if (extra.length) r.note = `not replayed exactly by tab_act: ${extra.join('; ')}`;
    out.push(r);
  }
  return out;
}
