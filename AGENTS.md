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

**No `npm run test`** — CI test job is broken without it. Add `"test": "zotero-plugin test"` to `package.json` to fix.

CI order: `lint` + `build` in parallel, then `test` (needs `build`).

## Architecture

### Entrypoints

| File                              | Role                                                                                            |
| --------------------------------- | ----------------------------------------------------------------------------------------------- |
| `addon/bootstrap.js`              | Zotero bootstrap entry — registers chrome, loads compiled script                                |
| `src/index.ts`                    | Creates `Addon`, registers `Zotero.ZoteroPatent`, injects `_globalThis.addon` and `ztoolkit`    |
| `src/addon.ts`                    | `Addon` class holding `data`, `hooks`, `ztoolkit`                                               |
| `src/hooks.ts`                    | Lifecycle: `onStartup`/`onMainWindowLoad`/`onShutdown`                                          |
| `src/modules/patent.ts`           | Right-click menu handlers (metadata, file download, browser open, batch)                        |
| `src/utils/cnipaClient.ts`        | CNIPA HTTP + CDP automation (815 lines — core logic)                                            |
| `src/utils/cdpClient.ts`          | CDP (Chrome DevTools Protocol) — launches Chrome/Edge, connects via Zotero's built-in WebSocket |
| `src/utils/pdfHelpers.ts`         | PDF metadata extraction from local files                                                        |
| `src/utils/uiHelpers.ts`          | Notification dialogs                                                                            |
| `addon/content/scripts/boot.js`   | Frame Script for Zotero viewer-based CNIPA automation                                           |
| `src/modules/preferenceScript.ts` | Preferences UI handlers                                                                         |

### Build output

- `npm run build` → `.scaffold/build/addon/content/scripts/zoteroPatent.js` (bundled with esbuild, target `firefox140`)
- XPI is `zotero-patent-helper.xpi`
- `package/` is vendored `zotero-plugin-scaffold@0.8.5` (not a workspace dep)
- `npm run build` may fail with scaffold exports error → run `scripts/fix_scaffold_exports.ps1`

### CI / Release

- CI (`.github/workflows/ci.yml`): Node 20, Ubuntu. `lint` and `build` run in parallel, `test` depends on `build`.
- Release (`.github/workflows/release.yml`): On tag push `v**`, runs `npm run release` (via scaffold CLI).

### Notable config files

| File                      | Purpose                                                                     |
| ------------------------- | --------------------------------------------------------------------------- |
| `zotero-plugin.config.ts` | Build config: entry, dist, esbuild options, test hook                       |
| `eslint.config.mjs`       | Extends `@zotero-plugin/eslint-config`                                      |
| `tsconfig.json`           | `target: ES2018`, `strict: true`                                            |
| `test/tsconfig.json`      | Extends root tsconfig                                                       |
| `typings/`                | Zotero runtime type declarations (`global.d.ts`, `i10n.d.ts`, `prefs.d.ts`) |

## CDP automation flow (primary approach)

1. Launch Chrome/Edge via `nsIProcess` with `--remote-debugging-port=19222`
2. Connect CDP WebSocket, create/attach page target at `about:blank`
3. Navigate to `http://epub.cnipa.gov.cn/`, wait for anti-bot `$_ts` challenge to resolve
4. Fill `#searchStr` input, submit via `form.submit()` → `/Dxb/IndexQuery`
5. Wait for results with `[onclick*="zl_xm"]` elements
6. Extract `an`, `pubType`, `ggr` from `zl_xm` onclick attribute
7. Use `Input.dispatchMouseEvent` (real click, not `element.click()`) → `/Sw/SwDetail`
8. Extract PDF URL from egaz.cnipa.gov.cn (`filedl`/`showpdf` pattern)
9. If math captcha appears, solve it (parse `digits +/- digits =` pattern)
10. Falls back to system browser on failure

### HTTP POST body formats

