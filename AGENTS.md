# AGENTS.md — Zotero Patent Helper

## Prerequisites

- Node.js 20 (pinned in CI)
- `.env` from `.env.example` with `ZOTERO_PLUGIN_ZOTERO_BIN_PATH` and `ZOTERO_PLUGIN_PROFILE_PATH` for `npm start`
- Zotero `6.999`–`9.*` (manifest.json)

## Commands

```bash
npm install              # deps + postinstall patch-package
npm start                # dev server (zotero-plugin serve; needs .env)
npm run build            # production build → .scaffold/build/
npm run lint:check       # prettier --check . && eslint .
npm run lint:fix         # prettier --write . && eslint . --fix
```

**No `npm run test`** — CI's test job depends on `build` but will fail because the script is missing. Add `"test": "zotero-plugin test"` to `package.json` to fix.

Build may fail with scaffold exports error → run `scripts/fix_scaffold_exports.ps1`.

## Architecture

### Entrypoints

| File                              | Role                                                                                         |
| --------------------------------- | -------------------------------------------------------------------------------------------- |
| `addon/bootstrap.js`              | Zotero bootstrap — registers chrome, loads compiled script via `loadSubScript`               |
| `src/index.ts`                    | Creates `Addon`, registers `Zotero.ZoteroPatent`, injects `_globalThis.addon` and `ztoolkit` |
| `src/addon.ts`                    | `Addon` class: `data`, `hooks`, `ztoolkit`                                                   |
| `src/hooks.ts`                    | Lifecycle: `onStartup` / `onMainWindowLoad` / `onShutdown`                                   |
| `src/modules/patent.ts`           | Right-click menu handlers (metadata, file download, batch)                                   |
| `src/utils/cnipaClient.ts`        | CNIPA HTTP + CDP automation (~1010 lines, core logic)                                        |
| `src/utils/cdpClient.ts`          | CDP — launches Chrome/Edge, connects via Zotero's built-in WebSocket                         |
| `src/utils/pdfHelpers.ts`         | PDF metadata extraction from local files; `downloadPdfAndAttach()`                           |
| `src/utils/uiHelpers.ts`          | Notification + `askUserToPick` dialog                                                        |
| `addon/content/scripts/boot.js`   | Frame Script for Zotero viewer-based CNIPA automation                                        |
| `src/modules/preferenceScript.ts` | Preferences pane handlers                                                                    |

### Build output

- `npm run build` → `.scaffold/build/addon/content/scripts/zoteroPatent.js` (esbuild, `firefox140` target)
- XPI: `zotero-patent-helper.xpi`
- `package/` is vendored `zotero-plugin-scaffold@0.8.5` (not a workspace dep, pinned via `resolutions`)
- `patches/` contains patch-package patches for `zotero-plugin-scaffold`

### CI / Release

- CI (`.github/workflows/ci.yml`): Node 20, Ubuntu. `lint` + `build` in parallel, `test` depends on `build`.
- Release (`.github/workflows/release.yml`): On tag push `v**`, runs `npm run release` (via scaffold CLI).

## CDP automation flow

1. Launch Chrome/Edge via `nsIProcess` + Node.js helper script → `--remote-debugging-port=19222`
2. Connect CDP WebSocket, reuse existing blank tab (`attachToFirstTab` — avoids creating new tabs)
3. Navigate to `http://epub.cnipa.gov.cn/` (HTTP-only, never HTTPS)
4. Wait for `$_ts` anti-bot challenge to resolve (poll for `indexForm` / `searchStr`)
5. Fill `#searchStr` input, submit via `indexForm.submit()` → natural navigation to `/Dxb/IndexQuery`
6. Wait for `[onclick*="zl_xm"]` result elements; may hit another `$_ts` challenge
7. Extract `an`, `pubType`, `ggr` from onclick attributes
8. Manually set `#patd` form fields and submit to `/Sw/SwDetail`
9. Extract PDF URL from egaz.cnipa.gov.cn (`filedl` / `showpdf` pattern)
10. If math captcha appears, solve (parse `digits +/- digits =` pattern)
11. Falls back to system browser on failure

