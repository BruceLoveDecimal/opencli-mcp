// Failure of a follow-up read must not hide an already-delivered click and invite a replay.
import { expect, it, vi } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { Runtime } from '../src/runtime/runtime.js';
import { Tab } from '../src/api/tab.js';
import { createMcpServer } from '../src/mcp/server.js';

it('preserves delivery when the action succeeds but its observation fails', async () => {
  const rt = new Runtime({ log: () => {} });
  await rt.init();
  rt.browserAvailable = () => true;
  rt.backend = () => 'extension';
  const id = 'action-observation';
  rt.session(id).selected = 'test-page';
  const act = vi.spyOn(Tab.prototype, 'act').mockResolvedValue({ delivery: 'received', controlState: 'unverified' });
  vi.spyOn(Tab.prototype, 'observe').mockRejectedValue(new Error('page context replaced'));
  const session = createMcpServer(rt, id, { persistent: true });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await session.server.connect(serverT);
  const client = new Client({ name: 'test', version: '1' }, { capabilities: {} });
  await client.connect(clientT);
  try {
    const result = await client.callTool({ name: 'tab_act', arguments: { tab: 'test-page', action: 'click', target: { ref: 'e3' }, observe: true } });
    const text = (result.content as Array<{ type: string; text?: string }>).find((c) => c.type === 'text')?.text ?? '{}';
    expect(JSON.parse(text), text).toMatchObject({ ok: true, delivery: 'received', observationError: { message: 'page context replaced' } });
    expect(act).toHaveBeenCalledTimes(1);
  } finally {
    vi.restoreAllMocks();
    await client.close();
    await rt.shutdown();
  }
});
