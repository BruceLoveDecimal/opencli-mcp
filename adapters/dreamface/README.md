# DreamFace adapter

Commands for DreamFace (`https://testm.facemojiapp.com` by default; pass `origin` for another deployment). `site.json` declares the site's front ends (`origins`), its `login` and `map` roles and the `guide` agents working on DreamFace get. They call the
site's own API from the logged-in page (`_shared.js`), so they need a browser profile that is signed in.

- **Login**: `login {email, password}` signs this browser in to that account (replacing another one) through the site's
  own dialog and returns the session's API headers. The site runs a reCAPTCHA before it logs in; the command never
  solves it: with `captcha_wait_sec` it waits for a person to complete the check in the same page, without it fails
  with `captcha_required`. Already signed in to the same account, it returns at once without touching the form.
- **Read**: `whoami`, `credits`, `works`, `work`, `projects`, `conversation`, `avatars`, `voices`, `image-models`,
  `agent-models`, `agent-tools`, `sitemap`.
- **Write** (spend credits or the free daily uses): `agent-chat`, `agent-image`, `agent-video`, `ai-image`, `ai-video`,
  `avatar-video`.

## Conversation scope and UI acceptance

`agent-chat`, `agent-image` and `agent-video` create a new Canvas project and call
`/df-tide-agent/agent/v2/chat` with `scene_type: INFINITE_CANVAS` and `project_id`.
`conversation` reads that project's history. These commands call APIs from the signed-in page;
they do not type in the composer, click Send, navigate to the new project or update the current chat.
Calling them while `/i-want` is open does not exercise that page's conversation flow.

For `/i-want` input, model selection, sending and reply display cases, operate the actual page and
verify its rendered result. Use `network_inspect` to correlate that send with its endpoint version,
`scene_type`, `model`, `conversation_id` and presence or absence of `project_id`.
The current `/i-want` request version and scene must be confirmed from that deployment's traffic;
the backend distinguishes ordinary `CHAT` (default, no `project_id`) from `INFINITE_CANVAS`
(required `project_id`), and isolates their histories. A successful Canvas answer cannot prove an
ordinary chat UI case passed. For example, an API answer of “1+1=2” while the page still shows
“你好” proves the API command returned a result, not that the page sent or displayed that exchange.

## Regression suite

`suite.json` checks the server endpoints these commands call (see `docs/sites.md`). When a command starts calling
another endpoint, add a check for it and list the command in its `adapters`.

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

### Targeted verification 2026-10-15

The login dialog now checks the email before displaying the password. The host login command supports both this two-step form and the earlier combined form; a person still completes any verification challenge. The Agent sidebar opens `/i-want`, and its live model catalogue must be read before choosing a model. A delivered click should be checked against the observed destination, rather than a guessed `/agent` route. Only the five smoke routes and login were rechecked; this does not claim a new full-site DFS.

Agent commands resolve an omitted model from the live catalogue and reject unavailable explicit models before creating a project. A failed or unknown turn retains project/conversation query instructions and must not be resubmitted.
