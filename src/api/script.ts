/**
 * The session script: every browser step the session takes (open/goto/history/act/expect/close) is kept as a
 * language-neutral CodeStep, so the whole session can be exported as a Playwright test (session_export_script) and
 * every tab_act result carries the code for its own step.
 */
import type { ActResult, FrameStep } from '../protocol.js';
import { frameSteps } from '../shared/engine.js';
import { keyFromSpec, renderScript, stepCode, type CodeAction, type CodeLanguage, type CodeStep, type CodeTarget } from '../codegen/playwright.js';
import type { SessionContext } from './context.js';
import type { ActOptions, Target } from './tab.js';

/** Enough for long sessions; the oldest steps drop first and the export says so. */
export const SCRIPT_MAX_STEPS = 2000;

export function noteStep(ctx: SessionContext, step: CodeStep): void {
  const script = ctx.state.script;
  script.push(step);
  if (script.length > SCRIPT_MAX_STEPS) { script.splice(0, script.length - SCRIPT_MAX_STEPS); ctx.state.scriptTruncated = true; }
}

function frameOf(target: Target | undefined): FrameStep[] | undefined {
  const frame = target && 'frame' in target ? (target as { frame?: FrameStep | FrameStep[] }).frame : undefined;
  const steps = frameSteps(frame);
  return steps.length ? steps : undefined;
}

/** The target as generated code sees it: the locator of the element the engine touched, inside the same frames. */
export function codeTarget(target: Target | undefined, resolved: { selector?: string; locator?: CodeTarget['locator'] }): CodeTarget | undefined {
  if (!target) return undefined;
  const t = target as { x?: number; y?: number };
  if (typeof t.x === 'number' && typeof t.y === 'number') return { point: { x: t.x, y: t.y } };
  return { ...(resolved.locator && { locator: resolved.locator }), ...(resolved.selector && { selector: resolved.selector }), ...(frameOf(target) && { frame: frameOf(target) }) };
}

/** The CodeStep for one completed act, or undefined for actions without a Playwright equivalent. */
export function actStep(page: string, opts: ActOptions, r: ActResult): CodeStep | undefined {
  const action = opts.action;
  if (action === 'back' || action === 'forward' || action === 'reload') return { kind: 'history', page, op: action };
  const target = codeTarget(opts.target, { selector: r.selector, locator: r.locator });
  const step: Extract<CodeStep, { kind: 'act' }> = { kind: 'act', page, action: action as CodeAction, ...(target && { target }) };
  // a secret field's value is not kept in the session script at all; code reads it from SECRET_n
  if (action === 'fill' || action === 'type') { if (r.secret) { step.secret = true; step.value = ''; } else step.value = opts.value ?? ''; }
  if (action === 'press' && opts.value) step.value = keyFromSpec(opts.value);
  // the option values the page actually selected: exact even when the agent passed a label or an index
  if (action === 'select') { if (r.selected?.length) step.values = r.selected; else if (opts.value !== undefined) step.value = opts.value; }
  if (action === 'upload') step.files = opts.files ?? [];
  if (action === 'drag') step.to = codeTarget(opts.to, { selector: r.toSelector, locator: r.toLocator });
  if (action === 'scroll') { step.direction = opts.direction ?? 'down'; step.amount = opts.amount ?? 600; }
  if (action === 'click' && r.method === 'dom') step.dom = true;
  const popups = (r.openedTabs ?? []).map((t) => t.page).filter((p): p is string => Boolean(p));
  if (popups.length) step.popups = popups;
  if (r.download?.started?.length) step.download = true;
  return step;
}

/** The code of one step, rendered on its own (page variables start at `page`). */
export function codeOf(step: CodeStep, lang: CodeLanguage = 'javascript'): string { return stepCode(step, lang); }

export interface ExportedScript { language: CodeLanguage; steps: number; truncated?: true; code: string }

/** The session's steps (optionally only one tab's) as a runnable test file. */
export function exportScript(ctx: SessionContext, opts: { language?: CodeLanguage; tab?: string; title?: string } = {}): ExportedScript {
  const language = opts.language ?? 'javascript';
  const steps = ctx.state.script.filter((s) => !opts.tab || s.page === opts.tab);
  return { language, steps: steps.length, ...(ctx.state.scriptTruncated && { truncated: true as const }), code: renderScript(steps, language, { title: opts.title ?? ctx.state.name ?? undefined }) };
}
