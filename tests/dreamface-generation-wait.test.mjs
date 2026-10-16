// Read-only waits must identify this submission and never replay a generation.
import { afterEach, expect, it, vi } from 'vitest';
import { waitForGeneration } from '../adapters/dreamface/_generation.js';

afterEach(() => vi.useRealTimers());
const origin = 'https://testm.facemojiapp.com';
const task = { kind: 'image', project_id: 'p', conversation_id: 'c', message_id: 'new' };
function fixture(history) {
  const requests = [];
  const tab = {
    async url() { return origin + '/canvas?projectId=p'; },
    async evaluate(code) {
      if (code.includes('localStorage.getItem')) return { user: JSON.stringify({ token: 'private', userId: 'u', accountId: 'a' }) };
      return { readable: true, verification: 'image_decoded', width: 512, height: 512 };
    },
    async fetchJson(url, options) {
      requests.push({ url, ...options });
      return { status_code: 'THS12140000000', data: { data: history() } };
    },
  };
  return { tab, requests };
}
const answer = (id, url = 'https://media.example/image.jpg') => ({ id, role: 'assistant', attachments: { image: [{ output_id: id, url }] } });

it('waits for the exact new assistant message instead of accepting an older artifact', async () => {
  vi.useFakeTimers();
  let reads = 0;
  const { tab, requests } = fixture(() => ++reads < 2 ? [answer('old')] : [answer('old'), answer('new')]);
  const pending = waitForGeneration(tab, origin, task, 10);
  await vi.advanceTimersByTimeAsync(2000);
  const result = await pending;
  expect(result).toMatchObject({ status: 'artifact_available', handle: task, terminal: 'unconfirmed', media: [{ output_id: 'new', readable: true }] });
  expect(reads).toBe(2);
  expect(requests.every((r) => r.method === 'GET' && r.url.includes('/history/c') && r.url.includes('project_id=p'))).toBe(true);
});

it('keeps the original handle pending at the shared deadline without any write', async () => {
  vi.useFakeTimers();
  const { tab, requests } = fixture(() => [answer('old')]);
  const pending = waitForGeneration(tab, origin, task, 3);
  await vi.advanceTimersByTimeAsync(3000);
  expect(await pending).toMatchObject({ status: 'pending', handle: task, media: [] });
  expect(requests).toHaveLength(2);
  expect(requests.every((r) => r.timeoutMs <= 3000 && r.method === 'GET')).toBe(true);
});

it('does not accept an inaccessible URL or a text-only success as a usable artifact', async () => {
  vi.useFakeTimers();
  const { tab } = fixture(() => [answer('new')]);
  const original = tab.evaluate;
  tab.evaluate = async (code) => code.includes('localStorage.getItem') ? original(code) : { readable: false, reason: 'load_failed' };
  const pending = waitForGeneration(tab, origin, task, 1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await pending).toMatchObject({ status: 'pending', media: [] });
});

it('rejects ambiguous handles before reading the account or starting any network operation', async () => {
  const { tab, requests } = fixture(() => []);
  await expect(waitForGeneration(tab, origin, { ...task, animate_id: 'a' }, 10)).rejects.toThrow('exactly one');
  await expect(waitForGeneration(tab, origin, { kind: 'image', project_id: 'p' }, 10)).rejects.toThrow('message_id');
  expect(requests).toEqual([]);
});

it('matches the ordinary editor task by animate id and rejects failed terminal states', async () => {
  const { tab, requests } = fixture(() => []);
  tab.fetchJson = async (url, options) => {
    requests.push({ url, ...options });
    return { status_code: 'THS12140000000', data: { list: [
      { id: 'old', animate_id: 'old', web_work_status: 200 },
      { id: 'work', animate_id: 'a', web_work_status: -1 },
    ] } };
  };
  expect(await waitForGeneration(tab, origin, { kind: 'video', animate_id: 'a' }, 10)).toMatchObject({ status: 'failed', terminal: 'failed', work_id: 'work' });
  expect(requests).toHaveLength(1);
  expect(requests[0].url).toContain('get_recent_creation_list');
});

it('finds the exact completed work beyond page one and probes only its media', async () => {
  const { tab, requests } = fixture(() => []);
  tab.fetchJson = async (url, options) => {
    requests.push({ url, ...options });
    const data = url.includes('get_work_detail_web') ? { id: 'new-work', work_url: 'https://media.example/new.jpg' }
      : options.body.page === 1 ? { list: Array.from({ length: 20 }, (_, n) => ({ id: `old${n}`, animate_id: `old${n}`, web_work_status: 200 })) }
      : { list: [{ id: 'new-work', animate_id: 'a', web_work_status: 200 }] };
    return { status_code: 'THS12140000000', data };
  };
  expect(await waitForGeneration(tab, origin, { kind: 'image', animate_id: 'a' }, 10)).toMatchObject({ status: 'artifact_available', terminal: 'done', work_id: 'new-work' });
  expect(requests).toHaveLength(3);
  expect(requests[2].url).toContain('work_id=new-work');
});

it('rejects a mismatched work detail instead of accepting another artifact', async () => {
  const { tab } = fixture(() => []);
  tab.fetchJson = async (url) => ({ status_code: 'THS12140000000', data: url.includes('get_work_detail_web')
    ? { id: 'other', work_url: 'https://media.example/old.jpg' }
    : { list: [{ id: 'expected', animate_id: 'a', web_work_status: 200 }] } });
  await expect(waitForGeneration(tab, origin, { kind: 'image', animate_id: 'a' }, 10)).rejects.toThrow('identity');
});

it('keeps gateway retries and backoff inside the same deadline', async () => {
  vi.useFakeTimers();
  const { tab, requests } = fixture(() => []);
  tab.fetchJson = async (url, options) => { requests.push({ url, ...options }); throw new Error('HTTP 503'); };
  const pending = waitForGeneration(tab, origin, task, 3);
  await vi.advanceTimersByTimeAsync(3000);
  expect(await pending).toMatchObject({ status: 'pending', handle: task });
  expect(requests.map((r) => r.timeoutMs)).toEqual([3000, 2000]);
});

it('does not count the same media URL twice toward the required output count', async () => {
  vi.useFakeTimers();
  const { tab } = fixture(() => [{ id: 'new', role: 'assistant', attachments: { image: [{ url: 'https://media.example/one.jpg' }, { url: 'https://media.example/one.jpg' }] } }]);
  const pending = waitForGeneration(tab, origin, { ...task, count: 2 }, 1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await pending).toMatchObject({ status: 'pending' });
});

it('does not navigate an unrelated page in order to read generation state', async () => {
  const { tab, requests } = fixture(() => []);
  tab.url = async () => 'https://unrelated.example/';
  await expect(waitForGeneration(tab, origin, task, 1)).rejects.toThrow('submitting page');
  expect(requests).toEqual([]);
});
