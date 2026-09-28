/**
 * Playwright code for what happened in a session: every tab_act/goto/expect (and every recorded user action) becomes
 * a language-neutral CodeStep; this module renders steps as Playwright JavaScript (@playwright/test) or Python
 * (pytest-playwright). Locator expressions come from the page (Playwright's asLocator over the replay selector the
 * engine generated for the element it actually touched), so the code names the same element the action hit.
 */
import type { FrameStep } from '../protocol.js';
import type { Locators } from '../shared/page-contract.js';
import { parseKey } from '../shared/engine.js';

export type CodeLanguage = 'javascript' | 'python';
export const CODE_LANGUAGES: readonly CodeLanguage[] = ['javascript', 'python'];

/** Where an action landed: locator code (preferred), a raw selector, or a viewport point. */
export interface CodeTarget {
  locator?: Locators;
  selector?: string;
  /** iframes entered first, outermost first: css selector of the <iframe> or its index among `iframe,frame` */
  frame?: FrameStep[];
  /** set when the frame path is unknown (a cross-origin parent hid it): the frame's own URL */
  frameUrl?: string;
  point?: { x: number; y: number };
}

export type CodeAction = 'click' | 'dblclick' | 'hover' | 'focus' | 'fill' | 'type' | 'press' | 'select' | 'check' | 'uncheck' | 'upload' | 'drag' | 'scroll';

export type CodeStep =
  | { kind: 'open'; page: string; url?: string; /** an existing user tab: the script cannot recreate its state, only its URL */ claimed?: boolean }
  | { kind: 'goto'; page: string; url: string }
  | { kind: 'history'; page: string; op: 'back' | 'forward' | 'reload' }
  | { kind: 'close'; page: string }
  | {
    kind: 'act'; page: string; action: CodeAction; target?: CodeTarget;
    value?: string; /** a password/OTP/card field: rendered as an environment variable, never as its value */ secret?: boolean;
    values?: string[]; files?: string[]; to?: CodeTarget; direction?: 'up' | 'down' | 'left' | 'right'; amount?: number;
    /** click only: HTMLElement.click() instead of a real mouse event */ dom?: boolean;
    button?: 'left' | 'middle' | 'right'; modifiers?: number; clickCount?: number;
    /** page ids of popups this action opened, a started download, a native dialog it raised */
    popups?: string[]; download?: boolean; dialog?: { accept: boolean; promptText?: string };
    /** recorded file names: the page never sees real paths */ fileNamesOnly?: boolean;
  }
  | { kind: 'expect'; page: string; text?: string; notText?: string; url?: string; title?: string; target?: CodeTarget; visible?: boolean };

/** Rendering state shared by the steps of one script: page variable names and secret numbering. */
export class CodeContext {
  private readonly names = new Map<string, string>();
  private secrets = 0;
  private downloads = 0;
  usedSecrets = false;
  usedRegex = false;
  constructor(readonly lang: CodeLanguage) {}
  pageVar(page: string): string {
    let v = this.names.get(page);
    if (!v) { v = this.names.size === 0 ? 'page' : `page${this.names.size}`; this.names.set(page, v); }
    return v;
  }
  known(page: string): boolean { return this.names.has(page); }
  /** download, download1, … so several downloads in one script never redeclare a variable */
  downloadVar(): string { return this.downloads++ === 0 ? 'download' : `download${this.downloads - 1}`; }
  secret(): string {
    this.usedSecrets = true;
    const name = `SECRET_${++this.secrets}`;
    return this.lang === 'javascript' ? `process.env.${name} ?? ''` : `os.environ.get(${str(name)}, "")`;
  }
}

/** A string literal: JSON escapes are valid in both languages; JavaScript keeps Playwright's single-quote style. */
function str(s: string, lang: CodeLanguage = 'python'): string {
  if (lang === 'python') return JSON.stringify(s);
  return `'${JSON.stringify(s).slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "\\'")}'`;
}
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

