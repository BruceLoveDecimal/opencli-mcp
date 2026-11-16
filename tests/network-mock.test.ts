import { afterEach, describe, expect, it } from 'vitest';
import { clearNetworkMock, handleFetchPaused, setNavigationGuard, setNetworkMock } from '../extension/src/network-mock.js';

type Call = { method: string; params: Record<string, unknown> };
const calls: Call[] = [];

function installChrome(): void {
  calls.length = 0;
  (globalThis as { chrome?: unknown }).chrome = {
    debugger: {
      sendCommand: async (_source: unknown, method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        if (method === 'Fetch.getResponseBody') return { body: 'event: text_delta\nid: 7\ndata: {"content":"once"}\n\n', base64Encoded: false };
        return {};
      },
    },
  };
}

afterEach(() => { delete (globalThis as { chrome?: unknown }).chrome; });

describe('bounded network mocks', () => {
  it('continues the real response after a delay and preserves navigation guarding', async () => {
    installChrome();
    await setNavigationGuard(1, (url: string) => url.startsWith('https://allowed.example'));
    await setNetworkMock(1, { url: '/api/slow', delayMs: 1 });
    await handleFetchPaused({ tabId: 1 }, { requestId: 'r1', request: { url: 'https://allowed.example/api/slow' }, resourceType: 'XHR' });
    await handleFetchPaused({ tabId: 1 }, { requestId: 'r2', request: { url: 'https://blocked.example' }, resourceType: 'Document' });
    expect(calls.find((call) => call.method === 'Fetch.continueRequest' && call.params.requestId === 'r1')).toBeDefined();
    expect(calls.find((call) => call.method === 'Fetch.failRequest' && call.params.requestId === 'r2')).toMatchObject({ params: { errorReason: 'Aborted' } });
    await clearNetworkMock(1);
    expect(calls.filter((call) => call.method === 'Fetch.enable').at(-1)?.params).toEqual({ patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] });
  });

  it('fails only the matched URL offline', async () => {
    installChrome();
    await setNetworkMock(2, { url: '/agent/v2/chat', offline: true });
    await handleFetchPaused({ tabId: 2 }, { requestId: 'r3', request: { url: 'https://site.example/df-tide-agent/agent/v2/chat' } });
    expect(calls.at(-1)).toMatchObject({ method: 'Fetch.failRequest', params: { requestId: 'r3', errorReason: 'InternetDisconnected' } });
  });

  it('replays SSE frames with their original ids', async () => {
    installChrome();
    await setNetworkMock(3, { url: '/chat', replayEvents: true });
    await handleFetchPaused({ tabId: 3 }, { requestId: 'r4', request: { url: 'https://site.example/chat' }, responseStatusCode: 200 });
    const fulfilled = calls.find((call) => call.method === 'Fetch.fulfillRequest')!;
    const body = Buffer.from(String(fulfilled.params.body), 'base64').toString('utf8');
    expect(body.match(/event: text_delta/g)).toHaveLength(2);
    expect(body.match(/id: 7/g)).toHaveLength(2);
    expect(body.split('\n\n').filter(Boolean)).toEqual([
      'event: text_delta\nid: 7\ndata: {"content":"once"}',
      'event: text_delta\nid: 7\ndata: {"content":"once"}',
    ]);
    expect(body.match(/"once"/g)).toHaveLength(2);
  });
  it('blocks disallowed document navigation even when its URL matches a mock', async () => {
    installChrome();
    await setNavigationGuard(4, (url) => url.startsWith('https://allowed.example/'));
    await setNetworkMock(4, { url: '/api/slow', delayMs: 1 });
    await handleFetchPaused({ tabId: 4 }, { requestId: 'blocked-mock', request: { url: 'https://blocked.example/api/slow' }, resourceType: 'Document' });
    expect(calls.at(-1)).toMatchObject({ method: 'Fetch.failRequest', params: { requestId: 'blocked-mock', errorReason: 'Aborted' } });
  });

  it('continues a guarded document at request stage and replays it at response stage', async () => {
    installChrome();
    await setNavigationGuard(5, (url) => url.startsWith('https://allowed.example/'));
    await setNetworkMock(5, { url: '/chat', replayEvents: true });
    const request = { requestId: 'two-stages', request: { url: 'https://allowed.example/chat' }, resourceType: 'Document' };
    await handleFetchPaused({ tabId: 5 }, request);
    expect(calls.at(-1)).toMatchObject({ method: 'Fetch.continueRequest' });
    await handleFetchPaused({ tabId: 5 }, { ...request, responseStatusCode: 200 });
    expect(calls.at(-1)).toMatchObject({ method: 'Fetch.fulfillRequest' });
  });
});
