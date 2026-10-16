import { defineAdapter } from 'opencli-mcp/adapter-sdk';
import { ORIGIN_ARG, siteOrigin } from './_shared.js';
import { waitForGeneration } from './_generation.js';

export default defineAdapter({
  description: 'Read-only wait for media from one existing UI/API submission. Never submits or spends credits. Requires the exact task/message identity; probes image decode or video metadata. artifact_available is not proof of full playback or Agent turn completion. （只读等待 本次生成 图片 视频）',
  access: 'read',
  domain: 'facemojiapp.com',
  args: [
    { name: 'kind', type: 'string', required: true, choices: ['image', 'video'] },
    { name: 'animate_id', type: 'string', help: 'Ordinary editor task id from this submission; exclusive with Agent ids' },
    { name: 'project_id', type: 'string', help: 'Canvas project id from this UI/API submission' },
    { name: 'conversation_id', type: 'string', help: 'Canvas conversation id from this submission' },
    { name: 'message_id', type: 'string', help: 'Exact assistant message id for this submitted turn; never use the latest message of an old project' },
    { name: 'count', type: 'int', default: 1, min: 1, max: 4, help: 'Minimum number of readable media items to await; observed_count reports extra candidates' },
    { name: 'timeout_sec', type: 'int', default: 60, min: 1, max: 180 },
    ORIGIN_ARG,
  ],
  result: { kind: 'value', description: 'artifact_available, pending or failed; exact handle, media readability, and separately reported terminal state', fields: { status: 'string', terminal: 'string', handle: 'object', media: 'media[]' } },
  async run({ tab, args }) { return waitForGeneration(tab, siteOrigin(args), args, args.timeout_sec ?? 60); },
});
