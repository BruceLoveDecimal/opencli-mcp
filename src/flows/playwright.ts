/**
 * Export a web flow as a @playwright/test spec. The engine records Playwright's own generated selectors
 * (`internal:role=…`, `internal:testid=…`), which map back to getBy* locators; anything else stays page.locator().
 * Network and site steps have no faithful Playwright equivalent here and are kept as comments (replay them with flow_run).
 */
import type { WebFlow, WebStep } from './schema.js';

type Target = NonNullable<Extract<WebStep, { do: 'act' }>['target']>;

const q = (s: string): string => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** Split a selector on top-level ` >> ` (not inside quotes or brackets). */
export function splitSelector(selector: string): string[] {
  const parts: string[] = [];
  let depth = 0; let quote: string | null = null; let start = 0;
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === '[' || c === '(') depth++;
    else if (c === ']' || c === ')') depth--;
    else if (depth === 0 && selector.startsWith(' >> ', i)) { parts.push(selector.slice(start, i)); start = i + 4; i += 3; }
  }
  parts.push(selector.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** `"text"i` / `"text"s` / `/re/i` → JS argument text plus whether it is exact. */
function textArg(raw: string): { arg: string; exact: boolean } | null {
  const str = /^"((?:[^"\\]|\\.)*)"([is]?)$/.exec(raw);
  if (str) { try { return { arg: q(JSON.parse(`"${str[1]}"`) as string), exact: str[2] === 's' }; } catch { return null; } }
  const re = /^\/(.*)\/([a-z]*)$/.exec(raw);
  if (re) return { arg: `/${re[1]}/${re[2]}`, exact: false };
  return null;
}

const ROLE_OPTIONS: Record<string, string> = { checked: 'checked', disabled: 'disabled', expanded: 'expanded', level: 'level', pressed: 'pressed', selected: 'selected', 'include-hidden': 'includeHidden' };

/** One selector part as a locator method call (without the receiver), or null when it has no getBy* form. */
function partToCall(part: string): string | null {
  let m: RegExpExecArray | null;
  if ((m = /^internal:role=([a-z]+)((?:\[[^\]]*\])*)$/i.exec(part))) {
    const opts: string[] = [];
    for (const attr of m[2].match(/\[[^\]]*\]/g) ?? []) {
      const a = /^\[([a-z-]+)=(.*)\]$/i.exec(attr);
      if (!a) return null;
      if (a[1] === 'name') { const t = textArg(a[2]); if (!t) return null; opts.push(`name: ${t.arg}`); if (t.exact) opts.push('exact: true'); }
      else if (ROLE_OPTIONS[a[1]]) opts.push(`${ROLE_OPTIONS[a[1]]}: ${/^(true|false|\d+)$/.test(a[2]) ? a[2] : q(a[2].replace(/^"|"$/g, ''))}`);
      else return null;
    }
    return `getByRole(${q(m[1])}${opts.length ? `, { ${opts.join(', ')} }` : ''})`;
  }
  if ((m = /^internal:testid=\[([\w-]+)=(.*)\]$/.exec(part))) { const t = textArg(m[2]); return t ? `getByTestId(${t.arg})` : null; }
  if ((m = /^internal:(label|text)=(.*)$/.exec(part))) {
    const t = textArg(m[2]); if (!t) return null;
    return `${m[1] === 'label' ? 'getByLabel' : 'getByText'}(${t.arg}${t.exact ? ', { exact: true }' : ''})`;
  }
  if ((m = /^internal:attr=\[(placeholder|alt|title)=(.*)\]$/.exec(part))) {
    const t = textArg(m[2]); if (!t) return null;
    const fn = { placeholder: 'getByPlaceholder', alt: 'getByAltText', title: 'getByTitle' }[m[1] as 'placeholder' | 'alt' | 'title'];
    return `${fn}(${t.arg}${t.exact ? ', { exact: true }' : ''})`;
  }
  if ((m = /^nth=(-?\d+)$/.exec(part))) return m[1] === '0' ? 'first()' : m[1] === '-1' ? 'last()' : `nth(${m[1]})`;
  if (part === 'internal:control=enter-frame') return 'contentFrame()';
  return null;
}

export function selectorToLocator(selector: string, root = 'page'): string {
  let expr = root;
  for (const part of splitSelector(selector)) expr += `.${partToCall(part) ?? `locator(${q(part)})`}`;
  return expr;
}

function frameRoot(frame: Target['frame'], root = 'page'): string {
  if (frame === undefined) return root;
  const chain = Array.isArray(frame) ? frame : typeof frame === 'string' ? frame.split(/\s*>>\s*/) : [frame];
  let expr = root;
  for (const f of chain) expr += typeof f === 'number' ? `.locator('iframe').nth(${f}).contentFrame()` : `.locator(${q(f)}).contentFrame()`;
  return expr;
}

/** A flow target as a Playwright locator expression. Points ({x,y}) have no locator and return null. */
export function targetToLocator(t: Target): string | null {
  if (t.x !== undefined && t.y !== undefined && !t.selector) return null;
  let root = frameRoot(t.frame);
  if (t.within) root = selectorToLocator(t.within, root);
  let expr: string;
  if (t.selector) expr = selectorToLocator(t.selector, root);
  else if (t.testid) expr = `${root}.getByTestId(${q(t.testid)})`;
  else if (t.role) expr = `${root}.getByRole(${q(t.role)}${t.name ? `, { name: ${q(t.name)} }` : ''})`;
  else if (t.label) expr = `${root}.getByLabel(${q(t.label)})`;
  else if (t.text) expr = `${root}.getByText(${q(t.text)})`;
  else return null;
  if (t.nth !== undefined) expr += t.nth === 0 ? '.first()' : t.nth === -1 ? '.last()' : `.nth(${t.nth})`;
  return expr;
}

