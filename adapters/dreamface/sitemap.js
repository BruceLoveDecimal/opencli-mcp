import { defineAdapter, errors } from 'opencli-mcp/adapter-sdk';
import { ORIGIN_ARG, siteOrigin } from './_shared.js';
import { COMMANDS, LAYERS, ROUTES, TRAPS, VERIFIED, tree } from './_sitemap.js';

const SECTIONS = ['overview', 'all', 'tree', 'routes', 'traps', 'commands'];

export default defineAdapter({
  description: 'DreamFace web map for driving the pages: every route with its controls, submit buttons and credit cost, the traps met while clicking through (overlays, stale refs, unnamed controls) and which command covers which page. Read it before operating DreamFace pages; it does not touch the page. （站点地图 页面结构 路由 坑 交互验收）',
  access: 'read',
  domain: 'facemojiapp.com',
  args: [
    { name: 'route', type: 'string', help: 'Only this route and its children, e.g. /avatar or /creation; omit for all' },
    { name: 'section', type: 'string', choices: SECTIONS, help: 'overview (default without route): tree + traps + commands; all (default with route): also every page\'s controls; tree / routes / traps / commands: just that part' },
    ORIGIN_ARG,
  ],
  result: { kind: 'value', description: 'Site map', fields: { verified: 'string', tree: 'string', routes: 'array', traps: 'array', commands: 'array' } },
  async run({ args }) {
    const origin = siteOrigin(args);
    const section = args.section || (args.route ? 'all' : 'overview');
    const want = (part) => section === part || section === 'all' || (section === 'overview' && part !== 'routes');
    const prefix = args.route ? `/${String(args.route).trim().replace(/^\/+|\/+$/g, '')}` : null;
    const routes = prefix ? ROUTES.filter((r) => r.path === prefix || r.path.startsWith(`${prefix}/`) || r.path.startsWith(`${prefix}?`)) : ROUTES;
    if (prefix && !routes.length) throw errors.argument(`no route ${prefix} in the DreamFace map`, `Known routes: ${ROUTES.map((r) => r.path).join(', ')}`);
    const paths = new Set(routes.map((r) => r.path));
    const traps = prefix ? TRAPS.filter((t) => !t.routes || t.routes.some((p) => paths.has(p))) : TRAPS;
    const commands = prefix ? COMMANDS.filter((c) => c.routes.some((p) => paths.has(p))) : COMMANDS;
    const out = { verified: VERIFIED, origin, note: 'Paths are relative to origin. Locate controls by their visible text or role+name listed here; refs (eN) expire. Pass route (e.g. /avatar) for that page\'s controls and submit buttons.' };
    if (want('tree')) Object.assign(out, { layers: LAYERS, tree: tree(routes) });
    if (want('routes')) out.routes = routes;
    if (want('traps')) out.traps = traps;
    if (want('commands')) out.commands = commands;
    return out;
  },
});
