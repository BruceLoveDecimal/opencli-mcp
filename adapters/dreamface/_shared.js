// Shared helpers for the DreamFace adapters. Files starting with `_` are not commands.
//
// DreamFace's web API authenticates with request headers, not cookies: `token` (the logged-in user's JWT), `Client-Id`
// (a device fingerprint) and `dream-face-web`. The web app keeps them in localStorage under md5-named keys; every call
// reads them at run time from the logged-in page, so nothing is stored in the adapter.
import { errors } from 'opencli-mcp/adapter-sdk';

export const DEFAULT_ORIGIN = 'https://testm.facemojiapp.com';
/** The web app's version, sent as app_version/appVersion like the site does. */
export const APP_VERSION = '4.7.1';
const OK = 'THS12140000000';
/** md5("userInfo"), md5("loginSecretKey") and md5("fingerprintjsStatClientId"): the web app's storage keys. */
export const USER_INFO_KEY = '49f290d6e8459c53f31f97de37921086';
export const LOGIN_SECRET_KEY = 'f5c8e5076df19ee3120af47e17e0cfda';
const CLIENT_ID_KEY = '19fb90a3b8f09f14a91f48eee48c12af';

export const ORIGIN_ARG = { name: 'origin', type: 'string', default: DEFAULT_ORIGIN, help: 'DreamFace site, e.g. the test environment https://testm.facemojiapp.com' };

export function siteOrigin(args) {
  const raw = String(args?.origin || DEFAULT_ORIGIN).trim();
  try { return new URL(raw).origin; } catch { throw errors.argument(`origin is not a URL: ${raw}`); }
}

/** Be on the DreamFace origin so storage and same-origin API calls work. */
export async function ensureOnSite(tab, origin) {
  const url = await tab.url().catch(() => null);
  if (!url || !url.startsWith(origin)) await tab.goto(`${origin}/zh/home`, { waitUntil: 'load' });
}

/** The session stored in the page (the tab must be on the origin), or null when logged out. */
export async function storedSession(tab) {
  const raw = await tab.evaluate(`(() => ({ user: localStorage.getItem(${JSON.stringify(USER_INFO_KEY)}), clientId: localStorage.getItem(${JSON.stringify(CLIENT_ID_KEY)}) }))()`);
  let user = null;
  try { user = raw?.user ? JSON.parse(raw.user) : null; } catch { user = null; }
  if (!user?.token || !user?.userId || !user?.accountId) return null;
  return { token: user.token, userId: user.userId, accountId: user.accountId, clientId: raw.clientId || '', email: user.thirdId || null, vip: user.userRights?.vipLabel ?? null };
}

/** The logged-in session: { token, userId, accountId, clientId, email, vip }. Throws an auth error when logged out. */
export async function session(tab, origin) {
  await ensureOnSite(tab, origin);
  const s = await storedSession(tab);
  if (!s) throw errors.auth('DreamFace: not logged in', `Open ${origin} in this browser and sign in (or run dreamface/login), then retry.`);
  return s;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function headers(s, extra = {}) {
  return { 'dream-face-web': 'dream-face-web', ...(s.clientId && { 'Client-Id': s.clientId }), token: s.token, ...extra };
}

/** tab.fetchJson with the session headers, retrying the gateway errors DreamFace's test environment returns now and then. */
export async function request(tab, s, url, { method = 'GET', body, timeoutMs, retryServerError = false, deadline } = {}) {
  // A gateway error cannot prove a write was rejected. Only reads or explicitly harmless requests may retry.
  const canRetry = retryServerError || method === 'GET';
  const retryable = retryServerError ? /HTTP 50[0234]\b/ : /HTTP 50[234]\b/;
  for (let attempt = 1; ; attempt++) {
    const remaining = deadline === undefined ? undefined : deadline - Date.now();
    if (remaining !== undefined && remaining <= 0) throw errors.upstream('Read deadline reached');
    const limit = remaining === undefined ? timeoutMs : Math.max(1, Math.min(timeoutMs ?? 30_000, remaining));
    try {
      return await tab.fetchJson(url, { method, headers: headers(s), ...(body !== undefined && { body }), ...(limit && { timeoutMs: limit }) });
    } catch (error) {
      if (attempt >= 3 || !canRetry || !retryable.test(String(error?.message))) throw error;
      await sleep(deadline === undefined ? 1000 * attempt : Math.max(0, Math.min(1000 * attempt, deadline - Date.now())));
    }
  }
}

/** Call a DreamFace API on the page; returns `data`. Query values that are undefined are dropped. */
export async function api(tab, origin, s, path, { method = 'GET', query, body, timeoutMs, retryServerError, deadline } = {}) {
  const url = new URL(path, origin);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  const json = await request(tab, s, url.href, { method, body, timeoutMs, retryServerError: retryServerError ?? method === 'GET', deadline });
  const code = json?.status_code ?? json?.statusCode;
  if (code === OK) return json.data ?? json.body ?? null;
  const message = json?.status_msg ?? json?.statusMsg ?? 'no status';
  if (String(code) === '-4000' || /auth/i.test(message)) throw errors.auth(`DreamFace: ${message}`, `Sign in again at ${origin}.`);
  throw errors.upstream(`DreamFace ${path}: ${message} (${code})`);
}

/**
 * The web app writes request bodies in camelCase and its HTTP client converts every key to snake_case before sending
 * (userId → user_id, deep). Endpoints reject camelCase bodies as "Parameter Illegal", so bodies written in the page's
 * shape go through this first.
 */
export function snakeKeys(value) {
  if (Array.isArray(value)) return value.map(snakeKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), snakeKeys(v)]));
}