### HTTP POST body formats

| Endpoint                                | Body                                                                                         | Referer                     |
| --------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------- |
| `POST /Dxb/IndexQuery`                  | `searchStr=...&sortField=ggr_desc&showMode=1&pageSize=20&...&__RequestVerificationToken=...` | `http://epub.cnipa.gov.cn/` |
| `POST /Sw/SwDetail` (via CDP patd form) | `an=...&pubType=3&ggr=...&__RequestVerificationToken=...`                                    | —                           |
| `GET /showpdf`                          | `path=...&key=...` (egaz.cnipa.gov.cn)                                                       | `http://epub.cnipa.gov.cn/` |
| `GET /filedl`                           | `path=...` (egaz.cnipa.gov.cn)                                                               | `http://epub.cnipa.gov.cn/` |

## Key Gotchas

### `$_ts` anti-bot

Polling loop waits for `body.innerHTML.length > 0` and absence of `$_ts` string. May re-run after form submit on `/Dxb/IndexQuery`.

### `Zotero.openInViewer` — HTTP-only, no custom UA

- URL must be `http://epub.cnipa.gov.cn/`, never `https://`
- Do not pass `customUserAgent` — breaks TLS fingerprint
- `browser.contentDocument` is `null` for remote browsers → Frame Script only

### CDP clicks — `Input.dispatchMouseEvent`, not `element.click()`

- `Runtime.evaluate('element.click()')` is synthetic → no user activation → `window.open()` blocked
- Always use `clickElementReal()` / `clickElementRealByIndex()` (`cdpClient.ts`) for clicks that open tabs
- Same for `form.submit()` with `target='_blank'`

### Frame Script quirks

- `loadFrameScript('data:...')` blocked in Zotero 7+. Must use `rootURI + 'content/scripts/boot.js'` (jar: URI)
- Does not persist across navigation — re-call after form submit
- `eval()` = frame script sandbox; `content.eval()` = page context only

### CNIPA selectors are fragile

All DOM selectors in `cnipaClient.ts` and `boot.js` may break on site updates. Annotate purpose near selector when modifying.

### Download: CDP-only (Zotero HTTP gives 502)

- `egaz.cnipa.gov.cn` returns 502 for direct Zotero HTTP requests — download **must** go through CDP browser fetch
- `downloadPdfAndAttach` in `pdfHelpers.ts` delegates to `downloadPdfViaCdp` in `cnipaClient.ts`
- CDP download: evaluate `fetch(url, { credentials: 'include' })` in browser page, get blob as base64, write via `nsIFileOutputStream` + `nsIBinaryOutputStream`
- Download URL: `filedl`, not `showpdf`. Extract `path` from showpdf → construct `http://egaz.cnipa.gov.cn/filedl?path=<path>`
- Always set `Referer: http://epub.cnipa.gov.cn/` when downloading from egaz.cnipa.gov.cn

## Style & Conventions

- Editorconfig: CRLF, 4-space TS/JS, 2-space JSON, single quotes, max 120 chars
- `@ts-expect-error` for Zotero runtime type gaps; `_globalThis.addon` for dynamic injection
- `__env__` is a build-time global define (`development` / `production`) used in `ztoolkit.ts`
- Import `config` from `package.json` for addon metadata (`addonName`, `addonID`, `addonRef`, `addonInstance`, `prefsPrefix`)
- Do **not** modify `src/modules/examples.ts` (template example from scaffold)
- ESLint: `@typescript-eslint/no-unused-vars` is **off**

## Git

- Branch: `feature/<desc>`, `fix/<desc>`, `chore/<desc>`
- Commits: Conventional (`feat:`, `fix:`, `chore:`)
- Must pass `npm run lint:check` before commit

## Other instruction files

- `CLAUDE.md` — development diary with older approach notes. May be stale; AGENTS.md is canonical.
