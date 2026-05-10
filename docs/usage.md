# Usage

## URL parameters

Append parameters to any URL opened in Firefox.

### `__reuse_tab=1`

Focus an existing tab if one matches; otherwise open a new tab.

```bash
firefox "https://example.com/page?__reuse_tab=1"
```

Match order:

- exact URL match
- path-prefix match
- root-domain match (e.g. `youtube.com/?__reuse_tab=1` focuses any tab on that domain)
- no match: opens in a new tab

### `__close_tabs=<glob>`

Close matching tabs before reusing. Useful for stale auth or error pages. Patterns are wildcard (`*`) matches against the full URL; if a pattern omits the scheme, it is also matched against the URL without the scheme.

```bash
firefox "https://outlook.office.com/mail?__reuse_tab=1&__close_tabs=login.microsoftonline.com/*"
```

Multiple patterns are comma-separated:

```bash
firefox "https://example.com/app?__reuse_tab=1&__close_tabs=login.microsoftonline.com/*,example.com/logout*"
```

### `__run_js=<command>`

Execute one of the built-in commands on the target tab.

```bash
firefox "https://example.com?__reuse_tab=1&__run_js=delete_cookies=myprefix"
firefox "https://example.com?__reuse_tab=1&__run_js=delete_cookie=mykey"
firefox "https://example.com?__reuse_tab=1&__run_js=copy_cookies"
firefox "https://example.com?__reuse_tab=1&__run_js=copy_cookies=/app"
firefox "https://example.com?__reuse_tab=1&__run_js=copy_cookies_exact=/app"
```

`copy_cookies=/path` uses an observed request when available, otherwise a best-effort probe request. `copy_cookies_exact=/path` waits for the next real request to that exact path if none has been observed yet.

## Key event blocking

Configurable in addon options. One pattern per line, `*` wildcard.

```
https://app.example.com/*
example.com/*
*.example.com/*
```

Useful when Ctrl is remapped to Cmd at the OS level and web apps should ignore the resulting `metaKey` presses without breaking browser shortcuts.