/** Both id spellings the two back ends use. */
export function ids(s) { return { user_id: s.userId, account_id: s.accountId }; }
export function camelIds(s) { return { userId: s.userId, accountId: s.accountId }; }

/** One media item as returned to the agent. */
function media(item) {
  return { url: item.url, label: item.label ?? null, ...(item.output_id && { output_id: item.output_id }), ...(item.first_frame_image_url && { cover_url: item.first_frame_image_url }), ...(item.video_width && { width: item.video_width, height: item.video_height }) };
}

/**
 * Run one agent turn (the home page / canvas agent): create a canvas project, stream `/df-tide-agent/agent/v2/chat`
 * in the page, wait for `message_complete`, then read the turn back from the conversation history. Returns the answer
 * text and every image/video/audio it produced.
 *
 * The stream is read inside the page (it can run for minutes while a video renders) and polled with short evaluates,
 * so no single browser command outlives its deadline.
 */
/** Resolve live configuration before creating any project or starting a billable turn. */
export async function agentModel(tab, origin, s, requested, deadline) {
  const models = await api(tab, origin, s, '/df-tide-agent/model/v1/list', { method: 'POST', body: ids(s), deadline });
  const available = (models || []).filter((m) => m.name && m.is_active !== false);
  const selected = requested ? available.find((m) => m.name === requested) : available[0];
  if (!selected) throw errors.argument(requested ? `Agent model ${requested} is unavailable` : 'No Agent model is currently available', 'Read dreamface agent-models; no generation has been submitted.');
  return selected.name;
}

export async function runAgent(tab, origin, { message, model, timeoutSec, kind, count = 1 }) {
  // A media submission must release the host's session lock while its original task keeps running.
  const mediaRun = kind === 'image' || kind === 'video';
  const deadline = Date.now() + Math.min(timeoutSec * 1000, mediaRun ? 30_000 : Infinity);
  const s = await session(tab, origin);
  model = await agentModel(tab, origin, s, model, deadline);
  // creating an empty project is harmless to repeat; the test environment times out here now and then
  const project = await api(tab, origin, s, '/df-tide-agent/project/v1/create', { method: 'POST', body: ids(s), retryServerError: true, deadline });
  if (!project?.id || !project?.conversation_id) throw errors.upstream('Project creation returned no recoverable identity; inspect recent projects before retrying');
  const run = `opencli_df_${Date.now().toString(36)}`;
  const body = { ...ids(s), message, model, execution_mode: 'auto', platform_type: 'WEB', scene_type: 'INFINITE_CANVAS', project_id: project.id, app_version: APP_VERSION };
  const launch = () => tab.evaluate(`(() => {
    const state = window[${JSON.stringify(run)}] = { events: [], done: false, error: null };
    (async () => {
      const res = await fetch('/df-tide-agent/agent/v2/chat', { method: 'POST', credentials: 'include', headers: ${JSON.stringify(headers(s, { 'Content-Type': 'application/json', Accept: 'text/event-stream' }))}, body: ${JSON.stringify(JSON.stringify(body))} });
      if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
      const reader = res.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\\r/g, '');
        let cut;
        while ((cut = buffer.indexOf('\\n\\n')) >= 0) {
          const block = buffer.slice(0, cut); buffer = buffer.slice(cut + 2);
          let event = 'message'; const data = [];
          for (const line of block.split('\\n')) { if (line.startsWith('event:')) event = line.slice(6).trim(); else if (line.startsWith('data:')) data.push(line.slice(5).trimStart()); }
          // deltas are read back from the history; blocks without data are the server's heartbeats
          if (event === 'text_delta' || event === 'think_delta' || !data.join('').trim()) continue;
          state.events.push({ event, data: data.join('\\n').slice(0, 2000) });
          if (event === 'done' || event === 'message_complete' || event === 'error') { state.done = true; state.error = event === 'error' ? data.join('\\n') : null; reader.cancel().catch(() => {}); return; }
        }
      }
      state.done = true;
    })().catch((e) => { state.error = String(e && e.message || e); state.done = true; });
    return true;
  })()`, { allowWrite: true });
  if (mediaRun) {
    return runMediaTurn(tab, origin, s, project, { launch, run, message, kind, count, deadline });
  }
  await launch();
  let state;
  for (;;) {
    await sleep(2000);
    state = await tab.evaluate(`window[${JSON.stringify(run)}]`);
    if (!state) throw errors.upstream('DreamFace: the page reloaded while the agent was running', `Do not resubmit; query project ${project.id}, conversation ${project.conversation_id}.`);
    if (state.done) break;
    if (Date.now() > deadline) throw errors.upstream(`DreamFace agent did not finish within ${timeoutSec}s`, `The run continues on DreamFace; read it later with dreamface conversation (project ${project.id}, conversation ${project.conversation_id}).`);
  }
  if (state.error) {
    let detail = {};
    try { detail = JSON.parse(state.error); } catch { /* not JSON */ }
    const timedOut = /timeout/i.test(`${detail.error_type ?? ''} ${detail.error ?? ''} ${state.error}`);
    throw errors.upstream(
      `DreamFace agent failed: ${detail.error_type || detail.code || state.error}`,
      `Do not resubmit${timedOut ? ' after the upstream timeout' : ''}; inspect project ${project.id}, conversation ${project.conversation_id} with dreamface conversation.`,
    );
  }
  const turn = await lastTurn(tab, origin, s, project);
  return { project_id: project.id, conversation_id: project.conversation_id, ...turn, ...usage(state.events) };
}

