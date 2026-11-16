# DreamFace adapter

Commands for DreamFace (`https://testm.facemojiapp.com` by default; pass `origin` for another deployment). `site.json` declares the site's front ends (`origins`), its `login` and `map` roles and the `guide` agents working on DreamFace get. They call the
site's own API from the logged-in page (`_shared.js`), so they need a browser profile that is signed in.

- **Login**: `login {email, password}` signs this browser in to that account (replacing another one) through the site's
  own dialog and returns the session's API headers. The site runs a reCAPTCHA before it logs in; the command never
  solves it: with `captcha_wait_sec` it waits for a person to complete the check in the same page, without it fails
  with `captcha_required`. Already signed in to the same account, it returns at once without touching the form.
- **Read**: `whoami`, `credits`, `works`, `work`, `projects`, `conversation`, `generation-wait`, `avatars`, `voices`, `image-models`,
  `agent-models`, `agent-tools`, `sitemap`, `chat-history`, `skill-list`, `model-catalog`, `interaction-state`,
  `attachment-inspect`, `canvas-nodes`, `media-probe`, `media-inspect`.
- **Write** (spend credits or the free daily uses): `agent-chat`, `agent-image`, `agent-video`, `ai-image`, `ai-video`,
  `avatar-video`, `chat-turn`, `interaction-action`. Other writes: `chat-stop`, `attachment-upload` (selects files but never sends),
  `agent-settings`, `canvas-project`, `canvas-save`.

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

## Agent acceptance commands

- `chat-turn` sends ordinary `CHAT` without `project_id`, supports same-session follow-ups, selected Skill IDs, formal
  attachments and frozen Ask/Auto settings. It retains bounded SSE frames with nested tokens/credentials redacted and
  the exact session/turn/conversation handles. `chat-history` reads only ordinary history; `chat-stop` returns a cancellation receipt, not a terminal state.
- `skill-list` keeps stable `skill_id` values across languages and exposes local filtering/pagination. `model-catalog`
  separates driving models from Video/Image/Audio media groups using `model_type`, never `category`.
- `attachment-upload` operates a real file input and never sends. Only formal URLs from successful responses can be
  reused. `attachment-inspect` validates type, order, count, missing URLs and Canvas `source_node_id` references.
- `interaction-action` resumes fee/question cards with `interaction_action`, or voice selection with its original
  envelope. Form submit/skip requires an explicit reusable `submission_id` and current `form_version`; `interaction-state`
  is the read-only recovery path. Acceptance, turn completion and billing remain distinct.
- `canvas-project`, `canvas-nodes` and `canvas-save` cover empty project creation, persisted snapshots, node/output
  provenance and idempotent incremental saves. A save is marked persisted only after a fresh snapshot confirms its
  request, operation IDs and revision.
- `agent-settings` normalizes thresholds to 0.1–100 with one decimal and migrates legacy 0.1 to 10 only when `legacy:true`.
  Its apply action uses real controls; reload and the next new-turn request must still confirm persistence.
- `media-probe` downloads bytes and checks MIME, non-empty content and SHA-256 before image/audio decoding or video
  can-play validation. `media-inspect` performs up to 8 independent checks in one call. Interrupted downloads retain
  received chunks in the tab and resume with HTTP Range. Video can-play is not full playback, and none of these
  commands proves rendered UI behavior.

The engine also exposes typed `network_mock`, `browser_viewport` and `browser_ime` tools. Network mocks are scoped to
one URL substring and support delay, offline/dropped responses, HTTP status, empty JSON and duplicate SSE frames.
Always clear them after the scenario. Viewport changes require fresh element refs; IME composition does not synthesize
Enter. These capabilities require adapter API 3 and protocol revision 2.

