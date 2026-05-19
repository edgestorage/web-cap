---
name: web-cap
description: Use when installing, configuring, or using the web-cap CLI from the web-capability npm package for local-first browser automation. Applies to running browser automation from the command line, connecting the browser extension runtime, inspecting tabs, searching/executing/registering reusable page scripts, and optionally starting the MCP adapter with `web-cap mcp`.
---

# Web Cap CLI

## What Web Cap Is

Web Cap is a command-line browser automation toolkit for agents. The npm package is `web-capability`; the installed CLI command is `web-cap`.

Start from the CLI workflow. MCP is only one CLI subcommand (`web-cap mcp`) for tools that need a stdio MCP adapter.

## Install

Install the package from npm when the project does not already provide it:

```bash
npm install -g web-capability
```

For local development inside the Web Cap repository, use:

```bash
pnpm install
pnpm cli --help
```

The browser side still requires the Web Cap extension/runtime to be loaded and connected. Use `web-cap session-status` first to check whether a browser runtime is connected.

## Core CLI Workflow

Use the CLI directly before considering MCP:

```bash
web-cap session-status
web-cap script-search "inspect page"
web-cap script-get builtin.page.inspect
web-cap script-execute --script "async () => ({ ok: true, title: document.title, url: location.href })"
```

In this repository, replace `web-cap` with `pnpm cli` when running against source:

```bash
pnpm cli session-status
pnpm cli script-search "inspect page"
pnpm cli script-get builtin.page.inspect
```

## Working Rules

Treat Web Cap scripts as reusable browser capabilities, not just throwaway snippets:

1. Check browser context with `session-status` when the active tab matters.
2. Search existing scripts when the task is common, repeated, risky, or site-specific.
3. Inspect promising scripts with `script-get`.
4. Execute scripts with `script-execute`.
5. Register reliable scripts with `script-register` or `script-execute --register`.

Prefer the least permanent option that still makes the task reliable.

## When To Search First

Run `script-search` before writing new JavaScript when any of these are true:

- The task is common or generic: extract visible text, click by text, fill a form, gather links, inspect page state, summarize a table, handle pagination, or scrape repeated cards.
- The target site is known or stable enough that a site-specific script may already exist.
- The operation is risky or stateful: buying, deleting, sending, submitting, changing settings, auth flows, admin pages, or anything where a tested script is safer.
- The same operation will likely be repeated across tabs, sites, or future turns.
- You are unsure of page structure and need a quicker way to discover available built-ins.

Use broad search terms first, then site-specific filters when useful:

```bash
web-cap script-search "extract visible page text"
web-cap script-search "click element by text" --site bilibili.com
web-cap script-search "notifications messages list" --site message.bilibili.com
```

Skip search for tiny one-off reads where direct DOM inspection is faster and harmless, such as reading `document.title`, `location.href`, or a small visible text fragment.

## Execute Scripts

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
web-cap script-execute --script "async () => ({ ok: true, title: document.title, url: location.href, text: document.body.innerText.slice(0, 4000) })"
```

Example structured page scan:

```javascript
async (input) => {
  const visible = (el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0;
  };
  const items = [...document.querySelectorAll("a, button, [role=button], li, [class*=item]")]
    .filter(visible)
    .map((el) => ({
      text: (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim(),
      href: el.href || "",
      aria: el.getAttribute("aria-label") || ""
    }))
    .filter((x) => x.text || x.href || x.aria);
  return { ok: true, url: location.href, title: document.title, items };
}
```

## Register Reusable Scripts

Register a script when a searched-for reusable capability did not already exist and the temporary script has become reliable enough to preserve.

Register after:

- The script has a stable purpose and input/output contract.
- It is parameterized through input instead of hard-coded to the current user request.
- It returns structured JSON output.
- It has been tested once on the live page or workflow.

Do not register when:

- The code contains one-off user data, temporary selectors, or task-specific constants.
- The script mutates live state without explicit safety design and clear inputs.
- The page structure is still unknown and the code is exploratory.
- The operation was too trivial to search for in the first place.

## Reuse Scripts

After `script-search`, use `script-get` for promising scripts before execution. Then call by script id or compose from another script via `cap.call`.

Temporary script ids from recent `script-execute` runs can also be reused while they remain in local history. Use temporary reuse when iterating on the same page during one investigation; promote to a registered script once the pattern is reusable.

When composing scripts, keep the outer inline script small:

```javascript
async (input) => {
  const page = await cap.call("extract-visible-page-state", {
    includeLinks: true,
    maxItems: 100
  });
  return { ok: true, source: page.url, items: page.items.filter((x) => /消息|通知/.test(x.text)) };
}
```

## Stateful Site Actions

For actions that change a user's account or site state, prefer browser-visible UI operations such as clicking the page's own buttons and verifying the resulting page state. Avoid calling a site's private or semi-private HTTP APIs directly, even from the same-origin page context, unless the user explicitly asks for API-based execution or the UI path is unavailable and the tradeoff is explained first.

When opening pages or tabs only to perform an operation, close those temporary pages after the operation and verification are complete, unless the user asked to keep them open or the page is useful context for the next step.

## MCP Is Optional

Use MCP only when the surrounding agent/tooling expects a stdio MCP server:

```bash
web-cap mcp
```

Do not frame Web Cap as primarily MCP. The normal path is the npm package plus the `web-cap` command-line interface.
