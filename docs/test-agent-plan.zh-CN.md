# 测试 Agent 能力实施方案（opencli-mcp + mobile-mcp）

本方案对照 Playwright Test Agents（planner / generator / healer，`playwright@1.64` 的 `lib/mcp/test/*`），给两个引擎补齐六项能力。Web 端和 App 端用同一套数据格式（用例、Flow、断言、套件结果），由 quality-agent 等宿主消费。

## 0. Playwright 的做法与我们的取舍

| Playwright | 我们 |
|---|---|
| 浏览器由 seed 测试打开，跑完 `pauseAtEnd` 后把 BrowserContext 交给 MCP | 浏览器/设备已在会话中；seed 由站点/App 的 `seed` role 与 Flow 的 `seed` 描述 |
| 每个 action/assertion 工具多一个 `intent` 参数，返回实际执行的代码，`GeneratorJournal` 记下 `(intent, code)` | 同样给 action/assert 工具加 `intent`（和 `step`），引擎按会话记 Journal，存**持久定位器**而不是一次性的 `eN`/`@eN` |
| 产物是 `.spec.ts`，CI 里无 LLM 回放 | 产物是 Flow JSON（两端通用、可由 `flow_run` 回放）；Web 另可导出 `@playwright/test` spec |
| healer：`test_debug` 在出错处暂停，返回错误 + 快照 + console | `flow_run` 失败时**不释放** tab/设备，返回 paused 报告（错误、当前状态、console、最近请求），Agent 用已有工具修复后 `from` 续跑；Journal 合并为修复后的 Flow |
| `browser_generate_locator` | `tab_locator` / `mobile_locator`：按持久度给出候选并验证唯一性 |
| `planner_save_plan`（结构化 schema → markdown） | `plan_save`：同一 schema 的用例计划（JSON + markdown），步骤断言区分 page / server / network |

不照搬的部分：生成类、扣积分的写操作不进入"盲目回放"——Flow 回放遇到 `write` 的 site/app 命令默认暂停（`write_blocked`），需显式 `allowWrites`；已送达的写操作从不自动重放。

## 1. 共享格式

### 1.1 Flow（可回放产物）

```jsonc
{
  "flow": 1,
  "platform": "web",              // web | mobile
  "name": "ai-image-generate",
  "case": "2.1",                  // 可选：对应用例 id
  "site": "dreamface",            // web 可选；mobile 用 "app"
  "seed": { "site": "dreamface", "command": "seed", "args": {}, "url": "https://testm.facemojiapp.com/zh/home" },
  "steps": [
    { "intent": "打开 AI 图片页", "step": "1", "do": "goto", "url": "https://…/ai-image" },
    { "intent": "输入提示词", "step": "2", "do": "act", "action": "fill",
      "target": { "selector": "internal:role=textbox[name=\"Prompt\"i]" }, "value": "a cat" },
    { "intent": "生成按钮可用", "step": "2", "do": "expect", "expect": { "selector": "…", "enabled": true } },
    { "intent": "提交请求带正确参数", "step": "3", "do": "network",
      "match": { "url": "/task/v2/submit", "method": "POST", "request": [{ "path": "model", "equals": "dreamImage" }] } },
    { "intent": "积分扣减", "step": "4", "do": "site", "site": "dreamface", "command": "credits", "access": "read" }
  ]
}
```

Mobile 的 step：`launch` / `openUrl` / `act`（tap、type、fill、swipe、press…，target 为 `{id|label|text|role+name}`）/ `expect`（target + state）/ `scroll` / `app`（app_run）/ `network`。

### 1.2 断言（JSON 路径）

服务端和网络断言共用一个求值器（`suite.json` 已在用）：路径 `a.b[0]`、`[*]`、`[?k=v]`；算子 `equals`、`notEquals`、`exists`、`type`、`minItems`、`contains`、`matches`、`jsonHas`；`${name}` 引用前面 `capture` 的值。

### 1.3 用例计划

```jsonc
{ "name": "DreamFace 冒烟", "overview": "…", "suites": [{ "name": "AI 图片", "seed": {…},
  "cases": [{ "id": "1.1", "title": "…", "budget": { "writes": 1 },
    "steps": [{ "id": "1", "perform": "点击生成", "expect": [{ "kind": "page", "text": "出现生成中" }, { "kind": "server", "text": "作品列表新增一条" }] }] }] }] }
```

## 2. 六项能力

