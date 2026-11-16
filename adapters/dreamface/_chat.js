// Ordinary CHAT and interaction recovery share the same V2 SSE transport.
// Keep connection completion, suspended work and the original turn's terminal state separate.
import { errors } from 'opencli-mcp/adapter-sdk';
import { APP_VERSION, api, headers, ids, messageRow } from './_shared.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const parse = (value) => { try { return JSON.parse(value); } catch { return {}; } };

export function eventData(event) { return parse(event?.data || '{}'); }

export function redactEventData(text) {
  const scrub = (value) => {
    if (Array.isArray(value)) return value.map(scrub);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /token|secret|credential|checkpoint|api_key/i.test(key) ? '******' : scrub(item)]));
  };
  try { return JSON.stringify(scrub(JSON.parse(text))); } catch { return text; }
}

export function chatIdentity(events, initial = {}) {
  const out = { ...initial };
  for (const event of events || []) {
    const data = eventData(event);
    if (data.session_id) out.session_id = data.session_id;
    if (data.turn_id) out.turn_id = data.turn_id;
    if (data.conversation_id) out.conversation_id = data.conversation_id;
    if (data.message_id) out.message_id = data.message_id;
    if (data.stream_id) out.stream_id = data.stream_id;
  }
  return out;
}

export function lastEventId(events) {
  return [...(events || [])].reverse().find((event) => /^\d+$/.test(String(event.id ?? '')))?.id ?? 0;
}

/** Start a fetch in the page and retain bounded raw SSE frames for evidence and recovery. */
export async function launchChat(tab, s, body, key) {
  const requestHeaders = headers(s, { 'Content-Type': 'application/json', Accept: 'text/event-stream' });
  await tab.evaluate(`(() => {
    const state = window[${JSON.stringify(key)}] = { events: [], done: false, error: null, truncated: false };
    const redact = ${redactEventData.toString()};
    (async () => {
      const res = await fetch('/df-tide-agent/agent/v2/chat', { method: 'POST', credentials: 'include', headers: ${JSON.stringify(requestHeaders)}, body: ${JSON.stringify(JSON.stringify(body))} });
      if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
      const reader = res.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\\r/g, '');
        let cut;
        while ((cut = buffer.indexOf('\\n\\n')) >= 0) {
          const block = buffer.slice(0, cut); buffer = buffer.slice(cut + 2);
          let event = 'message'; let id = null; const data = [];
          for (const line of block.split('\\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('id:')) id = line.slice(3).trim();
            else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
          }
          if (!data.join('').trim()) continue;
          if (state.events.length < 2000) state.events.push({ event, id, data: redact(data.join('\\n')).slice(0, 16000) });
          else state.truncated = true;
          if (event === 'done' || event === 'message_complete' || event === 'error') {
            state.done = true; state.error = event === 'error' ? redact(data.join('\\n')) : null;
            reader.cancel().catch(() => {}); return;
          }
        }
      }
      state.done = true;
    })().catch((e) => { state.error = String(e && e.message || e); state.done = true; });
    return true;
  })()`, { allowWrite: true });
}

export async function readChatStream(tab, key) {
  const state = await tab.evaluate(`window[${JSON.stringify(key)}]`);
  if (!state) throw errors.upstream('The page reloaded while the original chat was running', 'Do not resubmit; recover with the original conversation/session ids.');
  return state;
}

export function chatStatus(state) {
  if (state.error) return 'error';
  if (!state.done) return 'running';
  const done = [...state.events].reverse().find((event) => event.event === 'done');
  const data = eventData(done);
  const reason = String(data.reason || '');
  if (/suspend|awaiting|waiting/.test(reason) || data.status === 'suspended') return 'suspended';
  if (done) return data.success === false || data.status === 'failed' ? 'failed' : 'completed';
  return 'connection_closed';
}

export async function waitChat(tab, key, { timeoutSec = 120, observationMs } = {}) {
  const deadline = Date.now() + Math.min(timeoutSec * 1000, observationMs ?? Infinity);
  let state;
  for (;;) {
    state = await readChatStream(tab, key);
    if (state.done || Date.now() >= deadline) break;
    await sleep(Math.min(1500, Math.max(1, deadline - Date.now())));
  }
  return state;
}

