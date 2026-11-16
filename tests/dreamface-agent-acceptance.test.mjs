import { describe, expect, it } from 'vitest';
import chatTurn from '../adapters/dreamface/chat-turn.js';
import skillList from '../adapters/dreamface/skill-list.js';
import modelCatalog from '../adapters/dreamface/model-catalog.js';
import interactionAction from '../adapters/dreamface/interaction-action.js';
import canvasSave from '../adapters/dreamface/canvas-save.js';
import attachmentInspect from '../adapters/dreamface/attachment-inspect.js';
import { normalizeAttachments } from '../adapters/dreamface/_attachments.js';
import { normalizeSettings } from '../adapters/dreamface/_settings.js';
import { redactEventData } from '../adapters/dreamface/_chat.js';

const origin = 'https://testm.facemojiapp.com';
const session = { token: 'secret', userId: 'u', accountId: 'a' };

function fixture({ stream = [], responses = {} } = {}) {
  const calls = { writes: [], requests: [] };
  const tab = {
    async url() { return `${origin}/i-want`; },
    async evaluate(code, options) {
      if (code.includes('localStorage.getItem')) return { user: JSON.stringify(session), clientId: 'client' };
      if (options?.allowWrite) { calls.writes.push(code); return true; }
      return { done: true, error: null, events: stream, truncated: false };
    },
    async fetchJson(url, options = {}) {
      calls.requests.push({ url, options });
      const match = Object.entries(responses).find(([path]) => url.includes(path));
      if (match) return { status_code: 'THS12140000000', data: match[1] };
      if (url.includes('/model/v1/list')) return { status_code: 'THS12140000000', data: [{ name: 'Luna', is_active: true }] };
      return { status_code: 'THS12140000000', data: null };
    },
  };
  return { tab, calls };
}

const stream = [
  { event: 'session_id', id: '1', data: JSON.stringify({ session_id: 'session-1', turn_id: 'turn-1' }) },
  { event: 'conversation_created', id: '2', data: JSON.stringify({ conversation_id: 'conversation-1', message_id: 'assistant-1' }) },
  { event: 'text_delta', id: '3', data: JSON.stringify({ content: 'answer' }) },
  { event: 'done', id: '4', data: JSON.stringify({ success: true, status: 'completed', reason: 'turn_completed' }) },
];

