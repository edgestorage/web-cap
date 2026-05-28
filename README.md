# Web Cap

[中文说明](./README.zh-CN.md)

Web Cap is a local-first browser automation toolkit for agents. It lets agents inspect real browser tabs, run reusable in-page scripts, and save successful scripts for later command-line use.

Agents interact with Web Cap through the `web-cap` CLI. The CLI manages the required local runtime automatically, so users do not need a separate startup command.

## Quick Use

1. Install the Web Cap skill with the `skills` CLI:

   ```bash
   npx skills add edgestorage/web-cap
   ```

2. Install the Web Cap browser extension:

   - Open the latest GitHub Release.
   - Download the Chrome extension zip asset, named like `*chrome*.zip`.
   - Open `chrome://extensions` in Chrome.
   - Enable Developer mode.
   - Drag the downloaded zip file into the extensions page.

## Features

- Browser extension runtime for real Chrome/Firefox tabs.
- Command-line interface for script search, inspection, execution, and registration.
- Built-in scripts for common page operations such as inspect, wait, click, fill, query, and text reading.
- Local script registry for reusable browser workflows.
- Browser tab creation and event watching commands for agent workflows.
- Local-first state storage by default.

## Why Script-First

Many browser automation tools expose a fixed set of direct actions: click this selector, fill that input, read this text, take a screenshot. Web Cap takes a script-first approach instead.

Agents can run JavaScript inside the page, compose built-in capabilities, and register useful scripts as reusable browser skills. This makes Web Cap better suited for workflows where an agent needs to inspect page structure, adapt to product-specific UI, and turn a successful operation into something it can call again later.

Compared with action-first browser tools, Web Cap focuses on:

- In-page execution, so scripts can work directly with the DOM and page state.
- Reusable capabilities, so successful scripts can be searched, inspected, and called again.
- Composable scripts, so one script can call another through `cap.call(...)`.
- Post-execution observation, so each script run can return evidence about what changed on the page.
- Local persistence, so agent-learned workflows can survive beyond a single run.
- CLI access, so agents can use the same browser capabilities from normal command-line workflows.

Web Cap observes the page around script execution. It snapshots visible elements before a script runs, tracks DOM mutations while it runs, then snapshots changed areas afterward and returns a visible-elements diff with `added`, `removed`, and `updated` items. Execution evidence can also include browser-side events such as opened tabs, URL changes, reloads, scroll changes, managed clicks, keyboard input, and script calls.

That means an agent does not only get a script's declared JSON result. It can also inspect what the browser visibly did after the script, which is useful for verification, recovery, and deciding whether a newly successful script should be registered as a reusable capability.

## Agent-Oriented Details

- Page targeting: script definitions include target sites, URL patterns, page hints, tags, type, status, and version, so agents can search for the right capability and avoid running a script on the wrong page.
- Two script types: `read` scripts inspect or extract page state, while `act` scripts operate on the page or trigger browser-side changes.
- Event streaming: `wait-events` streams browser page events as JSON Lines, which gives agents a lightweight way to watch clicks, input/change/submit activity, URL changes, and loading state.
- Local execution history: inline scripts are tracked locally with status and result metadata. Temporary script ids remain callable while they are in the latest local history entries.
- Success-gated registration: `--register` only persists a script when its execution result includes `ok: true`, which helps keep the reusable script registry clean.
- Tab-aware execution: commands can target a specific `--tab-id`, while default execution follows the active connected browser tab.

## How It Works

```text
Agent
   |
   | CLI command
   v
Web Cap CLI
   |
   v
Managed local runtime
   |
   | WebSocket
   v
Browser extension
   |
   v
Real browser tab
```

The browser extension connects to the local runtime and executes commands against normal browser tabs. Agents call the CLI, and the CLI handles runtime startup and connection details automatically.

## Packages

- `extension/` - browser extension entrypoints and runtime code.
- `core/` - CLI, local runtime, script registry, and orchestration logic.
- `shared/` - shared protocol, script schema, and validation helpers.
- `skills/` - Agent Skills installable with the `skills` CLI.
- `tests/` - Vitest coverage for CLI, runtime behavior, browser command contracts, and extension helpers.
- `tools/` - project utilities.

## Requirements

- Node.js 20 or newer
- pnpm 9.x
- A Chromium-based browser or Firefox for extension development

## Development Quick Start

Install dependencies:

```bash
pnpm install
```

