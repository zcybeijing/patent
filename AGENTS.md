# AGENTS.md - Zotero Patent Helper

## Prerequisites
- Node.js 20 (pinned in CI workflows)
- `.env` file required for `npm start` (copy `.env.example`, set `ZOTERO_PLUGIN_ZOTERO_BIN_PATH` and `ZOTERO_PLUGIN_PROFILE_PATH`)
- Zotero version range: `6.999` – `9.*` (from `addon/manifest.json`)

## Commands
```bash
npm install      # Install deps + auto-apply patches (postinstall runs patch-package)
npm start        # Dev server with hot reload (zotero-plugin serve; requires .env)
npm run build    # Production build → .scaffold/build/
npm run lint:check  # Prettier + ESLint check
npm run lint:fix  # Auto-fix formatting
npm run test     # Runs via zotero-plugin-scaffold (configured in zotero-plugin.config.ts)
npm run release  # Publish to GitHub Releases (triggered by v* tag push; provided by scaffold)
```

CI order: `lint:check` → `build` → `test`

## Architecture

### Entrypoints & Key Files
- `src/index.ts` — registers addon as `Zotero.ZoteroPatent`
- `src/hooks.ts` — lifecycle (onStartup/onShutdown/onMainWindowLoad)
- `src/modules/patent.ts` — right-click menu handlers, calls `cnipaClient.ts` functions
- **`src/utils/cnipaClient.ts`** — all CNIPA interaction (HTTP client + viewer automation) in one file
- `src/utils/pdfHelpers.ts` — PDF metadata extraction from local files
- `addon/content/scripts/boot.js` — Frame Script for viewer-based automation

### `cnipaClient.ts` Function Map

| Export | Called By | Purpose |
|--------|-----------|---------|
| `seedCookiesFromService()` | internal | Sync viewer cookies → HTTP client |
| `getCsrfToken()` | unused | Returns current CSRF token |
| `fetchCsrfToken()` | unused | Fetches fresh CSRF token from homepage |
| `searchCnipaByTitle(title)` | `patent.ts` (菜单获取元数据/文件) | HTTP search, returns `PatentSearchResult[]` |
| `fetchPatentDetails(url)` | `patent.ts` | Parse detail page HTML → metadata |
| `fetchPatentDetailPdfUrl(url)` | `patent.ts` | Find PDF download URL from detail page |
| `openCnipaBrowser(title)` | `patent.ts` (菜单"打开中国专利网查询") | Full viewer automation: search → match → SwDetail |

Internal helpers: `initCnipaSession()`, `fetchText()` (HTTP with cookies/UA/headers), `navigateAndDownload()`.

## Key Gotchas

### 1. Frame Script必须在 Zotero 7/9 中用 `chrome://` URI 加载
- `loadFrameScript('data:text/javascript,...')` **在 Zotero 7+ 中不工作**（data: URI 被安全策略阻止）
- 必须用插件内的文件：`rootURI + 'content/scripts/boot.js'`
  - 文件路径：`addon/content/scripts/boot.js` → 构建后自动复制到 xpi
  - `rootURI` 在 Zotero 中指向 `jar:file:///...xpi!/` 格式

### 2. `loadFrameScript(url, true)` 不跨页面导航
- Frame Script 仅在**当前**页面内容进程中运行
- 导航到新页面（如 `form.submit()` 到 SwDetail）后，新页面**不会**自动加载 frame script
- 需要在父进程检测到 URI 变化后**重新调用** `mm.loadFrameScript(bootURI, true)`

### 3. `content.eval()` vs `eval()` 的区别
- 在 frame script 中：
  - `eval()` — 在 frame script 沙箱中执行（有 `sendAsyncMessage`、`addMessageListener` API）
  - `content.eval()` — 在**页面上下文**中执行（无 frame script API，只有 DOM API）
- 两种 eval 都可用，但环境不同

### 4. Zotero.openInViewer 规则
- URL 必须用 `http://epub.cnipa.gov.cn/` 不要用 `https://`
- **不要传 `customUserAgent`** — 任何自定义 UA 都会使页面无法加载（TLS 指纹不匹配）
- 等窗口加载：同时检查 `document.readyState === 'complete'` 和 `load` 事件（窗口可能已加载完毕）
- `browser.contentDocument` 在远程 browser 中为 null → 需用 Frame Script 在内容进程中操作 DOM

### 5. CNIPA POST API 的行为
- `POST /Sw/SwDetail` 返回 400 除非：
  - Referer 为 `http://epub.cnipa.gov.cn/Dxb/AdvancedQuery`
  - 请求携带正确的 `__RequestVerificationToken`
  - session 中已有 `/Dxb/AdvancedQuery` 的访问记录
- Frame Script 中的 XHR/fetch 自动携带同源 cookies
- 400 可能由 token 绑定 Referer 或 session 上下文不匹配导致

### 6. CNIPA selectors 脆弱
- `src/utils/cnipaClient.ts` 中所有 DOM 选择器可能因 CNIPA 改版而失效
- 修改时必须在选择器附近加注释说明用途

### 7. 构建问题
- `npm run build` 失败显示 scaffold exports 错误 → 运行 `scripts/fix_scaffold_exports.ps1`
- 构建输出到 `.scaffold/build/`，xpi 文件为 `zotero-patent-helper.xpi`

### 8. 其他
- `patches/zotero-plugin-toolkit+5.1.2.patch` 自动在 `postinstall` 时应用
- `src/modules/examples.ts` 是模板示例代码，不要修改
- `cleanup()` 已被移除（window.ts 已删除，所有代码合并到 cnipaClient.ts）

## Style
- Indent: 4 spaces (TS/JS), 2 spaces (JSON)
- Quotes: single
- Line endings: CRLF (`.editorconfig` enforced)
- Max line: 120
- Use `@ts-expect-error` for Zotero runtime type gaps
- Import `config` from `package.json` for addon metadata

## Git
- Branch: `feature/<desc>`, `fix/<desc>`, `chore/<desc>`
- Commits: Conventional (`feat:`, `fix:`, `chore:`)
- Must pass `npm run lint:check` before commit
