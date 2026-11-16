import { defineAdapter, errors } from 'opencli-mcp/adapter-sdk';
import { ORIGIN_ARG, ids, session, siteOrigin } from './_shared.js';
import { chatIdentity, interactionDetail, launchChat, streamEvidence, waitChat } from './_chat.js';

const FORM_ACTIONS = new Set(['submit', 'skip']);

export default defineAdapter({
  description: 'Act on the original fee/question/voice interaction through V2 SSE without creating a user message or task. Form retries reuse submission_id/form_version/values; voice uses its legacy selection envelope. May resume billable work. （交互卡操作）',
  access: 'write', domain: 'facemojiapp.com',
  args: [
    { name: 'interaction_id', type: 'string', required: true, help: 'Exact interaction_id from the original card; for voice this is selection_id' },
    { name: 'action', type: 'string', required: true, choices: ['confirm', 'continue', 'submit', 'skip', 'retry', 'cancel', 'select', 'reject'] },
    { name: 'submission_id', type: 'string', help: 'Required for submit/skip; reuse exactly across network retries' },
    { name: 'form_version', type: 'string', help: 'Opaque original card form_version' },
    { name: 'values', type: 'array', items: { type: 'object', properties: {}, open: true }, help: 'Full values: question_id plus exactly one of option_ids/message' },
    { name: 'voice_id', type: 'string', help: 'Original voice id for action=select' },
    { name: 'kind', type: 'string', choices: ['auto', 'question', 'credit', 'voice'], default: 'auto', help: 'Use voice for a voice skip; select/reject are detected automatically' },
    { name: 'session_id', type: 'string' }, { name: 'turn_id', type: 'string' }, { name: 'message_id', type: 'string' }, { name: 'conversation_id', type: 'string' },
    { name: 'project_id', type: 'string', help: 'Required only when the original interaction belongs to INFINITE_CANVAS' },
    { name: 'command_id', type: 'string', help: 'Stable client command id; reuse when retrying voice selection' },
    { name: 'timeout_sec', type: 'int', default: 60, min: 1, max: 1800 },
    { name: 'observation_ms', type: 'int', default: 30000, min: 100, max: 30000, help: 'Release the call after this window with pending and original ids' }, ORIGIN_ARG,
  ],
  result: { kind: 'value', description: 'Original interaction stream, raw events and terminal/suspended state' },
  async run({ tab, args }) {
    const origin = siteOrigin(args); const s = await session(tab, origin);
    const voice = args.kind === 'voice' || args.action === 'select' || args.action === 'reject';
    if (FORM_ACTIONS.has(args.action) && !voice) {
      if (!args.submission_id || !args.form_version) throw errors.argument('submit/skip requires submission_id and form_version');
      if (args.action === 'submit') {
        if (!Array.isArray(args.values)) throw errors.argument('submit requires a complete values array');
        const card = await interactionDetail(tab, origin, s, args.interaction_id);
        if (card?.form_version !== args.form_version) throw errors.argument('form_version does not match the current card', 'Read interaction-state; do not submit an old form.');
        const fields = new Map((card?.fields || []).map((field) => [field.question_id, field]));
        const answered = new Set();
        for (const value of args.values) {
          const field = fields.get(value?.question_id);
          if (!field || answered.has(value.question_id)) throw errors.argument('values contains an unknown or duplicate question_id');
          answered.add(value.question_id);
          const option = Object.hasOwn(value, 'option_ids'); const custom = Object.hasOwn(value, 'message');
          if (option === custom || Object.keys(value).some((key) => !['question_id', 'option_ids', 'message'].includes(key))) throw errors.argument('Each answer needs question_id plus exactly one of option_ids/message');
          if (option && (!Array.isArray(value.option_ids) || value.option_ids.length !== 1 || !(field.options || []).some((item) => item.id === value.option_ids[0]))) throw errors.argument('option_ids must contain one id from the original question');
          if (custom && (!field.allow_custom_answer || typeof value.message !== 'string' || !value.message.trim() || Array.from(value.message).length > (field.message_max_length || 1000))) throw errors.argument('Custom answer is not allowed, blank, or too long');
        }
        for (const field of fields.values()) if (field.required && !answered.has(field.question_id)) throw errors.argument(`Required question ${field.question_id} has no answer`);
      }
    }
    let body;
    if (voice) {
      if (!args.session_id || !args.turn_id) throw errors.argument('voice actions require original session_id and turn_id');
      if (args.action === 'select' && !args.voice_id) throw errors.argument('select requires voice_id');
      body = {
        ...ids(s), session_id: args.session_id, turn_id: args.turn_id, message_id: args.message_id,
        conversation_id: args.conversation_id, project_id: args.project_id, scene_type: args.project_id ? 'INFINITE_CANVAS' : 'CHAT',
        suspend_token: args.interaction_id, command_id: args.command_id, message: '', stream: true,
        interaction_response: { type: 'voice_selection', selection_id: args.interaction_id, action: args.action, ...(args.voice_id && { voice_id: args.voice_id }) },
      };
    } else {
      const payload = FORM_ACTIONS.has(args.action)
        ? { submission_id: args.submission_id, form_version: args.form_version, values: args.action === 'skip' ? [] : args.values }
        : {};
      body = {
        ...ids(s), session_id: args.session_id, turn_id: args.turn_id, message_id: args.message_id,
        conversation_id: args.conversation_id, project_id: args.project_id, scene_type: args.project_id ? 'INFINITE_CANVAS' : 'CHAT',
        message: '', stream: true, command_id: args.command_id,
        interaction_action: { interaction_id: args.interaction_id, action: args.action, payload },
      };
    }
    const key = `opencli_df_interaction_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    await launchChat(tab, s, body, key);
    const state = await waitChat(tab, key, { timeoutSec: args.timeout_sec ?? 60, observationMs: args.observation_ms ?? 30000 });
    const result = streamEvidence(state, chatIdentity(state.events, { session_id: args.session_id, turn_id: args.turn_id, message_id: args.message_id, conversation_id: args.conversation_id, project_id: args.project_id }));
    if (!state.done) result.status = 'pending';
    result.interaction_id = args.interaction_id; result.action = args.action;
    if (FORM_ACTIONS.has(args.action) && !voice) result.submission_id = args.submission_id;
    result.new_user_message = false;
    result.hint = result.status === 'pending' || result.status === 'suspended'
      ? 'Read interaction-state and the original history. Do not create a new chat or generate a new submission id; acceptance is not turn completion.'
      : 'Check the original card, turn and (for Canvas) project. API acceptance alone is not rendered UI or billing evidence.';
    return result;
  },
});
