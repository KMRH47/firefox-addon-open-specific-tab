# Tab Reuse

A Firefox extension that focuses an existing tab instead of opening a duplicate, driven by URL parameters.

## Quick start

Download the latest signed `.xpi` from [Releases](https://github.com/qol-tools/firefox-addon-open-specific-tab/releases) and open it in Firefox.

```bash
firefox "https://example.com/page?__reuse_tab=1"
```

## About

Recognises `__reuse_tab`, `__close_tabs`, and `__run_js` URL parameters; matches by exact URL, path prefix, or root domain. Site-pattern key-event blocking is configurable in addon options. See [docs/usage.md](docs/usage.md) for the full parameter reference.

## License

PolyForm Noncommercial 1.0.0
