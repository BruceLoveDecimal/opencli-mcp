import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { capture, check, checkAll, parseBody, parseSse, select } from '../src/flows/json-expect.js';
import { Journal, maskArgs } from '../src/flows/journal.js';
import { flowToPlaywright, selectorToLocator, splitSelector } from '../src/flows/playwright.js';
import { planMarkdown, planSchema, webFlowSchema } from '../src/flows/schema.js';

const body = {
  status_code: 'OK',
  data: { list: [{ id: 'a', status: 200, tags: ['x'] }, { id: 'b', status: 100, tags: [] }], total: 2, raw: '{"aiVideoTextId":"t1"}' },
  events: [{ event: 'delta', data: { t: 1 } }, { event: 'done', data: { success: false } }],
};

describe('json-expect', () => {
  it('selects fields, indexes, wildcards and filters', () => {
    expect(select(body, 'data.list[0].id')).toEqual(['a']);
    expect(select(body, 'data.list[*].id')).toEqual(['a', 'b']);
    expect(select(body, 'data.list[?status=200]')).toEqual([[body.data.list[0]]]);
    expect(select(body, 'events[?event=done].data.success')).toEqual([false]);
    expect(select(body, 'data.missing')).toEqual([undefined]);
    expect(() => select(body, 'data..[')).toThrow();
  });

  it('checks every operator on every reached value', () => {
    expect(checkAll(body, [
      { path: 'status_code', equals: 'OK' },
      { path: 'data.list', minItems: 2, maxItems: 2 },
      { path: 'data.list[*].id', type: 'string' },
      { path: 'data.list[?status=200]', minItems: 1 },
      { path: 'events[?event=done].data.success', equals: false },
      { path: 'data.raw', jsonHas: 'aiVideoTextId' },
      { path: 'data.list[0].tags', contains: 'x' },
      { path: 'data.list[0].id', matches: '^a$' },
      { path: 'data.missing', exists: false },
      { path: 'data.total', notEquals: 0 },
    ]).ok).toBe(true);
    const failures = check(body, { path: 'data.list[*].status', equals: 200 });
    expect(failures).toEqual([{ path: 'data.list[*].status', op: 'equals', expected: 200, actual: [200, 100] }]);
    expect(check(body, { path: 'data.nothing[*].id', type: 'string' })[0].op).toBe('type');
    expect(check(body, { path: 'data.nothing' })[0].op).toBe('exists');
  });

  it('substitutes captured variables and captures the first value', () => {
    const vars = capture(body, { first: 'data.list[0].id', ok: 'data.list[?status=200].id', none: 'data.nope' });
    expect(vars).toEqual({ first: 'a', ok: 'a' });
    expect(check(body, { path: 'data.list[1].id', equals: '${other}' }, { other: 'b' })).toEqual([]);
  });

  it('parses SSE and JSON bodies', () => {
    const sse = 'event: error\ndata: {"error":"Parameter Illegal"}\n\nevent: done\ndata: {"success":false}\n\n';
    expect(parseSse(sse).events).toEqual([{ event: 'error', data: { error: 'Parameter Illegal' } }, { event: 'done', data: { success: false } }]);
    expect(parseBody(sse, 'auto', 'text/event-stream')).toEqual(parseSse(sse));
    expect(parseBody('{"a":1}')).toEqual({ a: 1 });
    expect(parseBody('plain')).toBe('plain');
  });

  it('accepts the dreamface suite expectations', () => {
    const suite = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'adapters', 'dreamface', 'suite.json'), 'utf8')) as { checks: Array<{ expect: unknown[] }> };
    for (const c of suite.checks) for (const rule of c.expect) expect(() => check({}, rule as never)).not.toThrow();
  });
});

