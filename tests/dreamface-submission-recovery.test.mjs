// Submission recovery must retain identity without waiting for an entire Agent turn or replaying it.
import { afterEach, expect, it, vi } from 'vitest';
import { runAgent, waitForWork, request } from '../adapters/dreamface/_shared.js';
import { waitForGeneration } from '../adapters/dreamface/_generation.js';

const origin = 'https://testm.facemojiapp.com';
afterEach(() => vi.useRealTimers());
function agentFixture(history = []) {
  const calls = [];
  const tab = {
    async url() { return origin + '/home'; },
    async evaluate(code, options) {
      calls.push({ code, options });
      if (code.includes('localStorage.getItem')) return { user: JSON.stringify({ token: 'secret', userId: 'u', accountId: 'a' }) };
      if (options?.allowWrite) return true;
      return { done: false, events: [], error: null };
    },
    async fetchJson(url, options) {
      calls.push({ url, options });
      const data = url.includes('/model/') ? [{ name: 'Current', is_active: true }]
        : url.includes('/create') ? { id: 'p', conversation_id: 'c' } : { data: history };
      return { status_code: 'THS12140000000', data };
    },
  };
  return { tab, calls };
}

it('returns a recoverable pending handle within thirty seconds when the Agent stream never ends', async () => {
  vi.useFakeTimers();
  const { tab, calls } = agentFixture();
  let result;
  const pending = runAgent(tab, origin, { message: 'new request', kind: 'video', count: 1, timeoutSec: 1200 }).then((v) => { result = v; });
  await vi.advanceTimersByTimeAsync(30000);
  expect(result).toMatchObject({ status: 'pending', handle: { kind: 'video', project_id: 'p', conversation_id: 'c', count: 1 } });
  expect(calls.filter((c) => c.options?.allowWrite)).toHaveLength(1);
  expect(calls.filter((c) => c.url?.includes('/project/v1/create'))).toHaveLength(1);
  await pending;
});

it('delivers media from the exact submitted turn without requiring stream completion or accepting older attachments', async () => {
  vi.useFakeTimers();
  const history = [
    { id: 'old-user', role: 'user', content: 'previous request' },
    { id: 'old-answer', role: 'assistant', attachments: { video: [{ url: 'https://media.example/old.mp4' }] } },
    { id: 'user', role: 'user', content: 'new request' },
    { id: 'answer', role: 'assistant', attachments: { video: [{ url: 'https://media.example/new.mp4', output_id: 'new' }] } },
  ];
  const { tab, calls } = agentFixture(history);
  const pending = runAgent(tab, origin, { message: 'new request', kind: 'video', count: 1, timeoutSec: 1200 });
  await vi.advanceTimersByTimeAsync(2000);
  const result = await pending;
  expect(result.credits_used).toBeNull();
  expect(result).toMatchObject({ status: 'generated', terminal: 'unconfirmed', handle: { message_id: 'answer' }, videos: [{ output_id: 'new' }] });
  expect(JSON.stringify(result)).not.toContain('old.mp4');
  expect(calls.filter((c) => c.options?.allowWrite)).toHaveLength(1);
});

it('keeps the submitted animate id when an ordinary work read fails', async () => {
  const tab = { async fetchJson() { throw new Error('signal is aborted without reason'); } };
  try { await waitForWork(tab, origin, {}, 'original-task', 10); throw new Error('expected failure'); }
  catch (error) { expect(error.hint).toContain('original-task'); expect(error.hint).toMatch(/not resubmit/i); }
});

it('returns an explicit read failure with the original handle instead of losing a submitted video task', async () => {
  const { tab } = agentFixture();
  tab.fetchJson = async () => { throw new Error('signal is aborted without reason'); };
  const result = await waitForGeneration(tab, origin, { kind: 'video', animate_id: 'original-task' }, 10);
  expect(result).toMatchObject({ status: 'pending', handle: { animate_id: 'original-task' }, media: [], read_error: { message: 'signal is aborted without reason' } });
});


it('never retries an ambiguous generation POST after a gateway error', async () => {
  let writes = 0;
  const tab = { async fetchJson() { writes++; throw new Error('HTTP 503'); } };
  await expect(request(tab, {}, origin + '/submit', { method: 'POST', body: { prompt: 'once' } })).rejects.toThrow('503');
  expect(writes).toBe(1);
});

it('retains the original project when the page disappears after submission', async () => {
  const { tab } = agentFixture();
  const original = tab.evaluate;
  tab.evaluate = async (code, options) => code.includes('localStorage') || options?.allowWrite ? original(code, options) : undefined;
  const result = await runAgent(tab, origin, { message: 'new request', kind: 'video', count: 1, timeoutSec: 1200 });
  expect(result).toMatchObject({ status: 'command_outcome_unknown', handle: { project_id: 'p', conversation_id: 'c' } });
  expect(result.hint).toMatch(/not resubmit/i);
});
