import { defineAdapter, errors } from 'opencli-mcp/adapter-sdk';
import { ORIGIN_ARG, session, siteOrigin } from './_shared.js';
import { responseUrls } from './_attachments.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default defineAdapter({
  description: 'Select up to five real local image/audio/video files in the actual DreamFace composer and collect upload/UI/network evidence. Never sends the chat. Failed or unfinished files are not converted into attachment URLs. （上传附件）',
  access: 'write', domain: 'facemojiapp.com',
  args: [
    { name: 'files', type: 'array', required: true, items: { type: 'string' }, help: 'Absolute paths of real image/audio/video fixtures, at most 5' },
    { name: 'target', type: 'object', properties: {}, open: true, help: 'Observed file-input target; omitted finds an enabled input[type=file]' },
    { name: 'route', type: 'string', default: '/i-want', help: 'Actual composer route, e.g. /i-want or /canvas?projectId=…' },
    { name: 'timeout_sec', type: 'int', default: 30, min: 1, max: 120 }, ORIGIN_ARG,
  ],
  result: { kind: 'value', description: 'Real file selection, upload responses and current UI evidence; not a chat submission' },
  async run({ tab, args }) {
    const files = args.files || [];
    if (!files.length || files.length > 5) throw errors.argument('files requires 1–5 absolute paths');
    const origin = siteOrigin(args); await session(tab, origin);
    await tab.goto(new URL(args.route || '/i-want', origin).href, { waitUntil: 'load' });
    let target = args.target;
    if (!target) {
      const found = await tab.find({ selector: 'input[type=file]', limit: 20 });
      const candidate = (found?.entries || []).find((entry) => entry.enabled !== false);
      if (!candidate?.ref) throw errors.empty('No enabled file input exists on this composer');
      target = { ref: candidate.ref };
    }
    const selected = await tab.act({ action: 'upload', target, files });
    const cursor = selected.network?.afterSequence ?? 0;
    const deadline = Date.now() + (args.timeout_sec ?? 30) * 1000;
    let entries = []; let observation;
    for (;;) {
      const captured = await tab.network.read({ afterSequence: cursor, limit: 100 });
      entries = captured.entries.filter((entry) => /upload|file|attachment/i.test(String(entry.url || '')) || Number(entry.seq) === Number(selected.network?.cursor));
      observation = await tab.observe({ viewport: true });
      if (entries.some((entry) => entry.responseStatus || entry.error || entry.done) || Date.now() >= deadline) break;
      await sleep(Math.min(1000, Math.max(1, deadline - Date.now())));
    }
    const responses = [];
    for (const entry of entries) {
      let detail = null;
      try { detail = await tab.network.detail({ seq: entry.seq, part: 'response', maxChars: 30000 }); } catch { /* retain summary */ }
      const text = detail?.body?.text || detail?.text || entry.responsePreview || '';
      let json = null; try { json = JSON.parse(text); } catch { /* non-JSON upload response */ }
      responses.push({ seq: entry.seq, url: entry.url, status: entry.responseStatus || entry.status || null, formal_urls: responseUrls(json), response: json || String(text).slice(0, 2000) });
    }
    const pending = entries.some((entry) => !entry.done && !entry.responseStatus && !entry.error);
    return {
      selected: selected.fileSelection || [], selection_verified: selected.controlState === 'verified',
      upload_count: responses.length, responses, formal_urls: [...new Set(responses.flatMap((row) => row.formal_urls))],
      status: responses.some((row) => Number(row.status) >= 400) ? 'failed' : pending ? 'pending' : responses.length ? 'responded' : 'no_upload_request_observed',
      submitted: false, observation: observation.state,
      hint: 'Only formal_urls from a successful upload may be passed to chat-turn. Check the visible success/failure state and never send while any file is pending.',
    };
  },
});
