# Reusable Capability Scripts

When the user wants to save a Web Cap script for reuse, store it under the current working directory's Web Cap capability folder.

- Default folder: `.web-cap`.
- Environment/constant name: `WEB_CAP_PATH`.
- Script path pattern: `${WEB_CAP_PATH}/<domain>/<capability-name>.js`.
- Domain documentation path: `${WEB_CAP_PATH}/<domain>/README.md`.

When the user wants to find reusable Web Cap scripts, check these locations:

- Current Web Cap capability folder: `${WEB_CAP_PATH}`. If `WEB_CAP_PATH` is not defined, use `.web-cap` in the current working directory.
- If `web-cap session-status` returns `availableScripts.sites[]`, use each entry's `directory` as the first place to inspect with `ls`.

Within that location, look for domain directories and scripts that follow `<domain>/<capability-name>.js`, and read `<domain>/README.md` when it exists before running a script.

Use the site's primary registrable domain as `<domain>`, without protocol, path, query, or fragment. Examples: `github.com`, `example.com`, `docs.openai.com`.

Name script files by the reusable capability or workflow they provide, using lowercase action/object names when possible. Examples:

- `.web-cap/github.com/extract-issue-list.js`
- `.web-cap/github.com/create-pr-comment.js`
- `.web-cap/example.com/read-page-summary.js`

Each saved script must start with a JSDoc-style metadata block:

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
  return {
    ok: true,
    url: location.href,
    title: document.title
  };
}
```

Header requirements:

- The block must use JSDoc syntax: `/** ... */`.
- The first content line should identify the file as a Web Cap script: `web-cap script`.
- Use `@description` for the reusable capability or workflow.
- Use `@param` for the input object and important input fields.
- Use `@returns` when the returned structured result needs extra explanation.
- Use `@match` to describe where the script can run using URL/page patterns that future agents can match against `location.href`.

`@match` pattern rules:

- Use full URL patterns with origin and path, such as `https://github.com/:owner/:repo/issues`.
- Use `:name` path parameters for variable path segments.
- Use `*` as a wildcard for broad path matches, such as `https://docs.example.com/*`.
- Separate multiple supported page patterns with commas.
- Add page-state details in normal words when URL alone is not enough, such as login state, visible tab, selected mode, or loaded table.

For each domain directory, maintain `${WEB_CAP_PATH}/<domain>/README.md` with concise notes about the reusable scripts in that directory. Use this format:

```markdown
# <domain> Web Cap Scripts

## Description

<Short description of this domain's reusable Web Cap scripts.>

## Scripts

### <capability-name>.js

- Description: <what it does>
- Pages: <URL patterns or page types>
- Input: <input fields or none>
- Output: <important result fields>
- State: <required login/page state, or none>
```

Execution example:

```bash
web-cap script-execute --tab-id <tab-id> --script-file .web-cap/example.com/read-page-summary.js --input '{"limit":10}'
```

## Multi-Page Workflows

Use `cap.goto(url, nextInput)` when a script needs to continue after a full page
navigation. Web Cap navigates to `url`, waits for the page to load, then reruns
the same script with `nextInput` as the first `input` argument.

```javascript
/**
 * web-cap script
 *
 * @description Search a site, open the first result, and read the detail page.
 * @param {object} input
 * @param {string} [input.step] Current workflow step.
 * @param {string} input.query Search query.
 * @match https://example.com/*
 */
export default async function (input = {}) {
  if (!input.step) {
    await page.locator("input[name='q']").fill(input.query);
    await page.getByRole("button", { name: "Search" }).click();
    return cap.goto(location.href, { step: "results", query: input.query });
  }

  if (input.step === "results") {
    const href = await page.locator("a.result").first().getAttribute("href");
    if (!href) {
      return { ok: false, error: "No result link found.", url: location.href };
    }
    return cap.goto(href, { step: "detail", query: input.query, href });
  }

  return {
    ok: true,
    query: input.query,
    href: input.href,
    url: location.href,
    title: document.title
  };
}
```

Each `nextInput` must be a JSON object and must satisfy the script input schema
on the next run. Include any original input fields you still need in later
steps.
