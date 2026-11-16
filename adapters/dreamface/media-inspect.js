import { defineAdapter, errors } from 'opencli-mcp/adapter-sdk';
import { ORIGIN_ARG, siteOrigin } from './_shared.js';
import { probeMediaContent } from './_media.js';

export default defineAdapter({
  description: 'Batch-download and decode up to 8 real media URLs in one command. Each row reports MIME, bytes, SHA-256 and decoder/can-play evidence; interrupted downloads resume with Range instead of restarting from zero. （批量媒体检查）',
  access: 'read', domain: 'facemojiapp.com',
  args: [
    { name: 'items', type: 'array', required: true, items: { type: 'object', properties: {}, open: true }, help: 'Up to 8 entries: {url,kind:image|audio|video}' },
    { name: 'timeout_sec', type: 'int', default: 30, min: 1, max: 120 },
    { name: 'max_bytes', type: 'int', default: 52428800, min: 1, max: 104857600 }, ORIGIN_ARG,
  ],
  result: { kind: 'rows', description: 'One independent download/decoder result per requested URL' },
  async run({ tab, args }) {
    siteOrigin(args);
    if (!Array.isArray(args.items) || !args.items.length || args.items.length > 8) throw errors.argument('items requires 1–8 media entries');
    const items = args.items.map((item) => {
      if (!['image', 'audio', 'video'].includes(item?.kind)) throw errors.argument('Every media item needs kind=image|audio|video');
      try { const url = new URL(item.url); if (!['http:', 'https:'].includes(url.protocol)) throw new Error('scheme'); return { kind: item.kind, url: url.href }; }
      catch { throw errors.argument('Every media item needs an absolute HTTP(S) url'); }
    });
    const timeoutMs = (args.timeout_sec ?? 30) * 1000;
    const rows = await Promise.all(items.map(async (item) => ({
      ...item,
      ...(await probeMediaContent(tab, item.url, item.kind, timeoutMs, args.max_bytes ?? 52428800)),
      full_playback_verified: false,
    })));
    return { rows, hint: 'Rows are independent evidence, not a group pass. Video can-play is not full playback; rendered cards, players and billing still need their own evidence.' };
  },
});
