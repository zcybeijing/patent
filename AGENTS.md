# AGENTS.md — Zotero Patent Helper

## Prerequisites

- Node.js 20 (pinned in CI)
- `.env` from `.env.example` with `ZOTERO_PLUGIN_ZOTERO_BIN_PATH` and `ZOTERO_PLUGIN_PROFILE_PATH` for `npm start`
- Zotero `6.999`–`9.*` (manifest.json)

## Commands

- `npm install` — deps + postinstall patch-package
- `npm start` — dev server (`zotero-plugin serve`; needs `.env`)
- `npm run build` — production build → `.scaffold/build/`
- `npm run lint:check` — `prettier --check . && eslint .`
- `npm run lint:fix` — `prettier --write . && eslint . --fix`
- **No `npm run test`** — CI test job depends on `build` but will fail because the script is missing. Add `"test": "zotero-plugin test"` to `package.json` (the `zotero-plugin.config.ts` already has a `test.waitForPlugin` config).

## Architecture

### Entrypoints

| File | Role |
|------|------|
| `addon/bootstrap.js` | Zotero bootstrap — registers chrome, loads compiled script via `loadSubScript` |
| `src/index.ts` | Creates `Addon`, injects `_globalThis.addon` and `ztoolkit` |
| `src/addon.ts` | `Addon` class: `data`, `hooks`, `ztoolkit` |
| `src/hooks.ts` | Lifecycle: `onStartup` / `onMainWindowLoad` / `onShutdown` |
| `src/modules/patent.ts` | Right-click menu handlers (metadata, file download, batch) |
| `src/utils/cnipaClient.ts` | CNIPA HTTP + CDP automation (~1200 lines, core logic) |
| `src/utils/cdpClient.ts` | CDP — launches Chrome/Edge, connects via Zotero's built-in WebSocket |
| `src/utils/pdfHelpers.ts` | PDF metadata extraction from local files; `downloadPdfAndAttach()` |
| `src/utils/uiHelpers.ts` | Notification + dialog helpers |
| `src/utils/ztoolkit.ts` | Creates `ZoteroToolkit` instance with `__env__`-aware logging |
| `src/utils/locale.ts` | Fluent i18n initialization (`initLocale`, `getString`) |
| `src/utils/prefs.ts` | Typed wrappers around `Zotero.Prefs.get/set/clear` |
| `src/utils/helper_builder.cjs` | Build-time script that generates a base64 Node.js CDP launcher |
| `addon/content/scripts/boot.js` | Frame Script for Zotero viewer-based CNIPA automation |
| `src/modules/preferenceScript.ts` | Preferences pane handlers |

### Build output

- `npm run build` → `.scaffold/build/addon/content/scripts/zoteroPatent.js` (esbuild, `firefox140` target, bundled single-file)
- XPI: `zotero-patent-helper.xpi`
- `package/` is vendored `zotero-plugin-scaffold@0.8.5` (provides `zotero-plugin` CLI)
- `patches/` contains patch-package patches for `zotero-plugin-toolkit`

## Gotchas

### Build may fail with scaffold exports error

`node_modules/zotero-plugin-scaffold/package.json` exports can be malformed after install. Run `scripts/fix_scaffold_exports.ps1` to patch the exports field (it adjusts `import`/`require`/`default` paths based on what's actually in `dist/`).

### CNIPA automation

- **HTTP-only, never HTTPS**: `http://epub.cnipa.gov.cn/`. Do not pass `customUserAgent` — breaks TLS fingerprint.
- **`$_ts` anti-bot**: Polling loop waits for `body.innerHTML.length > 0` and absence of `$_ts` string. May re-run after form submit on `/Dxb/IndexQuery`.
- **CDP clicks must be real**: `Runtime.evaluate('element.click()')` is synthetic → no user activation. Use `clickElementReal()` / `clickElementRealByIndex()` (`cdpClient.ts`) for clicks that open tabs. Same for `form.submit()` with `target='_blank'`.
- **Downloads must go through CDP**: `egaz.cnipa.gov.cn` returns 502 for direct Zotero HTTP requests. Use `fetch(url, { credentials: 'include' })` in browser page, get blob as base64, write via `nsIFileOutputStream`. Always set `Referer: http://epub.cnipa.gov.cn/`.
- **Download URL**: Use `filedl`, not `showpdf`. Extract `path` from `showpdf` → `http://egaz.cnipa.gov.cn/filedl?path=<path>`.
- **Frame Script**: `loadFrameScript('data:...')` blocked in Zotero 7+. Must use `rootURI + 'content/scripts/boot.js'` (jar: URI). Does not persist across navigation — re-call after form submit. `eval()` = frame script sandbox; `content.eval()` = page context only.
- **All DOM selectors in `cnipaClient.ts` and `boot.js` are fragile** — CNIPA site changes break them. Annotate purpose near selectors when modifying.

## Style & Conventions

- Editorconfig: CRLF, 4-space TS/JS, 2-space JSON, single quotes, max 120 chars
- `@ts-expect-error` for Zotero runtime type gaps; `_globalThis.addon` for dynamic injection
- `__env__` is a build-time global define (`development` / `production`) used in `ztoolkit.ts`
- Import `config` from `package.json` for addon metadata (`addonName`, `addonID`, `addonRef`, `addonInstance`, `prefsPrefix`)
- Do **not** modify `src/modules/examples.ts` (template example from scaffold)
- ESLint: `@typescript-eslint/no-unused-vars` is **off**

## CI / Release

- CI (`.github/workflows/ci.yml`): Node 20, Ubuntu. `lint` + `build` in parallel, `test` depends on `build`.
- Release (`.github/workflows/release.yml`): On tag push `v**`, runs `npm run release` via scaffold CLI.

## Other instruction files

- `CLAUDE.md` — development diary with older approach notes. May be stale; AGENTS.md is canonical.
- `CONTRIBUTING.md` — branch naming, commit style, PR requirements.