Coverage mapping: attachments AC-03–06/15/65–67; chat and recovery AC-01/12/39–46; catalogues AC-07–15/58;
interactions AC-21–38/47–48/61/72; Canvas AC-54/63–76; settings AC-16–20; media AC-49–51/57/68–69; viewport and IME
AC-02/38/56/59/76. This maps supporting evidence, not an automatic pass: every visual, focus, layout, click, playback,
permission, billing and cross-account assertion still needs its real page/service evidence.

## Waiting after a UI submission

For a click-mode case, submit through the UI once, correlate its request/response with the exact task identity,
then use read-only `generation-wait`. It never starts a generation, sends an Agent message or navigates the page.
Keep the submitting page on `origin`. Pass `kind=image|video` and either the ordinary editor's `animate_id`, or
the Canvas turn's `project_id`, `conversation_id` and exact assistant `message_id`. These handles are exclusive.
Ordinary `/i-want` CHAT history is not supported by the Canvas reader; do not substitute a different scene.

The command polls at 2, 4, then 8 second intervals, bounded by `timeout_sec` (1–180), across API retries and up to
five creation-list pages per poll. A missing or unfinished task returns `pending` with the same handle. Resume
only that handle; never resubmit an unknown generation. API failures remain errors, and a failed ordinary work
returns `failed` with its source status. The caller still owns the overall case deadline.

`artifact_available` means this exact task/message exposes the requested minimum `count` of distinct readable
media URLs: images were decoded, or video metadata (positive dimensions and duration) was loaded without playback.
`observed_count` reports extra candidates. Availability is separate from `terminal`: ordinary works report their
source status, while Agent history alone leaves the whole turn's terminal state `unconfirmed`. These observations
do not prove creative accuracy, full video playback, exact output count after turn completion or lowest cost.
Only perform those additional checks when the confirmed case requires them. Signed URLs must not be treated as
permanent downloads. No live generation benchmark is implied by the adapter's regression tests.

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


### Bounded submission and recovery

`agent-image` and `agent-video` wait at most 30 seconds per submission call, even when `timeout_sec` is larger.
They return `generated`, `pending`, `no_media` or `command_outcome_unknown` with their original project/conversation
handle. `generated` means this exact input has an attachment; use `generation-wait` to prove media readability.
It does not imply the whole Agent stream finished. If `message_id` is not yet known, read `conversation` for those
exact ids, match this submitted input and resolve its assistant message before waiting. Never select the latest
message of an unrelated project or resubmit an unknown generation. Plain `agent-chat` retains its complete-turn behavior.

`ai-video` also releases the submission call after a maximum 30 second observation window and retains its
`animate_id`, including after transient read failures. Continue with the same handle and a read-only
`generation-wait` window of 1–180 seconds, bounded by the original case deadline. That command already sleeps
between reads; do not add another fixed sleep after a pending window. Its `read_error` reports failed observation,
not failed generation. Generation POSTs are never automatically retried after ambiguous gateway errors.

An Agent response without an observed usage receipt returns `credits_used: null`; absence of a receipt is not evidence that generation was free.


### Shared interaction guidance

The manifest guide applies to navigation, queries, editing, generation and result checks whenever the host matches
DreamFace; no smoke-test phrase is required. Reuse the current page and action observations, preserve original
submission handles, and stop repeated failed interactions. Completion follows the requested task: media readability
is sufficient only when generation success is the goal; explicit visual or playback assertions still apply.
Requested variants and follow-up edits remain separate authorized steps, each submitted once. Fixed smoke-test
counts, media settings and deadlines belong to the test request rather than everyday product operation.

### Responsive interaction

Use the live editor exposed by the current page rather than a fixed window size or a remembered desktop form.
A prompt-like div may be an entry that opens a separate editor. Inspect candidates with the read-only `tab_find`
`target` form, activate the entry once if needed, then inspect the actual visible and editable field before typing.
Viewport changes can replace nodes; resolve a fresh ref after the transition. Large action maps retain editors
and focus while folding surrounding history. These checks never authorize a generation retry.
