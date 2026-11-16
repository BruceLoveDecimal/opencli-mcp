// Canvas persistence and chat output mapping are read from the same project-scoped snapshot.
import { errors } from 'opencli-mcp/adapter-sdk';
import { api, ids } from './_shared.js';

export async function canvasSnapshot(tab, origin, s, projectId) {
  if (!projectId) throw errors.argument('project_id is required; never send INFINITE_CANVAS work without a project');
  return api(tab, origin, s, '/df-tide-agent/canvas/v1/project/snapshot', { query: { project_id: projectId, ...ids(s) } });
}

export async function resolveCanvasAssets(tab, origin, s, projectId, assetIds) {
  if (!assetIds.length) return { assets: [], unresolved_asset_ids: [] };
  return api(tab, origin, s, '/df-tide-agent/canvas/v1/resource/batch-url', {
    method: 'POST', query: ids(s), body: { project_id: projectId, asset_ids: [...new Set(assetIds)] },
  });
}

export function canvasRows(snapshot, resolved = {}) {
  const document = snapshot?.document || {};
  const urls = new Map((resolved?.assets || []).map((asset) => [asset.asset_id, asset.url || asset.resource_url || null]));
  const rows = Object.values(document.nodes || {}).map((node) => {
    const provenance = document.provenance?.[node.id] || node.provenance || null;
    const asset = document.assets?.[node.content?.asset_id] || null;
    return {
      node_id: node.id, type: node.type, status: node.content?.status || null,
      asset_id: node.content?.asset_id || null, media_type: asset?.media_type || node.content?.expected_media_type || null,
      url: urls.get(node.content?.asset_id) || null, referenceable: node.capabilities?.referenceable === true,
      output_id: provenance?.output_id || null, task_id: node.content?.task_id || provenance?.task_id || null,
      message_id: provenance?.message_id || null, conversation_id: provenance?.conversation_id || null,
      source_node_ids: provenance?.source_node_ids || [], group_id: node.content?.group_id || null,
      transform: node.transform || null,
    };
  });
  return { rows, revision: document.revision ?? null, project_id: document.project_id || null, root_node_ids: document.root_node_ids || [], unresolved_asset_ids: resolved?.unresolved_asset_ids || [] };
}
