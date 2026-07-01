# AGENTS.md — Zotero Patent Helper

Zotero WebExtensions addon: CNIPA patent metadata extraction and PDF download via CDP browser automation.

## Commands (verbatim)

```
npm install         # deps + postinstall: patch-package
npm start           # zotero-plugin serve (dev server; needs .env)
npm run build       # zotero-plugin build → .scaffold/build/addon/content/scripts/zoteroPatent.js
npm run lint:check  # prettier --check . && eslint .
npm run lint:fix    # prettier --write . && eslint . --fix
```

**No `test` script in `package.json`** — CI calls `npm run test` but it will fail. Scaffold test config lives in `zotero-plugin.config.ts` (`test.waitForPlugin`).

## Prerequisites

- `.env` from `.env.example` — `ZOTERO_PLUGIN_ZOTERO_BIN_PATH` + `ZOTERO_PLUGIN_PROFILE_PATH` required for `npm start`.
- Zotero 6.999–9.* (`addon/manifest.json`). Node.js 20 (CI pin).

## File layout

```
addon/
  bootstrap.js       Zotero bootstrap — registers chrome, loadSubScript on bundled JS
  manifest.json      Extension manifest (scaffold rewrites __addonRef__ etc.)
  content/scripts/boot.js   Frame Script for Zotero 7+ viewer CNIPA automation
src/
  index.ts           Entry — injects `addon` global, defines `ztoolkit`
  addon.ts           Addon class (data.config from package.json, hooks, ztoolkit)
  hooks.ts           onStartup / onMainWindowLoad / onMainWindowUnload / onShutdown
  modules/patent.ts  Right-click menu items: metadata extraction, PDF download, batch ops
  modules/preferenceScript.ts   Preferences pane handlers
  modules/examples.ts           Scaffold template — **do not edit**
  utils/cnipaClient.ts         CNIPA browser automation (core logic)
  utils/cdpClient.ts           CDP — launches Chrome/Edge, WS connect via Zotero's built-in channel
  utils/pdfHelpers.ts          Local PDF metadata extraction; downloadPdfAndAttach()
  utils/uiHelpers.ts           Notification + dialog helpers
  utils/ztoolkit.ts            ZoteroToolkit creator (__env__ logging gate)
  utils/locale.ts               Fluent i18n
  utils/prefs.ts                Typed Zotero.Prefs get/set/clear wrappers
  utils/helper_builder.cjs      Build-time: generates base64 Node.js CDP launcher
typings/                 Global type augmentations (global.d.ts, prefs.d.ts, i10n.d.ts)
zotero-plugin.config.ts  Scaffold config: esbuild entry, asset paths, defines globals
patches/                 patch-package: zotero-plugin-toolkit+5.1.2.patch
```

## Wiring you can't guess

- `src/index.ts` sets `_globalThis.addon` and defines `ztoolkit` on `_globalThis` via `Object.defineProperty`.
- `src/addon.ts` imports `package.json` via `require()` — but since `package.json` is an ESM module (`"type": "module"`), this only works at runtime in Zotero (non-ESM context). Don't try `import` on `package.json`.
- Build-time defines (`__addonRef__`, `__env__`, etc.) injected by esbuild via `zotero-plugin.config.ts`.
- `addon/manifest.json` placeholders replaced by scaffold at build time — don't edit manually.

## Gotchas

### Scaffold exports patching

`node_modules/zotero-plugin-scaffold/package.json` exports can break. Run `scripts/fix_scaffold_exports.ps1` after install.

### CNIPA browser automation (non-negotiable)

- **HTTP only**: `http://epub.cnipa.gov.cn/`. Never HTTPS.
- **No `customUserAgent`**: breaks TLS fingerprint.
- **`$_ts` anti-bot**: Poll for `body.innerHTML.length > 0` and no `$_ts` string. Re-poll after form submit on `/Dxb/IndexQuery`.
- **CDP clicks must be real**: `Runtime.evaluate('element.click()')` is synthetic — no tab activation. Use `clickElementReal()` / `clickElementRealByIndex()` from `cdpClient.ts`.
- **PDF downloads via CDP**: `egaz.cnipa.gov.cn` returns 502 for direct HTTP. Use page-context `fetch(url, { credentials: 'include' })`, blob → base64 → `nsIFileOutputStream`. Always set `Referer: http://epub.cnipa.gov.cn/`.
- **Download URL**: use `filedl` endpoint, not `showpdf`.
- **Frame Script (Zotero 7+)**: `loadFrameScript('data:...')` is blocked. Use `rootURI + 'content/scripts/boot.js'` (jar: URI). Must re-register after navigation — boot.js scope doesn't persist across page changes.
- **Fragile DOM selectors**: All selectors in `cnipaClient.ts` and `boot.js` break when CNIPA updates the page. Annotate purpose next to each selector when modifying.

## Style & Conventions

- `.editorconfig`: CRLF, 4-space TS/JS, 2-space JSON, single quotes, 120-char max.
- `@ts-expect-error` for Zotero runtime type gaps.
- `__env__` define: `"development"` / `"production"` (esbuild).
- `@typescript-eslint/no-unused-vars` explicitly **off** in `eslint.config.mjs`.
- `tsconfig.json`: `target: ES2018`, `module: ESNext`, `strict: true`, `exclude: ["build", "addon", "node_modules"]`.

## CI

`.github/workflows/ci.yml` — `lint` + `build` (parallel) → `test` (needs build artifact). Node 20, ubuntu-latest.
`.github/workflows/release.yml` — tag `v**` → build + `npm run release`.
