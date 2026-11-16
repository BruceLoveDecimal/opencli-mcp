import { defineAdapter } from 'opencli-mcp/adapter-sdk';
import { ORIGIN_ARG, api, ids, session, siteOrigin } from './_shared.js';

export default defineAdapter({
  description: 'Read driving models and media models in one catalogue. Media groups use model_type (never category); stable name/id is returned separately from translated labels and response order is preserved. （模型目录）',
  access: 'read', domain: 'facemojiapp.com',
  args: [{ name: 'language', type: 'string', choices: ['en', 'zh'], default: 'en' }, { name: 'model_type', type: 'string', choices: ['Video', 'Image', 'Audio'] }, ORIGIN_ARG],
  result: { kind: 'value', description: 'Driving and media model catalogue grouped by model_type' },
  async run({ tab, args }) {
    const origin = siteOrigin(args); const s = await session(tab, origin); const language = args.language || 'en';
    const [driving, toolData] = await Promise.all([
      api(tab, origin, s, '/df-tide-agent/model/v1/list', { method: 'POST', body: { ...ids(s), language } }),
      api(tab, origin, s, '/df-tide-agent/agent/v2/tools/list', { query: { language } }),
    ]);
    const media = (toolData?.tools || []).filter((tool) => tool?.name && tool.model_type).map((tool, index) => ({
      id: tool.name, name: tool.name, label: tool.display_name || tool.name, description: tool.description || '',
      model_type: tool.model_type, category: tool.category || null, category_display_name: tool.category_display_name || null,
      icon: tool.icon || null, response_index: index,
    }));
    const groups = {};
    for (const type of ['Video', 'Image', 'Audio']) groups[type] = media.filter((row) => row.model_type === type);
    return {
      driving: (driving || []).filter((model) => model?.name && model.is_active !== false).map((model, index) => ({ id: model.name, name: model.name, description: model.description || '', response_index: index })),
      groups: args.model_type ? { [args.model_type]: groups[args.model_type] } : groups,
      language, grouping_field: 'model_type', empty: media.length === 0,
    };
  },
});
