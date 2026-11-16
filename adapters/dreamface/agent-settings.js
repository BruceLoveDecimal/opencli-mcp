import { defineAdapter, errors } from 'opencli-mcp/adapter-sdk';
import { ORIGIN_ARG, session, siteOrigin } from './_shared.js';
import { normalizeSettings } from './_settings.js';

export default defineAdapter({
  description: 'Normalize Ask/Auto threshold settings (including legacy 0.1→10), inspect setting-only storage candidates, or apply settings through the real Agent Settings controls. No server preference endpoint is invented; chat-turn carries the frozen values. （智能体设置）',
  access: 'write', domain: 'facemojiapp.com',
  args: [
    { name: 'action', type: 'string', choices: ['inspect', 'normalize', 'apply'], default: 'inspect' },
    { name: 'execution_mode', type: 'string', choices: ['ask', 'auto'], default: 'auto' },
    { name: 'credit_confirmation_threshold', type: 'number', default: 10, help: 'Normalized to 0.1–100 with one decimal' },
    { name: 'legacy', type: 'boolean', default: false, help: 'Treat numeric 0.1 as the old default and migrate it to 10; an explicitly saved new 0.1 stays 0.1' },
    { name: 'route', type: 'string', default: '/i-want' }, ORIGIN_ARG,
  ],
  result: { kind: 'value', description: 'Normalized request settings and real UI/storage evidence' },
  async run({ tab, args }) {
    const origin = siteOrigin(args); await session(tab, origin);
    const settings = normalizeSettings(args);
    if (args.action === 'normalize') return { ...settings, legacy_migration: args.legacy && Number(args.credit_confirmation_threshold) === 0.1 ? '0.1_to_10' : 'none', server_preference_saved: false, hint: 'Pass these exact values on each new chat-turn. Existing interactions retain their original frozen configuration.' };
    await tab.goto(new URL(args.route || '/i-want', origin).href, { waitUntil: 'load' });
    const storage = await tab.evaluate(`(() => Object.keys(localStorage).filter((key) => /agent.*(setting|mode|threshold)|credit.*threshold|execution.*mode/i.test(key)).map((key) => {
      const raw = localStorage.getItem(key); let value = raw; try { value = JSON.parse(raw); } catch {}
      return { key, value };
    }))()`);
    const observation = await tab.observe({ viewport: true });
    if (args.action === 'inspect') return { ...settings, storage_candidates: storage, migration_evidence: 'unconfirmed', observation: observation.state, hint: 'Storage key names alone do not prove which PC/H5 setting is active. Use the real panel, reload, and inspect the next new-turn request; do not overwrite account data.' };
    const settingsButton = await tab.find({ query: 'Agent Settings', limit: 10 });
    const entry = (settingsButton?.entries || []).find((item) => item.visible !== false && item.ref);
    if (!entry) throw errors.empty('Agent Settings trigger was not found on this page');
    await tab.act({ action: 'click', target: { ref: entry.ref } });
    await tab.act({ action: 'click', target: { role: 'button', name: settings.execution_mode === 'ask' ? 'Ask' : 'Auto' } });
    const inputs = await tab.find({ selector: 'input[type=number]', limit: 20 });
    const input = (inputs?.entries || []).find((item) => item.visible !== false && item.enabled !== false && item.ref);
    if (!input) throw errors.empty('No enabled threshold input exists in Agent Settings');
    await tab.act({ action: 'fill', target: { ref: input.ref }, value: String(settings.credit_confirmation_threshold) });
    const after = await tab.observe({ viewport: true });
    return { ...settings, storage_candidates: storage, ui_applied: true, persisted: 'requires_reload_and_new_turn_verification', observation: after.state, server_preference_saved: false, hint: 'Settings were delivered to the real controls. Reload and verify the panel plus the next new-turn request; do not change an existing suspended interaction.' };
  },
});
