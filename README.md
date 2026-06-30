# Zotero Patent Helper

Zotero 插件：从中国专利网（CNIPA）抓取专利元数据并下载 PDF

## 版本

**v2.2** — CDP 浏览器自动化

## 功能

1. **PDF 元数据提取**
   - 从本地 PDF 附件提取专利信息：标题、申请号、申请日、发明人、申请人、摘要、IPC 分类
   - 支持发明专利、实用新型、外观设计
   - 自动识别专利类型，creator 类型自动适配

2. **在线搜索元数据**
   - 通过 HTTP 搜索 CNIPA 获取专利信息（searchCnipaByTitle）
   - 抓取详情页补充元数据（fetchPatentDetails）

3. **CDP 浏览器下载 PDF**
   - 通过 CDP（Chrome DevTools Protocol）控制本地 Chrome/Edge
   - 自动搜索、提交表单、处理 CNIPA 反爬（$\_ts）
   - 验证码手动弹窗识别
   - PDF 通过浏览器页面 fetch + WebSocket 回传写入

4. **批量处理**
   - 批量提取 PDF 元数据（从本地附件）
   - 批量下载专利文件（逐条 CDP 自动化）

## 菜单

| 菜单项 | 功能 |
|--------|------|
| 获取专利元数据 | 从 PDF 附件提取，若无则在线搜索 |
| 查询并下载专利文件 | CDP 自动化搜索 + PDF 下载 |
| 批量获取专利元数据 | 选中的多个条目提取 PDF 元数据 |
| 批量获取专利文件 | 选中的多个条目逐一下载 PDF |

## 架构

| 文件 | 功能 |
|------|------|
| `src/index.ts` | 入口，创建 Addon 实例 |
| `src/addon.ts` | Addon 类：data、hooks、ztoolkit |
| `src/hooks.ts` | 生命周期钩子 |
| `src/modules/patent.ts` | 右键菜单处理 |
| `src/modules/preferenceScript.ts` | 偏好设置面板 |
| `src/utils/cnipaClient.ts` | CNIPA HTTP + CDP 自动化（核心，~1150 行） |
| `src/utils/cdpClient.ts` | CDP 客户端：启动浏览器，WebSocket 命令 |
| `src/utils/pdfHelpers.ts` | PDF 元数据提取、下载与附件 |
| `src/utils/uiHelpers.ts` | 通知与对话框 |
| `src/utils/ztoolkit.ts` | ZoteroToolkit 实例 |
| `src/utils/locale.ts` | Fluent i18n 初始化 |
| `src/utils/prefs.ts` | Prefs 类型包装 |
| `addon/bootstrap.js` | Zotero 引导，注册 Chrome，加载脚本 |
| `addon/content/scripts/boot.js` | Frame Script（Zotero 内浏览器 CNIPA 自动化） |

## 系统要求

- Node.js 20
- Zotero 6.999–9.x
- Chrome 或 Edge（默认安装路径）

## 开发

```bash
npm install
npm start      # 开发服务器（需 .env）
npm run build  # 构建 → .scaffold/build/
```

## 已知问题

- 控制台窗口闪现：nsIProcess 启动 node.exe 时无法避免
- CNIPA 502 间歇性错误，自动重试
- SwDetail 详情页 POST 偶发返回空
- DOM 选择器脆弱，CNIPA 改版会失效
