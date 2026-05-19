# Web Cap 中文说明

[English](./README.md)

Web Cap 是一个本地优先的浏览器自动化工具，面向 agent 使用。它可以让 agent 检查真实浏览器标签页、执行可复用的页面脚本，并把成功的脚本保存到本地，后续继续通过命令行调用。

Agent 通过 `web-cap` CLI 使用 Web Cap。CLI 会自动管理所需的本地运行时，用户不需要额外的启动命令。

## 功能特性

- 面向真实 Chrome/Firefox 标签页的浏览器扩展运行时。
- 提供脚本搜索、查看、执行、注册能力的命令行接口。
- 内置常用页面操作脚本，包括 inspect、wait、click、fill、query、read text。
- 本地脚本注册表，用于沉淀可复用浏览器工作流。
- 支持创建浏览器标签页和监听页面事件，适合 agent 工作流。
- 默认使用本地优先的状态存储。

## 为什么是 Script-First

很多浏览器自动化工具会提供一组固定的直接动作：点击某个 selector、填写某个输入框、读取某段文本、截屏。Web Cap 采用的是 script-first 方式。

Agent 可以在页面内运行 JavaScript，组合内置能力，并把有用脚本注册成可复用的浏览器能力。这让 Web Cap 更适合那些需要理解页面结构、适配具体产品 UI，并把一次成功操作沉淀成后续可重复调用能力的工作流。

相比 action-first 的浏览器工具，Web Cap 更关注：

- 页面内执行，脚本可以直接访问 DOM 和页面状态。
- 能力复用，成功脚本可以被搜索、查看并再次调用。
- 脚本组合，一个脚本可以通过 `cap.call(...)` 调用另一个脚本。
- 执行后观察，每次脚本运行都可以返回页面变化证据。
- 本地持久化，让 agent 学到的工作流不只存在于单次运行中。
- 命令行访问，让 agent 可以在普通 CLI 工作流中使用同一套浏览器能力。

Web Cap 会围绕脚本执行观察页面。它会在脚本运行前记录可见元素快照，在运行期间跟踪 DOM 变化，然后在执行后重新采样变化区域，并返回包含 `added`、`removed`、`updated` 的可见元素 diff。执行证据还可以包含浏览器侧事件，例如新标签页打开、URL 变化、页面刷新、滚动变化、托管点击、键盘输入和脚本调用。

这意味着 agent 拿到的不只是脚本声明的 JSON 结果，还能看到脚本执行后浏览器页面实际发生了什么。这对于校验结果、失败恢复，以及判断一个成功脚本是否值得注册成可复用能力都很重要。

## 面向 Agent 的细节

- 页面目标约束：脚本定义包含目标站点、URL patterns、page hints、tags、type、status 和 version，agent 可以搜索合适能力，也能避免把脚本跑到错误页面上。
- 两种脚本类型：`read` 脚本用于检查或提取页面状态，`act` 脚本用于操作页面或触发浏览器侧变化。
- 事件流：`wait-events` 会以 JSON Lines 形式流式输出浏览器页面事件，让 agent 轻量观察点击、input/change/submit、URL 变化和加载状态。
- 本地执行历史：inline scripts 会在本地记录状态和结果元数据。临时脚本 id 在仍位于最近本地历史记录中时可以继续被调用。
- 成功门槛注册：`--register` 只有在脚本执行结果包含 `ok: true` 时才会持久化脚本，有助于保持可复用脚本注册表干净。
- 标签页感知执行：命令可以通过 `--tab-id` 指定目标标签页；默认执行会使用当前连接浏览器的 active tab。

## 工作方式

```text
Agent
   |
   | CLI command
   v
Web Cap CLI
   |
   v
自动管理的本地运行时
   |
   | WebSocket
   v
Browser extension
   |
   v
真实浏览器标签页
```

浏览器扩展连接到本地运行时，并在普通浏览器标签页中执行命令。Agent 调用 CLI，CLI 会自动处理运行时启动和连接细节。

## 目录结构

- `extension/` - 浏览器扩展入口和运行时代码。
- `core/` - CLI、本地运行时、脚本注册表和编排逻辑。
- `shared/` - 共享协议、脚本 schema 和校验工具。
- `skills/` - 可通过 `skills` CLI 安装的 Agent Skills。
- `tests/` - CLI、runtime、浏览器命令契约和扩展辅助逻辑的 Vitest 测试。
- `tools/` - 项目工具脚本。

## 环境要求

- Node.js 20 或更新版本
- pnpm 9.x
- 用于扩展开发的 Chromium 系浏览器或 Firefox

## 快速开始

安装依赖：

```bash
pnpm install
```

启动扩展开发构建：

```bash
pnpm dev
```

Firefox 开发构建：

```bash
pnpm dev:firefox
```

从 WXT 输出目录加载生成的浏览器扩展，然后打开一个普通的 `http` 或 `https` 页面。

从 agent 或终端运行 CLI 命令：

