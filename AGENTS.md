# AGENTS.md - Zotero Patent Helper

## Prerequisites

- Node.js 20 (pinned in CI workflows)

## Commands

```bash
npm install      # Install deps + auto-apply patches (postinstall runs patch-package)
npm start        # Dev server with hot reload
npm run build    # Production build → .scaffold/build/
npm run lint:check  # Prettier + ESLint
npm run lint:fix  # Auto-fix
# No test script (CI runs test via zotero-plugin-scaffold after build)
npm run release  # Publish to GitHub Releases (triggered by v* tag push)
```

CI order: `lint:check` → `build` → `test` (test rebuilds; artifact not used).

## Architecture

| Directory / File           | Purpose                                                            |
| -------------------------- | ------------------------------------------------------------------ |
| `addon/`                   | Static assets (bootstrap.js, manifest.json, prefs.js)              |
| `src/index.ts`             | Entry: creates Addon, registers as `Zotero.ZoteroPatent`           |
| `src/addon.ts`             | Addon class (holds `data`, `hooks`, `ztoolkit`)                    |
| `src/hooks.ts`             | Lifecycle hooks (register, startup, shutdown, etc.)                |
| `src/modules/patent.ts`    | Core: CNIPA metadata fetch, PDF download                           |
| `src/utils/cnipaClient.ts` | CNIPA HTTP client (fragile selectors - may need updates)           |
| `src/utils/pdfHelpers.ts`  | PDF download + Zotero attachment                                   |
| `zotero-plugin.config.ts`  | Build config: esbuild target `firefox140`, dist `.scaffold/build/` |
| `test/`                    | Tests (`.test.ts` files, separate tsconfig)                        |

## Key Gotchas

1. **Patch applied**: `patches/zotero-plugin-toolkit+5.1.2.patch` fixes `ChromeUtils.importESModule` issue. Applied automatically after `npm install`.

2. **CNIPA selectors are fragile**: `src/utils/cnipaClient.ts` contains page scraping selectors that may break when CNIPA updates their site. Add comments when updating.

3. **Template code**: `src/modules/examples.ts` contains unused template examples. Do not modify unless adding new patterns.

4. **Register pattern**: Addon registers as `Zotero.ZoteroPatent` via `src/index.ts`. Tests wait for `Zotero.ZoteroPatent.data.initialized`.

5. **Preferences prefix**: All prefs use `extensions.zotero.zoteroPatent.*` prefix.

## Style

- Indent: 4 spaces (TS/JS), 2 spaces (JSON)
- Quotes: single
- Line endings: CRLF
- Max line: 120
- Use `@ts-expect-error` for Zotero runtime type gaps
- Import `config` from `package.json` for addon metadata

## Git

- Branch: `feature/<desc>`, `fix/<desc>`, `chore/<desc>`
- Commits: Conventional (`feat:`, `fix:`, `chore:`)
- Must pass `npm run lint:check` before commit
