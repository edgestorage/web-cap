---
name: web-cap
description: Use when you need to operate or inspect a real browser tab through local-first browser automation, including clicking, typing, reading page state, extracting data, navigating pages, or running reusable scripts against live browser sessions.
---

# Web Cap CLI

## Overview

Web Cap is a command-line browser automation toolkit for agents. The npm package is `web-capability`, and the installed CLI command is `web-cap`.

Use `web-cap --help` to view all available commands, and `web-cap <command> --help` to inspect options for a specific command.

## Check And Install

Check whether the Web Cap browser extension/runtime is connected before running page automation:

```bash
web-cap session-status
```

If the `web-cap` command is not available, install the CLI:

```bash
npm install -g web-capability
```

The browser side requires the `web_cap` extension/runtime to be loaded and connected. Users can download the browser extension from the latest GitHub Release at `https://github.com/edgestorage/web-cap/releases/latest`. Re-run `web-cap session-status` after installation or extension setup before executing page scripts.
`script-execute` requires `--tab-id`; use the tab id shown by `session-status`.

## Connection Checks

Before the first page automation step in a task, run:

```bash
web-cap session-status
```

Use the result to decide the next step:

- If the `web-cap` command is missing, install the CLI with `npm install -g web-capability`, then run `web-cap session-status` again.
- If no browser runtime is connected, tell the user to install or enable the `web_cap` extension. The extension can be downloaded from the latest GitHub Release: `https://github.com/edgestorage/web-cap/releases/latest`.
- If the extension is installed but still disconnected, ask the user to confirm that the `web_cap` extension is enabled and that a normal `http` or `https` tab is open.
- If `session-status` lists multiple tabs, choose the tab that matches the user's requested title or URL. Do not guess a tab id when the target is ambiguous.
- If the intended tab is not listed, ask the user to open or focus the target page, then run `web-cap session-status` again.
- If `session-status` returns `availableScripts.sites` for the target page, inspect the listed site directory before writing a new script or doing non-trivial page-specific work.
- Do not run `script-execute` until you have a specific `--tab-id` from `session-status`.

## Run Scripts

Prefer running scripts directly with `script-execute`:

```bash
web-cap session-status
web-cap script-execute --tab-id <tab-id> --script "export default async function () { return { ok: true, title: document.title, url: location.href }; }"
```

Treat Web Cap scripts as reusable browser capabilities, not just throwaway snippets:

1. Check browser context with `session-status` when the active tab matters.
2. Prefer script files for anything longer than a tiny one-off read.
3. Execute scripts with `script-execute --tab-id <tab-id> --script-file <path>` and pass variable data through `--input` or `--input-file`.
4. Return structured JSON objects, including `ok`, `url`, and `title` when useful.

Use one-off inline scripts only for very small reads such as `document.title`, `location.href`, or a short visible text fragment.

## Script Files

When using saved reusable Web Cap scripts:

- Resolve `WEB_CAP_PATH`; if it is not defined, use `.web-cap` in the current working directory.
- When `session-status` shows `availableScripts.sites[]` entries for the target page, run `ls <directory>` on the listed directory to see whether an existing script can be reused.
- Look under `${WEB_CAP_PATH}/<domain>/` for scripts that match the target site or workflow.
- Read `${WEB_CAP_PATH}/<domain>/README.md` when it exists before running a saved script.
- Execute saved scripts with `script-execute --tab-id <tab-id> --script-file <path>`.
- When saving a new reusable script, write it to `${WEB_CAP_PATH}/<domain>/<capability-name>.js`.
- Follow `references/how-to-write-reusable-scripts.md` for reusable script metadata, naming, and README format.

For reusable automation, write a normal script file and call it whenever needed:

```javascript
/**
 * web-cap script
 *
 * @description Read a compact summary of the current page.
 * @param {object} input
 * @param {number} [input.limit] Optional maximum number of links/items to return.
 * @match https://example.com/articles/:articleId, https://example.com/docs/*
 */
export default async function (input) {
  const heading = await page.locator("h1").first().textContent().catch(() => "");
  const links = await page.locator("a").evaluateAll((items, limit) =>
    items.slice(0, limit).map((el) => ({
      text: (el.textContent || "").replace(/\s+/g, " ").trim(),
      href: el.href || ""
    })),
    input.limit ?? 20
  );

  return {
    ok: true,
    url: location.href,
    title: document.title,
    heading,
    links
  };
}
```

For page lifecycle userscripts that should run automatically when matching pages load, use
`web-cap userscript` metadata and install them with `userscript install`:

