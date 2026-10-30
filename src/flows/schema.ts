/**
 * Flow (a replayable recording) and Plan (structured test cases) — the formats web and mobile share.
 * See docs/flows.md. Mobile-mcp validates its own `platform:"mobile"` steps with the same envelope.
 */
import { z } from 'zod';

export const jsonExpectSchema = z.object({
  path: z.string().min(1),
  equals: z.unknown().optional(), notEquals: z.unknown().optional(), exists: z.boolean().optional(),
  type: z.enum(['string', 'number', 'boolean', 'array', 'object', 'null']).optional(),
  minItems: z.number().int().min(0).optional(), maxItems: z.number().int().min(0).optional(),
  contains: z.unknown().optional(), matches: z.string().optional(), jsonHas: z.string().optional(),
}).strict();

const frame = z.union([z.string(), z.number().int(), z.array(z.union([z.string(), z.number().int()]))]);
/** A durable web locator: never an `eN` ref (refs belong to one snapshot). */
export const flowTargetSchema = z.object({
  selector: z.string().optional(), role: z.string().optional(), name: z.string().optional(), label: z.string().optional(),
  text: z.string().optional(), testid: z.string().optional(), nth: z.number().int().optional(), within: z.string().optional(), frame: frame.optional(),
  x: z.number().optional(), y: z.number().optional(),
}).strict();

export const pageExpectSchema = z.object({
  text: z.string().optional(), notText: z.string().optional(), url: z.string().optional(), title: z.string().optional(),
  selector: z.string().optional(), visible: z.boolean().optional(),
  value: z.string().optional(), count: z.number().int().min(0).optional(), enabled: z.boolean().optional(), checked: z.boolean().optional(), hasText: z.string().optional(),
}).strict();

export const networkMatchSchema = z.object({
  url: z.string().min(1).describe('substring of the request URL'),
  method: z.string().optional(),
  status: z.number().int().optional(),
  request: z.array(jsonExpectSchema).optional().describe('assertions on the JSON request body'),
  response: z.array(jsonExpectSchema).optional().describe('assertions on the JSON (or SSE: {events}) response body'),
}).strict();

const stepBase = { intent: z.string().optional(), step: z.string().optional() };

export const webStepSchema = z.discriminatedUnion('do', [
  z.object({ ...stepBase, do: z.literal('goto'), url: z.string() }).strict(),
  z.object({
    ...stepBase, do: z.literal('act'),
    action: z.enum(['click', 'dblclick', 'hover', 'focus', 'fill', 'type', 'press', 'select', 'check', 'uncheck', 'upload', 'drag', 'scroll', 'back', 'forward', 'reload']),
    target: flowTargetSchema.optional(), to: flowTargetSchema.optional(), value: z.string().optional(), files: z.array(z.string()).optional(),
    direction: z.enum(['up', 'down', 'left', 'right']).optional(), amount: z.number().optional(), method: z.enum(['cdp', 'dom']).optional(),
  }).strict(),
  z.object({ ...stepBase, do: z.literal('expect'), expect: pageExpectSchema, timeout: z.number().positive().max(120).optional() }).strict(),
  z.object({ ...stepBase, do: z.literal('network'), match: networkMatchSchema, timeout: z.number().positive().max(120).optional() }).strict(),
  z.object({ ...stepBase, do: z.literal('site'), site: z.string(), command: z.string(), args: z.record(z.string(), z.unknown()).default({}), access: z.enum(['read', 'write']).optional(), expect: z.array(jsonExpectSchema).optional() }).strict(),
]);

export const webSeedSchema = z.object({
  site: z.string().optional(), command: z.string().optional(), args: z.record(z.string(), z.unknown()).optional(), url: z.string().optional(),
}).strict();

export const webFlowSchema = z.object({
  flow: z.literal(1),
  platform: z.literal('web'),
  name: z.string().min(1),
  case: z.string().optional(),
  site: z.string().optional(),
  seed: webSeedSchema.optional(),
  steps: z.array(webStepSchema),
}).strict();

export type WebStep = z.infer<typeof webStepSchema>;
export type WebFlow = z.infer<typeof webFlowSchema>;
export type WebSeed = z.infer<typeof webSeedSchema>;
export type NetworkMatch = z.infer<typeof networkMatchSchema>;

// ── plan (what planner agents save; the same shape for web and app cases) ──
export const planSchema = z.object({
  name: z.string().min(1),
  overview: z.string(),
  platform: z.enum(['web', 'mobile']).default('web'),
  suites: z.array(z.object({
    name: z.string().min(1),
    seed: z.record(z.string(), z.unknown()).optional().describe('flow seed every case of this suite starts from'),
    cases: z.array(z.object({
      id: z.string().min(1).describe('stable id such as "1.2"; flows reference it as case'),
      title: z.string().min(1),
      budget: z.object({ writes: z.number().int().min(0).optional() }).strict().optional().describe('write commands (credits) the case may spend'),
      steps: z.array(z.object({
        id: z.string().min(1),
        perform: z.string().optional(),
        expect: z.array(z.object({ kind: z.enum(['page', 'server', 'network']), text: z.string().min(1) }).strict()).default([]),
      }).strict()).min(1),
    }).strict()).min(1),
  }).strict()).min(1),
}).strict();
export type Plan = z.infer<typeof planSchema>;

/** The markdown a planner shares with people: same layout as Playwright's planner_save_plan. */
export function planMarkdown(plan: Plan): string {
  const lines = [`# ${plan.name}`, '', '## Overview', '', plan.overview, '', '## Test Scenarios'];
  plan.suites.forEach((suite, i) => {
    lines.push('', `### ${i + 1}. ${suite.name}`);
    if (suite.seed) lines.push('', `**Seed:** \`${JSON.stringify(suite.seed)}\``);
    for (const c of suite.cases) {
      lines.push('', `#### ${c.id}. ${c.title}`);
      if (c.budget?.writes !== undefined) lines.push('', `**Write budget:** ${c.budget.writes}`);
      lines.push('', '**Steps:**');
      c.steps.forEach((s) => {
        lines.push(`  ${s.id}. ${s.perform ?? '-'}`);
        for (const e of s.expect) lines.push(`    - expect (${e.kind}): ${e.text}`);
      });
    }
  });
  return `${lines.join('\n')}\n`;
}