const MODIFIER_NAMES: Array<[number, string]> = [[1, 'Alt'], [2, 'Control'], [4, 'Meta'], [8, 'Shift']];
function modifierList(mask = 0): string[] { return MODIFIER_NAMES.filter(([bit]) => mask & bit).map(([, name]) => name); }
/** A Playwright key combination from a key name and a modifier mask, e.g. Control+Shift+KeyA. */
export function playwrightKey(key: string, modifiers = 0): string {
  const name = key === ' ' ? 'Space' : key;
  return [...modifierList(modifiers), name].join('+');
}
/** tab_act press values (`enter`, `ctrl+a`) in Playwright's key syntax. */
export function keyFromSpec(spec: string): string { const { def, modifiers } = parseKey(spec); return playwrightKey(def.key, modifiers); }

function frameChain(ctx: CodeContext, t: CodeTarget): string {
  const content = ctx.lang === 'javascript' ? '.contentFrame()' : '.content_frame';
  let out = '';
  if (t.frame?.length) {
    for (const step of t.frame) out += typeof step === 'number' ? `.locator(${str('iframe, frame', ctx.lang)}).nth(${step})${content}` : `.locator(${str(step, ctx.lang)})${content}`;
  } else if (t.frameUrl) {
    // no path through a cross-origin parent: match the frame element by its URL
    let hint = t.frameUrl; try { const u = new URL(t.frameUrl); hint = `${u.host}${u.pathname}`; } catch { /* keep the raw url */ }
    out += `.locator(${str(`iframe[src*=${JSON.stringify(hint)}]`, ctx.lang)})${content}`;
  }
  return out;
}

/** `page.getByRole(...)` for a target, or null when the target is a bare point. */
function locatorExpr(ctx: CodeContext, page: string, t: CodeTarget | undefined): string | null {
  if (!t) return null;
  const code = t.locator?.[ctx.lang] ?? (t.selector ? `locator(${str(t.selector, ctx.lang)})` : null);
  if (!code) return null;
  return `${ctx.pageVar(page)}${frameChain(ctx, t)}.${code}`;
}

