# DreamFace adapter

Commands for DreamFace (`https://testm.facemojiapp.com` by default; pass `origin` for another deployment). They call the
site's own API from the logged-in page (`_shared.js`), so they need a browser profile that is signed in.

- **Read**: `whoami`, `credits`, `works`, `work`, `projects`, `conversation`, `avatars`, `voices`, `image-models`,
  `agent-models`, `agent-tools`, `sitemap`.
- **Write** (spend credits or the free daily uses): `agent-chat`, `agent-image`, `agent-video`, `ai-image`, `ai-video`,
  `avatar-video`.

## Site map

`sitemap` returns the web map for agents that drive the pages instead of (or besides) calling commands. It never
touches the page. Without `route` it returns the overview; with `route` (e.g. `/avatar`, `/apps`) the controls,
submit buttons and traps of that subtree.

```
[studio] logged-in creation app (sidebar shell)          [seo] Nuxt marketing site (/ and /zh)
/home ─┬─ /home?type=price (pricing overlay)             / ─┬─ /ai-tools
       ├─ /canvas ── /canvas?projectId=<id>                 ├─ /tools/<slug>            (marketing only)
       ├─ /i-want            (sidebar "Agent")              ├─ /ai-video/<slug> …       (embedded tool, ⚠ samples)
       ├─ /avatar ── /avatar-bulk                           ├─ /models/<slug>           (embedded tool)
       ├─ /video                                            ├─ /gallery ── /image-templates/<slug>
       ├─ /image                                            └─ /blogpage ── /blog/<slug> (no /zh)
       ├─ /all-tools ── /apps/<slug> × 15  (⚠ photo-enhance, background-remover,
       │                                    image-detector, translate run without Create)
       └─ /creation          (sidebar "Creations"; /creations is a 404)
```

The data lives in `_sitemap.js` (`LAYERS`, `ROUTES`, `TRAPS`, `COMMANDS`); the tree above is `tree()` drawn by hand
for readers of this file. `sitemap` renders the real one from `ROUTES`.

## Updating the map (depth-first walk)

Walk the site with the typed browser tools, one branch per session (studio home + canvas + agent; avatar + video;
image + all tools + creations; the SEO site), and write down what you see:

1. Open each route directly (`tab_goto`), wait for a known text (`tab_expect`), then `tab_observe` and `tab_read`.
2. Expand every entry on the page one level at a time — tabs, dropdowns, dialogs, cards, sidebar items — and record
   whether the URL changed, what appeared, and how you got back (Close, Escape, reload).
3. Stop at leaves: a submit button (record its label, when it enables and the cost shown in it) or a link that leaves
   the origin (record the href).
4. Quote visible text exactly; never record refs.
5. Do not submit anything, pay, log out, delete or change account settings. **Do not click sample images, template
   thumbnails under a tool form or onboarding "Next" buttons** — on this site they start jobs without a Create button
   (see the `one-click-samples` and `tour-submits` traps). Check `credits` and `works` before and after a walk; if
   either changed, find the click that did it and add it to `TRAPS`.
6. Update `ROUTES` / `TRAPS` / `COMMANDS` and `VERIFIED`, and redraw the tree above if routes were added or moved.
