import { defineAdapter, errors } from 'opencli-mcp/adapter-sdk';
import { ORIGIN_ARG, api, ids, session, siteOrigin } from './_shared.js';
import { canvasRows, canvasSnapshot, resolveCanvasAssets } from './_canvas.js';

export default defineAdapter({
  description: 'Create an empty Canvas project without sending a turn, or read one exact project detail, persisted snapshot and resolved asset URLs. Missing/inaccessible projects fail instead of falling back to another project. （画布项目与快照）',
  access: 'write', domain: 'facemojiapp.com',
  args: [{ name: 'action', type: 'string', choices: ['create', 'inspect'], default: 'inspect' }, { name: 'project_id', type: 'string' }, { name: 'resolve_assets', type: 'boolean', default: true }, ORIGIN_ARG],
  result: { kind: 'value', description: 'Project identity and persisted Canvas snapshot' },
  async run({ tab, args }) {
    const origin = siteOrigin(args); const s = await session(tab, origin);
    if (args.action === 'create') {
      const project = await api(tab, origin, s, '/df-tide-agent/project/v1/create', { method: 'POST', body: ids(s) });
      if (!project?.id || !project?.conversation_id) throw errors.upstream('Project creation returned no recoverable identity');
      return { project_id: project.id, conversation_id: project.conversation_id, created: true, first_turn_sent: false, hint: 'The project is empty. Send the first turn exactly once with INFINITE_CANVAS and this project_id; project creation is not a chat handoff.' };
    }
    if (!args.project_id) throw errors.argument('project_id is required for inspect');
    const [detail, snapshot] = await Promise.all([
      api(tab, origin, s, `/df-tide-agent/project/v1/detail/${encodeURIComponent(args.project_id)}`, { query: ids(s) }),
      canvasSnapshot(tab, origin, s, args.project_id),
    ]);
    if (snapshot?.document?.project_id && snapshot.document.project_id !== args.project_id) throw errors.upstream('Canvas snapshot project identity mismatch');
    const assetIds = Object.keys(snapshot?.document?.assets || {});
    const resolved = args.resolve_assets === false ? null : await resolveCanvasAssets(tab, origin, s, args.project_id, assetIds);
    return { detail, ...canvasRows(snapshot, resolved), snapshot, assets: resolved?.assets || [], persisted: true };
  },
});
