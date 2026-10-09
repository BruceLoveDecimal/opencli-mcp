import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const dir = path.join(import.meta.dirname, '..', 'adapters', 'dreamface');

describe('dreamface regression suite', () => {
  it('checks an endpoint of every command that calls the server', () => {
    const suite = JSON.parse(fs.readFileSync(path.join(dir, 'suite.json'), 'utf8')) as { name: string; checks: { id: string; adapters?: string[] }[] };
    expect(suite.name).toBe('dreamface');
    const ids = suite.checks.map((check) => check.id);
    expect(new Set(ids).size).toBe(ids.length);
    const covered = new Set(suite.checks.flatMap((check) => check.adapters ?? []));
    // login drives the page and sitemap is static; every other command calls the site's API
    const commands = fs.readdirSync(dir)
      .filter((file) => file.endsWith('.js') && !file.startsWith('_'))
      .map((file) => file.slice(0, -3))
      .filter((command) => !['login', 'sitemap'].includes(command));
    expect(commands.filter((command) => !covered.has(command))).toEqual([]);
  });
});