```javascript
/**
 * web-cap userscript
 *
 * @name Foo
 * @version 1.0.0
 * @match https://example.com/*
 * @runAt document-idle
 */
console.log("foo");
```

```bash
web-cap userscript install --file ./foo.js
web-cap userscript list
web-cap userscript show userscript.foo
web-cap userscript remove userscript.foo
```

```bash
web-cap script-execute --tab-id <tab-id> --script-file .web-cap/example.com/read-page-summary.js --input '{"limit":10}'
```

Organize reusable scripts by the site's primary domain:

- Put reusable site scripts under `${WEB_CAP_PATH}/<domain>/`, such as `.web-cap/example.com/read-page-summary.js` or `.web-cap/github.com/fill-search-form.js`.
- Use the registrable site domain as the directory name when possible, without protocol, path, or query string.
- Use action-and-object file names, such as `read-page-summary.js`, `extract-search-results.js`, or `fill-login-form.js`.
- Prefer `--script-file` for anything longer than a tiny one-off read. Pass variable data through `--input` or `--input-file`.
- Return an object with at least `ok`. On failure, return `ok: false` with `error`, `details`, `url`, and `title` when available.

## Script Guidelines

Write scripts as small browser functions with clear boundaries:

- Accept variable behavior through input JSON.
- Return structured JSON objects, not raw arrays or loose strings.
- Include `ok`, `url`, and `title` when useful.
- Normalize whitespace before returning page text.
- Filter hidden elements with computed style and bounding boxes.
- Use waits sparingly and expose timing through result fields when it affects reliability.
- For destructive actions, return a preview plan first unless the user explicitly asked to perform the action.

Example one-off read:

```bash
web-cap script-execute --tab-id <tab-id> --script "export default async function () { return { ok: true, title: document.title, url: location.href, text: document.body.innerText.slice(0, 4000) }; }"
```

## Page Operations

When a script operates on page content, prefer the Playwright-compatible runtime APIs exposed as global `page` and `cap.page`. Use `page.locator(...)`, role/text helpers, and locator actions instead of hand-rolled DOM clicks or form mutations.

If the target element cannot be determined confidently from roles, text, selectors, or DOM state, capture a screenshot before taking action. Use visual confirmation to disambiguate the target and avoid guessing, especially when controls have similar labels, icons, or repeated layouts.

Use `browser-screenshot` with the tab id from `session-status`:

```bash
web-cap browser-screenshot --tab-id <tab-id> --pretty
```

Example form interaction:

```javascript
export default async function (input) {
  await page.locator('input[name="email"]').fill(input.email);
  await page.locator('input[name="password"]').fill(input.password);
  await page.getByRole("button", { name: "Login" }).click();

  return {
    ok: true,
    url: location.href,
    title: document.title
  };
}
```

Example repeated item extraction:

```javascript
export default async function (input) {
  const cards = page.locator(input.cardSelector);
  const count = Math.min(await cards.count(), input.limit ?? 20);
  const items = [];

  for (let index = 0; index < count; index += 1) {
    const card = cards.nth(index);
    items.push({
      title: await card.locator(input.titleSelector).first().textContent().catch(() => ""),
      href: await card.locator("a").first().getAttribute("href").catch(() => "")
    });
  }

  return { ok: true, url: location.href, title: document.title, items };
}
```

## Stateful Site Actions

For actions that change a user's account or site state, prefer browser-visible UI operations such as clicking the page's own buttons and verifying the resulting page state.

Avoid calling a site's private or semi-private HTTP APIs directly, even from the same-origin page context, unless the user explicitly asks for API-based execution or the UI path is unavailable and the tradeoff is explained first.

When opening pages or tabs only to perform an operation, treat them as temporary and close them before finishing the task, after the operation and verification are complete. Do not leave temporary pages open unless the user asked to keep them open or the page is useful context for the next step.

## Tab Selection And Cleanup

Use `web-cap session-status` as the source of truth for available tabs and tab ids:

- Reuse the user's existing target tab when the task is about a page they already opened.
- Do not close tabs that were already open before the task unless the user explicitly asks.
- Temporary tabs opened only for lookup, navigation, or verification should be closed after the result is captured.
- Keep a tab open when it is the deliverable, when the user asked to keep it open, or when the next step depends on the page staying live.
- Keep a tab open for handoff when it is waiting for user login, approval, payment, CAPTCHA, or another user-only action.
- If multiple tabs match, prefer a tab whose title or URL clearly matches the user's request. Ask for the target tab when the match is ambiguous.