| Endpoint               | Body                                                                                                                                       | Referer                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| `POST /Dxb/IndexQuery` | `searchStr=...&fmgb=true&fmsq=true&xxsq=true&wgsq=true&trsSql=&__RequestVerificationToken=...&fmgb=false&fmsq=false&xxsq=false&wgsq=false` | `http://epub.cnipa.gov.cn/`               |
| `POST /Sw/SwDetail`    | `an=...&pubType=3&ggr=...&__RequestVerificationToken=...`                                                                                  | `http://epub.cnipa.gov.cn/Dxb/IndexQuery` |
| `GET /showpdf`         | `path=...&key=...` (on egaz.cnipa.gov.cn)                                                                                                  | `http://epub.cnipa.gov.cn/`               |
| `GET /filedl`          | `path=...` (on egaz.cnipa.gov.cn, after captcha)                                                                                           | `http://epub.cnipa.gov.cn/`               |

## Key Gotchas

### `$_ts` anti-bot

CNIPA runs a `$_ts` challenge on page load. Polling loop waits for `body.innerHTML.length > 0` and absence of `$_ts` string. May re-run on `/Dxb/IndexQuery` after form submit.

### `Zotero.openInViewer` — HTTP-only, no custom UA

- URL must be `http://epub.cnipa.gov.cn/`, never `https://`
- Do not pass `customUserAgent` — breaks TLS fingerprint
- `browser.contentDocument` is `null` for remote browsers → Frame Script only

### CDP clicks — `Input.dispatchMouseEvent`, not `element.click()`

- `Runtime.evaluate('element.click()')` is synthetic → no user activation → `window.open()` blocked
- Always use `clickElementReal()` / `clickElementRealByIndex()` (`cdpClient.ts`) for clicks that open tabs
- Same for `form.submit()` with `target='_blank'`

### Frame Script quirks

- `loadFrameScript('data:...')` blocked in Zotero 7+. Must use `rootURI + 'content/scripts/boot.js'` (`jar:file:///...xpi!/`)
- Does not persist across navigation — re-call after form submit
- `eval()` = frame script sandbox; `content.eval()` = page context only

### CNIPA selectors are fragile

All DOM selectors in `cnipaClient.ts` and `boot.js` may break on site updates. Annotate purpose near selector when modifying.

### Download: use `Zotero.HTTP.request`, not `ztoolkit.file.saveTempFile`

- `ztoolkit.file.saveTempFile` does **not exist** in `zotero-plugin-toolkit` 5.1.2 — will throw at runtime
- Use `Zotero.HTTP.request('GET', url, { responseType: 'arraybuffer' })` instead
- Write response to temp file via `nsIFileOutputStream` + `nsIBinaryOutputStream`
- Download URL must be `filedl`, not `showpdf`. Extract `path` from showpdf → construct `http://egaz.cnipa.gov.cn/filedl?path=<path>`
- Always set `Referer: http://epub.cnipa.gov.cn/` header when downloading from egaz.cnipa.gov.cn
- `downloadPdfAndAttach` in `pdfHelpers.ts` handles this correctly; also updates existing PDF attachment (removes old, imports new)

## Style

- Editorconfig: CRLF, 4-space TS/JS, 2-space JSON, single quotes, max 120 chars (`.editorconfig`)
- `@ts-expect-error` for Zotero runtime type gaps; `_globalThis.addon` for dynamic injection
- Import `config` from `package.json` for addon metadata
- Do **not** modify `src/modules/examples.ts` (template example)
- ESLint: `@typescript-eslint/no-unused-vars` is **off**

## Git

- Branch: `feature/<desc>`, `fix/<desc>`, `chore/<desc>`
- Commits: Conventional (`feat:`, `fix:`, `chore:`)
- Must pass `npm run lint:check` before commit

## Other instruction files

- `CLAUDE.md` — development diary with older approach notes. May be stale; AGENTS.md is the canonical instruction source.
