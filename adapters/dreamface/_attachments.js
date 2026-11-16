// Attachment normalization is deliberately strict: only completed, absolute HTTP(S) URLs may enter a chat request.
import { errors } from 'opencli-mcp/adapter-sdk';

export function mediaType(item) {
  const raw = String(item?.type || item?.media_type || item?.mime || item?.file_type || '').toLowerCase();
  if (raw.startsWith('image/') || raw === 'image' || /jpe?g|png|webp|gif/.test(raw)) return 'image';
  if (raw.startsWith('video/') || raw === 'video' || /mp4|webm|mov|mkv/.test(raw)) return 'video';
  if (raw.startsWith('audio/') || raw === 'audio' || /mp3|wav|aac|ogg|flac/.test(raw)) return 'audio';
  return null;
}

export function normalizeAttachments(items, { max = 5, requireUrl = true } = {}) {
  if (!Array.isArray(items)) throw errors.argument('attachments/candidates must be an array');
  const rows = items.map((item, index) => {
    const type = mediaType(item);
    const url = item?.url || item?.resource_url || item?.work_url || null;
    const validUrl = typeof url === 'string' && /^https?:\/\//i.test(url);
    return {
      index, type, url: validUrl ? url : null, label: item?.label || item?.name || null,
      ...(item?.source_node_id || item?.sourceNodeId ? { source_node_id: item.source_node_id || item.sourceNodeId } : {}),
      ...(item?.output_id ? { output_id: item.output_id } : {}),
      valid: Boolean(type && (!requireUrl || validUrl)),
      error: !type ? 'unknown_media_type' : requireUrl && !validUrl ? 'missing_formal_url' : null,
    };
  });
  const validRows = rows.filter((row) => row.valid);
  return {
    rows, valid: validRows.length === rows.length && validRows.length <= max,
    count: rows.length, accepted_count: validRows.length, max,
    errors: rows.filter((row) => !row.valid).map((row) => ({ index: row.index, error: row.error })),
    ...(validRows.length > max ? { overflow: validRows.length - max } : {}),
    attachments: Object.fromEntries(['image', 'video', 'audio'].map((type) => [type, validRows.filter((row) => row.type === type).map((row) => ({ url: row.url, label: row.label, ...(row.source_node_id && { source_node_id: row.source_node_id }), ...(row.output_id && { output_id: row.output_id }) }))])),
  };
}

export function responseUrls(value, urls = []) {
  if (Array.isArray(value)) { for (const item of value) responseUrls(item, urls); return urls; }
  if (!value || typeof value !== 'object') return urls;
  for (const [key, item] of Object.entries(value)) {
    if (['url', 'file_url', 'resource_url', 'work_url', 'oss_url'].includes(key) && typeof item === 'string' && /^https?:\/\//.test(item)) urls.push(item);
    else if (item && typeof item === 'object') responseUrls(item, urls);
  }
  return urls;
}
