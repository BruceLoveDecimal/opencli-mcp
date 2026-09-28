import { defineAdapter } from 'opencli-mcp/adapter-sdk';
import { ORIGIN_ARG, api, ids, session, siteOrigin } from './_shared.js';

export default defineAdapter({
  description: 'Remaining DreamFace credits (paid and free) and today\'s free agent uses. （积分 余额）',
  access: 'read',
  domain: 'facemojiapp.com',
  args: [ORIGIN_ARG],
  result: { kind: 'value', description: 'Credit balance', fields: { paid: 'number', free: 'number', free_expires: 'string|null', free_uses_left: 'number|null' } },
  async run({ tab, args }) {
    const origin = siteOrigin(args);
    const s = await session(tab, origin);
    const credits = await api(tab, origin, s, '/dw-server/credits/get_remaining_credits', { method: 'POST', body: { ...ids(s), time_zone: 'Asia/Shanghai' } });
    const free = await api(tab, origin, s, '/dw-server/rights/get_free_rights', { method: 'POST', body: ids(s) }).catch(() => null);
    return {
      paid: credits?.paid_count ?? 0,
      free: credits?.free_count ?? 0,
      free_expires: credits?.free_expires_time > 0 ? new Date(credits.free_expires_time).toISOString() : null,
      free_uses_left: free?.remain_count ?? null,
      free_uses_total: free?.total_count ?? null,
    };
  },
});
