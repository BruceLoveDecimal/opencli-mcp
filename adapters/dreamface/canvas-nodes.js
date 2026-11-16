import { defineAdapter } from 'opencli-mcp/adapter-sdk';
import { ORIGIN_ARG, session, siteOrigin } from './_shared.js';
import { canvasRows, canvasSnapshot, resolveCanvasAssets } from './_canvas.js';

export default defineAdapter({
  description: 'List persisted Canvas image/video/audio nodes with output/task/message provenance and source_node_id references for Add to Chat validation. Read-only; does not click, delete or send. （画布节点与引用）',
  access: 'read', domain: 'facemojiapp.com',
  args: [
    { name: 'project_id', type: 'string', required: true }, { name: 'node_ids', type: 'array', items: { type: 'string' } },
    { name: 'media_type', type: 'string', choices: ['image', 'video', 'audio'] }, { name: 'referenceable_only', type: 'boolean', default: false }, ORIGIN_ARG,
  ],
  result: { kind: 'rows', description: 'Persisted Canvas nodes and their chat/output identity mapping' },
  async run({ tab, args }) {
    const origin = siteOrigin(args); const s = await session(tab, origin);
    const snapshot = await canvasSnapshot(tab, origin, s, args.project_id);
    const resolved = await resolveCanvasAssets(tab, origin, s, args.project_id, Object.keys(snapshot?.document?.assets || {}));
    const result = canvasRows(snapshot, resolved);
    const wanted = args.node_ids?.length ? new Set(args.node_ids) : null;
    const rows = result.rows.filter((row) => (!wanted || wanted.has(row.node_id)) && (!args.media_type || row.media_type === args.media_type) && (!args.referenceable_only || row.referenceable));
    return { ...result, rows, references: rows.filter((row) => row.url && row.media_type).map((row) => ({ source_node_id: row.node_id, type: row.media_type, url: row.url, output_id: row.output_id })), hint: 'A reference is valid only for this same project and a currently persisted node. Adding/removing references in the composer still requires real UI evidence.' };
  },
});
