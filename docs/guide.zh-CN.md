# opencli-mcp 中文指南

opencli-mcp 是一个连接到真实 Chrome 的 MCP browser service。Chrome extension 负责 tab、CDP 和页面操作；本地 host 把这些能力提供给 MCP client。site Adapter 是建立在同一个 browser API 之上的可选能力，用来封装经过验证的站点操作。

## 安装

需要 Node.js 22+、Google Chrome 和一个 MCP client。

1. 从 [Chrome Web Store](https://chromewebstore.google.com/detail/opencli-mcp/lnaoghmfcdnbhgcihkakfobckmfhllkg) 安装 extension。
2. 在终端运行 `npm install -g opencli-mcp`，然后运行 `opencli-mcp setup`。
3. 按提示选择要配置的 MCP client。重启或重新连接 client 后即可使用。`opencli-mcp doctor` 只检查连接状态，不修改配置。

`setup` 注册 Chrome Native Messaging host，按你的选择配置 MCP client，并等待 extension 连接。它不会自动安装 extension，也不会覆盖已有的 MCP client 条目。详细选项与排障步骤见 [安装说明](setup.md)。

使用 DeepSeek Harness (`dsh`) 时，先运行 `opencli-mcp setup --clients none`，再运行 `dsh plugin --profile web add opencli-mcp`。主包内的 bundle 通过 dsh 自带的 MCP client 接入 browser service；具体说明见 [dsh 安装步骤](setup.md#deepseek-harness-dsh)。

使用 OpenCode 时，运行 `opencli-mcp setup --clients opencode`；使用 Pi 时，先安装 `pi-mcp-adapter`，再运行 `opencli-mcp setup --clients pi`。具体见 [OpenCode 与 Pi 安装步骤](setup.md#opencode)。

## Browser 工作流

先调用 `tab_open` 打开新 tab，或用 `tab_list {user:true}` 找到现有 tab，再用 `tab_claim` 接管。随后按 **observe → act → verify** 工作：

- `tab_observe` 给出可访问性快照和 `eN` 引用；`tab_read` 读取长文档的线性文本。
- `tab_act` 等待目标可操作、定位、执行真实输入并等待页面稳定。复杂流程可在持久的 `js` session 中使用同一套 `Tab` API。
- `tab_expect` 轮询你要确认的结果。页面变化后重新 observe，不要沿用旧引用。
- 如果 `tab_act` 返回 `openedTabs`，可直接使用其中的 `tab`；若为 `pending:true`，稍后用数字 `tabId` 在 `tab_list` 中找到它。下载时把 `download.afterSequence` 传给 `tab_download_wait`，确认文件是否完成。

完成后调用 `session_finalize`。没有保留的 agent tab 会关闭；已接管的 user tab 会释放。需要把新 tab 留给用户时标记为 `deliverable`，需要供后续回合继续接管时标记为 `handoff`。也可用 `tab_release` 保留单个 tab，或用 `tab_close` 明确关闭。详见 [tab 生命周期](tab-lifecycle.md)。

## Playwright 代码与录制

每次 `tab_act` 的结果都带有 `code` 字段，即这一步对应的 Playwright 代码；通过的 `tab_expect` 也会给出断言代码，`tab_find` 的每个结果带有 `locator`。定位器由 Playwright 自己的生成器产生，基于 `tab_act` 实际命中的元素，因此代码与实际操作的元素一致。`session_export_script` 把整个 session 的打开、跳转、操作和断言导出为可直接运行的 Playwright 测试（`javascript` 为 @playwright/test，`python` 为 pytest-playwright）。

用户更愿意演示而不是描述时，可以录制：`record_start` 把 tab 切到前台并开始记录用户的点击、输入、勾选、下拉选择、按键和文件选择（包括 iframe、跨域 iframe 和该 tab 打开的弹窗），以及用户自己输入的跳转、操作引起的对话框和下载。agent 自己在该 tab 上的操作不会被录入。用户说完成后调用 `record_stop`，返回：

- `code`：录到的流程，作为 Playwright 测试；
- `steps`：可以用 `tab_act` 逐条回放的步骤（`target.selector` 与 `target.frame` 原样传入）；
- `network.afterSequence`：配合 `network_inspect` 查看流程期间的网络请求，可作为编写 Adapter 的起点。

密码、验证码和银行卡字段的值不会被录制，也不会写入代码；生成的代码从 `SECRET_1`、`SECRET_2` 等环境变量读取。录制的步骤也会加入 `session_export_script`。`session_finalize` 会停止尚未结束的录制。

## Site Adapter

内置 Adapter 覆盖 Twitter/X、Bilibili 和 Reddit。`sites_search` 查找命令和参数，`site_run` 直接执行；在 `js` 中可用 `sites.enable('reddit')` 暴露该站的动态工具。Adapter 与交互式 browser 操作使用同一个 `Tab` API 和当前 Chrome 登录状态。

创建自己的 Adapter 时，先用 `network_inspect` 的 list/detail 和 `recon.discover(tab)` 找候选 API，再验证鉴权、参数、分页及错误行为。`tools_define` 创建不会立即生效的 draft；用 `tools_try` 传入真实参数和结果断言验证，通过后用 `tools_activate` 发布。系统不会根据一次操作轨迹猜测并生成永久工具。详见 [Adapter 指南](define-tools.md)。

## 架构与开发

```text
MCP client → stdio launcher → local host ⇄ Chrome extension → website
                                   Native Messaging
```

host 由 Chrome 通过 Native Messaging 启动；extension 管理 tab lease、CDP 附着和虚拟光标。每个 MCP client 使用独立的 tab 与 JavaScript session，避免相互清理。`src/api/` 是 browser object model，`src/mcp/` 暴露 MCP tools 与 `js`，`src/sites/` 加载和执行 Adapter。

开发构建与测试命令见 [README](../README.md#development)。Browser 操作的错误代码见 [错误说明](errors.md)，`js` API 见 [生成的参考](api-reference.md)。
