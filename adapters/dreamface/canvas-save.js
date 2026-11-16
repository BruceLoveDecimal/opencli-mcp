import { defineAdapter, errors } from 'opencli-mcp/adapter-sdk';
import { ORIGIN_ARG, api, ids, session, siteOrigin } from './_shared.js';
import { canvasRows, canvasSnapshot } from './_canvas.js';

export default defineAdapter({
  description: 'Save explicit Canvas incremental operations with base_revision/request_id, then re-read the persisted snapshot. A write response without the expected revision/operation ids is not reported as persisted. （画布增量保存）',
  access: 'write', domain: 'facemojiapp.com',
  args: [
    { name: 'project_id', type: 'string', required: true }, { name: 'base_revision', type: 'int', required: true, min: 0 },
    { name: 'request_id', type: 'string', required: true, help: 'Stable save id; reuse exactly after a lost response' },
    { name: 'operations', type: 'array', required: true, items: { type: 'object', properties: {}, open: true }, help: 'Each: operation_id/action/node_id plus complete node/asset_upserts/provenance_upserts/generation_group_upserts as required' },
    { name: 'verify_snapshot', type: 'boolean', default: true }, ORIGIN_ARG,
  ],
  result: { kind: 'value', description: 'Save receipt and independently re-read persistence evidence' },
  async run({ tab, args }) {
    const origin = siteOrigin(args); const s = await session(tab, origin);
    if (!Array.isArray(args.operations) || args.operations.some((operation) => !operation?.operation_id || !operation?.action)) throw errors.argument('Every operation needs operation_id and action');
    const body = { project_id: args.project_id, base_revision: args.base_revision, request_id: args.request_id, operations: args.operations };
    const receipt = await api(tab, origin, s, '/df-tide-agent/canvas/v1/project/save', { method: 'POST', query: ids(s), body });
    let snapshot = null; let readError = null;
    if (args.verify_snapshot !== false) {
      try { snapshot = await canvasSnapshot(tab, origin, s, args.project_id); }
      catch (error) { readError = String(error?.message || error); }
    }
    const savedIds = receipt?.saved_operation_ids || [];
    const revision = snapshot?.document?.revision;
    const persisted = Boolean(snapshot && receipt?.project_id === args.project_id && receipt?.request_id === args.request_id
      && args.operations.every((operation) => savedIds.includes(operation.operation_id))
      && (receipt.no_change === true || (typeof revision === 'number' && revision >= receipt.revision)));
    return { receipt, persisted, snapshot: snapshot ? { ...canvasRows(snapshot), document: snapshot.document, limits: snapshot.limits, usage: snapshot.usage } : null, ...(readError && { snapshot_read_error: readError }), hint: persisted ? 'The snapshot confirms these operation ids and revision. UI placement and media still need page evidence.' : 'Do not claim persistence or blindly create new operation ids. Re-read the same project/revision and resolve any version conflict before retrying request_id.' };
  },
});
