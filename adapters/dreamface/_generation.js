// Observe one already-submitted generation. Never create a project, send a message, or replay a task.
import { errors } from 'opencli-mcp/adapter-sdk';
import { api, APP_VERSION, ids, messageRow, storedSession } from './_shared.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function handleOf(args) {
  if (!['image', 'video'].includes(args.kind)) throw errors.argument('kind must be image or video');
  const ordinary = Boolean(args.animate_id);
  const agent = Boolean(args.project_id || args.conversation_id || args.message_id);
  if (ordinary === agent) throw errors.argument('Pass exactly one handle: animate_id OR project_id + conversation_id + message_id');
  if (agent && !(args.project_id && args.conversation_id && args.message_id)) throw errors.argument('Agent reads require project_id, conversation_id and the exact assistant message_id from this submission');
  return ordinary ? { kind: args.kind, animate_id: args.animate_id } : {
    kind: args.kind, project_id: args.project_id, conversation_id: args.conversation_id, message_id: args.message_id,
  };
}

/** A media decoder is stronger evidence than a URL or thumbnail; video metadata does not prove full playback. */
export async function probeMedia(tab, url, kind, timeoutMs) {
  try { if (!['https:', 'http:'].includes(new URL(url).protocol)) return { readable: false, reason: 'invalid_url' }; }
  catch { return { readable: false, reason: 'invalid_url' }; }
  return tab.evaluate(`new Promise((resolve) => {
    const kind = ${JSON.stringify(kind)};
    const item = kind === 'image' ? new Image() : document.createElement('video');
    let finished = false;
    const done = (result) => {
      if (finished) return; finished = true; clearTimeout(timer);
      item.onload = item.onloadedmetadata = item.onerror = null;
      if (kind === 'video') { item.removeAttribute('src'); item.load(); }
      else item.src = '';
      resolve(result);
    };
    const timer = setTimeout(() => done({ readable: false, reason: 'media_timeout' }), ${Math.max(1, Math.floor(timeoutMs))});
    item.onerror = () => done({ readable: false, reason: 'load_failed' });
    if (kind === 'image') item.onload = async () => {
      try { await item.decode(); done({ readable: item.naturalWidth > 0 && item.naturalHeight > 0, verification: 'image_decoded', width: item.naturalWidth, height: item.naturalHeight }); }
      catch { done({ readable: false, reason: 'decode_failed' }); }
    };
    else {
      item.preload = 'metadata';
      item.onloadedmetadata = () => done({ readable: item.videoWidth > 0 && item.videoHeight > 0 && Number.isFinite(item.duration) && item.duration > 0, verification: 'video_metadata_loaded', width: item.videoWidth, height: item.videoHeight, duration: item.duration });
    }
    item.src = ${JSON.stringify(url)};
  })`);
}

async function readTask(tab, origin, s, handle, deadline) {
  const read = (path, options = {}) => api(tab, origin, s, path, { ...options, retryServerError: true, deadline });
  if (handle.animate_id) {
    // Bound pagination under the same deadline; absence from page one is not task failure.
    for (let page = 1; page <= 5 && Date.now() < deadline; page++) {
      const data = await read('/dw-server/work/v2/get_recent_creation_list', {
        method: 'POST', body: { ...ids(s), appVersion: APP_VERSION, page, size: 20 },
      });
      const work = (data?.list || []).find((w) => w.animate_id === handle.animate_id);
      if (work) {
        if (work.web_work_status < 0) return { status: 'failed', terminal: 'failed', work_id: work.id, failure_status: work.web_work_status, candidates: [] };
        if (work.web_work_status !== 200) return { terminal: 'running', work_id: work.id, candidates: [] };
        const detail = await read('/dw-server/work/get_work_detail_web', { query: { work_id: work.id, ...ids(s) } });
        if (detail?.id !== work.id) {
          const error = errors.upstream('Work detail identity does not match this generation', `Read the original animate_id ${handle.animate_id}; do not resubmit.`);
          error.code = 'identity_mismatch';
          throw error;
        }
        const urls = handle.kind === 'image' && work.picture_path_list?.length ? work.picture_path_list : [detail?.work_url];
        return { terminal: 'done', work_id: work.id, candidates: urls.filter(Boolean).map((url) => ({ url })) };
      }
      if ((data?.list || []).length < 20) break;
    }
    return { terminal: 'unconfirmed', candidates: [] };
  }
  const history = await read(`/df-tide-agent/conversation/v1/history/${encodeURIComponent(handle.conversation_id)}`, {
    query: { ...ids(s), limit: 100, scene_type: 'INFINITE_CANVAS', project_id: handle.project_id },
  });
  const message = (history?.data || []).find((m) => m.id === handle.message_id && m.role === 'assistant');
  if (!message) return { terminal: 'unconfirmed', candidates: [] };
  const row = messageRow(message);
  // An attachment proves media availability, not the terminal state of the whole Agent turn.
  return { terminal: 'unconfirmed', candidates: (handle.kind === 'image' ? row.images : row.videos).filter((m) => m.url) };
}

/** Poll in code, keeping one identity and one deadline across reads, retries, pagination and media probes. */
export async function waitForGeneration(tab, origin, args, timeoutSec) {
  const task = handleOf(args);
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0 || timeoutSec > 180) throw errors.argument('timeout_sec must be within 1..180');
  const deadline = Date.now() + timeoutSec * 1000;
  const count = args.count ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > 4) throw errors.argument('count must be within 1..4');
  const handle = { ...task, origin, count };
  // Result observation must not navigate away from the UI that submitted the task.
  const current = await tab.url();
  if (!current || new URL(current).origin !== origin) throw errors.argument('Keep the submitting page on the requested origin before waiting');
  const s = await storedSession(tab);
  if (!s) throw errors.auth('DreamFace: not logged in');
  let last = { terminal: 'unconfirmed' };
  let interval = 2000;
  while (Date.now() < deadline) {
    try {
      const { candidates, ...state } = await readTask(tab, origin, s, handle, deadline);
      last = state;
      if (state.status === 'failed') return { ...state, handle, media: [] };
      const unique = [...new Map(candidates.map((item) => [item.url, item])).values()];
      const media = [];
      for (const item of unique.slice(0, count)) {
        if (Date.now() >= deadline) break;
        const probe = await probeMedia(tab, item.url, handle.kind, Math.min(5000, deadline - Date.now()));
        if (probe?.readable) media.push({ ...item, ...probe });
      }
      if (media.length === count && Date.now() < deadline) return { ...state, status: 'artifact_available', handle, media, observed_count: unique.length };
    } catch (error) {
      if (['auth_required', 'invalid_args', 'identity_mismatch'].includes(error?.code)) throw error;
      return { ...last, status: 'pending', handle, media: [], read_error: { code: error?.code || 'read_failed', message: String(error?.message || error).slice(0, 500) }, hint: 'Read failed; query this same handle again within the original case deadline. Never resubmit.' };
    }
    if (Date.now() < deadline) await sleep(Math.min(interval, deadline - Date.now()));
    interval = Math.min(8000, interval * 2);
  }
  return { ...last, status: 'pending', handle, media: [], hint: 'Only query this same handle again; never resubmit an unknown generation.' };
}