Start the extension development build:

```bash
pnpm dev
```

For Firefox:

```bash
pnpm dev:firefox
```

Load the generated extension from WXT's output directory, then open a normal `http` or `https` page.

Run CLI commands from an agent or terminal:

```bash
pnpm cli session-status
pnpm cli script-search "inspect page" --type read --site generic-web
pnpm cli script-get builtin.page.inspect
```

A typical agent flow is:

1. Use `script-search` to find a reusable script.
2. Use `script-get` to inspect its input and output schema.
3. Use `script-execute` to run it against the connected browser.
4. Use `script-register` when a script should become reusable.

## CLI Commands

### `script-search`

Search callable built-in and locally registered scripts. Searching first is recommended because reusable scripts usually make browser work faster and more reliable.

### `script-get`

Read one script definition and return its callable schema summary, including `scriptId`, `name`, `description`, `inputSchema`, and `outputSchema`.

### `script-execute`

Execute script code in the selected browser tab. Scripts receive one object argument and return one JSON object.

`script-execute` accepts optional execution settings such as `--timeout-ms`, `--script-file`, and `--input-file`. During execution, scripts can call other scripts through `cap.call(scriptId, input)`.

### `script-register`

Register a reusable script definition with metadata, input JSON schema, output JSON schema, and script function code. The output schema must declare an `ok` property and include `ok` in `required`.

### Browser commands

Web Cap also includes commands such as `browser-new-tab`, `session-status`, and `wait-events` for agent workflows that need tab control or browser event observation.

## Script Model

Scripts are JavaScript functions with JSON-compatible inputs and outputs:

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

The runtime injects `cap` while the script executes.

Available runtime helpers:

- `cap.call(scriptId, input)` - call a built-in or registered script.
- `cap.get(scriptId)` - read one script schema summary.
- `cap.list()` - list callable script schema summaries.

Built-in scripts include:

- `builtin.page.inspect`
- `builtin.page.wait_for_element`
- `builtin.page.query_elements`
- `builtin.page.click`
- `builtin.page.fill_input`
- `builtin.page.read_text`

## CLI Usage

Run a one-off script:

```bash
pnpm cli script-execute \
  --script "export default async function (input) { return { ok: true, input }; }" \
  --input '{"hello":"world"}' \
  --timeout-ms 30000
```

Use files for larger payloads:

```bash
pnpm cli script-execute \
  --script-file ./script.js \
  --input-file ./input.json
```

Common CLI commands:

```bash
pnpm cli session-status
pnpm cli script-search "inspect page" --type read --site generic-web
pnpm cli script-get builtin.page.inspect
pnpm cli script-register --definition-file ./script-definition.json
pnpm cli browser-new-tab --url https://example.com --active true
pnpm cli wait-events --duration-ms 10000
```

Use `--compact` on JSON-producing commands to print compact single-line JSON.

## Local State

Web Cap stores local state under `~/.web-cap/` by default. Set `WEB_CAP_STATE_DIR` to use another directory.

Local state includes registered scripts, recent script execution metadata, and browser session information needed by CLI commands.

## Build

Build the browser extension:

```bash
pnpm build
```

Build the Firefox extension:

```bash
pnpm build:firefox
```

Build the npm CLI package:

```bash
pnpm build:npm
```

After building the npm package, the `web-cap` executable is available from `dist/cli.js`:

```bash
npx web-cap --help
```

Create extension zip packages:

```bash
pnpm zip
pnpm zip:firefox
```

## Quality Checks

```bash
pnpm typecheck
pnpm test
pnpm build
```

## GitHub Actions

The repository includes a build workflow at `.github/workflows/build.yml`. It runs lint, typecheck, and tests, then uploads browser extension build artifacts and an npm package tarball.

When a version tag matching `v*` is pushed, the workflow also creates a GitHub Release and uploads the browser extension zip files as release assets.

## Known Limitations

- The extension targets normal `http` and `https` pages.
- Restricted browser pages such as `chrome://` are intentionally out of scope.
- Scripts execute in-page and rely on implicit `cap` injection.
- Manual validation with a loaded browser extension is recommended before release.

## Contributing

Issues and pull requests are welcome. For larger changes, please open an issue first so the implementation direction can be discussed.

Before sending a pull request, run:

```bash
pnpm typecheck
pnpm test
pnpm build
```

## License

Apache License 2.0. See [LICENSE](./LICENSE).
