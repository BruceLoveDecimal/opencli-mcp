import { defineAdapter } from 'opencli-mcp/adapter-sdk';
import { ORIGIN_ARG, session, siteOrigin } from './_shared.js';
import { normalizeAttachments } from './_attachments.js';

export default defineAdapter({
  description: 'Inspect current attachment controls and validate candidate type/order/formal URLs, including Canvas source_node_id references and the five-item limit. Read-only; never selects, removes or sends. （附件与素材核对）',
  access: 'read', domain: 'facemojiapp.com',
  args: [
    { name: 'candidates', type: 'array', items: { type: 'object', properties: {}, open: true }, help: 'Current uploads or My Creations candidates: {url,type,label,source_node_id,output_id}' },
    { name: 'existing_count', type: 'int', default: 0, min: 0, max: 5 }, { name: 'max', type: 'int', default: 5, min: 1, max: 5 },
    { name: 'route', type: 'string', help: 'Optional actual composer route, e.g. /i-want or /home?tab=agent' }, ORIGIN_ARG,
  ],
  result: { kind: 'value', description: 'Candidate validation and rendered attachment/media state' },
  async run({ tab, args }) {
    const origin = siteOrigin(args); await session(tab, origin);
    if (args.route) await tab.goto(new URL(args.route, origin).href, { waitUntil: 'load' });
    const normalized = normalizeAttachments(args.candidates || [], { max: Math.max(1, (args.max || 5) - (args.existing_count || 0)) });
    const controls = await tab.evaluate(`(() => ({
      files: [...document.querySelectorAll('input[type=file]')].map((e, i) => ({ index: i, accept: e.accept, multiple: e.multiple, disabled: e.disabled, count: e.files?.length || 0 })),
      media: [...document.querySelectorAll('img,video,audio')].filter((e) => e.closest('form,[class*=attachment],[class*=composer],[class*=chat]')).slice(0, 100).map((e) => ({ tag: e.tagName.toLowerCase(), src: e.currentSrc || e.src || null, complete: e.tagName === 'IMG' ? e.complete && e.naturalWidth > 0 : undefined, readyState: e.readyState }))
    }))()`);
    const observation = await tab.observe({ viewport: true });
    const { rows, ...summary } = normalized;
    return { ...summary, candidate_results: rows, existing_count: args.existing_count || 0, controls, observation: observation.state, hint: 'Candidates with missing_formal_url or unknown_media_type must not enter a chat request. Rendered controls are evidence only; use real clicks for selection/removal assertions.' };
  },
});
