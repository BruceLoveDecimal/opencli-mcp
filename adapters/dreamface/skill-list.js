import { defineAdapter } from 'opencli-mcp/adapter-sdk';
import { ORIGIN_ARG, api, session, siteOrigin } from './_shared.js';

export default defineAdapter({
  description: 'Read the live manual Skill catalogue with stable skill_id values and language-specific display text. Empty catalogues remain empty; filtering is local and does not create a turn. （Skill 目录）',
  access: 'read', domain: 'facemojiapp.com',
  args: [
    { name: 'language', type: 'string', choices: ['en', 'zh'], default: 'en' },
    { name: 'query', type: 'string', help: 'Case-insensitive filter over id, name and description' },
    { name: 'offset', type: 'int', default: 0, min: 0 }, { name: 'limit', type: 'int', default: 100, min: 1, max: 200 }, ORIGIN_ARG,
  ],
  result: { kind: 'rows', description: 'Stable Skill catalogue entries', paginated: true },
  async run({ tab, args }) {
    const origin = siteOrigin(args); const s = await session(tab, origin);
    const data = await api(tab, origin, s, '/df-tide-agent/skill/v1/list', { method: 'POST', body: { language: args.language || 'en' } });
    const seen = new Set();
    const all = (data || []).filter((row) => row?.skill_id && !seen.has(row.skill_id) && seen.add(row.skill_id)).map((row) => ({ skill_id: row.skill_id, name: row.name || '', description: row.description || '', cover_url: row.cover_url || null }));
    const query = String(args.query || '').toLowerCase();
    const filtered = query ? all.filter((row) => `${row.skill_id} ${row.name} ${row.description}`.toLowerCase().includes(query)) : all;
    const offset = args.offset || 0; const limit = args.limit || 100;
    return { rows: filtered.slice(offset, offset + limit), total: filtered.length, empty: filtered.length === 0, language: args.language || 'en', nextCursor: offset + limit < filtered.length ? String(offset + limit) : undefined, selection_limit: 32 };
  },
});
