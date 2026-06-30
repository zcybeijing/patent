# Zotero Patent Helper

Zotero 插件：从中国专利网（CNIPA）抓取专利元数据并下载 PDF，更新条目

## 版本

**v2.2** — CDP 浏览器自动化

## 功能

1. **PDF 元数据提取**
   - 从本地 PDF 文件提取专利信息：标题、申请号、申请日、发明人、申请人、摘要、IPC 分类
   - 支持发明专利、实用新型专利、外观设计专利
   - 自动识别专利类型，creator 类型自动适配

2. **专利 PDF 下载**
   - 通过 CDP（Chrome DevTools Protocol）控制本地 Chrome/Edge 浏览器
   - 自动导航至 CNIPA 搜索页，输入申请号，提交查询
   - 手动验证码识别（弹窗显示验证码图片）
   - 支持发明专利/实用新型 batch 下载
   - PDF 通过浏览器页面 fetch + WebSocket 回传写入

3. **批量处理**
   - 选中多个条目批量下载 PDF
   - 处理结果统计（成功/失败/跳过数量）

## 架构

| 文件 | 功能 |
|------|------|
| `src/index.ts` | 入口，创建 Addon 实例 |
| `src/addon.ts` | Addon 类：data、hooks、ztoolkit |
| `src/hooks.ts` | 生命周期：onStartup / onMainWindowLoad / onShutdown |
| `src/modules/patent.ts` | 右键菜单处理（元数据、文件下载、批量） |
| `src/modules/preferenceScript.ts` | 偏好设置面板处理 |
| `src/utils/cnipaClient.ts` | CNIPA HTTP + CDP 自动化（核心实现，~1200 行） |
| `src/utils/cdpClient.ts` | CDP 客户端：启动 Chrome/Edge，WebSocket 连接与命令 |
| `src/utils/pdfHelpers.ts` | PDF 本地元数据提取；`downloadPdfAndAttach()` |
| `src/utils/uiHelpers.ts` | 通知与对话框 |
| `src/utils/ztoolkit.ts` | ZoteroToolkit 实例 |
| `src/utils/locale.ts` | Fluent i18n 初始化 |
| `src/utils/prefs.ts` | Prefs 类型包装 |
| `addon/bootstrap.js` | Zotero 引导脚本 |
| `addon/content/scripts/boot.js` | Frame Script（Zotero viewer 内 CNIPA 自动化） |

## 系统要求

- Node.js 20
- Zotero 6.999–9.x
- Chrome 或 Edge 浏览器（安装在默认路径）

## 本地调试

```bash
# 安装依赖
npm install

# 准备 .env（参考 .env.example）
# 设置 ZOTERO_PLUGIN_ZOTERO_BIN_PATH 和 ZOTERO_PLUGIN_PROFILE_PATH

# 启动开发服务器（热重载）
npm start

# 构建生产版本
npm run build

# 代码检查
npm run lint:check
npm run lint:fix
```

## CNIPA 自动化注意事项

- **HTTP-only**：`http://epub.cnipa.gov.cn/`，不可使用 HTTPS
- **`$_ts` 反爬**：轮询检测 `body.innerHTML.length > 0` 且不含 `$_ts` 字符串
- **验证码**：手动弹窗识别，调用 `CheckCaptcha` API 验证
- **PDF 下载**：必须通过 CDP 浏览器页面 `fetch(url, { credentials: 'include' })` 获取，`Referer` 必须设置为 `http://epub.cnipa.gov.cn/`
- **CDP 点击必须真实**：使用 `clickElementReal()`，`Runtime.evaluate('element.click()')` 属于合成事件，无法触发用户激活
- **DOM 选择器脆弱**：CNIPA 页面可能随时变化，选择器集中在 `cnipaClient.ts` 和 `boot.js`

## 菜单功能

| 菜单项 | 功能 |
|--------|------|
| 获取专利元数据 | 从 PDF 或 CNIPA 获取单个专利元数据 |
| 获取专利文件 | 从 CNIPA 下载 PDF 并附加到条目 |
| 打开中国专利网查询 | 在 Zotero 浏览器中打开 CNIPA |
| 批量获取专利元数据 | 选中多个条目批量处理 |

## 已知问题

- **控制台窗口闪现**：`nsIProcess` 启动 `node.exe` 辅助脚本时，Windows 会短暂显示控制台窗口（`node.exe` 为 32 位控制台程序，`CREATE_NO_WINDOW` 在 WOW64 下无效）
- **CNIPA 502 错误**：服务器偶发 502 Bad Gateway，会自动重试
- **SwDetail 空白**：部分专利详情页 POST 返回空内容，怀疑为服务端 `$_ts` 验证拒绝
- **node.exe 路径依赖**：需通过 `PATH` 环境变量或默认安装路径 `C:\Program Files\nodejs\` 查找

## 代码风格

- CRLF，4 空格缩进（TypeScript），2 空格缩进（JSON）
- 单引号，最大 120 字符
- `@ts-expect-error` 用于 Zotero 运行时类型缺口
