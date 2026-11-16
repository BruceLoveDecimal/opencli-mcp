import { defineAdapter } from 'opencli-mcp/adapter-sdk';
import { ORIGIN_ARG, api, ids, session, siteOrigin } from './_shared.js';

export default defineAdapter({
  description: 'Request cancellation of the original ordinary CHAT session/turn. A successful receipt is not a terminal turn; verify the original history/SSE and never cancel a guessed latest task. （停止普通对话）',
  access: 'write', domain: 'facemojiapp.com',
  args: [
    { name: 'session_id', type: 'string', required: true }, { name: 'turn_id', type: 'string', help: 'Exact turn from session_id SSE; strongly recommended' },
    { name: 'conversation_id', type: 'string', help: 'Original ordinary CHAT conversation for subsequent history reads' }, ORIGIN_ARG,
  ],
  result: { kind: 'value', description: 'Cancellation receipt, not proof of backend termination' },
  async run({ tab, args }) {
    const origin = siteOrigin(args); const s = await session(tab, origin);
    await api(tab, origin, s, '/df-tide-agent/agent/v2/chat/cancel', { method: 'POST', body: { ...ids(s), session_id: args.session_id, turn_id: args.turn_id, scene_type: 'CHAT' } });
    return { cancel_requested: true, terminal: false, session_id: args.session_id, turn_id: args.turn_id || null, conversation_id: args.conversation_id || null, hint: 'Read the same session turn/history for the real terminal state and billing; do not start a replacement turn merely because the stop receipt returned.' };
  },
});