function jsOptions(entries: Array<[string, string | undefined]>): string {
  const set = entries.filter(([, v]) => v !== undefined);
  return set.length ? `{ ${set.map(([k, v]) => `${k}: ${v}`).join(', ')} }` : '';
}
function pyKwargs(entries: Array<[string, string | undefined]>): string {
  return entries.filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`).join(', ');
}
function call(ctx: CodeContext, expr: string, jsMethod: string, pyMethod: string, args: string[] = [], opts: Array<[string, string | undefined]> = []): string {
  if (ctx.lang === 'javascript') {
    const o = jsOptions(opts);
    return `await ${expr}.${jsMethod}(${[...args, ...(o ? [o] : [])].join(', ')});`;
  }
  const kw = pyKwargs(opts.map(([k, v]) => [k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), v]));
  return `${expr}.${pyMethod}(${[...args, ...(kw ? [kw] : [])].join(', ')})`;
}
const list = (ctx: CodeContext, xs: string[]) => `[${xs.map((x) => str(x, ctx.lang)).join(', ')}]`;

function actLines(ctx: CodeContext, s: Extract<CodeStep, { kind: 'act' }>): string[] {
  const p = ctx.pageVar(s.page);
  const loc = locatorExpr(ctx, s.page, s.target);
  const js = ctx.lang === 'javascript';
  const pt = s.target?.point;
  const mods = modifierList(s.modifiers);
  const clickOpts: Array<[string, string | undefined]> = [
    ['button', s.button && s.button !== 'left' ? str(s.button, ctx.lang) : undefined],
    ['modifiers', mods.length ? list(ctx, mods) : undefined],
  ];
  if (!loc) {
    // a viewport point: the mouse is the only faithful replay
    if (!pt) return [`${js ? '//' : '#'} ${s.action}: no locator was recorded for this target`];
    const xy = [String(Math.round(pt.x)), String(Math.round(pt.y))];
    if (s.action === 'click') return [call(ctx, `${p}.mouse`, 'click', 'click', xy, clickOpts.slice(0, 1))];
    if (s.action === 'dblclick') return [call(ctx, `${p}.mouse`, 'dblclick', 'dblclick', xy)];
    if (s.action === 'hover') return [call(ctx, `${p}.mouse`, 'move', 'move', xy)];
    if (s.action === 'scroll') return [call(ctx, `${p}.mouse`, 'move', 'move', xy), wheel(ctx, p, s)];
    return [`${js ? '//' : '#'} ${s.action} at ${xy.join(',')}: no locator was recorded for this target`];
  }
  switch (s.action) {
    case 'click':
      if (s.dom) return [js ? `await ${loc}.evaluate(el => el.click());` : `${loc}.evaluate("el => el.click()")`];
      if ((s.clickCount ?? 1) === 2) return [call(ctx, loc, 'dblclick', 'dblclick', [], clickOpts)];
      return [call(ctx, loc, 'click', 'click', [], [...clickOpts, ['clickCount', (s.clickCount ?? 1) > 2 ? String(s.clickCount) : undefined]])];
    case 'dblclick': return [call(ctx, loc, 'dblclick', 'dblclick')];
    case 'hover': return [call(ctx, loc, 'hover', 'hover')];
    case 'focus': return [call(ctx, loc, 'focus', 'focus')];
    case 'check': return [call(ctx, loc, 'check', 'check')];
    case 'uncheck': return [call(ctx, loc, 'uncheck', 'uncheck')];
    case 'fill': return [call(ctx, loc, 'fill', 'fill', [s.secret ? ctx.secret() : str(s.value ?? '', ctx.lang)])];
    case 'type': return [call(ctx, loc, 'pressSequentially', 'press_sequentially', [s.secret ? ctx.secret() : str(s.value ?? '', ctx.lang)])];
    case 'press': return [call(ctx, loc, 'press', 'press', [str(s.value ?? '', ctx.lang)])];
    case 'select': {
      const values = s.values ?? (s.value !== undefined ? [s.value] : []);
      return [call(ctx, loc, 'selectOption', 'select_option', [values.length === 1 ? str(values[0], ctx.lang) : list(ctx, values)])];
    }
    case 'upload': {
      const note = s.fileNamesOnly ? [`${js ? '//' : '#'} the page only reports file names: replace them with paths on your machine`] : [];
      return [...note, call(ctx, loc, 'setInputFiles', 'set_input_files', [list(ctx, s.files ?? [])])];
    }
    case 'drag': {
      const to = locatorExpr(ctx, s.page, s.to);
      if (!to) return [`${js ? '//' : '#'} drag: no locator was recorded for the drop target`];
      return [call(ctx, loc, 'dragTo', 'drag_to', [to])];
    }
    case 'scroll': return [call(ctx, loc, 'hover', 'hover'), wheel(ctx, p, s)];
  }
}

function wheel(ctx: CodeContext, p: string, s: Extract<CodeStep, { kind: 'act' }>): string {
  const amount = s.amount ?? 600; const dir = s.direction ?? 'down';
  const dx = dir === 'left' ? -amount : dir === 'right' ? amount : 0; const dy = dir === 'up' ? -amount : dir === 'down' ? amount : 0;
  return call(ctx, `${p}.mouse`, 'wheel', 'wheel', [String(dx), String(dy)]);
}

/** Wrap an action in the waits for what it triggers: popups, a download, a native dialog. */
function withEffects(ctx: CodeContext, s: Extract<CodeStep, { kind: 'act' }>, lines: string[]): string[] {
  const p = ctx.pageVar(s.page);
  const js = ctx.lang === 'javascript';
  const pre: string[] = []; const post: string[] = [];
  let body = lines;
  if (s.dialog) {
    const answer = s.dialog.accept ? `accept(${s.dialog.promptText !== undefined ? str(s.dialog.promptText, ctx.lang) : ''})` : 'dismiss()';
    pre.push(js ? `${p}.once('dialog', dialog => dialog.${answer}.catch(() => {}));` : `${p}.once("dialog", lambda dialog: dialog.${answer})`);
  }
  if (s.download) {
    const v = ctx.downloadVar();
    if (js) { pre.push(`const ${v}Promise = ${p}.waitForEvent('download');`); post.push(`const ${v} = await ${v}Promise;`); }
    else { body = [`with ${p}.expect_download() as ${v}_info:`, ...body.map((l) => `    ${l}`)]; post.push(`${v} = ${v}_info.value`); }
  }
  for (const popup of s.popups ?? []) {
    if (ctx.known(popup)) continue;
    const v = ctx.pageVar(popup);
    if (js) { pre.push(`const ${v}Promise = ${p}.waitForEvent('popup');`); post.push(`const ${v} = await ${v}Promise;`); }
    else { body = [`with ${p}.expect_popup() as ${v}_info:`, ...body.map((l) => `    ${l}`)]; post.push(`${v} = ${v}_info.value`); }
  }
  return [...pre, ...body, ...post];
}
function expectLines(ctx: CodeContext, s: Extract<CodeStep, { kind: 'expect' }>): string[] {
  const p = ctx.pageVar(s.page);
  const js = ctx.lang === 'javascript';
  const out: string[] = [];
  const e = (subject: string, jsM: string, pyM: string, arg?: string) => js ? `await expect(${subject}).${jsM}(${arg ?? ''});` : `expect(${subject}).${pyM}(${arg ?? ''})`;
  const re = (s: string) => { if (js) return `/${escapeRegExp(s)}/`; ctx.usedRegex = true; return `re.compile(${str(escapeRegExp(s))})`; };
  const body = `${p}.locator(${str('body', ctx.lang)})`;
  if (s.text !== undefined) out.push(e(body, 'toContainText', 'to_contain_text', str(s.text, ctx.lang)));
  if (s.notText !== undefined) out.push(e(body, 'not.toContainText', 'not_to_contain_text', str(s.notText, ctx.lang)));
  if (s.url !== undefined) out.push(e(p, 'toHaveURL', 'to_have_url', re(s.url)));
  if (s.title !== undefined) out.push(e(p, 'toHaveTitle', 'to_have_title', re(s.title)));
  const loc = locatorExpr(ctx, s.page, s.target);
  if (loc) out.push(s.visible === false ? e(loc, 'toBeHidden', 'to_be_hidden') : e(loc, 'toBeVisible', 'to_be_visible'));
  return out;
}

/** Code for one step. Keep one CodeContext across the steps of a script so page variables stay consistent. */
export function renderStep(ctx: CodeContext, s: CodeStep): string[] {
  const js = ctx.lang === 'javascript';
  switch (s.kind) {
    case 'open': {
      const first = !ctx.known(s.page) && ctx.pageVar(s.page) === 'page';
      const v = ctx.pageVar(s.page);
      const lines: string[] = [];
      if (!first) lines.push(js ? `const ${v} = await context.newPage();` : `${v} = page.context.new_page()`);
      if (s.claimed) lines.push(`${js ? '//' : '#'} a tab the user already had open: its logged-in state is not part of this script`);
      if (s.url) lines.push(call(ctx, v, 'goto', 'goto', [str(s.url, ctx.lang)]));
      return lines;
    }
    case 'goto': return [call(ctx, ctx.pageVar(s.page), 'goto', 'goto', [str(s.url, ctx.lang)])];
    case 'history': return [s.op === 'reload' ? call(ctx, ctx.pageVar(s.page), 'reload', 'reload') : s.op === 'back' ? call(ctx, ctx.pageVar(s.page), 'goBack', 'go_back') : call(ctx, ctx.pageVar(s.page), 'goForward', 'go_forward')];
    case 'close': return [call(ctx, ctx.pageVar(s.page), 'close', 'close')];
    case 'expect': return expectLines(ctx, s);
    case 'act': {
      ctx.pageVar(s.page);
      return withEffects(ctx, s, actLines(ctx, s));
    }
  }
}

/** Code for one step on its own, as a tool result shows it. */
export function stepCode(s: CodeStep, lang: CodeLanguage = 'javascript'): string {
  return renderStep(new CodeContext(lang), s).join('\n');
}

/** A runnable test file: @playwright/test for JavaScript, pytest-playwright for Python. */
export function renderScript(steps: CodeStep[], lang: CodeLanguage, opts: { title?: string } = {}): string {
  const ctx = new CodeContext(lang);
  const body = steps.flatMap((s) => renderStep(ctx, s));
  const title = opts.title ?? 'recorded flow';
  if (lang === 'javascript') {
    return [
      `import { test, expect } from '@playwright/test';`,
      '',
      `test(${str(title, 'javascript')}, async ({ page, context }) => {`,
      ...body.map((l) => `  ${l}`),
      '});',
      '',
    ].join('\n');
  }
  const imports = [ctx.usedSecrets ? 'import os' : '', ctx.usedRegex ? 'import re' : ''].filter(Boolean);
  const fn = `test_${title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'flow'}`;
  return [
    ...imports,
    'from playwright.sync_api import Page, expect',
    '',
    '',
    `def ${fn}(page: Page) -> None:`,
    ...(body.length ? body.map((l) => `    ${l}`) : ['    pass']),
    '',
  ].join('\n');
}
