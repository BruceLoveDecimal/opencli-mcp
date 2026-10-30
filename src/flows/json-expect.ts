/**
 * JSON assertions shared by suite_run, network_expect and flow steps (the format suite.json already uses).
 * Paths: `a.b`, `a[0]`, `a[*].b` (every item), `a[?k=v]` (items whose k is v; a trailing filter yields the
 * filtered array so `minItems` counts them). `${name}` in an expected value is replaced from `vars`.
 * Mobile-mcp carries the same module; keep the two in step.
 */

export interface JsonExpect {
  path: string;
  equals?: unknown;
  notEquals?: unknown;
  exists?: boolean;
  type?: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'null';
  minItems?: number;
  maxItems?: number;
  contains?: unknown;
  matches?: string;
  /** the value is a JSON string (or object) that has this key */
  jsonHas?: string;
}

export interface ExpectFailure { path: string; op: string; expected: unknown; actual: unknown }
export interface ExpectReport { ok: boolean; failures: ExpectFailure[] }

type Segment = { kind: 'field'; name: string } | { kind: 'index'; index: number } | { kind: 'all' } | { kind: 'filter'; key: string; value: string };

export function parsePath(path: string): Segment[] {
  const out: Segment[] = [];
  const re = /([^.[\]]+)|\[(\d+|\*|\?[^\]=]+=[^\]]*)\]/g;
  let m: RegExpExecArray | null;
  let consumed = 0;
  while ((m = re.exec(path))) {
    const gap = path.slice(consumed, m.index).replace(/\./g, '');
    if (gap) throw new Error(`invalid path "${path}"`);
    consumed = re.lastIndex;
    if (m[1] !== undefined) out.push({ kind: 'field', name: m[1] });
    else if (m[2] === '*') out.push({ kind: 'all' });
    else if (m[2].startsWith('?')) { const eq = m[2].indexOf('='); out.push({ kind: 'filter', key: m[2].slice(1, eq), value: m[2].slice(eq + 1) }); }
    else out.push({ kind: 'index', index: Number(m[2]) });
  }
  if (path.slice(consumed).replace(/\./g, '')) throw new Error(`invalid path "${path}"`);
  return out;
}

const child = (node: unknown, name: string): unknown => node !== null && typeof node === 'object' ? (node as Record<string, unknown>)[name] : undefined;

/** Every value the path reaches. A path without wildcards or filters reaches exactly one value (possibly undefined). */
export function select(root: unknown, path: string): unknown[] {
  const segments = parsePath(path);
  let nodes: unknown[] = [root];
  segments.forEach((seg, i) => {
    const last = i === segments.length - 1;
    if (seg.kind === 'field') nodes = nodes.map((n) => child(n, seg.name));
    else if (seg.kind === 'index') nodes = nodes.map((n) => Array.isArray(n) ? n.at(seg.index) : undefined);
    else if (seg.kind === 'all') nodes = nodes.flatMap((n) => Array.isArray(n) ? n : []);
    else {
      const filtered = nodes.map((n) => Array.isArray(n) ? n.filter((item) => String(child(item, seg.key)) === seg.value) : []);
      nodes = last ? filtered : filtered.flat();
    }
  });
  return nodes;
}

export function substitute<T>(value: T, vars: Record<string, unknown>): T {
  if (typeof value === 'string') {
    const whole = /^\$\{([^}]+)\}$/.exec(value);
    if (whole && whole[1] in vars) return vars[whole[1]] as T;
    return value.replace(/\$\{([^}]+)\}/g, (all, name: string) => name in vars ? String(vars[name]) : all) as T;
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, vars)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, vars)])) as T;
  return value;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object); const kb = Object.keys(b as object);
  return ka.length === kb.length && ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

const typeOf = (v: unknown): string => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
const preview = (values: unknown[]): unknown => {
  const v = values.length === 1 ? values[0] : values.slice(0, 5);
  const s = JSON.stringify(v);
  return s && s.length > 300 ? `${s.slice(0, 300)}…` : v;
};
const hasKey = (v: unknown, key: string): boolean => {
  let obj = v;
  if (typeof v === 'string') { try { obj = JSON.parse(v); } catch { return false; } }
  return obj !== null && typeof obj === 'object' && key in (obj as object);
};

const OPS = ['equals', 'notEquals', 'exists', 'type', 'minItems', 'maxItems', 'contains', 'matches', 'jsonHas'] as const;

