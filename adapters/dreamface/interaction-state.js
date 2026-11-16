import { defineAdapter } from 'opencli-mcp/adapter-sdk';
import { ORIGIN_ARG, api, ids, session, siteOrigin } from './_shared.js';
import { interactionDetail } from './_chat.js';

export default defineAdapter({
  description: 'Read the current question form or fee gate by its exact interaction_id. Read-only recovery after a lost response; does not retry an action or infer task completion from input_accepted. （交互卡状态）',
  access: 'read', domain: 'facemojiapp.com',
  args: [{ name: 'interaction_id', type: 'string', required: true }, { name: 'kind', type: 'string', choices: ['auto', 'question', 'credit'], default: 'auto' }, ORIGIN_ARG],
  result: { kind: 'value', description: 'Current persisted interaction card and available actions' },
  async run({ tab, args }) {
    const origin = siteOrigin(args); const s = await session(tab, origin); const kind = args.kind || 'auto';
    let card; let resolvedKind = kind;
    if (kind === 'question' || kind === 'auto') {
      try { card = await interactionDetail(tab, origin, s, args.interaction_id); resolvedKind = 'question'; }
      catch (error) { if (kind === 'question') throw error; }
    }
    if (!card) {
      card = await api(tab, origin, s, '/df-tide-agent/agent/v1/gate/detail', { query: { interaction_id: args.interaction_id, ...ids(s) } });
      resolvedKind = 'credit';
    }
    const status = card?.status || null;
    const terminal = ['INPUT_COMPLETED', 'CANCELLED', 'FAILED', 'INTERRUPTED', 'EXPIRED', 'COMPLETED'].includes(status);
    return { card, kind: resolvedKind, interaction_id: card?.interaction_id || args.interaction_id, status, revision: card?.revision ?? null, actions: card?.actions || [], input_accepted: Boolean(card?.input_accepted), terminal, turn_terminal_unconfirmed: !terminal, hint: 'This is only the interaction snapshot. Use the original session/turn history for task and media completion; never submit an action absent from actions.' };
  },
});