export function streamEvidence(state, identity) {
  const status = chatStatus(state);
  return {
    status,
    terminal: status === 'completed',
    ...identity,
    last_event_id: lastEventId(state.events),
    events: state.events,
    ...(state.truncated && { events_truncated: true }),
    ...(state.error && { error: state.error }),
  };
}

export function chatBody(s, args, extra = {}) {
  return {
    ...ids(s), message: args.message, model: args.model,
    execution_mode: args.execution_mode || 'auto',
    credit_confirmation_threshold: args.credit_confirmation_threshold,
    platform_type: args.platform_type || 'WEB', scene_type: 'CHAT', app_version: APP_VERSION,
    session_id: args.session_id, conversation_id: args.conversation_id,
    requested_skill_ids: args.requested_skill_ids || [], attachments: args.attachments,
    ...extra,
  };
}

export async function ordinaryHistory(tab, origin, s, args) {
  if (!args.conversation_id) throw errors.argument('conversation_id is required for ordinary CHAT history');
  return api(tab, origin, s, `/df-tide-agent/conversation/v1/history/${encodeURIComponent(args.conversation_id)}`, {
    query: {
      ...ids(s), limit: args.limit || 100, scene_type: 'CHAT', platform_type: 'WEB', app_version: APP_VERSION,
      before: args.before, before_id: args.before_id, render_schema_version: 1,
    },
  });
}

export function historyRows(history) {
  return (history?.data || []).map((row) => ({
    ...messageRow(row), turn_id: row.turn_id || null, contents: row.contents || [],
    outputs_preview: row.outputs_preview || null, generation_completed: row.generation_completed ?? null,
  }));
}

export async function interactionDetail(tab, origin, s, interactionId) {
  if (!interactionId) throw errors.argument('interaction_id is required');
  return api(tab, origin, s, '/df-tide-agent/agent/v1/interactions/detail', { query: { interaction_id: interactionId, ...ids(s) } });
}

export async function reconnectChat(tab, s, identity, key) {
  if (!identity.session_id) throw errors.argument('session_id is required to reconnect');
  const body = {
    ...ids(s), session_id: identity.session_id, last_event_id: identity.last_event_id || 0,
    message_id: identity.message_id, stream_id: identity.stream_id,
    platform_type: 'WEB', app_version: APP_VERSION, scene_type: identity.project_id ? 'INFINITE_CANVAS' : 'CHAT', project_id: identity.project_id,
  };
  await tab.evaluate(`(() => {
    const state = window[${JSON.stringify(key)}] = { events: [], done: false, error: null, truncated: false };
    const redact = ${redactEventData.toString()};
    (async () => {
      const res = await fetch('/df-tide-agent/agent/v2/chat/reconnect', { method: 'POST', credentials: 'include', headers: ${JSON.stringify(headers(s, { 'Content-Type': 'application/json', Accept: 'text/event-stream' }))}, body: ${JSON.stringify(JSON.stringify(body))} });
      if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
      const reader = res.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\\r/g, '');
        let cut;
        while ((cut = buffer.indexOf('\\n\\n')) >= 0) {
          const block = buffer.slice(0, cut); buffer = buffer.slice(cut + 2);
          let event = 'message'; let id = null; const data = [];
          for (const line of block.split('\\n')) { if (line.startsWith('event:')) event = line.slice(6).trim(); else if (line.startsWith('id:')) id = line.slice(3).trim(); else if (line.startsWith('data:')) data.push(line.slice(5).trimStart()); }
          if (data.join('').trim()) state.events.push({ event, id, data: redact(data.join('\\n')).slice(0, 16000) });
          if (event === 'done' || event === 'error') { state.done = true; state.error = event === 'error' ? redact(data.join('\\n')) : null; reader.cancel().catch(() => {}); return; }
        }
      }
      state.done = true;
    })().catch((e) => { state.error = String(e && e.message || e); state.done = true; });
    return true;
  })()`, { allowWrite: true });
}
