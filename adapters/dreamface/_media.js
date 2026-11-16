// Download and decode real media in the page. HTTP success alone is never sufficient evidence.
// Interrupted downloads retain their chunks in this tab and resume with Range instead of starting from zero.
export async function probeMediaContent(tab, url, kind, timeoutMs = 15000, maxBytes = 50 * 1024 * 1024) {
  return tab.evaluate(`(async () => {
    const timeout = ${Math.max(1, Math.floor(timeoutMs))}; const maxBytes = ${Math.max(1, Math.floor(maxBytes))};
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeout);
    const url = ${JSON.stringify(url)}; const kind = ${JSON.stringify(kind)};
    const cache = window.__opencliMediaDownloads ||= new Map();
    const state = cache.get(url) || { chunks: [] };
    if (!cache.has(url)) { cache.set(url, state); if (cache.size > 4) cache.delete(cache.keys().next().value); }
    let objectUrl = null; let context = null;
    const downloaded = () => state.chunks.reduce((size, chunk) => size + chunk.byteLength, 0);
    try {
      const offset = downloaded();
      const response = await fetch(url, {
        credentials: 'omit', signal: controller.signal,
        headers: offset ? { Range: 'bytes=' + offset + '-' } : {},
      });
      const mime = response.headers.get('content-type')?.split(';')[0]?.toLowerCase() || null;
      if (response.status === 416 && offset) {
        // The previous attempt already received the complete representation.
      } else {
        if (!response.ok) return { readable: false, reason: 'http_error', status: response.status, mime, downloaded_bytes: offset };
        if (response.status === 200 && offset) state.chunks = [];
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          state.chunks.push(value);
          if (downloaded() > maxBytes) { cache.delete(url); await reader.cancel(); return { readable: false, reason: 'too_large', status: response.status, mime, max_bytes: maxBytes }; }
        }
      }
      const bytes = downloaded();
      if (!bytes) { cache.delete(url); return { readable: false, reason: 'empty_file', status: response.status, mime, bytes }; }
      const buffer = new Uint8Array(bytes); let position = 0;
      for (const chunk of state.chunks) { buffer.set(chunk, position); position += chunk.byteLength; }
      cache.delete(url);
      const digest = await crypto.subtle.digest('SHA-256', buffer);
      const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
      const blob = new Blob([buffer], { type: mime || 'application/octet-stream' });
      const base = { status: response.status === 416 ? 206 : response.status, mime, bytes, sha256, resumed_from: offset || undefined };
      if (kind === 'image') {
        try {
          const bitmap = await createImageBitmap(blob); const result = { ...base, readable: bitmap.width > 0 && bitmap.height > 0, verification: 'image_decoded', width: bitmap.width, height: bitmap.height }; bitmap.close(); return result;
        } catch { return { ...base, readable: false, reason: 'image_decode_failed' }; }
      }
      if (kind === 'audio') {
        try {
          context = new (window.AudioContext || window.webkitAudioContext)();
          const audio = await context.decodeAudioData(buffer.buffer);
          return { ...base, readable: audio.duration > 0 && audio.numberOfChannels > 0, verification: 'audio_decoded', duration: audio.duration, channels: audio.numberOfChannels, sample_rate: audio.sampleRate };
        } catch { return { ...base, readable: false, reason: 'audio_decode_failed' }; }
      }
      objectUrl = URL.createObjectURL(blob);
      return await new Promise((resolve) => {
        const started = Date.now(); const video = document.createElement('video'); let settled = false;
        const done = (result) => { if (settled) return; settled = true; clearTimeout(mediaTimer); video.removeAttribute('src'); video.load(); resolve({ ...base, ...result }); };
        const mediaTimer = setTimeout(() => done({ readable: false, reason: 'video_load_timeout' }), Math.max(1, timeout - (Date.now() - started)));
        video.preload = 'auto'; video.muted = true;
        video.onerror = () => done({ readable: false, reason: 'video_decode_failed' });
        video.onloadedmetadata = () => { if (!(video.videoWidth > 0 && video.videoHeight > 0 && Number.isFinite(video.duration) && video.duration > 0)) done({ readable: false, reason: 'invalid_video_metadata' }); };
        video.oncanplay = () => done({ readable: video.videoWidth > 0 && video.videoHeight > 0 && video.duration > 0, verification: 'video_can_play', width: video.videoWidth, height: video.videoHeight, duration: video.duration });
        video.src = objectUrl;
      });
    } catch (error) {
      return { readable: false, reason: error?.name === 'AbortError' ? 'media_timeout' : 'download_failed', error: String(error?.message || error).slice(0, 300), downloaded_bytes: downloaded() };
    } finally { clearTimeout(timer); if (objectUrl) URL.revokeObjectURL(objectUrl); if (context) await context.close().catch(() => {}); }
  })()`, { allowWrite: true });
}
