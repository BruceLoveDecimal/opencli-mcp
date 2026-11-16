import { defineAdapter, errors } from 'opencli-mcp/adapter-sdk';
import { ORIGIN_ARG, siteOrigin } from './_shared.js';
import { probeMediaContent } from './_media.js';

export default defineAdapter({
  description: 'Download real image/audio/video content and verify MIME, non-empty bytes, SHA-256 and actual decode/can-play evidence. Supports corrupt/empty/CDN failure reporting; HTTP 200 alone never passes. （媒体可用性检查）',
  access: 'read', domain: 'facemojiapp.com',
  args: [
    { name: 'url', type: 'string', required: true }, { name: 'kind', type: 'string', required: true, choices: ['image', 'audio', 'video'] },
    { name: 'timeout_sec', type: 'int', default: 20, min: 1, max: 120 }, { name: 'max_bytes', type: 'int', default: 52428800, min: 1, max: 104857600 }, ORIGIN_ARG,
  ],
  result: { kind: 'value', description: 'Download and decoder evidence for one exact URL' },
  async run({ tab, args }) {
    siteOrigin(args);
    let url; try { url = new URL(args.url); } catch { throw errors.argument('url must be absolute HTTP(S)'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw errors.argument('url must be absolute HTTP(S)');
    const result = await probeMediaContent(tab, url.href, args.kind, (args.timeout_sec ?? 20) * 1000, args.max_bytes ?? 52428800);
    return { url: url.href, kind: args.kind, ...result, full_playback_verified: false, hint: args.kind === 'video' ? 'can-play metadata and downloaded bytes do not prove full playback; use the real player when the case requires it.' : 'Decoder evidence does not prove the page rendered this media in the correct card or project.' };
  },
});
