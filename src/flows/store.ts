/** Saved flows and plans under ~/.opencli-mcp (flows/, plans/). Names are file-system safe and never escape the dir. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ActionError } from '../api/errors.js';

export const flowsDir = (): string => path.join(os.homedir(), '.opencli-mcp', 'flows');
export const plansDir = (): string => path.join(os.homedir(), '.opencli-mcp', 'plans');

export function safeName(name: string): string {
  const base = name.trim().replace(/\.(flow\.json|spec\.ts|json|md)$/i, '').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 120);
  if (!base) throw new ActionError('invalid_args', `"${name}" is not a usable file name`, 'Use letters, digits, dash or underscore.');
  return base;
}

export function writeFile(dir: string, file: string, text: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, file);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, target);
  return target;
}

export function readSavedFlow(name: string): unknown {
  const file = path.join(flowsDir(), `${safeName(name)}.flow.json`);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new ActionError('flow_not_found', `no saved flow "${name}"`, 'Export one with journal {action:"export", save:true} or pass the flow object.');
    throw new ActionError('invalid_flow', `${file} is not valid JSON: ${(err as Error).message}`);
  }
}

export function listSavedFlows(): string[] {
  try { return fs.readdirSync(flowsDir()).filter((f) => f.endsWith('.flow.json')).map((f) => f.slice(0, -'.flow.json'.length)).sort(); } catch { return []; }
}