/** Match this input in its new project; an unrelated/latest assistant is never a recovery handle. */
async function submittedTurn(tab, origin, s, project, message, deadline) {
  const history = await api(tab, origin, s, `/df-tide-agent/conversation/v1/history/${encodeURIComponent(project.conversation_id)}`, {
    query: { ...ids(s), limit: 100, scene_type: 'INFINITE_CANVAS', project_id: project.id }, deadline,
  });
  const rows = history?.data || [];
  const users = rows.filter((row) => row.role === 'user' && row.content === message);
  if (users.length !== 1) return null;
  const start = rows.indexOf(users[0]) + 1;
  const nextUser = rows.findIndex((row, index) => index >= start && row.role === 'user');
  const answers = rows.slice(start, nextUser < 0 ? undefined : nextUser).filter((row) => row.role === 'assistant');
  if (answers.length !== 1 || !answers[0].id) return null;
  return { ...messageRow(answers[0]), user_message_id: users[0].id };
}

async function runMediaTurn(tab, origin, s, project, { launch, run, message, kind, count, deadline }) {
  let turn = null;
  let state = { done: false, error: null };
  const result = (status, readError) => ({
    status, terminal: state.done && !state.error ? 'done' : 'unconfirmed',
    project_id: project.id, conversation_id: project.conversation_id,
    ...(turn?.user_message_id && { user_message_id: turn.user_message_id }),
    answer: turn?.content || '', images: turn?.images || [], videos: turn?.videos || [], audios: turn?.audios || [],
    handle: { kind, project_id: project.id, conversation_id: project.conversation_id, ...(turn?.id && { message_id: turn.id }), origin, count },
    ...(readError && { read_error: { code: readError.code || 'read_failed', message: String(readError.message || readError).slice(0, 500) } }),
    ...usage(state.events || []),
    hint: turn?.id
      ? 'Only read this same handle with generation-wait (timeout_sec 1..180). Do not resubmit or add a fixed sleep after its pending result.'
      : 'Do not resubmit. Read conversation for these exact project/conversation ids, match this submitted input and resolve its assistant message_id before generation-wait.',
  });
  try {
    await launch();
    let interval = 2000;
    while (Date.now() < deadline) {
      const observed = await tab.evaluate(`window[${JSON.stringify(run)}]`);
      if (!observed) return result('command_outcome_unknown');
      state = observed;
      turn = await submittedTurn(tab, origin, s, project, message, deadline);
      const outputs = kind === 'image' ? turn?.images : turn?.videos;
      // These are attachments, not decoder evidence; generation-wait separately verifies readability.
      if ((outputs || []).length >= count) return result('generated');
      if (state.error) return result('command_outcome_unknown', new Error(state.error));
      if (state.done) return result('no_media');
      await sleep(Math.max(0, Math.min(interval, deadline - Date.now())));
      interval = Math.min(8000, interval * 2);
    }
    return result('pending');
  } catch (error) {
    return result('command_outcome_unknown', error);
  }
}

