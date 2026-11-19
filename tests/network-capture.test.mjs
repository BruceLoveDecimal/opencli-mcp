import { afterEach, expect, it, vi } from 'vitest';
import { detach, readNetworkCapture, registerListeners, startNetworkCapture } from '../extension/src/cdp.js';

const event = () => ({ addListener: vi.fn() });

afterEach(() => { vi.unstubAllGlobals(); });

it('retains the completed SSE response body but still skips binary bodies', async () => {
  const onEvent = event();
  const source = { tabId: 704 };
  const body = 'id: 7\nevent: text_delta\ndata: {"text":"example"}\n\n';
  const sendCommand = vi.fn(async (_source, method) => method === 'Network.getResponseBody'
    ? { body, base64Encoded: false }
    : {});
  vi.stubGlobal('chrome', {
    debugger: { onEvent, onDetach: event(), sendCommand, attach: vi.fn(), detach: vi.fn() },
    tabs: { get: vi.fn(async () => ({ url: 'https://example.test/' })), onRemoved: event(), onUpdated: event() },
    downloads: { onCreated: event() },
  });
  registerListeners();
  const onNetworkEvent = onEvent.addListener.mock.calls[1][0];
  await startNetworkCapture(source.tabId);

  for (const [requestId, mimeType] of [['stream', 'text/event-stream'], ['binary', 'application/octet-stream']]) {
    const url = `https://example.test/${requestId}`;
    await onNetworkEvent(source, 'Network.requestWillBeSent', { requestId, type: 'Fetch', request: { url } });
    await onNetworkEvent(source, 'Network.responseReceived', { requestId, response: { url, mimeType, status: 200 } });
    await onNetworkEvent(source, 'Network.loadingFinished', { requestId });
  }
  expect(await readNetworkCapture(source.tabId)).toMatchObject([
    { requestId: 'stream', responseContentType: 'text/event-stream', responsePreview: body, responseBodyFullSize: body.length },
    { requestId: 'binary', responseContentType: 'application/octet-stream' },
  ]);
  expect(sendCommand.mock.calls.filter(([, method]) => method === 'Network.getResponseBody'))
    .toEqual([[source, 'Network.getResponseBody', { requestId: 'stream' }]]);
  await detach(source.tabId);
});
