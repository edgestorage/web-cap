---
name: web-cap
description: Use when you need to operate or inspect a real browser tab through local-first browser automation, including clicking, typing, reading page state, extracting data, navigating pages, or running reusable scripts against live browser sessions.
---

# Web Cap CLI

## Overview

Web Cap is a command-line browser automation toolkit for agents. The npm package is `web-capability`, and the installed CLI command is `web-cap`.

## Check And Install

Check whether the Web Cap browser extension/runtime is connected before running page automation:

```bash
web-cap session-status
```

If the `web-cap` command is not available, install the CLI:

```bash
npm install -g web-capability
```

The browser side requires the Web Cap extension/runtime to be loaded and connected. Re-run `web-cap session-status` after installation or extension setup before executing page scripts.

## Run Scripts

Prefer running scripts directly with `script-execute`:

```bash
web-cap session-status
web-cap script-execute --script "export default async function () { return { ok: true, title: document.title, url: location.href }; }"
```

Treat Web Cap scripts as reusable browser capabilities, not just throwaway snippets:

1. Check browser context with `session-status` when the active tab matters.
2. Prefer script files for anything longer than a tiny one-off read.
3. Execute scripts with `script-execute --script-file <path>` and pass variable data through `--input` or `--input-file`.
4. Return structured JSON objects, including `ok`, `url`, and `title` when useful.

Use one-off inline scripts only for very small reads such as `document.title`, `location.href`, or a short visible text fragment.

## Script Files

For reusable automation, write a normal script file and call it whenever needed:

```javascript
// scripts/read-page-summary.js
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

```bash
web-cap script-execute --script-file scripts/read-page-summary.js --input '{"limit":10}'
```

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
web-cap script-execute --script "export default async function () { return { ok: true, title: document.title, url: location.href, text: document.body.innerText.slice(0, 4000) }; }"
```

## Page Operations

When a script operates on page content, prefer the Playwright-compatible runtime APIs exposed as global `page` and `cap.page`. Use `page.locator(...)`, role/text helpers, and locator actions instead of hand-rolled DOM clicks or form mutations.

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

When opening pages or tabs only to perform an operation, close those temporary pages after the operation and verification are complete, unless the user asked to keep them open or the page is useful context for the next step.
