# Web Cap 中文说明

[English](./README.md)

Web Cap 是一个本地优先的浏览器自动化工具，面向 agent 使用。它可以让 agent 检查真实浏览器标签页、执行可复用的页面脚本，并把成功的脚本保存到本地，后续继续通过命令行调用。

Agent 通过 `web-cap` CLI 使用 Web Cap。CLI 会自动管理所需的本地运行时，用户不需要额外的启动命令。

## 快速使用

1. 通过 `skills` CLI 安装 Web Cap skill：

   ```bash
   npx skills add edgestorage/web-cap
   ```

   这个 skill 包含面向 agent 的 `web-cap` CLI 安装和连接检查流程。

2. 安装 Web Cap 浏览器扩展：

   - 打开 [Web Cap Releases](https://github.com/edgestorage/web-cap/releases) 页面。
   - 下载 Chrome 扩展 zip 产物，文件名类似 `*chrome*.zip`。
   - 在 Chrome 中打开 `chrome://extensions`。
   - 开启开发者模式。
   - 将下载的 zip 文件拖到扩展程序页面中。

3. 检查 CLI 是否能看到浏览器运行时：

   ```bash
   web-cap session-status
   ```

## 手动安装 CLI

面向 agent 的工作流推荐通过 Web Cap skill 获取 CLI 设置流程。也可以直接用 npm 安装 CLI：

```bash
npm install -g web-capability
```

安装后的命令是 `web-cap`：

```bash
web-cap --help
web-cap session-status
```

## 功能特性

- 面向真实 Chrome/Firefox 标签页的浏览器扩展运行时。
- 提供脚本执行、注册、创建标签页和用户接手观察能力的命令行接口。
- Playwright 风格的 page helper，用于 inspect、wait、click、fill、query、read text 等常见页面操作。
- 本地脚本注册表，用于沉淀可复用浏览器工作流。
- 支持创建浏览器标签页和监听页面事件，适合 agent 工作流。
- 默认使用本地优先的状态存储。

## 可复用脚本 Hub

Web Cap 可以从本地 `.web-cap/` 目录运行可复用 capability scripts。共享的 [Web Cap Hub](https://github.com/edgestorage/web-cap-hub) 仓库收集了面向常见网站的现成脚本，也可以作为编写新站点工作流的示例。

复用 hub 中的脚本：

```bash
git clone https://github.com/edgestorage/web-cap-hub.git
cd web-cap-hub

web-cap session-status
web-cap script-execute \
  --tab-id <tab-id> \
  --script-file .web-cap/github.com/read-repository-summary.js \
  --input '{"owner":"edgestorage","repo":"web-cap"}'
```

当前脚本集合和贡献说明见 [Web Cap Hub README](https://github.com/edgestorage/web-cap-hub)。

## 为什么是 Script-First

很多浏览器自动化工具会提供一组固定的直接动作：点击某个 selector、填写某个输入框、读取某段文本、截屏。Web Cap 采用的是 script-first 方式。

Agent 可以在页面内用 Playwright 风格 helper 运行 JavaScript，并把有用脚本注册成可复用的浏览器能力。这让 Web Cap 更适合那些需要理解页面结构、适配具体产品 UI，并把一次成功操作沉淀成后续可重复运行能力的工作流。

相比 action-first 的浏览器工具，Web Cap 更关注：

- 页面内执行，脚本可以直接访问 DOM 和页面状态。
- 能力复用，成功脚本可以被保存并再次运行。
- Playwright 风格的 page helper，用于页面检查和交互。
- 可选的执行后观察，在启用证据采集时脚本运行可以返回页面变化证据。
- 本地持久化，让 agent 学到的工作流不只存在于单次运行中。
- 命令行访问，让 agent 可以在普通 CLI 工作流中使用同一套浏览器能力。

启用证据采集后，Web Cap 会围绕脚本执行观察页面。它会在脚本运行前记录可见元素快照，在运行期间跟踪 DOM 变化，然后在执行后重新采样变化区域，并返回包含 `added`、`removed`、`updated` 的可见元素 diff。执行证据还可以包含浏览器侧事件，例如新标签页打开、URL 变化、页面刷新、滚动变化、托管点击、键盘输入和脚本调用。

这意味着 agent 拿到的不只是脚本声明的 JSON 结果，还能看到脚本执行后浏览器页面实际发生了什么。这对于校验结果、失败恢复，以及判断一个成功脚本是否值得注册成可复用能力都很重要。

## 面向 Agent 的细节

- 页面目标约束：脚本定义包含目标站点、URL patterns、page hints、tags、type、status 和 version，agent 可以选择合适能力，也能避免把脚本跑到错误页面上。
- 两种脚本类型：`read` 脚本用于检查或提取页面状态，`act` 脚本用于操作页面或触发浏览器侧变化。
- 用户接手观察：`wait-events` 会在用户完成浏览器操作期间等待，并以 JSON Lines 形式流式输出这段操作路径。仅在 agent 遇到必须由用户操作的步骤，并需要根据点击、input/change/submit、URL 变化或加载状态判断用户后续操作路径时使用。
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
- `lib/` - CLI、本地运行时、脚本注册表和编排逻辑。
- `shared/` - 共享协议、脚本 schema 和校验工具。
- `skills/` - 可通过 `skills` CLI 安装的 Agent Skills。
- `tests/` - CLI、runtime、浏览器命令契约和扩展辅助逻辑的 Vitest 测试。
- `scripts/` - 项目工具脚本和 runtime 生成辅助脚本。

## 环境要求

- Node.js 20 或更新版本
- pnpm 9.x
- 用于扩展开发的 Chromium 系浏览器或 Firefox

## 开发快速开始

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

开发时可以直接运行源码 CLI：

```bash
pnpm cli session-status
```

典型 agent 流程是：

1. 用 `script-execute` 在已连接的浏览器中执行脚本代码。
2. 内联脚本执行成功后需要复用时，在 `script-execute` 中加 `--register`。

## CLI 命令

### `script-execute`

在选定的浏览器标签页中执行脚本。脚本接收一个对象参数，并返回一个 JSON 对象。

`script-execute` 支持 `--timeout-ms`、`--script-file`、`--input-file`、`--register` 等可选执行配置。脚本执行期间，可以使用注入的 Playwright 风格 `page` helper。`--register` 只会在执行成功且结果包含 `ok: true` 时保存内联脚本。

### 浏览器命令

Web Cap 还包括 `browser-new-tab`、`session-status`、`wait-events` 等命令，适合需要标签页控制，或需要等待用户完成浏览器步骤并检查其操作路径的 agent 工作流。

## 脚本模型

脚本是使用 JSON 兼容输入输出的 JavaScript 函数：

```js
export default async function (input) {
  const title = await page.title();
  const text = await page.locator(input.selector).textContent();

  return {
    ok: true,
    title,
    text,
  };
}
```

运行时会在脚本执行期间注入 Playwright 风格的 `page` helper。常用 API 包括 `page.locator(...)`、`page.getByRole(...)`、`locator.click()`、`locator.fill()`、`locator.textContent()` 和 `locator.waitFor()`。

## CLI 用法

执行一次性脚本：

```bash
web-cap script-execute \
  --tab-id 1 \
  --script "export default async function (input) { return { ok: true, input }; }" \
  --input '{"hello":"world"}' \
  --timeout-ms 30000
```

较大的脚本和输入可以使用文件：

```bash
web-cap script-execute \
  --tab-id 1 \
  --script-file ./script.js \
  --input-file ./input.json
```

常用 CLI 命令：

```bash
web-cap session-status
web-cap script-execute --tab-id 1 --script-file ./script.js --input-file ./input.json --register
web-cap browser-new-tab --url https://example.com --active true
web-cap wait-events --duration-ms 10000
```

本地源码开发时，可以把 `web-cap` 替换成 `pnpm cli`。

JSON 输出类命令默认输出单行紧凑 JSON。需要可视化查看时可以加 `--pretty` 输出格式化 JSON。

## 配置

持久化 CLI 配置通过 `web-cap config` 管理，并保存在本地状态目录中。常用选项包括：

| 配置项 | 默认值 | 示例 | 作用 |
| --- | --- | --- | --- |
| `evidence` | `common` | `web-cap config set evidence events,visibleElements` | 控制脚本执行证据。可使用 `common`、`all`，或用逗号组合 `events` 和 `visibleElements`。 |
| `mouseTrajectorySimulation` | `false` | `web-cap config set mouseTrajectorySimulation true` | 开启后，浏览器级托管鼠标点击会在 press/release 前发送多步移动路径。 |
| `activateTabOnScriptExecute` | `false` | `web-cap config set activateTabOnScriptExecute true` | 执行脚本前激活目标标签页。 |

使用 `script_execute` 时，也可以通过 `options.evidence` 为单次请求传入 evidence 配置。

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
node dist/cli.js --help
```

生成扩展 zip 包：

```bash
pnpm zip
pnpm zip:firefox
```

## 质量检查

```bash
pnpm lint
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
- 脚本在页面内执行，并依赖注入的 Playwright 风格 `page` helper。
- 发布前建议使用真实加载的浏览器扩展做手动验证。

## 贡献

欢迎提交 issue 和 pull request。较大的改动建议先开 issue 讨论实现方向。

提交 pull request 前，请运行：

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## 许可证

Apache License 2.0。详见 [LICENSE](./LICENSE)。