### ① 可回放产物：intent + Journal + 导出
- opencli：`tab_open`/`tab_goto`/`tab_act`/`tab_expect`/`site_run`/`network_expect` 增加 `intent`、`step`。`Tab.goto/act/expect` 写入会话 Journal（adapter 的后台会话不记录）。act 记录引擎已经算出的 Playwright `selector`（`eN` 不进入产物）；`ref` 断言先解析成 selector。
- mobile：`mobile_action`/`mobile_assert`/`mobile_scroll_until`/`mobile_launch_app`/`mobile_open_url`/`app_run` 增加 `intent`、`step`；由命中的元素推导持久 target（`id` → `label` → `role+name` → `text`，在同一快照里验证唯一，否则加 `nth`）。
- 新工具 `journal`：`action: read | export | clear`；`export` 的 `format: flow | playwright`（Web）/`flow`（Mobile），可 `save` 到 `~/.opencli-mcp/flows/`、`~/.mobile-mcp/flows/`。

### ② 回放与失败暂停（healer）
- `flow_run {flow | name, tab?, from?, until?, allowWrites?, skipSeed?}`：逐步用同一引擎执行；成功返回每步耗时；失败返回 `status: "paused"`、失败步、错误码、URL/标题、当前状态快照、console 错误（Web）、最近请求，以及 `resume: {from}`。tab/设备保持占用。
- 回放步骤带原 intent 记入 Journal；Agent 手动修复的那一步也带 intent 记录，`journal export {since: journalFrom}` 即得到修复后的 Flow。
- `tab_locator {target}` / `mobile_locator {ref, snapshotId}`：给出 testid → id → href → role+name → label/placeholder → text → 引擎生成选择器的候选，标注 `matches` 与 `unique`。

### ③ Seed / 前置状态
- `site.json` / `app.json` 的 `roles` 新增 `seed`（进入已知起点，返回 `{url?}`）和 `reset`（清理测试数据）。
- Flow `seed`：Web 为 `{site?, command?, args?, url?}`；Mobile 为 `{app?, command?, args?, package?, clearData?, launch?}`。`flow_run` 先执行 seed（`skipSeed` 跳过）。
- mobile 新增 `mobile_clear_app_data`（Android `pm clear`；iOS 返回 `unsupported`），对应 ROADMAP "Clear app storage"。

### ④ 用例/计划格式
- `plan_save {name, overview, suites, fileName}`：校验 schema，写 `<home>/plans/<file>.json` 和 `.md`（与 Playwright planner 的 markdown 同结构），返回路径。planner 用 `sitemap`（`map` role）而不是盲目探索。
- Flow 与用例通过 `case` / `step` 关联，`journal export` 按 step 分组输出。

### ⑤ 更细的断言
- `tab_expect` 新增 `value`、`count`、`enabled`、`checked`、`hasText`（作用于 selector/ref）。在页面模块的 `check` 中实现，扩展通过特性 `expect-state` 声明；旧扩展收到这些字段时返回 `capability_unavailable`，不会静默通过。
- `network_expect {afterSequence, url, method?, status?, request?, response?, timeout}`：轮询会话网络日志，解析 JSON/SSE 请求体和响应体后用 1.2 的求值器判断，返回命中的 `seq` 作为证据。mobile 对 `network_capture` 的记录提供同名工具。
- `mobile_assert` 新增 `value`（字段值）与 `count`。

### ⑥ suite 执行器下沉到引擎
- opencli `suite_run {site, origin?, tab?, only?, adapters?}`：读取各来源中最新的 `<site>/suite.json`，在已登录页面上逐条 `page_request`（会话值、secrets 掩码沿用 page_request），解析 JSON/SSE，`capture` 供后续检查引用；返回逐条结果、失败明细，以及受影响的 adapter 命令列表。
- mobile `suite_run {device, app, pageId?}`：同一格式，通过 App WebView 页面发请求（复用 `mobile_webview` 的页面连接）。

## 3. 实施顺序与验证

1. 共享求值器与 schema（单元测试）。
2. Journal + intent + 导出（单元测试：记录、选择器→Playwright locator 转换、Flow 导出）。
3. `flow_run`、定位器候选、seed（以假页面/假 Robot 测试回放、暂停、续跑、写操作拦截）。
4. 断言扩展、`network_expect`、`suite_run`（用假网络日志和假页面请求测试）。
5. mobile 端移植以上各项。
6. 文档：`docs/flows.md`、`docs/sites.md`（roles）、`docs/adapters.md`（mobile）、SKILL/instructions 更新。

兼容性：所有新参数可选；adapterApi 不变（未改变 adapter 可用的 context API）。页面模块的新断言字段受 `expect-state` 特性保护。