/** Which tools the agent called and the credits DreamFace reported for them, from the stream's events. */
function usage(events) {
  const parse = (data) => { try { return JSON.parse(data); } catch { return {}; } };
  const tools = events.filter((e) => e.event === 'tool_call_start').map((e) => parse(e.data).name).filter((name) => name && name !== 'load_tool_schema');
  const usage = events.filter((e) => e.event === 'dreamapi_usage').map((e) => parse(e.data).credit_usage)
    .filter((value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)));
  return { tools, credits_used: usage.length ? usage.reduce((sum, value) => sum + Number(value), 0) : null };
}

/** The latest assistant message of a canvas conversation, with its media. */
export async function lastTurn(tab, origin, s, project) {
  const history = await api(tab, origin, s, `/df-tide-agent/conversation/v1/history/${project.conversation_id}`, { query: { ...ids(s), limit: 20, scene_type: 'INFINITE_CANVAS', project_id: project.id } });
  const messages = history?.data || [];
  const answer = [...messages].reverse().find((m) => m.role === 'assistant');
  if (!answer) throw errors.empty('DreamFace agent returned no answer');
  const a = answer.attachments || {};
  return {
    answer: answer.content || '',
    images: (a.image || []).map(media),
    videos: (a.video || []).map(media),
    audios: (a.audio || []).map(media),
  };
}

/** Normalize a conversation message for read commands. */
export function messageRow(m) {
  const a = m.attachments || {};
  return { id: m.id, role: m.role, content: m.content || '', created: m.create_time ? new Date(m.create_time).toISOString() : null, images: (a.image || []).map(media), videos: (a.video || []).map(media), audios: (a.audio || []).map(media) };
}

/** Work status codes (web_work_status / work_status): 0 waiting, 100 generating, 200 success, negative = failed. */
const WORK_FAILURES = {
  '-1': 'generation failed', '-2': 'generation timed out', '-3': 'not enough credits', '-101': 'rejected: nudity',
  '-102': 'rejected: sensitive text', '-103': 'rejected: political content',
};

/** Submit a generation task (image, avatar) — POST /dw-server/task/v2/submit; returns the animate id. */
export async function submitTask(tab, origin, s, body) {
  const data = await api(tab, origin, s, '/dw-server/task/v2/submit', { method: 'POST', body });
  if (!data?.animate_image_id) throw errors.upstream('DreamFace accepted the task but returned no id');
  return data.animate_image_id;
}

/**
 * Wait for the work created by `animateId` to finish, polling the creation list (the list the "作品" page shows; it
 * covers images, videos and avatars). Returns the finished list entry; throws with the site's reason on failure.
 */
export async function waitForWork(tab, origin, s, animateId, timeoutSec) {
  const deadline = Date.now() + timeoutSec * 1000;
  try {
    for (;;) {
      const data = await api(tab, origin, s, '/dw-server/work/v2/get_recent_creation_list', { method: 'POST', body: { ...ids(s), appVersion: APP_VERSION, page: 1, size: 20 }, retryServerError: true, deadline });
      const work = (data?.list || []).find((w) => w.animate_id === animateId);
      const status = work?.web_work_status;
      if (status === 200) return work;
      if (typeof status === 'number' && status < 0) throw errors.upstream(`DreamFace: ${WORK_FAILURES[String(status)] || `failed with status ${status}`}`, `animate id ${animateId}`);
      if (Date.now() > deadline) throw errors.upstream(`DreamFace work did not finish within ${timeoutSec}s`, `It continues on DreamFace; check it later with dreamface works (animate id ${animateId}).`);
      await sleep(Math.max(0, Math.min(4000, deadline - Date.now())));
    }
  } catch (error) {
    throw errors.upstream(String(error?.message || error), `Do not resubmit. Read the original animate id ${animateId} with generation-wait or works.`);
  }
}

/** A finished work with its download URL (signed, valid about an hour) and every image URL. */
export async function workResult(tab, origin, s, work) {
  const detail = await api(tab, origin, s, '/dw-server/work/get_work_detail_web', { query: { work_id: work.id, ...ids(s) } }).catch(() => null);
  return workRow(work, detail);
}

export function workRow(work, detail = null) {
  return {
    work_id: work.id,
    animate_id: work.animate_id,
    type: work.work_type,
    kind: work.work_detail_type || work.template_name || null,
    name: work.work_name || '',
    status: work.web_work_status === 200 ? 'done' : work.web_work_status < 0 ? 'failed' : 'running',
    file_type: work.file_type || null,
    duration: work.duration ?? null,
    cover_url: work.work_webp_path || null,
    images: work.picture_path_list?.length ? work.picture_path_list : undefined,
    url: detail?.work_url || undefined,
    created: work.create_time ? new Date(work.create_time).toISOString() : null,
  };
}

/** The web app's `template_config` (template ids for AI video and more). */
export async function templateConfig(tab, origin, s) {
  const data = await api(tab, origin, s, '/dw-server/sys_config/query/template_config');
  try { return JSON.parse(data?.value || '{}'); } catch { return {}; }
}
