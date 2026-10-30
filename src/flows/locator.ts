/**
 * Locator candidates for one element, most durable first (testid → stable id → href → role+name → label/placeholder
 * → text → the engine's generated selector), each re-run through the same engine to report how many elements it matches.
 */
import { ActionError } from '../api/errors.js';
import type { Tab, Target } from '../api/tab.js';
import type { FindEntry, FindResult } from '../shared/page-contract.js';
import { selectorToLocator } from './playwright.js';

export interface LocatorCandidate { kind: string; selector: string; locator: string; matches: number; visible: number; unique: boolean; sameElement: boolean }

const GENERATED_ID = /\d{4,}|[a-f0-9]{8,}|^(:r|radix-|mui-|react-|ember|ext-gen|yui_)/i;
const quoted = (s: string): string => JSON.stringify(s);
const cssAttr = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

export function candidateSelectors(e: FindEntry): Array<{ kind: string; selector: string }> {
  const out: Array<{ kind: string; selector: string }> = [];
  const a = e.attrs;
  if (a['data-testid']) out.push({ kind: 'testid', selector: `internal:testid=[data-testid=${quoted(a['data-testid'])}s]` });
  if (a.id && /^[A-Za-z][\w-]*$/.test(a.id) && !GENERATED_ID.test(a.id)) out.push({ kind: 'id', selector: `#${a.id}` });
  if (e.tag === 'a' && a.href && !/^javascript:/i.test(a.href)) out.push({ kind: 'href', selector: `a[href="${cssAttr(a.href)}"]` });
  if (a.name && ['input', 'select', 'textarea', 'button'].includes(e.tag)) out.push({ kind: 'name', selector: `${e.tag}[name="${cssAttr(a.name)}"]` });
  if (e.role && e.name) {
    out.push({ kind: 'role', selector: `internal:role=${e.role}[name=${quoted(e.name)}i]` });
    out.push({ kind: 'role-exact', selector: `internal:role=${e.role}[name=${quoted(e.name)}s]` });
  }
  if (a['aria-label']) out.push({ kind: 'label', selector: `internal:label=${quoted(a['aria-label'])}i` });
  if (a.placeholder) out.push({ kind: 'placeholder', selector: `internal:attr=[placeholder=${quoted(a.placeholder)}i]` });
  const text = e.text.trim();
  if (text && text.length <= 60 && !['input', 'textarea', 'select'].includes(e.tag)) out.push({ kind: 'text', selector: `internal:text=${quoted(text)}i` });
  if (e.selector && !out.some((c) => c.selector === e.selector)) out.push({ kind: 'generated', selector: e.selector });
  return out;
}

const sameAs = (x: FindEntry, y: FindEntry): boolean => x.ref && y.ref ? x.ref === y.ref
  : x.tag === y.tag && x.box.x === y.box.x && x.box.y === y.box.y && x.box.w === y.box.w && x.box.h === y.box.h;

export async function locatorCandidates(tab: Tab, target: Target): Promise<{ element: Record<string, unknown>; candidates: LocatorCandidate[]; recommended?: LocatorCandidate }> {
  if ('x' in target) throw new ActionError('invalid_target', 'tab_locator needs an element target, not a point', 'Pass a ref from tab_observe or a selector/role/label/text.');
  const frame = 'frame' in target ? target.frame : undefined;
  const found = await tab.find({ ...target, limit: 5 }) as FindResult;
  if (!found.entries.length) throw new ActionError('not_found', 'The target matches no element', 'Observe again and pass a current ref.');
  if (found.visible_n > 1) throw new ActionError('selector_ambiguous', `${found.visible_n} visible elements match the target`, 'Pass the exact element (a ref from tab_observe) to get its locators.', { details: { entries: found.entries.slice(0, 5).map((e) => ({ ref: e.ref, role: e.role, name: e.name, text: e.text })) } });
  const element = found.entries.find((e) => e.visible) ?? found.entries[0];
  const candidates: LocatorCandidate[] = [];
  for (const c of candidateSelectors(element)) {
    const r = await tab.find({ selector: c.selector, ...(frame !== undefined && { frame }), limit: 2 }).catch(() => null) as FindResult | null;
    if (!r) continue;
    const visible = r.visible_n;
    const unique = r.matches_n === 1 || visible === 1;
    candidates.push({ ...c, locator: selectorToLocator(c.selector), matches: r.matches_n, visible, unique, sameElement: r.entries.some((e) => sameAs(e, element)) });
  }
  const recommended = candidates.find((c) => c.unique && c.sameElement);
  // a copy: the result is serialized, and a repeated object reference would read as circular
  return { element: { tag: element.tag, role: element.role, name: element.name, text: element.text, ref: element.ref, attrs: element.attrs }, candidates, ...(recommended && { recommended: { ...recommended } }) };
}
