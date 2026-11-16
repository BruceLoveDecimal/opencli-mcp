import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const dir = path.join(import.meta.dirname, '..', 'adapters', 'dreamface');

describe('dreamface regression suite', () => {
  it('checks an endpoint of every command that calls the server', () => {
    const suite = JSON.parse(fs.readFileSync(path.join(dir, 'suite.json'), 'utf8')) as { name: string; checks: { id: string; method: string; path: string; adapters?: string[] }[] };
    expect(suite.name).toBe('dreamface');
    const ids = suite.checks.map((check) => check.id);
    expect(new Set(ids).size).toBe(ids.length);
    const endpoints = suite.checks.map((check) => `${check.method} ${check.path}`);
    expect(new Set(endpoints).size).toBe(endpoints.length);
    const covered = new Set(suite.checks.flatMap((check) => check.adapters ?? []));
    // UI-only/static commands and arbitrary-URL media probes have no fixed DreamFace endpoint to put in this suite.
    const commands = fs.readdirSync(dir)
      .filter((file) => file.endsWith('.js') && !file.startsWith('_'))
      .map((file) => file.slice(0, -3))
      .filter((command) => !['login', 'sitemap', 'attachment-upload', 'attachment-inspect', 'agent-settings', 'media-probe', 'media-inspect'].includes(command));
    expect(commands.filter((command) => !covered.has(command))).toEqual([]);
  });
});