describe('journal', () => {
  it('exports successful replayable steps with their intents', () => {
    const j = new Journal();
    j.add({ ok: true, ms: 5, intent: 'open', record: { do: 'goto', url: 'https://a.test/' } });
    const mark = j.cursor;
    j.add({ ok: true, ms: 5, intent: 'click save', step: '2', record: { do: 'act', action: 'click', target: { selector: 'internal:role=button[name="Save"i]' } } });
    j.add({ ok: false, ms: 5, intent: 'broken', record: null, error: { code: 'not_found', message: 'x' } });
    j.add({ ok: true, ms: 5, intent: 'ref only', record: null, note: 'no selector' });
    const all = j.toFlow({ name: 'f' });
    expect(all.flow.steps).toHaveLength(2);
    expect(all.flow.steps[1]).toMatchObject({ intent: 'click save', step: '2' });
    expect(all.skipped.map((s) => s.reason)).toEqual(['failed: not_found', 'no selector']);
    expect(j.toFlow({ name: 'f', since: mark }).flow.steps).toHaveLength(1);
    expect(webFlowSchema.parse(all.flow).steps).toHaveLength(2);
  });

  it('masks credential arguments', () => {
    expect(maskArgs({ email: 'a@b.c', password: 'pw', captcha_wait_sec: 5 })).toEqual({ args: { email: 'a@b.c', password: '${password}', captcha_wait_sec: 5 }, masked: ['password'] });
  });
});

describe('playwright export', () => {
  it('maps engine selectors to getBy locators', () => {
    expect(splitSelector('div >> internal:role=button[name="a >> b"i] >> nth=1')).toEqual(['div', 'internal:role=button[name="a >> b"i]', 'nth=1']);
    expect(selectorToLocator('internal:role=button[name="Save"i]')).toBe("page.getByRole('button', { name: 'Save' })");
    expect(selectorToLocator('internal:role=checkbox[checked=true][name="Agree"s]')).toBe("page.getByRole('checkbox', { checked: true, name: 'Agree', exact: true })");
    expect(selectorToLocator('internal:testid=[data-testid="send"s]')).toBe("page.getByTestId('send')");
    expect(selectorToLocator('internal:label="Email"i')).toBe("page.getByLabel('Email')");
    expect(selectorToLocator('internal:text="It\'s"s')).toBe("page.getByText('It\\'s', { exact: true })");
    expect(selectorToLocator('internal:attr=[placeholder="Search"i]')).toBe("page.getByPlaceholder('Search')");
    expect(selectorToLocator('#main >> internal:role=link >> nth=0')).toBe("page.locator('#main').getByRole('link').first()");
    expect(selectorToLocator('iframe >> internal:control=enter-frame >> button')).toBe("page.locator('iframe').contentFrame().locator('button')");
  });

  it('writes a spec with step comments and assertions', () => {
    const spec = flowToPlaywright({ flow: 1, platform: 'web', name: 'save', site: 'shop', seed: { url: 'https://shop.test/' }, steps: [
      { do: 'act', action: 'fill', intent: 'type name', step: '1', target: { selector: 'internal:label="Name"i' }, value: 'Ann' },
      { do: 'act', action: 'click', intent: 'save', step: '2', target: { selector: 'internal:role=button[name="Save"i]' } },
      { do: 'expect', intent: 'save', step: '2', expect: { text: 'Saved', url: '/done?x=1', selector: 'internal:role=button[name="Save"i]', enabled: false }, timeout: 3 },
      { do: 'network', match: { url: '/api/save' } },
    ] });
    expect(spec).toContain("await page.goto('https://shop.test/');");
    expect(spec).toContain('// 1. type name');
    expect(spec.match(/\/\/ 2\. save/g)).toHaveLength(1);
    expect(spec).toContain("await page.getByLabel('Name').fill('Ann');");
    expect(spec).toContain("await expect(page.locator('body')).toContainText('Saved', { timeout: 3000 });");
    expect(spec).toContain('await expect(page).toHaveURL(/\\/done\\?x=1/, { timeout: 3000 });');
    expect(spec).toContain("await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled({ timeout: 3000 });");
    expect(spec).toContain('network assertion (replay with flow_run)');
  });
});

describe('plan', () => {
  it('validates and renders markdown', () => {
    const plan = planSchema.parse({ name: 'Smoke', overview: 'o', suites: [{ name: 'Image', seed: { url: 'https://x/' }, cases: [{ id: '1.1', title: 'Generate', budget: { writes: 1 }, steps: [{ id: '1', perform: 'Click Create', expect: [{ kind: 'page', text: 'Spinner' }, { kind: 'server', text: 'New work' }] }] }] }] });
    const md = planMarkdown(plan);
    expect(md).toContain('#### 1.1. Generate');
    expect(md).toContain('    - expect (server): New work');
    expect(() => planSchema.parse({ name: 'x', overview: '', suites: [] })).toThrow();
  });
});