const DELTA: Record<string, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

function actLines(s: Extract<WebStep, { do: 'act' }>): string[] {
  if (s.action === 'back') return ['await page.goBack();'];
  if (s.action === 'forward') return ['await page.goForward();'];
  if (s.action === 'reload') return ['await page.reload();'];
  const loc = s.target ? targetToLocator(s.target) : null;
  if (s.action === 'scroll') {
    const [dx, dy] = DELTA[s.direction ?? 'down']; const amount = s.amount ?? 600;
    return [...(loc ? [`await ${loc}.hover();`] : []), `await page.mouse.wheel(${dx * amount}, ${dy * amount});`];
  }
  if (!loc) {
    const t = s.target;
    if (t?.x !== undefined && t.y !== undefined && (s.action === 'click' || s.action === 'dblclick')) return [`await page.mouse.${s.action}(${t.x}, ${t.y});`];
    return [`// not exported: ${s.action} needs a locator (${JSON.stringify(s.target)})`];
  }
  const value = s.value ?? '';
  switch (s.action) {
    case 'fill': return [`await ${loc}.fill(${q(value)});`];
    case 'type': return [`await ${loc}.pressSequentially(${q(value)});`];
    case 'press': return [`await ${loc}.press(${q(value)});`];
    case 'select': return [`await ${loc}.selectOption(${q(value)});`];
    case 'upload': return [`await ${loc}.setInputFiles([${(s.files ?? []).map(q).join(', ')}]);`];
    case 'drag': { const to = s.to ? targetToLocator(s.to) : null; return to ? [`await ${loc}.dragTo(${to});`] : [`// not exported: drag needs a target locator`]; }
    default: return [`await ${loc}.${s.action}();`];
  }
}

function expectLines(s: Extract<WebStep, { do: 'expect' }>): string[] {
  const e = s.expect; const out: string[] = [];
  const timeout = s.timeout ? `, { timeout: ${Math.round(s.timeout * 1000)} }` : '';
  const opt = s.timeout ? `{ timeout: ${Math.round(s.timeout * 1000)} }` : '';
  if (e.text !== undefined) out.push(`await expect(page.locator('body')).toContainText(${q(e.text)}${timeout});`);
  if (e.notText !== undefined) out.push(`await expect(page.locator('body')).not.toContainText(${q(e.notText)}${timeout});`);
  if (e.url !== undefined) out.push(`await expect(page).toHaveURL(/${escapeRegex(e.url)}/${timeout});`);
  if (e.title !== undefined) out.push(`await expect(page).toHaveTitle(/${escapeRegex(e.title)}/${timeout});`);
  if (e.selector !== undefined) {
    const loc = selectorToLocator(e.selector);
    if (e.count !== undefined) out.push(`await expect(${loc}).toHaveCount(${e.count}${timeout});`);
    else if (e.visible === false) out.push(`await expect(${loc}).toBeHidden(${opt});`);
    const one = e.count === undefined ? loc : `${loc}.first()`;
    if (e.value !== undefined) out.push(`await expect(${one}).toHaveValue(${q(e.value)}${timeout});`);
    if (e.enabled !== undefined) out.push(`await expect(${one}).${e.enabled ? 'toBeEnabled' : 'toBeDisabled'}(${opt});`);
    if (e.checked !== undefined) out.push(`await expect(${one}).${e.checked ? '' : 'not.'}toBeChecked(${opt});`);
    if (e.hasText !== undefined) out.push(`await expect(${one}).toContainText(${q(e.hasText)}${timeout});`);
    if (e.visible !== false && e.count === undefined && e.value === undefined && e.enabled === undefined && e.checked === undefined && e.hasText === undefined) out.push(`await expect(${loc}).toBeVisible(${opt});`);
  }
  return out;
}

export function flowToPlaywright(flow: WebFlow): string {
  const body: string[] = [];
  if (flow.seed?.command) body.push(`// seed: ${flow.seed.site ?? flow.site ?? ''}/${flow.seed.command} ${JSON.stringify(flow.seed.args ?? {})} (run it before this test, e.g. in globalSetup)`);
  if (flow.seed?.url) body.push(`await page.goto(${q(flow.seed.url)});`);
  let lastComment: string | undefined;
  flow.steps.forEach((s, i) => {
    const comment = s.intent ? `// ${s.step ? `${s.step}. ` : ''}${s.intent}` : undefined;
    if (comment && comment !== lastComment) body.push(comment);
    lastComment = comment ?? lastComment;
    if (s.do === 'goto') body.push(`await page.goto(${q(s.url)});`);
    else if (s.do === 'act') body.push(...actLines(s));
    else if (s.do === 'expect') body.push(...expectLines(s));
    else if (s.do === 'network') body.push(`// step ${i + 1} network assertion (replay with flow_run): ${JSON.stringify(s.match)}`);
    else body.push(`// step ${i + 1} site command ${s.site}/${s.command} ${JSON.stringify(s.args)} (replay with flow_run)`);
  });
  const header = [`// flow: ${flow.name}${flow.case ? ` · case ${flow.case}` : ''}`, '// generated by opencli-mcp journal export'];
  return [
    "import { test, expect } from '@playwright/test';",
    '',
    ...header,
    `test.describe(${q(flow.site ?? 'flow')}, () => {`,
    `  test(${q(flow.name)}, async ({ page }) => {`,
    ...body.map((l) => `    ${l}`),
    '  });',
    '});',
    '',
  ].join('\n');
}
