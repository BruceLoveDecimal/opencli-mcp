import { defineAdapter, errors } from 'opencli-mcp/adapter-sdk';
import { APP_VERSION, ORIGIN_ARG, agentModel, session, siteOrigin } from './_shared.js';
import { chatBody, chatIdentity, historyRows, launchChat, ordinaryHistory, streamEvidence, waitChat } from './_chat.js';
import { normalizeAttachments } from './_attachments.js';

export default defineAdapter({
  description: 'Send one ordinary /i-want CHAT turn through V2 SSE (scene_type=CHAT, no project_id), or follow up in the same session. Returns raw events and recoverable ids; does not create a Canvas project or prove UI rendering. （普通智能体对话）',
  access: 'write', domain: 'facemojiapp.com',
  args: [
    { name: 'message', type: 'string', default: '', help: 'New user message; may be empty only with attachments' },
    { name: 'session_id', type: 'string', help: 'Existing ordinary CHAT session for a follow-up' },
    { name: 'conversation_id', type: 'string', help: 'Existing ordinary CHAT conversation; never a Canvas-only id without its session' },
    { name: 'model', type: 'string', help: 'Driving model from model-catalog; omitted uses the live default' },
    { name: 'execution_mode', type: 'string', choices: ['ask', 'auto'], default: 'auto' },
    { name: 'credit_confirmation_threshold', type: 'number', min: 0.1, max: 100, default: 10 },
    { name: 'requested_skill_ids', type: 'array', items: { type: 'string' }, help: 'At most 32 stable skill_id values from skill-list' },
    { name: 'attachments', type: 'object', properties: {}, open: true, help: 'Confirmed formal attachment URLs grouped as image/video/audio; no temporary or missing URLs' },
    { name: 'timeout_sec', type: 'int', default: 120, min: 1, max: 1800 }, ORIGIN_ARG,
  ],
  result: { kind: 'value', description: 'Original ordinary CHAT turn and its raw SSE evidence' },
  async run({ tab, args }) {
    const origin = siteOrigin(args); const s = await session(tab, origin);
    if (!String(args.message || '').trim() && !args.attachments) throw errors.argument('message or attachments is required');
    if (args.attachments) {
      const candidates = Object.entries(args.attachments).flatMap(([type, items]) => Array.isArray(items) ? items.map((item) => ({ ...item, type: item?.type || type })) : []);
      const normalized = normalizeAttachments(candidates, { max: 5 });
      if (!normalized.valid || !candidates.length) throw errors.argument('Attachments require 1–5 image/video/audio items with formal HTTP(S) URLs', normalized.errors.map((row) => row.error).join(', '));
    }
    const skillIds = [...new Set(args.requested_skill_ids || [])];
    if (skillIds.length > 32) throw errors.argument('At most 32 distinct requested_skill_ids are allowed');
    const model = await agentModel(tab, origin, s, args.model);
    const body = chatBody(s, { ...args, requested_skill_ids: skillIds }, { model });
    if (body.project_id) throw errors.argument('ordinary CHAT must not include project_id');
    const key = `opencli_df_chat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    await launchChat(tab, s, body, key);
    const state = await waitChat(tab, key, { timeoutSec: args.timeout_sec ?? 120 });
    const identity = chatIdentity(state.events, { conversation_id: args.conversation_id, session_id: args.session_id });
    const result = streamEvidence(state, identity);
    if (!state.done) result.status = 'pending';
    result.request = { scene_type: 'CHAT', model, execution_mode: body.execution_mode, credit_confirmation_threshold: body.credit_confirmation_threshold, requested_skill_ids: skillIds, app_version: APP_VERSION };
    if (identity.conversation_id) {
      try { result.history = historyRows(await ordinaryHistory(tab, origin, s, { ...args, conversation_id: identity.conversation_id })); }
      catch (error) { result.history_error = String(error?.message || error); }
    }
    result.hint = result.status === 'pending' || result.status === 'suspended'
      ? 'Keep these original ids. Do not create another user turn; read chat-history or recover the same interaction/session.'
      : 'API/SSE evidence only; verify the user bubble, streaming reply, controls and history in the real page separately.';
    return result;
  },
});
