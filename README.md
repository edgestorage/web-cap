# Web Cap

[中文说明](./README.zh-CN.md)

Web Cap is a local-first browser automation toolkit for agents. It lets agents inspect real browser tabs, run reusable in-page scripts, and save successful scripts for later command-line use.

Agents interact with Web Cap through the `web-cap` CLI. The CLI manages the required local runtime automatically, so users do not need a separate startup command.

## Quick Use

1. Install the Web Cap skill with the `skills` CLI:

   ```bash
   npx skills add edgestorage/web-cap
   ```

   The skill includes the `web-cap` CLI installation and connection-check workflow for agents.

2. Install the Web Cap browser extension:

   - Open the [Web Cap Releases](https://github.com/edgestorage/web-cap/releases) page.
   - Download the Chrome extension zip asset, named like `*chrome*.zip`.
   - Open `chrome://extensions` in Chrome.
   - Enable Developer mode.
   - Drag the downloaded zip file into the extensions page.

3. Check that the CLI can see the browser runtime:

   ```bash
   web-cap session-status
   ```

## Install CLI Manually

For agent workflows, the Web Cap skill provides the recommended CLI setup path. To install the CLI directly, use npm:

```bash
npm install -g web-capability
```

The installed command is `web-cap`:

```bash
web-cap --help
web-cap session-status
```

## Features

- Browser extension runtime for real Chrome/Firefox tabs.
- Command-line interface for script execution, registration, tab creation, and user handoff observation.
- Playwright-style page helpers for common operations such as inspect, wait, click, fill, query, and text reading.
- Local script registry for reusable browser workflows.
- Browser tab creation and event watching commands for agent workflows.
- Local-first state storage by default.

## Reusable Script Hub

Web Cap can run reusable capability scripts from a local `.web-cap/` directory. The shared [Web Cap Hub](https://github.com/edgestorage/web-cap-hub) repository collects ready-to-use scripts for common websites and provides examples for writing new site-specific workflows.

To reuse scripts from the hub:

```bash
git clone https://github.com/edgestorage/web-cap-hub.git
cd web-cap-hub

web-cap session-status
web-cap script-execute \
  --tab-id <tab-id> \
  --script-file .web-cap/github.com/read-repository-summary.js \
  --input '{"owner":"edgestorage","repo":"web-cap"}'
```

See the [Web Cap Hub README](https://github.com/edgestorage/web-cap-hub) for the current script collection and contribution guidelines.

## Why Script-First

Many browser automation tools expose a fixed set of direct actions: click this selector, fill that input, read this text, take a screenshot. Web Cap takes a script-first approach instead.

Agents can run JavaScript inside the page with Playwright-style helpers and register useful scripts as reusable browser skills. This makes Web Cap better suited for workflows where an agent needs to inspect page structure, adapt to product-specific UI, and turn a successful operation into something it can run again later.

Compared with action-first browser tools, Web Cap focuses on:

- In-page execution, so scripts can work directly with the DOM and page state.
- Reusable capabilities, so successful scripts can be saved and run again.
- Playwright-style page helpers for page inspection and interaction.
- Optional post-execution observation, so script runs can return evidence about what changed on the page when evidence collection is enabled.
- Local persistence, so agent-learned workflows can survive beyond a single run.
- CLI access, so agents can use the same browser capabilities from normal command-line workflows.

Web Cap can observe the page around script execution when evidence collection is enabled. It snapshots visible elements before a script runs, tracks DOM mutations while it runs, then snapshots changed areas afterward and returns a visible-elements diff with `added`, `removed`, and `updated` items. Execution evidence can also include browser-side events such as opened tabs, URL changes, reloads, scroll changes, managed clicks, keyboard input, and script calls.

That means an agent does not only get a script's declared JSON result. It can also inspect what the browser visibly did after the script, which is useful for verification, recovery, and deciding whether a newly successful script should be registered as a reusable capability.

## Agent-Oriented Details

- Page targeting: script definitions include target sites, URL patterns, page hints, tags, type, status, and version, so agents can select the right capability and avoid running a script on the wrong page.
- Two script types: `read` scripts inspect or extract page state, while `act` scripts operate on the page or trigger browser-side changes.
- User handoff observation: `wait-events` waits while a user completes a browser action, then streams the resulting interaction path as JSON Lines. Use it when an agent has reached a step that requires user action and needs the observed clicks, input/change/submit activity, URL changes, or loading state to infer what the user did next.
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
- `lib/` - CLI, local runtime, script registry, and orchestration logic.
- `shared/` - shared protocol, script schema, and validation helpers.
- `skills/` - Agent Skills installable with the `skills` CLI.
- `tests/` - Vitest coverage for CLI, runtime behavior, browser command contracts, and extension helpers.
- `scripts/` - project utilities and generated-runtime helpers.

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

Run the source CLI during development:

```bash
pnpm cli session-status
```

A typical agent flow is:

1. Use `script-execute` to run script code against the connected browser.
2. Add `--register` to `script-execute` when a successful inline script should become reusable.

## CLI Commands

### `script-execute`

Execute script code in the selected browser tab. Scripts receive one object argument and return one JSON object.

`script-execute` accepts optional execution settings such as `--timeout-ms`, `--script-file`, `--input-file`, `--no-evidence`, and `--register`. During execution, scripts can use the injected Playwright-style `page` helper. `--register` saves the inline script only after execution succeeds with `ok: true`.

### Browser commands

Web Cap also includes commands such as `browser-new-tab`, `session-status`, and `wait-events` for agent workflows that need tab control, or need to wait for a user to complete a browser step and inspect the resulting action path.

## Script Model

Scripts are JavaScript functions with JSON-compatible inputs and outputs:

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

The runtime injects a Playwright-style `page` helper while the script executes. Common APIs include `page.locator(...)`, `page.getByRole(...)`, `locator.click()`, `locator.fill()`, `locator.textContent()`, and `locator.waitFor()`.

For controlled multi-page scripts, `cap.goto(url, nextInput)` navigates to `url` and reruns the same script with exactly `nextInput` as the next `input`. Page/script state is lost across the navigation, so pass every cross-page field you need, such as `step`, `index`, `urls`, and accumulated `results`, through `nextInput` explicitly.

## CLI Usage

Run a one-off script:

```bash
web-cap script-execute \
  --tab-id 1 \
  --script "export default async function (input) { return { ok: true, input }; }" \
  --input '{"hello":"world"}' \
  --timeout-ms 30000
```

Use files for larger payloads:

```bash
web-cap script-execute \
  --tab-id 1 \
  --script-file ./script.js \
  --input-file ./input.json \
  --no-evidence
```

Common CLI commands:

```bash
web-cap session-status
web-cap script-execute --tab-id 1 --script-file ./script.js --input-file ./input.json --register
web-cap browser-new-tab --url https://example.com --active true
web-cap wait-events --duration-ms 10000
```

For local source development, replace `web-cap` with `pnpm cli`.

JSON-producing commands print compact single-line JSON by default. Use `--pretty` to print formatted JSON for visual inspection.

## Configuration

Persistent CLI configuration is managed with `web-cap config` and stored in local state. Useful options include:

| Key | Default | Example | Effect |
| --- | --- | --- | --- |
| `evidence` | `common` | `web-cap config set evidence events,visibleElements` | Controls script execution evidence. Use `common`, `all`, or a comma-separated list of `events` and `visibleElements`. Pass `--no-evidence` to `script-execute` to disable evidence for one run. |
| `mouseTrajectorySimulation` | `false` | `web-cap config set mouseTrajectorySimulation true` | When enabled, browser-level managed mouse clicks send a multi-step movement path before press/release. |
| `activateTabOnScriptExecute` | `false` | `web-cap config set activateTabOnScriptExecute true` | Activates the target tab before script execution. |

`evidence` can also be passed per request through `options.evidence` when using `script_execute`.

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

After building the npm package, the `web-cap` executable is available at `dist/cli.js`:

```bash
node dist/cli.js --help
```

Create extension zip packages:

```bash
pnpm zip
pnpm zip:firefox
```

## Quality Checks

```bash
pnpm lint
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
- Scripts execute in-page and rely on the injected Playwright-style `page` helper.
- Manual validation with a loaded browser extension is recommended before release.

## Contributing

Issues and pull requests are welcome. For larger changes, please open an issue first so the implementation direction can be discussed.

Before sending a pull request, run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## License

Apache License 2.0. See [LICENSE](./LICENSE).
