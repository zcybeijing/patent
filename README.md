# Zotero Patent Helper

中国专利管理插件 for Zotero

## 功能

### ✅ 已完成

1. **PDF元数据提取**
   - 从本地PDF文件提取专利信息：标题、申请号、申请日、发明人、申请人、摘要、IPC分类
   - 支持新建条目时自动附加PDF并提取元数据

2. **CNIPA专利搜索**
   - 通过HiddenBrowser加载中国专利局网站（epub.cnipa.gov.cn）
   - 获取CSRF令牌并构建POST搜索请求
   - 自动打开搜索结果（失败时fallback到Zotero内部浏览器）

3. **专利PDF下载**
   - 从CNIPA网站下载专利PDF
   - 自动附加到Zotero条目

### ⚠️ 已知问题

1. **CNIPA Cookie限制**
   - 状态：无法完成自动搜索
   - 原因：CNIPA通过JavaScript动态设置Cookie（.AspNetCore.Antiforgery、NOh8RTWx6K2dS），HiddenBrowser无法获取
   - 影响：POST请求返回400错误
   - 当前方案：自动fallback到Zotero内部浏览器手动搜索
   - 解决思路：需要使用已登录的浏览器会话Cookie，或使用浏览器扩展注入Cookie

2. **CNIPA页面选择器**
   - 状态：需持续维护
   - 原因：CNIPA网站DOM结构可能随时变化
   - 位置：`src/utils/cnipaClient.ts`

3. **HiddenBrowser不稳定**
   - 状态：偶发
   - 表现：页面加载超时、文档丢失
   - 原因：远程浏览器资源限制

## 本地调试

```bash
# 安装依赖
npm install

# 启动开发服务器（热重载）
npm start

# 构建生产版本
npm run build

# 代码检查
npm run lint:check
npm run lint:fix
```

## 架构

| 文件 | 功能 |
|------|------|
| `src/index.ts` | 入口，注册 `Zotero.ZoteroPatent` |
| `src/addon.ts` | Addon类，data/hooks/ztoolkit |
| `src/hooks.ts` | 生命周期hooks |
| `src/modules/patent.ts` | 专利菜单处理 |
| `src/utils/pdfHelpers.ts` | PDF元数据提取 |
| `src/utils/cnipaClient.ts` | CNIPA HTTP客户端（选择器脆弱） |
| `src/utils/window.ts` | HiddenBrowser自动化、浏览器导航 |
| `src/utils/uiHelpers.ts` | UI通知、对话框 |

## 注意事项

- CNIPA页面DOM与接口可能随时变化，需在`src/utils/cnipaClient.ts`根据页面结构调整选择器
- 临时文件保存与Zotero附件导入使用`ztoolkit.file.saveTempFile`与`Zotero.Attachments.importFromFile`
- 所有prefs使用前缀`extensions.zotero.zoteroPatent.*`
- 代码风格：4空格缩进，单引号，CRLF，120字符宽