import { defineAdapter } from 'opencli-mcp/adapter-sdk';
import { ORIGIN_ARG, api, ids, session, siteOrigin } from './_shared.js';
import { historyRows, ordinaryHistory } from './_chat.js';

export default defineAdapter({
  description: 'Read ordinary /i-want CHAT history, or list ordinary conversations when conversation_id is omitted. Never substitutes INFINITE_CANVAS history. （普通对话历史）',
  access: 'read', domain: 'facemojiapp.com',
  args: [
    { name: 'conversation_id', type: 'string', help: 'Ordinary CHAT conversation to read' },
    { name: 'limit', type: 'int', default: 100, min: 1, max: 100 },
    { name: 'before', type: 'int', help: 'Pagination timestamp returned as oldest_time' },
    { name: 'before_id', type: 'string', help: 'Stable pagination cursor returned as oldest_id' }, ORIGIN_ARG,
  ],
  result: { kind: 'rows', description: 'Ordinary CHAT conversations or messages', paginated: true },
  async run({ tab, args }) {
    const origin = siteOrigin(args); const s = await session(tab, origin);
    if (!args.conversation_id) {
      const data = await api(tab, origin, s, '/df-tide-agent/conversation/v1/list', { query: { ...ids(s), scene_type: 'CHAT', platform_type: 'WEB', limit: args.limit || 20, before: args.before, before_id: args.before_id } });
      const rows = data?.data || data?.list || [];
      return { rows, nextCursor: data?.oldest_id || data?.next_before_id || undefined, scene_type: 'CHAT' };
    }
    const history = await ordinaryHistory(tab, origin, s, args);
    return { rows: historyRows(history), conversation_id: args.conversation_id, session_id: history?.session_id || null, has_more: Boolean(history?.has_more), nextCursor: history?.oldest_id || undefined, oldest_time: history?.oldest_time || null, scene_type: 'CHAT' };
  },
});
