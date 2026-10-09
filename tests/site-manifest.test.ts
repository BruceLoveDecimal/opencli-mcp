import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SiteRegistry } from '../src/sites/loader.js';
import { ensureManagedSource } from '../src/sites/define.js';

const command = (label: string, audience?: string) => `import { defineAdapter } from 'opencli-mcp/adapter-sdk';
export default defineAdapter({ description: ${JSON.stringify(label)}, access: 'read'${audience ? `, audience: ${JSON.stringify(audience)}` : ''}, async run() { return { value: ${JSON.stringify(label)} }; } });
`;

function source(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencli-site-'));
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
  }
  ensureManagedSource(dir);
  return dir;
}

describe('site manifest and host commands', () => {
  it('merges site.json across sources and keeps host commands out of search', async () => {
    const builtin = source({
      'shop/site.json': JSON.stringify({ aliases: ['Shop'], origins: ['https://*.shop.test'], roles: { login: 'login' }, guide: 'old guide' }),
      'shop/orders.js': command('list the orders'),
      'shop/login.js': command('log in to the shop', 'host'),
    });
    const managed = source({ 'shop/site.json': JSON.stringify({ aliases: ['商店'], guide: 'new guide', allowOrigins: ['https://captcha.test'] }) });
    const registry = new SiteRegistry([{ kind: 'builtin', dir: builtin }, { kind: 'managed', dir: managed }]);
    await registry.load();

    const [shop] = registry.sites();
    expect(shop).toMatchObject({
      site: 'shop',
      aliases: ['shop', '商店'],
      origins: ['https://*.shop.test'],
      allowOrigins: ['https://captcha.test'],
      account: 'shop',
      roles: { login: 'login' },
      guide: 'new guide',
    });
    expect(shop.sample).toEqual(['orders']);
    // agents do not find the login, the host still runs it
    expect((await registry.search('shop login')).map((hit) => hit.name)).toEqual(['orders']);
    expect(await (await registry.resolve('shop', 'login')).run({} as never)).toEqual({ value: 'log in to the shop' });
  });
});
