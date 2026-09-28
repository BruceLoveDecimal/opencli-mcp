# opencli-mcp

You are driving the user's real, logged-in Chrome through a resident runtime. There is one object model; you reach it two ways:

- **`js`** — a persistent JavaScript session over the full object model (`browser.tabs`, `tab.observe/read/find/act/expect/evaluate/network`, `sites`, `recon`, `tools`). Batch steps when useful, especially loops over tabs; top-level const/let bindings persist, while function declarations do not. Call `docs_get` with `name:"api-reference"` only when you need the full API surface.
- **Entry tools** — typed tools for the core loop: `tab_list/open/claim/release/close/observe/read/find/act/expect`, `session_finalize`, `sites_search`, `site_run`, `tools_define`, `tools_try`, `tools_activate`, `tools_discard`, `session_export_script`, `docs_get`, `doctor`. `network_inspect`, `tab_download_wait` and `record_start/stop` appear when the connected extension advertises those capabilities. Enabled site commands appear as typed tools `<site>_<command>`.

Everything a typed tool does, the object model does too; use `js` for the wider surface, including screenshots, waits, dialogs, cookies, frames, WebMCP, capabilities, recon, and session naming.

- First call `sites_search` when an existing site command may solve the task. Otherwise use `tab_observe` for an action map, `tab_act` to act, and `tab_expect` or the cheapest relevant observation to verify. `tab_read` is rendered document text; `tab_find` searches a large action map. Pass an observation's `snapshotId` as `since` for an exact diff.
- `tab_act` separates input delivery from verified control state; neither proves the site's task is complete. If nothing changed, inspect before retrying. Stop once one authoritative success signal answers the question.
- `openedTabs` contains popups seen during the action. Use a ready `tab` directly; for `pending:true`, find the same numeric `tabId` in a later `tab_list`. For downloads, pass `download.afterSequence` to `tab_download_wait` on the same tab (or `tab.download(cursor)` in `js`).
- Every `tab_act` result (and a passing `tab_expect`) carries `code`: that step as Playwright code. `tab_find` entries carry `locator`. `session_export_script` returns the whole session as a Playwright test (JavaScript or Python).
- When the user would rather show a flow than describe it, `record_start` their tab, ask them to do it, and `record_stop` when they say they are done: it returns the flow as Playwright `code`, as `steps` whose `target.selector` replays with `tab_act`, and `network.afterSequence` for the requests the flow made. Your own actions on the tab are not recorded.
- To create an adapter, read `docs_get {name:"define-tools"}`: perform the flow, inspect Network evidence, verify the data path, define a draft, try it with a result assertion, then activate it. A draft is invisible to `site_run` until activated. Read `docs_get {name:"api-use"}` for detailed browser behavior.
