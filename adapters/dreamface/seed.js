import { defineAdapter, errors } from 'opencli-mcp/adapter-sdk';
import { ORIGIN_ARG, session, siteOrigin } from './_shared.js';

export default defineAdapter({
  description: 'Test seed: confirm this browser is signed in to DreamFace on origin and return the page a UI flow starts on. Never logs in or changes data. （测试起点 种子）',
  access: 'read',
  domain: 'facemojiapp.com',
  args: [ORIGIN_ARG, { name: 'path', type: 'string', default: '/zh/home', help: 'start page path, e.g. /zh/ai-image' }],
  result: { kind: 'value', description: 'Start url and account', fields: { url: 'string', origin: 'string', user_id: 'string', email: 'string|null' } },
  async run({ tab, args }) {
    const origin = siteOrigin(args);
    const path = String(args.path || '/zh/home');
    if (!path.startsWith('/')) throw errors.argument(`path must start with "/": ${path}`);
    const s = await session(tab, origin);
    return { url: new URL(path, origin).href, origin, user_id: s.userId, email: s.email ?? null };
  },
});
