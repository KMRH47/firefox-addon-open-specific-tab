# Development Notes

Quick, practical notes for working on this Firefox extension.

## Setup

1. Install dependencies:
   `npm install`
2. Run tests:
   `npm test`

You can also use the Makefile shortcuts:

- `make test`
- `make bump`
- `make build`

## Property Tests

Property-based tests run with 10,000 cases each by default.

If you want heavier stress testing, increase `numRuns` values in `background.test.js`.

## Commit Style

We use Conventional Commits. Example:

```
feat: add configurable key event blocking
```

## Loading The Extension (Temporary)

1. Open `about:debugging` in Firefox.
2. Click **This Firefox** → **Load Temporary Add-on…**
3. Select `manifest.json` from this repo.

## Useful Query Params

- `__reuse_tab=1` — reuse an existing tab when possible.
- `__run_js=copy_cookies` or `copy_cookies=/path` / `copy_cookies_exact=/exact/request/path` / `delete_cookie=key` / `delete_cookies=prefix` — run helper actions.
  `copy_cookies_exact` waits for the next real matching request when needed.
- `__close_tabs=pattern1,pattern2` — close matching tabs before reuse.

Wildcard patterns are supported (`*`). If a pattern omits the scheme, it is matched
against the URL without the scheme as well.
