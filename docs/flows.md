## Flows — record, replay and repair test steps

A **flow** is a replayable recording of browser steps. Steps the session performs are kept in its **journal**; a flow is
exported from the journal, replayed with `flow_run`, and repaired where the site changed. The format is shared with
mobile-mcp (`platform: "mobile"`), so a host can keep web and app cases side by side.

### 1. Record with intents
Pass `intent` (what the step does in test terms, e.g. the plan's step text) and `step` (the case step id) on
`tab_open`, `tab_goto`, `tab_act`, `tab_expect`, `site_run` and `network_expect`. Every call is journaled whether or
not you pass them; the intent is what makes an exported flow readable and lets a repair line up with the step it fixes.

- Acts never record an `eN` ref (refs belong to one snapshot): a locator you pass (`selector`, `role`+`name`,
  `label`, `text`, `testid`) is kept as given, and a ref becomes the engine's **generated selector** of the element
  acted on (`internal:role=button[name="Save"i]`, `internal:testid=[data-testid="send"s]`, …). A ref with no generated
  selector is journaled as not replayable (`journal read` shows why). Prefer a `tab_locator` recommendation when the
  step must survive layout changes.
- A value typed into a credential field is recorded as a `${name}` placeholder; credential args of site commands
  (`password`, `token`, …) likewise. `flow_run` fills them from `vars`.
- `tab_expect` with `ref` records the element's selector instead.

`journal {action:"read", since?}` lists entries (`ok`, `ms`, `record`, `error`, `note`). `journal {action:"clear"}`
starts over; `cursor` / `journalFrom` values mark where a recording begins.

### 2. Export
`journal {action:"export", name, since?, case?, site?, seed?, format:"flow"|"playwright", save?}` returns the
successful replayable steps after `since`:

```json
{ "flow": 1, "platform": "web", "name": "save-form", "case": "1.2", "site": "shop",
  "seed": { "site": "shop", "command": "seed", "url": "https://shop.test/" },
  "steps": [
    { "do": "goto", "url": "https://shop.test/form", "intent": "open the form", "step": "1" },
    { "do": "act", "action": "fill", "target": { "selector": "internal:label=\"Name\"i" }, "value": "Ann" },
    { "do": "act", "action": "click", "target": { "selector": "internal:role=button[name=\"Save\"i]" } },
    { "do": "expect", "expect": { "text": "Saved" }, "timeout": 5 },
    { "do": "network", "match": { "url": "/api/save", "method": "POST", "request": [{ "path": "name", "equals": "Ann" }] } },
    { "do": "site", "site": "shop", "command": "orders", "args": {}, "access": "read", "expect": [{ "path": "rows", "minItems": 1 }] }
  ] }
```

`format:"playwright"` writes a `@playwright/test` spec: selectors become `getByRole` / `getByTestId` / `getByLabel` /
`getByText` / `getByPlaceholder` locators, expectations become web-first assertions. Network and site steps stay as
comments (replay them with `flow_run`). `save:true` writes `~/.opencli-mcp/flows/<name>.flow.json` (or `.spec.ts`);
`flows_list` lists saved flows.

### 3. Replay and repair
`flow_run {flow | name, tab?, from?, until?, vars?, allowWrites?, skipSeed?, stepTimeout?}` runs the steps with the same
engine as `tab_act` / `tab_expect`.

- Without `tab`, the seed url (or the first `goto`) opens a new session tab.
- A `site` step whose command is `write` pauses with `write_blocked` unless `allowWrites:true`; each replay spends what
  the command spends. A step that may already have reached the site (`command_outcome_unknown`) is never retried by the runner.
- A failing step **pauses** the run: `status:"paused"`, `failedAt`, the error (with candidates/failed checks), the page
  `url`/`title`/`state`, console errors, recent requests and `resume {from, retry}`. The tab stays in the session.

To repair: inspect with `tab_observe` / `tab_locator`, fix the page or perform the step yourself **with the same
intent**, then `flow_run` again with `from: resume.from` (continue after it) or `from: resume.retry` (run it again).
Replayed steps are journaled too, so `journal {action:"export", since: <journalFrom of the first run>}` is the repaired
flow. Stop and report when the site itself is broken (the step is right, the product is wrong) instead of editing the
flow to pass.

### 4. Locators
`tab_locator {target}` lists locators for one element, most durable first — `testid`, stable `id`, `href`, form
`name`, `role`+name (and exact), `label`, `placeholder`, `text`, the generated selector — each run through the engine:
`matches`, `unique`, `sameElement`, and the Playwright `locator` code. `recommended` is the first unique one that finds
the same element.

### 5. Assertions
- `tab_expect` checks page text/url/title and, on a `selector` or `ref`: `visible`, `count` (exact number of
  matches), and on the first visible match `value`, `enabled`, `checked`, `hasText`.
- `network_expect {url, method?, status?, request?, response?, afterSequence?, timeout?}` waits for a captured request
  whose JSON request/response bodies satisfy the assertions (an SSE response is `{events:[{event, data}]}`). Pass the
  `network.afterSequence` of the `tab_act` that sends it. The result's `seq` is the evidence (`network_inspect detail`).
- JSON assertions: `{path, equals | notEquals | exists | type | minItems | maxItems | contains | matches | jsonHas}`;
  paths `a.b`, `a[0]`, `a[*].b` (every item), `a[?k=v]` (items whose k is v; at the end of a path it is the filtered
  list, so `minItems` counts them). `${name}` refers to `vars` or captured values.

### 6. Site regression suites
`suite_run {site, tab? | origin?, only?, adapters?}` runs `<site>/suite.json` — fixed requests to the endpoints the
site's commands depend on — from a logged-in page of the site with `page_request` rules (session values by
`localStorage:`/`cookie:` source, secrets masked). Checks may `capture` values for later checks; a check needing a
value nothing captured is `skipped`. The report has per-check `failures` (path, op, expected, actual) and
`affectedAdapters`: the commands whose endpoints failed.

### 7. Seeds and plans
- `site.json` `roles` may name a `seed` command (bring the site to a known starting point; return `{url}` for UI flows)
  and a `reset` command (remove what tests created). A flow's `seed` is `{site?, command?, args?, url?}`.
- `plan_save {fileName, plan}` validates a plan — `suites[{name, seed?, cases[{id, title, budget?{writes}, steps[{id,
  perform?, expect[{kind: page|server|network, text}]}]}]}]` — and writes JSON and Markdown under
  `~/.opencli-mcp/plans/`. Flows point back with `case`; recorded steps with `step`.
