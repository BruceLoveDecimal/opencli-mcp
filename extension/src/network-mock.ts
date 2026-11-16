/// <reference types="chrome" />
// Bounded Fetch-domain fault injection shared by the extension and CDP backends.
// Navigation guarding and test mocks share one Fetch session so arming a mock cannot disable origin enforcement.
import type { NetworkMockSpec } from '../../src/protocol.js';

const mocks = new Map<number, NetworkMockSpec>();
const navigationGuards = new Map<number, (url: string) => boolean>();
const handled = new Set<string>();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function arm(tabId: number): Promise<void> {
  const patterns: Array<Record<string, unknown>> = [];
  if (navigationGuards.has(tabId)) patterns.push({ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' });
  const mock = mocks.get(tabId);
  if (mock) patterns.push({ urlPattern: `*${mock.url}*`, requestStage: mock.replayEvents ? 'Response' : 'Request' });
  if (patterns.length) await chrome.debugger.sendCommand({ tabId }, 'Fetch.enable', { patterns });
  else await chrome.debugger.sendCommand({ tabId }, 'Fetch.disable').catch(() => {});
}

export async function setNavigationGuard(tabId: number, guard: (url: string) => boolean): Promise<void> {
  navigationGuards.set(tabId, guard);
  await arm(tabId);
}

export async function setNetworkMock(tabId: number, spec: NetworkMockSpec): Promise<{ active: true; url: string }> {
  if (!spec.url.trim()) throw Object.assign(new Error('network mock url must not be empty'), { code: 'invalid_args' });
  mocks.set(tabId, spec);
  await arm(tabId);
  return { active: true, url: spec.url };
}

export async function clearNetworkMock(tabId: number): Promise<{ active: false }> {
  mocks.delete(tabId);
  await arm(tabId);
  return { active: false };
}

export function forgetNetworkMock(tabId: number): void {
  mocks.delete(tabId);
  for (const key of handled) if (key.startsWith(`${tabId}:`)) handled.delete(key);
}

export function forgetNetworkGuard(tabId: number): void {
  forgetNetworkMock(tabId);
  navigationGuards.delete(tabId);
}

export async function restoreNetworkInterception(tabId: number): Promise<void> {
  if (mocks.has(tabId) || navigationGuards.has(tabId)) await arm(tabId).catch(() => {});
}

function replaySse(body: string): string {
  // Keep each frame's delimiter; concatenating payloads corrupts the following data field.
  return body.replace(/([\s\S]*?)(\r?\n\r?\n)/g, (_match, frame: string, separator: string) => `${frame}${separator}${frame}${separator}`);
}

function decodeBody(body: string, base64Encoded: boolean): string {
  if (!base64Encoded) return body;
  const binary = atob(body);
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

function encodeBody(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

export async function handleFetchPaused(source: chrome.debugger.Debuggee, params: Record<string, unknown>): Promise<void> {
  const tabId = source.tabId;
  if (!tabId) return;
  const p = params as { requestId: string; request: { url: string }; resourceType?: string; responseStatusCode?: number };
  const key = `${tabId}:${(source as { sessionId?: string }).sessionId ?? ''}:${p.requestId}:${p.responseStatusCode === undefined ? 'request' : 'response'}`;
  if (handled.has(key)) return;
  handled.add(key);
  if (handled.size > 2000) handled.delete(handled.values().next().value!);
  const mock = mocks.get(tabId);
  try {
    const guard = navigationGuards.get(tabId);
    if (guard && p.resourceType === 'Document' && !guard(p.request.url)) {
      await chrome.debugger.sendCommand(source, 'Fetch.failRequest', { requestId: p.requestId, errorReason: 'Aborted' });
      return;
    }
    if (mock && p.request.url.includes(mock.url)) {
      if (mock.delayMs) await sleep(mock.delayMs);
      if (mock.offline || mock.dropResponse) {
        await chrome.debugger.sendCommand(source, 'Fetch.failRequest', { requestId: p.requestId, errorReason: mock.offline ? 'InternetDisconnected' : 'ConnectionClosed' });
      } else if (mock.replayEvents) {
        if (p.responseStatusCode === undefined) {
          await chrome.debugger.sendCommand(source, 'Fetch.continueRequest', { requestId: p.requestId });
          return;
        }
        const result = await chrome.debugger.sendCommand(source, 'Fetch.getResponseBody', { requestId: p.requestId }) as { body: string; base64Encoded: boolean };
        const body = decodeBody(result.body, result.base64Encoded);
        await chrome.debugger.sendCommand(source, 'Fetch.fulfillRequest', {
          requestId: p.requestId, responseCode: p.responseStatusCode ?? 200,
          responseHeaders: [{ name: 'Content-Type', value: 'text/event-stream' }],
          body: encodeBody(replaySse(body)),
        });
      } else if (mock.status !== undefined || mock.emptyObject) {
        await chrome.debugger.sendCommand(source, 'Fetch.fulfillRequest', {
          requestId: p.requestId, responseCode: mock.status ?? 200,
          responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
          body: encodeBody(mock.emptyObject ? '{}' : ''),
        });
      } else {
        await chrome.debugger.sendCommand(source, 'Fetch.continueRequest', { requestId: p.requestId });
      }
      return;
    }
    if (guard && p.resourceType === 'Document') {
      if (guard(p.request.url)) await chrome.debugger.sendCommand(source, 'Fetch.continueRequest', { requestId: p.requestId });
      else await chrome.debugger.sendCommand(source, 'Fetch.failRequest', { requestId: p.requestId, errorReason: 'Aborted' });
      return;
    }
    await chrome.debugger.sendCommand(source, 'Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
  } catch {
    // A navigation or mock cleanup can invalidate a paused request before its reply.
  }
}