describe('DreamFace agent acceptance adapters', () => {
  it('uses ordinary CHAT without project_id and retains raw SSE and follow-up identity', async () => {
    const { tab, calls } = fixture({ stream, responses: { '/conversation/v1/history/': { data: [{ id: 'assistant-1', role: 'assistant', content: 'answer' }] } } });
    const result = await chatTurn.run({ tab, args: { origin, message: 'hello', session_id: 'session-1', conversation_id: 'conversation-1' } });
    const body = JSON.parse(JSON.parse(/body: ("(?:[^"\\]|\\.)*")/.exec(calls.writes[0])?.[1] || 'null'));
    expect(body).toMatchObject({ scene_type: 'CHAT', session_id: 'session-1', conversation_id: 'conversation-1', requested_skill_ids: [] });
    expect(body).not.toHaveProperty('project_id');
    expect(result).toMatchObject({ status: 'completed', terminal: true, session_id: 'session-1', turn_id: 'turn-1', conversation_id: 'conversation-1', last_event_id: '4' });
    expect(result.events.map((event) => event.event)).toContain('text_delta');
  });

  it('rejects an attachment without a formal URL before creating a turn', async () => {
    const { tab, calls } = fixture();
    await expect(chatTurn.run({ tab, args: { origin, message: '', attachments: { image: [{ label: 'unfinished' }] } } })).rejects.toThrow('formal HTTP(S) URLs');
    expect(calls.writes).toHaveLength(0);
    expect(calls.requests.some((call) => call.url.includes('/agent/v2/chat'))).toBe(false);
  });

  it('redacts nested credentials without changing event text or ids', () => {
    const event = redactEventData(JSON.stringify({ turn_id: 'turn-1', content: 'answer', quote_token: 'private', nested: { suspend_token: 'suspended', safe: true } }));
    expect(event).toContain('"turn_id":"turn-1"');
    expect(event).toContain('"content":"answer"');
    expect(event).not.toContain('private');
    expect(event).not.toContain('suspended');
    expect(event).toContain('"safe":true');
  });

  it('keeps stable skill ids and groups media strictly by model_type', async () => {
    const skills = fixture({ responses: { '/skill/v1/list': [{ skill_id: 'stable-1', name: '写作', description: '中文' }] } });
    expect((await skillList.run({ tab: skills.tab, args: { origin, language: 'zh' } })).rows[0]).toMatchObject({ skill_id: 'stable-1', name: '写作' });
    const models = fixture({ responses: { '/tools/list': { tools: [
      { name: 'video-stable', display_name: 'Video renamed', model_type: 'Video', category: 'misc' },
      { name: 'image-stable', display_name: 'Image', model_type: 'Image', category: 'Video' },
    ] } } });
    const catalog = await modelCatalog.run({ tab: models.tab, args: { origin } });
    expect(catalog.groups.Video.map((row) => row.id)).toEqual(['video-stable']);
    expect(catalog.groups.Image.map((row) => row.id)).toEqual(['image-stable']);
  });

  it('rejects missing URLs and normalizes settings without confusing new 0.1 with legacy 0.1', () => {
    const normalized = normalizeAttachments([{ type: 'image', url: 'https://cdn.example/a.png' }, { type: 'video', name: 'missing' }]);
    expect(normalized.valid).toBe(false);
    expect(normalized.errors).toEqual([{ index: 1, error: 'missing_formal_url' }]);
    expect(normalizeSettings({ execution_mode: 'ask', credit_confirmation_threshold: 1.25 })).toEqual({ execution_mode: 'ask', credit_confirmation_threshold: 1.3 });
    expect(normalizeSettings({ credit_confirmation_threshold: 0.1, legacy: true }).credit_confirmation_threshold).toBe(10);
    expect(normalizeSettings({ credit_confirmation_threshold: 0.1 }).credit_confirmation_threshold).toBe(0.1);
  });

  it('returns attachment inspection as a value and accepts the actual composer route', async () => {
    const calls = [];
    const tab = {
      async url() { return `${origin}/i-want`; },
      async goto(url) { calls.push(url); },
      async evaluate(code) {
        if (code.includes('localStorage.getItem')) return { user: JSON.stringify(session), clientId: 'client' };
        return { files: [], media: [] };
      },
      async observe() { return { state: 'composer' }; },
    };
    const result = await attachmentInspect.run({ tab, args: { origin, route: '/home?tab=agent', candidates: [{ type: 'image', url: 'https://cdn.example/a.png' }] } });
    expect(calls).toEqual([`${origin}/home?tab=agent`]);
    expect(result).not.toHaveProperty('rows');
    expect(result.candidate_results).toHaveLength(1);
    expect(result.valid).toBe(true);
  });

  it('reuses form identity and sends interaction_action with an empty new message', async () => {
    const card = { interaction_id: 'interaction-1', form_version: 'digest-1', fields: [{ question_id: 'q1', required: true, allow_custom_answer: false, options: [{ id: 'o1', title: 'One' }] }] };
    const { tab, calls } = fixture({ stream, responses: { '/interactions/detail': card } });
    const result = await interactionAction.run({ tab, args: { origin, interaction_id: 'interaction-1', action: 'submit', submission_id: 'submission-1', form_version: 'digest-1', values: [{ question_id: 'q1', option_ids: ['o1'] }] } });
    const body = JSON.parse(JSON.parse(/body: ("(?:[^"\\]|\\.)*")/.exec(calls.writes[0])?.[1] || 'null'));
    expect(body).toMatchObject({ message: '', interaction_action: { interaction_id: 'interaction-1', action: 'submit', payload: { submission_id: 'submission-1', form_version: 'digest-1', values: [{ question_id: 'q1', option_ids: ['o1'] }] } } });
    expect(result.new_user_message).toBe(false);
  });

  it('marks Canvas persistence only after the snapshot confirms revision and operation ids', async () => {
    const receipt = { project_id: 'p1', request_id: 'request-1', revision: 4, saved_operation_ids: ['op1'] };
    const snapshot = { document: { project_id: 'p1', revision: 4, nodes: {}, assets: {}, root_node_ids: [] } };
    const { tab, calls } = fixture({ responses: { '/project/save': receipt, '/project/snapshot': snapshot } });
    const result = await canvasSave.run({ tab, args: { origin, project_id: 'p1', base_revision: 3, request_id: 'request-1', operations: [{ operation_id: 'op1', action: 'upsert_node', node_id: 'n1' }] } });
    expect(result.persisted).toBe(true);
    expect(calls.requests.find((call) => call.url.includes('/project/save')).options.body).toMatchObject({ base_revision: 3, request_id: 'request-1' });
  });
});
