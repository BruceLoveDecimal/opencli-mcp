import { describe, expect, it } from 'vitest';
import { probeMediaContent } from '../adapters/dreamface/_media.js';
import mediaInspect from '../adapters/dreamface/media-inspect.js';

// Minimal media fixtures: a real one-pixel GIF and corrupt/non-empty payloads.
const GIF = 'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

function page() {
  let current = null;
  return {
    evaluate: async (code) => {
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      const fn = new AsyncFunction(`return ${code}`);
      return fn();
    },
    async fetch(url) {
      current = url;
      if (url.includes('empty')) return new Response(new Uint8Array(), { status: 200, headers: { 'content-type': 'image/gif' } });
      if (url.includes('missing')) return new Response('no', { status: 404 });
      if (url.includes('bad')) return new Response('not an image', { status: 200, headers: { 'content-type': 'image/gif' } });
      return new Response(Buffer.from(GIF, 'base64'), { status: 200, headers: { 'content-type': 'image/gif' } });
    },
    async createImageBitmap(blob) {
      if (blob.type !== 'image/gif' || blob.size !== 34) throw new Error('decode');
      return { width: 1, height: 1, close() {} };
    },
  };
}

// The browser implementation is exercised in cdp-backend; this test checks result semantics with the same fetch/blob APIs.
describe('media content probing', () => {
  it('distinguishes decoded, empty, corrupt and HTTP error content', async () => {
    const p = page();
    const tab = { evaluate: async (code) => p.evaluate(code) };
    const originalFetch = globalThis.fetch;
    const originalBitmap = globalThis.createImageBitmap;
    const originalWindow = globalThis.window;
    globalThis.fetch = p.fetch;
    globalThis.createImageBitmap = p.createImageBitmap;
    globalThis.window = globalThis;
    try {
      expect(await probeMediaContent(tab, 'https://cdn.example/good', 'image')).toMatchObject({ readable: true, verification: 'image_decoded', width: 1, bytes: 34 });
      expect(await probeMediaContent(tab, 'https://cdn.example/empty', 'image')).toMatchObject({ readable: false, reason: 'empty_file' });
      expect(await probeMediaContent(tab, 'https://cdn.example/bad', 'image')).toMatchObject({ readable: false, reason: 'image_decode_failed' });
      expect(await probeMediaContent(tab, 'https://cdn.example/missing', 'image')).toMatchObject({ readable: false, reason: 'http_error', status: 404 });
    } finally { globalThis.fetch = originalFetch; globalThis.createImageBitmap = originalBitmap; globalThis.window = originalWindow; }
  });

  it('resumes an interrupted download with a Range request instead of restarting from zero', async () => {
    const p = page(); const bytes = Buffer.from(GIF, 'base64'); const ranges = [];
    const originalFetch = globalThis.fetch; const originalBitmap = globalThis.createImageBitmap; const originalWindow = globalThis.window;
    globalThis.window = globalThis; globalThis.createImageBitmap = p.createImageBitmap;
    globalThis.fetch = async (url, options = {}) => {
      ranges.push(options.headers?.Range || null);
      if (ranges.length === 1) return new Response(new ReadableStream({
        start(controller) { controller.enqueue(bytes.subarray(0, 10)); setTimeout(() => controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })), 0); },
      }), { status: 200, headers: { 'content-type': 'image/gif' } });
      return new Response(bytes.subarray(10), { status: 206, headers: { 'content-type': 'image/gif' } });
    };
    const tab = { evaluate: async (code) => p.evaluate(code) };
    try {
      const first = await probeMediaContent(tab, 'https://cdn.example/resume', 'image');
      expect(first).toMatchObject({ readable: false, reason: 'media_timeout', downloaded_bytes: 10 });
      expect(await probeMediaContent(tab, 'https://cdn.example/resume', 'image')).toMatchObject({ readable: true, verification: 'image_decoded', bytes: 34, resumed_from: 10 });
      expect(ranges).toEqual([null, 'bytes=10-']);
    } finally { globalThis.fetch = originalFetch; globalThis.createImageBitmap = originalBitmap; globalThis.window = originalWindow; }
  });

  it('checks independent media items in one batch command', async () => {
    const p = page(); const originalFetch = globalThis.fetch; const originalBitmap = globalThis.createImageBitmap; const originalWindow = globalThis.window;
    globalThis.window = globalThis; globalThis.fetch = p.fetch; globalThis.createImageBitmap = p.createImageBitmap;
    const tab = { evaluate: async (code) => p.evaluate(code) };
    try {
      const result = await mediaInspect.run({ tab, args: { items: [{ kind: 'image', url: 'https://cdn.example/one' }, { kind: 'image', url: 'https://cdn.example/two' }] } });
      expect(result.rows).toHaveLength(2);
      expect(result.rows.every((row) => row.readable && row.verification === 'image_decoded')).toBe(true);
    } finally { globalThis.fetch = originalFetch; globalThis.createImageBitmap = originalBitmap; globalThis.window = originalWindow; }
  });
});