```bash
pnpm cli session-status
pnpm cli script-search "inspect page" --type read --site generic-web
pnpm cli script-get builtin.page.inspect
```

通过 `skills` CLI 安装 Web Cap agent skill：

```bash
npx skills add edgestorage/web-cap --skill web-cap -a codex
```

典型 agent 流程是：

1. 用 `script-search` 查找可复用脚本。
2. 用 `script-get` 查看脚本输入输出 schema。
3. 用 `script-execute` 在已连接的浏览器中执行脚本。
4. 需要复用时，用 `script-register` 注册脚本。

## CLI 命令

### `script-search`

搜索可调用的内置脚本和本地已注册脚本。建议先搜索再执行，因为复用脚本通常更快、更稳定。

### `script-get`

读取某个脚本定义，并返回可调用的 schema 摘要，包括 `scriptId`、`name`、`description`、`inputSchema` 和 `outputSchema`。

### `script-execute`

在选定的浏览器标签页中执行脚本。脚本接收一个对象参数，并返回一个 JSON 对象。

`script-execute` 支持 `--timeout-ms`、`--script-file`、`--input-file` 等可选执行配置。脚本执行期间，可以通过 `cap.call(scriptId, input)` 调用其他脚本。

### `script-register`

注册可复用脚本定义，包括元信息、输入 JSON schema、输出 JSON schema 和脚本函数代码。输出 schema 必须声明 `ok` 字段，并把 `ok` 放入 `required`。

### 浏览器命令

Web Cap 还包括 `browser-new-tab`、`session-status`、`wait-events` 等命令，适合需要标签页控制或浏览器事件观察的 agent 工作流。

## 脚本模型

脚本是使用 JSON 兼容输入输出的 JavaScript 函数：

```js
export default async function (input) {
  const page = await cap.call('builtin.page.inspect', {});

  return {
    ok: true,
    title: page.title,
    selector: input.selector,
  };
}
```

运行时会在脚本执行期间注入 `cap`。

可用 runtime helper：

- `cap.call(scriptId, input)` - 调用内置脚本或已注册脚本。
- `cap.get(scriptId)` - 读取某个脚本的 schema 摘要。
- `cap.list()` - 列出当前可调用脚本的 schema 摘要。

内置脚本包括：

- `builtin.page.inspect`
- `builtin.page.wait_for_element`
- `builtin.page.query_elements`
- `builtin.page.click`
- `builtin.page.fill_input`
- `builtin.page.read_text`

## CLI 用法

执行一次性脚本：

```bash
pnpm cli script-execute \
  --script "export default async function (input) { return { ok: true, input }; }" \
  --input '{"hello":"world"}' \
  --timeout-ms 30000
```

较大的脚本和输入可以使用文件：

```bash
pnpm cli script-execute \
  --script-file ./script.js \
  --input-file ./input.json
```

常用 CLI 命令：

```bash
pnpm cli session-status
pnpm cli script-search "inspect page" --type read --site generic-web
pnpm cli script-get builtin.page.inspect
pnpm cli script-register --definition-file ./script-definition.json
pnpm cli browser-new-tab --url https://example.com --active true
pnpm cli wait-events --duration-ms 10000
```

JSON 输出类命令可以加 `--compact`，输出单行紧凑 JSON。

## 本地状态

Web Cap 默认把本地状态写入 `~/.web-cap/`。可以通过 `WEB_CAP_STATE_DIR` 指定其他目录。

本地状态包括已注册脚本、最近脚本执行元数据，以及 CLI 命令需要使用的浏览器会话信息。

## 构建

构建浏览器扩展：

```bash
pnpm build
```

构建 Firefox 扩展：

```bash
pnpm build:firefox
```

构建 npm CLI 包：

```bash
pnpm build:npm
```

构建后，`web-cap` 可执行文件位于 `dist/cli.js`：

```bash
npx web-cap --help
```

生成扩展 zip 包：

```bash
pnpm zip
pnpm zip:firefox
```

## 质量检查

```bash
pnpm typecheck
pnpm test
pnpm build
```

## GitHub Actions

仓库包含 `.github/workflows/build.yml` 构建流程。它会运行 lint、typecheck 和测试，然后上传浏览器插件构建产物以及 npm package tarball。

当推送匹配 `v*` 的版本 tag 时，workflow 还会创建 GitHub Release，并把浏览器插件 zip 文件上传为 release assets。

## 当前限制

- 扩展面向普通 `http` 和 `https` 页面。
- `chrome://` 等受限浏览器页面不在支持范围内。
- 脚本在页面内执行，并依赖隐式注入的 `cap`。
- 发布前建议使用真实加载的浏览器扩展做手动验证。

## 贡献

欢迎提交 issue 和 pull request。较大的改动建议先开 issue 讨论实现方向。

提交 pull request 前，请运行：

```bash
pnpm typecheck
pnpm test
pnpm build
```

## 许可证

Apache License 2.0。详见 [LICENSE](./LICENSE)。
