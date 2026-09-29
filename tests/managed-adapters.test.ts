import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SiteRegistry } from '../src/sites/loader.js';
import { BUILTIN_ADAPTERS_DIR, defaultSources } from '../src/lib/sources.js';
import { ensureManagedSource } from '../src/sites/define.js';

const whoami = (label: string) => `import { defineAdapter } from 'opencli-mcp/adapter-sdk';
export default defineAdapter({ description: ${JSON.stringify(label)}, access: 'read', async run() { return { value: ${JSON.stringify(label)} }; } });
`;

describe('managed adapter dirs', () => {
  it('sit between the built-ins and the user source, resolve the SDK, and hide their node_modules', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencli-managed-'));
    fs.mkdirSync(path.join(dir, 'dreamface'));
    fs.writeFileSync(path.join(dir, 'dreamface', 'whoami.js'), whoami('managed whoami'));
    ensureManagedSource(dir);

    const sources = defaultSources({ OPENCLI_MCP_ADAPTER_DIRS: dir });
    expect(sources.map((s) => s.kind)).toEqual(['builtin', 'managed', 'user']);
    expect(sources[0].dir).toBe(BUILTIN_ADAPTERS_DIR);

    const registry = new SiteRegistry(sources);
    await registry.load();
    const cmd = await registry.resolve('dreamface', 'whoami');
    expect(cmd.source).toBe('managed');
    expect(await cmd.run({} as never)).toEqual({ value: 'managed whoami' });
    // built-in commands the managed dir does not override stay available
    expect((await registry.resolve('dreamface', 'credits')).source).toBe('builtin');
    expect(registry.sites().map((s) => s.site)).not.toContain('node_modules');
  });
});
