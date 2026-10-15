import { expect, it } from 'vitest';
import { agentModel, runAgent } from '../adapters/dreamface/_shared.js';
it('resolves current models and refuses removed choices before any project or generation is submitted', async () => {
  const requests = [];
  const tab = {
    async url() { return 'https://testm.facemojiapp.com/home'; },
    async evaluate() { return { user: JSON.stringify({ token: 'private', userId: 'u', accountId: 'a', thirdId: 'test@example.com' }) }; },
    async fetchJson(url) { requests.push(url); return { status_code: 'THS12140000000', data: [{ name: 'Current', is_active: true }] }; },
  };
  expect(await agentModel(tab, 'https://testm.facemojiapp.com', {}, undefined)).toBe('Current');
  await expect(runAgent(tab, 'https://testm.facemojiapp.com', { message: 'one image', model: 'Removed', timeoutSec: 10 })).rejects.toThrow('unavailable');
  expect(requests.every((url) => url.includes('/model/v1/list'))).toBe(true);
});