/** Evaluate one assertion; every operator given must hold for every value the path reaches (and it must reach one). */
export function check(root: unknown, rule: JsonExpect, vars: Record<string, unknown> = {}): ExpectFailure[] {
  const r = substitute(rule, vars);
  let values: unknown[];
  try { values = select(root, r.path); } catch (err) { return [{ path: r.path, op: 'path', expected: 'valid path', actual: (err as Error).message }]; }
  const defined = values.filter((v) => v !== undefined);
  const failures: ExpectFailure[] = [];
  const fail = (op: string, expected: unknown): void => { failures.push({ path: r.path, op, expected, actual: preview(values) }); };
  const every = (pred: (v: unknown) => boolean): boolean => defined.length > 0 && defined.length === values.length && defined.every(pred);
  const ops = OPS.filter((op) => r[op] !== undefined);
  if (!ops.length && !every(() => true)) fail('exists', true);
  if (r.exists !== undefined && (r.exists ? !every(() => true) : defined.length > 0)) fail('exists', r.exists);
  if (r.equals !== undefined && !every((v) => deepEqual(v, r.equals))) fail('equals', r.equals);
  if (r.notEquals !== undefined && !every((v) => !deepEqual(v, r.notEquals))) fail('notEquals', r.notEquals);
  if (r.type !== undefined && !every((v) => typeOf(v) === r.type)) fail('type', r.type);
  if (r.minItems !== undefined && !every((v) => Array.isArray(v) && v.length >= r.minItems!)) fail('minItems', r.minItems);
  if (r.maxItems !== undefined && !every((v) => Array.isArray(v) && v.length <= r.maxItems!)) fail('maxItems', r.maxItems);
  if (r.contains !== undefined && !every((v) => typeof v === 'string' ? v.includes(String(r.contains)) : Array.isArray(v) && v.some((x) => deepEqual(x, r.contains)))) fail('contains', r.contains);
  if (r.matches !== undefined) {
    let re: RegExp | undefined;
    try { re = new RegExp(r.matches); } catch { fail('matches', `invalid regex ${r.matches}`); }
    if (re && !every((v) => typeof v === 'string' && re!.test(v))) fail('matches', r.matches);
  }
  if (r.jsonHas !== undefined && !every((v) => hasKey(v, r.jsonHas!))) fail('jsonHas', r.jsonHas);
  return failures;
}

export function checkAll(root: unknown, rules: JsonExpect[] = [], vars: Record<string, unknown> = {}): ExpectReport {
  const failures = rules.flatMap((rule) => check(root, rule, vars));
  return { ok: failures.length === 0, failures };
}

/** First value a capture path reaches (filters and wildcards pick their first item). */
export function capture(root: unknown, paths: Record<string, string> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, path] of Object.entries(paths)) {
    const values = select(root, path).flatMap((v) => Array.isArray(v) && /\[\?[^\]]*\]$/.test(path) ? v : [v]).filter((v) => v !== undefined);
    if (values.length) out[name] = values[0];
  }
  return out;
}

/** text/event-stream body → `{ events: [{ event, data }] }`, data parsed as JSON when it is JSON. */
export function parseSse(text: string): { events: Array<{ event: string; data: unknown; id?: string }> } {
  const events: Array<{ event: string; data: unknown; id?: string }> = [];
  for (const block of text.replace(/\r\n/g, '\n').split(/\n\n+/)) {
    let event = 'message'; let id: string | undefined; const data: string[] = [];
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const i = line.indexOf(':');
      const field = i < 0 ? line : line.slice(0, i);
      const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
      if (field === 'event') event = value; else if (field === 'data') data.push(value); else if (field === 'id') id = value;
    }
    if (!data.length) continue;
    const raw = data.join('\n');
    let parsed: unknown = raw;
    try { parsed = JSON.parse(raw); } catch { /* plain text event */ }
    events.push({ event, data: parsed, ...(id !== undefined && { id }) });
  }
  return { events };
}

/** A response body as a JSON value: JSON, SSE (`{events}`), or the raw text. */
export function parseBody(text: string, kind: 'json' | 'sse' | 'auto' = 'auto', contentType = ''): unknown {
  if (kind === 'sse' || (kind === 'auto' && /event-stream/i.test(contentType))) return parseSse(text);
  try { return JSON.parse(text); } catch { return kind === 'auto' && /^\s*(event|data):/m.test(text) ? parseSse(text) : text; }
}
