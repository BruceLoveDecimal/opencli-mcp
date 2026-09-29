/**
 * Where adapters live: the built-in corpus (ships with the package), managed dirs an embedding application keeps up to
 * date (OPENCLI_MCP_ADAPTER_DIRS), and the user's writable source. Later sources override earlier ones.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import type { Source } from '../sites/loader.js';

// The built-in `adapters/` dir sits at the package root. Walk up from this file until we find it — layout-agnostic, so
// it works both in dev (src/lib/sources.ts) and in the built package (dist/src/lib/sources.js, one level deeper).
function findBuiltinAdapters(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const cand = path.join(dir, 'adapters');
    if (fs.existsSync(cand) && fs.statSync(cand).isDirectory()) return cand;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../adapters');
}

export const BUILTIN_ADAPTERS_DIR = findBuiltinAdapters();
export const USER_ADAPTERS_DIR = path.join(os.homedir(), '.opencli-mcp', 'adapters');

/**
 * Managed adapter dirs, `path.delimiter`-separated in OPENCLI_MCP_ADAPTER_DIRS: e.g. adapters an application syncs from
 * a newer release than the one it bundles. Each must be usable against this engine; the application checks
 * `opencliMcp.adapterApi` in package.json before pointing here.
 */
export function managedAdapterDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.OPENCLI_MCP_ADAPTER_DIRS ?? '').split(path.delimiter).map((d) => d.trim()).filter(Boolean).map((d) => path.resolve(d));
}

/** Ordered sources; a later one overrides an earlier one for the same `<site>/<command>`. */
export function defaultSources(env: NodeJS.ProcessEnv = process.env): Source[] {
  return [
    { dir: BUILTIN_ADAPTERS_DIR, kind: 'builtin' },
    ...managedAdapterDirs(env).map((dir): Source => ({ dir, kind: 'managed' })),
    { dir: USER_ADAPTERS_DIR, kind: 'user' },
  ];
}
