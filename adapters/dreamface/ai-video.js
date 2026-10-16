import { defineAdapter, errors } from 'opencli-mcp/adapter-sdk';
import { ORIGIN_ARG, api, camelIds, session, siteOrigin, snakeKeys, templateConfig } from './_shared.js';
import { waitForGeneration } from './_generation.js';

/** The AI video page sends its own app version; the endpoint rejects the rest of the site's (4.7.1) as illegal. */
const VIDEO_APP_VERSION = '5.3.0';

export default defineAdapter({
  description: 'AI Video: text-to-video with DreamFace\'s default video model (Dream Video, 480p); waits at most 30s, then returns readable media or a pending original task handle; continue read-only with generation-wait. One free video per day, then credits. （AI 视频 文生视频 生成视频）',
  access: 'write',
  domain: 'facemojiapp.com',
  args: [
    { name: 'prompt', type: 'string', required: true, maxLength: 1500, example: 'a paper boat drifting on a calm lake at sunrise' },
    { name: 'duration_sec', type: 'int', default: 5, choices: [5, 10] },
    { name: 'resolution', type: 'string', default: '480p', choices: ['480p', '720p'] },
    { name: 'ai_sound', type: 'boolean', default: true, help: 'Add AI sound, as the site does by default' },
    { name: 'timeout_sec', type: 'int', default: 900, min: 60, max: 3600 },
    ORIGIN_ARG,
  ],
  result: { kind: 'value', description: 'Readable video or pending original task handle', fields: { status: 'string', handle: 'object', work_id: 'string', animate_id: 'string', url: 'string (signed, ~1h)', cover_url: 'string', duration: 'number' } },
  async run({ tab, args }) {
    const origin = siteOrigin(args);
    const prompt = String(args.prompt || '').trim();
    if (!prompt) throw errors.argument('`prompt` is required');
    const s = await session(tab, origin);
    const templateId = (await templateConfig(tab, origin, s)).aiVideoTextId;
    if (!templateId) throw errors.upstream('DreamFace template_config has no aiVideoTextId');
    const data = await api(tab, origin, s, '/dw-server/face/animate_image_web', {
      method: 'POST',
      // written as the page builds it, sent as its HTTP client sends it
      body: snakeKeys({
        ...camelIds(s),
        appVersion: VIDEO_APP_VERSION,
        createWorkSession: true,
        effectEnable: false,
        ext: { animateChannel: 'textToVideo', singTitle: prompt.slice(0, 10) },
        mergeByServer: false,
        noWaterMark: 0,
        photoInfoList: [{ photoPath: '' }],
        playTypes: args.ai_sound === false ? ['WAN'] : ['WAN', 'AI_SOUND'],
        ptInfos: [],
        templateId,
        timestamp: Date.now(),
        // as the page builds it for Dream Video (WAN) text-to-video
        viduInfo: {
          duration: args.duration_sec ?? 5, prompts: [{ content: prompt, type: 'text' }], style: 'general', type: 'text2video',
          ratio: '', modelVersion: 'wan2.1', resolution: args.resolution || '480p', movementAmplitude: 'auto', vertical: false,
        },
        workType: 'AI_VIDEO',
      }),
    });
    if (!data?.animate_image_id) throw errors.upstream('DreamFace accepted the video but returned no id');
    const result = await waitForGeneration(tab, origin, { kind: 'video', animate_id: data.animate_image_id, count: 1 }, Math.min(args.timeout_sec ?? 900, 30));
    return { ...result, animate_id: data.animate_image_id, ...(result.media?.[0]?.url && { url: result.media[0].url }), prompt };
  },
});
