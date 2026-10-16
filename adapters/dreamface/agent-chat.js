import { defineAdapter, errors } from 'opencli-mcp/adapter-sdk';
import { ORIGIN_ARG, runAgent, siteOrigin } from './_shared.js';

export default defineAdapter({
  description: 'Ask the DreamFace Canvas agent through the API and get its answer. Creates a new project with scene_type=INFINITE_CANVAS; does not send through or update the current page, including /i-want. Not evidence of i-want UI behavior. May use a free daily agent use or credits. （画布智能体 问答 对话；非 i-want 页面发送）',
  access: 'write',
  domain: 'facemojiapp.com',
  args: [
    { name: 'message', type: 'string', required: true, help: 'What to ask the agent', example: '用一句话介绍 DreamFace 能做什么' },
    { name: 'model', type: 'string', help: 'Agent model from agent-models; omitted uses the first currently available model' },
    { name: 'timeout_sec', type: 'int', default: 180, min: 10, max: 1800 },
    ORIGIN_ARG,
  ],
  result: { kind: 'value', description: 'The agent turn', fields: { answer: 'string', images: 'media[]', videos: 'media[]', project_id: 'string', conversation_id: 'string', tools: 'string[]', credits_used: 'number|null (null when no usage receipt was observed)' } },
  async run({ tab, args }) {
    const message = String(args.message || '').trim();
    if (!message) throw errors.argument('`message` is required');
    return runAgent(tab, siteOrigin(args), { message, model: args.model, timeoutSec: args.timeout_sec ?? 180 });
  },
});
