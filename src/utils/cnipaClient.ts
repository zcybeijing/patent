/**
 * CNIPA 抓取客户端：中国专利网 (epub.cnipa.gov.cn)
 *
 * 说明：
 * - 使用 fetch + DOMParser 解析页面
 * - 支持按专利名称搜索和获取PDF下载链接
 */

import { showNotification, showCaptchaDialog, showInputDialog } from './uiHelpers';
import * as cdp from './cdpClient';

var _running = false;

// Node.js OCR helper — uses locally installed tesseract.js@7
const OCR_HELPER_TEMPLATE = [
    'const fs=require("fs"),p=require("path");',
    'const imgPath=process.argv[2],readyPath=process.argv[3],nmPath=process.argv[4];',
    '(async function(){',
    'try{',
    'var T=require(p.join(nmPath,"tesseract.js"));',
    'const buf=fs.readFileSync(imgPath);',
    'const r=await T.recognize(buf,"eng",{logger:function(){}});',
    'fs.writeFileSync(readyPath,JSON.stringify({text:r&&r.data&&r.data.text?r.data.text:""}));',
    '}catch(e){fs.writeFileSync(readyPath,JSON.stringify({error:e.message}));}',
    'try{fs.unlinkSync(imgPath)}catch(e){}',
    '})()',
].join('\n');

function getNodeModulesPath(): string | null {
    // Approach 1: from proxy file in profile extensions dir
    try {
        var profD = Services.dirsvc.get('ProfD', Ci.nsIFile);
        var proxy = profD.clone();
        proxy.append('extensions');
        proxy.append('zotero-patent@local');
        Zotero.debug('[Patent] getNodeModulesPath proxy=' + proxy.path + ' exists=' + proxy.exists());
        if (proxy.exists() && !proxy.isDirectory()) {
            var stream = Cc['@mozilla.org/network/file-input-stream;1'].createInstance(Ci.nsIFileInputStream);
            stream.init(proxy, 0x01, 0, 0);
            var bis = Cc['@mozilla.org/binaryinputstream;1'].createInstance(Ci.nsIBinaryInputStream);
            bis.setInputStream(stream);
            var bytes = bis.readByteArray(bis.available());
            bis.close();
            stream.close();
            var buildPath = '';
            for (var i = 0; i < bytes.length; i++) buildPath += String.fromCharCode(bytes[i]);
            buildPath = buildPath.replace(/\r?\n/g, '').trim();
            Zotero.debug('[Patent] getNodeModulesPath buildPath=' + buildPath);
            if (buildPath) {
                var bf = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);
                bf.initWithPath(buildPath);
                for (var i = 0; i < 3; i++) {
                    var parent = bf.parent;
                    if (!parent) break;
                    bf = parent;
                }
                var nm = bf.path + '\\node_modules';
                var nf = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);
                nf.initWithPath(nm);
                Zotero.debug('[Patent] getNodeModulesPath try=' + nm + ' exists=' + nf.exists());
                if (nf.exists()) {
                    Zotero.debug('[Patent] getNodeModulesPath found via proxy file');
                    return nm;
                }
            }
        }
    } catch (e) {
        Zotero.debug('[Patent] getNodeModulesPath proxy err: ' + e);
    }
    // Approach 2: from _globalThis.rootURI
    try {
        var uri = _globalThis && (_globalThis.rootURI || _globalThis.resourceURI);
        if (uri && typeof uri === 'string' && uri.startsWith('file://')) {
            var file = Services.io.newURI(uri).QueryInterface(Ci.nsIFileURL).file;
            for (var i = 0; i < 3; i++) {
                var p = file.parent;
                if (!p) break;
                file = p;
            }
            var nm = file.path + '\\node_modules';
            var nf = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);
            nf.initWithPath(nm);
            if (nf.exists()) return nm;
        }
    } catch (_) {}
    // Approach 3: hardcoded fallback (dev machine)
    try {
        var h = 'D:\\ZoteroPlugins\\patent\\node_modules';
        var hf = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);
        hf.initWithPath(h);
        if (hf.exists()) return h;
    } catch (_) {}
    return null;
}

function decodeBase64ToFile(path: string, base64: string) {
    try {
        var binary = atob(base64.replace(/-/g, '+').replace(/_/g, '/'));
        var file = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);
        file.initWithPath(path);
        var stream = Cc['@mozilla.org/network/file-output-stream;1'].createInstance(Ci.nsIFileOutputStream);
        stream.init(file, 0x02 | 0x08 | 0x20, 0o666, 0);
        var bos = Cc['@mozilla.org/binaryoutputstream;1'].createInstance(Ci.nsIBinaryOutputStream);
        bos.setOutputStream(stream);
        var bytes = [];
        for (var i = 0; i < binary.length; i++) bytes.push(binary.charCodeAt(i) & 0xff);
        bos.writeByteArray(bytes, bytes.length);
        bos.close();
        stream.close();
    } catch (_) {}
}

/**
 * 从 Zotero 的 cookie 服务中提取 CNIPA 的 cookies（由 openInViewer 中 JS 生成的）
 * 合并到本客户端的 cookieJar 中，使 HTTP 请求复用真实浏览器的会话
 */
export function seedCookiesFromService() {
    try {
        const cookies = Services.cookies.getCookiesFromHost('epub.cnipa.gov.cn', {});
        for (const cookie of cookies) {
            const kv = cookie.name + '=' + cookie.value;
            if (!cookieJar.some((c) => c.startsWith(cookie.name + '='))) {
                cookieJar.push(kv);
            }
        }
        Zotero.debug('[Patent] cookies 已同步: ' + cookieJar.length);
    } catch (e) {
        Zotero.debug('[Patent] cookie 同步失败: ' + e);
    }
}

export type PatentSearchResult = {
    title: string;
    pubNumber?: string;
    applicationNumber?: string;
    filingDate?: string;
    issueDate?: string;
    inventors?: string[];
    assignees?: string[];
    abstractNote?: string;
    country?: string;
    issuingAuthority?: string;
    pubDate?: string;
    detailUrl?: string;
    pdfUrl?: string;
    an?: string;
    pubType?: string;
    ggr?: string;
};

let cnipaCsrfToken = '';

function sleep(ms: number): Promise<void> {
    return new Promise(function (r) {
        setTimeout(r, ms);
    });
}

export function getCsrfToken() {
    return cnipaCsrfToken;
}

/** 从 CNIPA 首页提取 CSRF token，供 viewer POST 使用 */
export async function fetchCsrfToken(): Promise<string> {
    if (cnipaCsrfToken) return cnipaCsrfToken;
    try {
        const html = await fetchText('http://epub.cnipa.gov.cn');
        if (html && html.length > 1000) {
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const input = doc.querySelector('input[name="__RequestVerificationToken"]');
            if (input) {
                cnipaCsrfToken = (input as HTMLInputElement).value || '';
                Zotero.debug('[Patent] fetchCsrfToken 获取成功: ' + (cnipaCsrfToken ? 'yes' : 'no'));
            }
        }
    } catch (e) {
        Zotero.debug('[Patent] fetchCsrfToken 失败: ' + e);
    }
    return cnipaCsrfToken;
}
/**
 * 获取CSRF token
 */
async function initCnipaSession() {
    try {
        const html = await fetchText('http://epub.cnipa.gov.cn/Advanced');
        Zotero.debug('[Patent] Advanced page: ' + (html?.length || 0) + ' chars');

        if (!html || html.length < 100) return;

        const doc = new DOMParser().parseFromString(html, 'text/html');
        const tokenInput = doc.querySelector('input[name="__RequestVerificationToken"]');
        if (tokenInput) {
            cnipaCsrfToken = (tokenInput as HTMLInputElement).value || '';
            Zotero.debug('[Patent] Token: ' + (cnipaCsrfToken ? 'found' : 'not found'));
        }
    } catch (e) {
        Zotero.debug('[Patent] initCnipaSession: ' + e);
    }
}

let cookieJar: string[] = [];

async function fetchText(url: string, options: RequestInit = {}) {
    const headers = new Headers(options.headers);
    headers.set(
        'User-Agent',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 Edg/147.0.0.0',
    );
    headers.set(
        'Accept',
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    );
    headers.set('Accept-Language', 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6,el;q=0.5');
    headers.set('Referer', 'http://epub.cnipa.gov.cn/');
    headers.set('Content-Type', 'application/x-www-form-urlencoded');
    headers.set('Upgrade-Insecure-Requests', '1');
    headers.set('Connection', 'keep-alive');

    if (cookieJar.length > 0) {
        headers.set('Cookie', cookieJar.join('; '));
    }

    const res = await fetch(url, { ...options, credentials: 'include', headers, redirect: 'manual' });

    // Handle redirects manually to capture cookies
    if (res.status === 302 || res.status === 303) {
        const location = res.headers.get('Location');
        if (location) {
            const redirectUrl = location.startsWith('http') ? location : 'http://epub.cnipa.gov.cn' + location;
            return fetchText(redirectUrl, options);
        }
    }

    // Capture cookies from response
    const setCookie = res.headers.get('Set-Cookie');
    if (setCookie) {
        const cookie = setCookie.split(';')[0];
        if (!cookieJar.includes(cookie)) {
            cookieJar.push(cookie);
        }
    }

    if (!res.ok) {
        const status = res.status;
        const statusText = res.statusText;
        // Try to get error body for debugging
        let errorBody = '';
        try {
            errorBody = await res.text();
        } catch {}
        throw new Error(`HTTP ${status} ${statusText}: ${errorBody.substring(0, 200)}`);
    }
    return await res.text();
}

/**
 * 根据专利名称查询 - 使用 /Dxb/AdvancedQuery
 */
export async function searchCnipaByTitle(title: string): Promise<PatentSearchResult[]> {
    const results: PatentSearchResult[] = [];

    // First, get CSRF token and establish session
    try {
        const html = await fetchText('http://epub.cnipa.gov.cn');
        if (html && html.length > 1000) {
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const tokenInput = doc.querySelector('input[name="__RequestVerificationToken"]');
            if (tokenInput) {
                cnipaCsrfToken = (tokenInput as HTMLInputElement).value || '';
                Zotero.debug('[Patent] Got CSRF token: ' + (cnipaCsrfToken ? 'yes' : 'no'));
            }
        }
    } catch (e) {
        Zotero.debug('[Patent] Init session error: ' + e);
    }

    // 方法1: POST带CSRF token（数据格式来自 pcap 抓包）
    if (results.length === 0 && cnipaCsrfToken) {
        try {
            const encoded = encodeURIComponent;
            const postData =
                'sortField=ggr_desc&showMode=1&pageSize=20&pageNum=1' +
                '&isFmgb=true&isFmsq=true&isXx=true&isWg=true' +
                '&catalogInfo.Pn=&catalogInfo.Pd_Begin=&catalogInfo.Pd_End=' +
                '&catalogInfo.Ggr_Begin=&catalogInfo.Ggr_End=' +
                '&catalogInfo.An=&catalogInfo.Edz=' +
                '&catalogInfo.Ad_Begin=&catalogInfo.Ad_End=' +
                '&catalogInfo.E71_73=&catalogInfo.E72=&catalogInfo.E51=' +
                '&catalogInfo.Ti=' +
                encoded(title) +
                '&catalogInfo.Abs=&catalogInfo.E74=' +
                '&catalogInfo.Edl=&catalogInfo.E30=&catalogInfo.E66=' +
                '&catalogInfo.E62=&catalogInfo.E83=&catalogInfo.E86=&catalogInfo.E87=&catalogInfo.E85=' +
                '&trsSql=&__RequestVerificationToken=' +
                encoded(cnipaCsrfToken) +
                '&isFmgb=false&isFmsq=false&isXx=false&isWg=false';

            Zotero.debug('[Patent] Trying POST with CSRF token (pcap format)');
            const html = await fetchText('http://epub.cnipa.gov.cn/Dxb/IndexQuery', {
                method: 'POST',
                body: postData,
            });
            Zotero.debug('[Patent] POST with token result: ' + (html?.length || 0) + ' chars');
            if (html) Zotero.debug('[Patent] 返回数据开头: ' + html.substring(0, 600));

            if (html && html.length > 100) {
                const doc = new DOMParser().parseFromString(html, 'text/html');
                // 提取 onclick 中的专利参数（an, pubType, ggr）
                const onclickEls = doc.querySelectorAll('[onclick*="zl_xm"]');
                for (const el of onclickEls) {
                    const onclick = el.getAttribute('onclick') || '';
                    const params = onclick.match(/'([^']+)'/g) || [];
                    const an = (params[0] || '').replace(/'/g, '');
                    const pubType = (params[1] || '').replace(/'/g, '');
                    const ggr = (params[2] || '').replace(/'/g, '');
                    let ctx = '';
                    let pEl = el.parentElement;
                    for (let c = 0; c < 5 && pEl; c++) {
                        ctx += (pEl.textContent || '').replace(/\s+/g, ' ');
                        pEl = pEl.parentElement;
                    }
                    const title = ctx.replace(/\s+/g, ' ').trim().substring(0, 200);
                    if (title && title.length > 2) {
                        results.push({
                            title,
                            an,
                            pubType,
                            ggr,
                            detailUrl: `http://epub.cnipa.gov.cn/Sw/SwDetail`,
                        });
                    }
                }
                // 备选：提取 <a> 标签中的详情链接
                if (results.length === 0) {
                    const links = doc.querySelectorAll('a[href*="sw"], a[href*="detail"]');
                    for (const link of links) {
                        const href = (link as HTMLAnchorElement).href;
                        const text = link.textContent?.trim() || '';
                        if (text && text.length > 2) {
                            results.push({
                                title: text.replace(/\s+/g, ' ').substring(0, 200),
                                detailUrl: href.startsWith('http') ? href : 'http://epub.cnipa.gov.cn' + href,
                            });
                        }
                    }
                }
            }
        } catch (e) {
            Zotero.debug('[Patent] POST with token failed: ' + e);
        }
    }

    if (results.length === 0) {
        showNotification('未找到匹配的专利');
    }

    return results.slice(0, 20);
}

/**
 * 从专利详情页解析完整元数据
 * CNIPA 详情页包含申请号、申请日、公开号、发明人、摘要等
 */
export async function fetchPatentDetails(detailUrl?: string): Promise<Partial<PatentSearchResult>> {
    const result: Partial<PatentSearchResult> = {};
    if (!detailUrl) return result;

    try {
        const html = await fetchText(detailUrl);
        const doc = new DOMParser().parseFromString(html, 'text/html');

        // 尝试从页面标题获取专利名称
        const titleEl = doc.querySelector('h1, h2, .patent-title, .title, [class*="title"], #tdTitle, .tt');
        if (titleEl && titleEl.textContent) {
            result.title = titleEl.textContent.trim().replace(/\s+/g, ' ');
        }

        // 从表格中提取数据
        const tableRows = doc.querySelectorAll('table.table tr, table.list-table tr, .detail-table tr, table tr');
        for (const row of tableRows) {
            const cells = row.querySelectorAll('td, th');
            if (cells.length >= 2) {
                const label = cells[0].textContent?.trim() || '';
                const value = cells[1].textContent?.trim() || '';

                if (!value) continue;

                // 申请号
                if (/申请号/.test(label)) {
                    result.applicationNumber = value.replace(/[^\dX]/gi, '').substring(0, 13);
                }
                // 申请日
                if (/申请日/.test(label)) {
                    result.filingDate = value.replace(/[^\d\-\.]/g, '');
                }
                // 公开号/公告号
                if (/公开号|公告号|授权公告号/.test(label)) {
                    result.pubNumber = value.trim();
                }
                // 公开日/公告日
                if (/公开日|公告日|授权公告日/.test(label)) {
                    result.issueDate = value.replace(/[^\d\-\.]/g, '');
                    if (!result.pubDate) result.pubDate = value.replace(/[^\d\-\.]/g, '');
                }
                // 发明人
                if (/发明人/.test(label)) {
                    result.inventors = value
                        .split(/[,;，；、\n]/)
                        .map((s) => s.trim())
                        .filter((s) => s.length > 1);
                }
                // 申请人/专利权人
                if (/申请人|专利权人|权利人/.test(label)) {
                    result.assignees = value
                        .split(/[,;，；、\n]/)
                        .map((s) => s.trim())
                        .filter((s) => s.length > 1);
                }
                // 摘要
                if (/摘要/.test(label) && !/摘要附图/.test(label)) {
                    result.abstractNote = value.replace(/\s+/g, ' ').trim();
                }
            }
        }

        // 如果没找到摘要，尝试从特定区域获取
        if (!result.abstractNote) {
            const absEl = doc.querySelector('.abstract, #abstract, [class*="abstract"], .summary');
            if (absEl && absEl.textContent) {
                result.abstractNote = absEl.textContent.trim().replace(/\s+/g, ' ');
            }
        }

        // 设置国家为 CN
        result.country = 'CN';
        result.issuingAuthority = 'CNIPA';

        Zotero.debug('[Patent] fetchPatentDetails result: ' + JSON.stringify(result));
    } catch (e) {
        Zotero?.debug?.('[Patent] fetchPatentDetails failed: ' + e);
    }

    return result;
}

/**
 * 从专利详情页寻找 PDF 下载 URL
 * CNIPA 详情页可能有多种PDF下载方式
 */
export async function fetchPatentDetailPdfUrl(detailUrl?: string): Promise<string | undefined> {
    if (!detailUrl) return undefined;

    try {
        const html = await fetchText(detailUrl);
        const doc = new DOMParser().parseFromString(html, 'text/html');

        // 方法1: 直接查找 PDF 下载链接
        const pdfLinks = doc.querySelectorAll('a[href*=".pdf"], a[href*="PDF"], a[download]');
        for (const link of pdfLinks) {
            const href = (link as HTMLAnchorElement).href;
            if (href && (href.toLowerCase().endsWith('.pdf') || href.toLowerCase().includes('pdf'))) {
                const fullUrl = href.startsWith('http') ? href : `http://epub.cnipa.gov.cn${href}`;
                Zotero.debug('[Patent] Found PDF link: ' + fullUrl);
                return fullUrl;
            }
        }

        // 方法2: 查找包含"下载"或"PDF"文字的链接
        const downloadLinks = doc.querySelectorAll(
            'a[href*="download"], a[href*="Down"], a:contains("PDF"), a:contains("下载")',
        );
        for (const link of downloadLinks) {
            const href = (link as HTMLAnchorElement).href;
            if (href) {
                const fullUrl = href.startsWith('http') ? href : `http://epub.cnipa.gov.cn${href}`;
                Zotero.debug('[Patent] Found download link: ' + fullUrl);
                return fullUrl;
            }
        }

        // 方法3: 查找 iframe 中的 PDF
        const iframes = doc.querySelectorAll('iframe[src*="pdf"], iframe[src*="PDF"]');
        for (const iframe of iframes) {
            const src = (iframe as HTMLIFrameElement).src;
            if (src) {
                const fullUrl = src.startsWith('http') ? src : `http://epub.cnipa.gov.cn${src}`;
                Zotero.debug('[Patent] Found PDF iframe: ' + fullUrl);
                return fullUrl;
            }
        }

        // 方法4: 从 JavaScript 中提取 PDF URL
        const scriptMatches = html.match(/["']([^"']*\.pdf[^"']*)["']/gi);
        if (scriptMatches) {
            for (const match of scriptMatches) {
                const urlMatch = match.match(/["']([^"']+\.pdf[^"']*)["']/i);
                if (urlMatch && urlMatch[1]) {
                    const fullUrl = urlMatch[1].startsWith('http')
                        ? urlMatch[1]
                        : `http://epub.cnipa.gov.cn${urlMatch[1]}`;
                    Zotero.debug('[Patent] Found PDF in script: ' + fullUrl);
                    return fullUrl;
                }
            }
        }

        // 方法5: 尝试解析公开号构建PDF URL (某些专利可以这样构建)
        const pubNumMatch = detailUrl.match(/([A-Z]{2}\d+[A-Z]?\d*)/i);
        if (pubNumMatch) {
            const pubNum = pubNumMatch[1].toUpperCase();
            // 尝试构建PDF URL - 格式可能需要根据实际调整
            const pdfUrl = `http://epub.cnipa.gov.cn/CN/patent/${pubNum}/pdf/`;
            Zotero.debug('[Patent] Trying constructed PDF URL: ' + pdfUrl);
            // 先检查是否存在
            try {
                const testRes = await fetch(pdfUrl, { method: 'HEAD' });
                if (testRes.ok) {
                    return pdfUrl;
                }
            } catch {}
        }

        Zotero.debug('[Patent] No PDF URL found on page');
    } catch (e) {
        Zotero?.debug?.('[Patent] fetchPatentDetailPdfUrl failed: ' + e);
    }

    return undefined;
}

export async function openCnipaBrowser(searchTitle) {
    Zotero.debug('[Patent] === START ===');
    if (_running) {
        Zotero.debug('[Patent] 正在运行中，跳过重复执行');
        return true;
    }
    _running = true;
    var _keepBrowser = false;

    try {
        Zotero.debug('[Patent] 启动浏览器 CDP 自动化...');
        if (!(await cdp.launchBrowser())) {
            Zotero.debug('[Patent] 启动浏览器失败');
            return true;
        }

        Zotero.debug('[Patent] 连接 CDP...');
        var baseUrl = 'http://epub.cnipa.gov.cn';
        var connected = false;
        for (var r = 0; r < 5; r++) {
            if (await cdp.connectCDP()) {
                connected = true;
                break;
            }
            Zotero.debug('[Patent] 重试 CDP 连接 (' + (r + 1) + '/5)...');
            await new Promise(function (q) {
                setTimeout(q, 2000);
            });
        }
        if (!connected) {
            Zotero.debug('[Patent] CDP 连接失败');
            return true;
        }

        // ---- 使用空白页打开 CNIPA 首页（不创建新标签页）----
        Zotero.debug('[Patent] 附加到标签页...');
        var attached = await cdp.findCnipaTabAndAttach();
        if (!attached) {
            attached = await cdp.attachToFirstTab();
        }
        if (attached) {
            await cdp.navigateTo('http://epub.cnipa.gov.cn/');
        } else {
            Zotero.debug('[Patent] 无可用标签页，创建新标签页');
            await cdp.createTab('http://epub.cnipa.gov.cn/');
        }

        // 等待首页加载完成（反爬虫挑战）
        Zotero.debug('[Patent] 等待页面就绪...');
        for (var w2 = 0; w2 < 40; w2++) {
            await sleep(250);
            try {
                var st = await cdp.evaluateJS(
                    '(function(){var h=(document.body||document.documentElement).innerHTML||"";if(h.indexOf("$_ts")>=0)return "CHALLENGE";if(h.indexOf("indexForm")>=0||h.indexOf("searchStr")>=0)return "READY";return h.length<100?"EMPTY":"OTHER";})()',
                );
                if (st === 'READY') {
                    Zotero.debug('[Patent] 首页就绪');
                    break;
                }
                if (st === 'CHALLENGE') Zotero.debug('[Patent] 反爬虫挑战进行中...');
            } catch (_) {}
        }

        if (!searchTitle) {
            showNotification('浏览器已打开');
            _keepBrowser = true;
            return true;
        }

        // ---- 在搜索前保存首页的 CSRF token（后续 /Sw/SwDetail POST 可能需要）----
        var homeCsrfToken = await cdp.evaluateJS(
            '(function(){var t=document.querySelector("input[name=\'__RequestVerificationToken\']");return t?t.value:"";})()',
        );
        Zotero.debug('[Patent] 首页 CSRF token: ' + (homeCsrfToken ? 'found' : 'not found'));

        // ---- 在首页搜索框中填入专利标题，确认值已设置 ----
        Zotero.debug('[Patent] 在首页搜索框输入: ' + searchTitle);
        var inputOk = '';
        for (var inRetry = 0; inRetry < 20; inRetry++) {
            if (!cdp.isConnected()) {
                Zotero.debug('[Patent] 浏览器已关闭');
                throw new Error('BROWSER_CLOSED');
            }
            inputOk = await cdp.evaluateJS(
                '(function(){var e=document.getElementById("searchStr");if(!e)return "NO_INPUT";' +
                    'e.value=' +
                    JSON.stringify(searchTitle) +
                    ';' +
                    'e.dispatchEvent(new Event("input",{bubbles:true}));' +
                    'e.dispatchEvent(new Event("change",{bubbles:true}));' +
                    'e.dispatchEvent(new KeyboardEvent("keyup",{bubbles:true,key:"Enter"}));' +
                    'return "OK value="+e.value;})()',
            );
            Zotero.debug('[Patent] 输入结果: ' + inputOk);
            if (inputOk && inputOk.indexOf('NO_INPUT') < 0) break;
            Zotero.debug('[Patent] 搜索框未就绪，等待重试...');
            await sleep(1000);
        }
        if (!inputOk || inputOk.indexOf('NO_INPUT') >= 0) {
            Zotero.debug('[Patent] 搜索框未找到，无法搜索');
            showNotification('CNIPA 首页未正常加载');
            return true;
        }

        // ---- 自然表单提交，让浏览器导航到 /Dxb/IndexQuery ----
        Zotero.debug('[Patent] 提交首页搜索（自然导航）...');
        await cdp.evaluateJS('(function(){var f=document.getElementById("indexForm");if(f)f.submit();})()');
        // 等待页面导航到 /Dxb/IndexQuery 并加载完成
        Zotero.debug('[Patent] 等待搜索结果页面...');
        var rows: Array<{ an: string; pt: string; ggr: string; ctx: string }> | null = null;
        for (var wi = 0; wi < 60; wi++) {
            await sleep(1000);
            try {
                var loc = await cdp.evaluateJS('window.location.href');
                if (!loc || loc.indexOf('IndexQuery') < 0) continue;
            } catch (_) {
                continue; // 导航中可能短暂断开
            }
            try {
                var check = await cdp.evaluateJS(
                    [
                        '(function(){',
                        'var e=document.querySelectorAll("[onclick*=\\"zl_xm\\"]");',
                        'if(e.length>0){var o=[];for(var j=0;j<e.length;j++){var c=e[j].getAttribute("onclick")||"";var p=c.match(/\\x27([^\\x27]+)\\x27/g)||[];var el=e[j];var x="";for(var t=0;t<5&&el.parentElement;t++){el=el.parentElement;x+=(el.textContent||"").replace(/\\s+/g," ");}o.push({an:(p[0]||"").replace(/\\x27/g,""),pt:(p[1]||"").replace(/\\x27/g,""),ggr:(p[2]||"").replace(/\\x27/g,""),ctx:x.substring(0,300)});}return JSON.stringify({s:1,d:o});}',
                        'return JSON.stringify({s:0});',
                        '})()',
                    ].join('\n'),
                );
                if (check) {
                    var pd = JSON.parse(check);
                    if (pd.s === 1) {
                        rows = pd.d;
                        Zotero.debug('[Patent] 找到 ' + rows.length + ' 条搜索结果 (zl_xm)');
                        break;
                    }
                }
            } catch (_) {}
        }

        if (!rows || rows.length === 0) {
            Zotero.debug('[Patent] 首页搜索未找到结果');
            try {
                var finalHtml = await cdp.evaluateJS(
                    'JSON.stringify({url:location.href,title:document.title,hlen:(document.body||document.documentElement).innerHTML.length,html:(document.body||document.documentElement).innerHTML.substring(0,5000)})',
                );
                Zotero.debug('[Patent] 最终页面状态: ' + finalHtml);
            } catch (_) {}
            showNotification('未找到搜索结果，请在浏览器中手动操作');
            return true;
        }

        // 匹配关键词
        var kw = searchTitle.replace(/\s+/g, '');
        var match = rows[0];
        var matchIdx = 0;
        for (var ri = 0; ri < rows.length; ri++) {
            if ((rows[ri].ctx || '').replace(/\s+/g, '').indexOf(kw) >= 0) {
                match = rows[ri];
                matchIdx = ri;
                break;
            }
        }
        Zotero.debug('[Patent] 匹配结果: an=' + match.an + ', idx=' + matchIdx);

        // ---- 步骤4: 等待搜索结果页面稳定后，鼠标点击导航到 SwDetail ----
        var pdfUrl = null;
        Zotero.debug('[Patent] 等待后直接鼠标点击打开 SwDetail...');
        await sleep(1500);
            Zotero.debug('[Patent] XHR 未获取到 PDF URL，尝试鼠标点击打开 SwDetail...');
            try {
                await cdp.evaluateJS(
                    '(function(){var e=document.querySelectorAll("[onclick*=\\"zl_xm\\"]");' +
                        'if(e&&e[' +
                        matchIdx +
                        ']){e[' +
                        matchIdx +
                        '].scrollIntoView({block:"center"});return true;}return false;})()',
                );
                await sleep(500);
                var clicked = await cdp.clickElementRealByIndex('[onclick*="zl_xm"]', matchIdx);
                Zotero.debug('[Patent] 鼠标点击结果: ' + clicked);
            } catch (e) {
                Zotero.debug('[Patent] 鼠标点击异常: ' + e);
            }
            for (var dw = 0; dw < 15; dw++) {
                await sleep(1000);
                var curUrl = '';
                try {
                    curUrl = await cdp.evaluateJS('window.location.href');
                } catch (_) {}
                if (curUrl.indexOf('SwDetail') < 0) {
                    try {
                        var switched = await cdp.findCnipaTabAndAttach();
                        if (switched) {
                            var nu = await cdp.evaluateJS('window.location.href');
                            if (nu.indexOf('SwDetail') >= 0) curUrl = nu;
                        }
                    } catch (_) {}
                }
                if (curUrl && curUrl.indexOf('SwDetail') >= 0) {
                    // 等待 SwDetail 页面加载完毕
                    for (var w3 = 0; w3 < 8; w3++) {
                        try {
                            var readyState = await cdp.evaluateJS('document.readyState');
                            if (readyState === 'complete') break;
                        } catch (_) {}
                        await sleep(500);
                    }
                    for (var w3 = 0; w3 < 6; w3++) {
                        try {
                            var bodyLenCheck = await cdp.evaluateJS('document.body?document.body.innerHTML.length:0');
                            if (bodyLenCheck > 100) break;
                        } catch (_) {}
                        await sleep(500);
                    }
                    // 诊断：查看 SwDetail 页面状态，如果空白则回退到 IndexQuery POST 方式
                    try {
                        var diag = await cdp.evaluateJS(
                            'JSON.stringify({url:location.href,title:document.title,hLen:(document.body?document.body.innerHTML.length:0),dLen:(document.documentElement?document.documentElement.outerHTML.length:0),ready:document.readyState})',
                        );
                        Zotero.debug('[Patent] SwDetail 诊断: ' + diag);
                        try {
                            var diagJson = JSON.parse(diag || '{}');
                            if (
                                diagJson.url &&
                                diagJson.url.indexOf('SwDetail') >= 0 &&
                                (!diagJson.title || diagJson.hLen < 120)
                            ) {
                                Zotero.debug(
                                    '[Patent] SwDetail 可能为空白页，回退到查询结果页并尝试 POST 提交打开 SwDetail',
                                );
                                var indexAttached = await cdp.findCnipaIndexQueryTabAndAttach();
                                if (indexAttached) {
                                    await sleep(500);
                                    var postSwDetail = await cdp.evaluateJS(
                                        '(function(){try{var f=document.createElement("form");f.method="POST";f.action="http://epub.cnipa.gov.cn/Sw/SwDetail";f.style.display="none";var fn=function(n,v){var i=document.createElement("input");i.type="hidden";i.name=n;i.value=v;f.appendChild(i);};fn("an",' +
                                            JSON.stringify(match.an) +
                                            ');fn("pubType",' +
                                            JSON.stringify(match.pt) +
                                            ');fn("ggr",' +
                                            JSON.stringify(match.ggr) +
                                            ');fn("trsSql","");var ti=document.querySelector("input[name=\"__RequestVerificationToken\"]");if(ti){fn("__RequestVerificationToken",ti.value);}document.body.appendChild(f);f.submit();return true;}catch(e){return false;}})()',
                                    );
                                    Zotero.debug('[Patent] POST 提交 SwDetail 结果: ' + postSwDetail);
                                    var patentTypeReady = false;
                                    for (var waitIndex = 0; waitIndex < 20; waitIndex++) {
                                        await sleep(500);
                                        try {
                                            var readyState = await cdp.evaluateJS('document.readyState');
                                            var bodyLen = await cdp.evaluateJS(
                                                'document.body?document.body.innerText.length:0',
                                            );
                                            var hasPatentType = await cdp.evaluateJS(
                                                '(function(){if(document.querySelector("input[value=\\"FM\\\"], input[name*=\\"patentType\\\"][value*=\\"FM\\\"], .patent-type-fm")) return true; var elems=document.querySelectorAll("button,a,div,span,label"); for(var i=0;i<elems.length;i++){var txt=(elems[i].textContent||elems[i].value||"").trim(); if(txt.indexOf("发明专利")>=0) return true;} return false;})()',
                                            );
                                            if (readyState === 'complete' && bodyLen > 200 && hasPatentType) {
                                                patentTypeReady = true;
                                                break;
                                            }
                                        } catch (_) {}
                                    }
                                    if (!patentTypeReady) {
                                        Zotero.debug('[Patent] 查询结果页加载稳定超时，仍未找到发明专利入口');
                                    }
                                    var patentTypeClicked = await cdp.evaluateJS(
                                        '(function(){function clickElem(el){try{if(el.scrollIntoView){el.scrollIntoView({block:"center"});}el.click();return true;}catch(e){return false;}}var sel = document.querySelector("input[value=\\"FM\\\"], input[name*=\\"patentType\\\"][value*=\\"FM\\\"], .patent-type-fm"); if(sel){return clickElem(sel);} var elems=document.querySelectorAll("button,a,div,span,label"); for(var i=0;i<elems.length;i++){var txt=(elems[i].textContent||elems[i].value||"").trim(); if(txt.indexOf("发明专利")>=0){ if(elems[i].offsetParent!==null||elems[i].getBoundingClientRect().width||elems[i].getBoundingClientRect().height){return clickElem(elems[i]);}}} return false;})()',
                                    );
                                    Zotero.debug('[Patent] 发明专利按钮点击结果: ' + patentTypeClicked);
                                    if (patentTypeClicked) {
                                        for (var retry = 0; retry < 20; retry++) {
                                            await sleep(1000);
                                            try {
                                                var newUrl = await cdp.evaluateJS('window.location.href');
                                                var bodyLen = await cdp.evaluateJS(
                                                    'document.body?document.body.innerHTML.length:0',
                                                );
                                                if (newUrl && newUrl.indexOf('SwDetail') >= 0 && bodyLen > 120) {
                                                    Zotero.debug('[Patent] 发明专利点击后发现 SwDetail 页: ' + newUrl);
                                                    break;
                                                }
                                            } catch (_) {}
                                            await cdp.findCnipaTabAndAttach();
                                        }
                                    }
                                }
                            }
                        } catch (e) {
                            Zotero.debug('[Patent] 解析 SwDetail 诊断失败: ' + e);
                        }
                    } catch (e) {
                        Zotero.debug('[Patent] SwDetail 诊断失败: ' + e);
                    }
                    // Hook AJAX 事件：捕获验证码响应和 CheckVcode 结果 + fetch 拦截
                    try {
                        await cdp.evaluateJS(
                            'window.__capLogger={requests:[],fetch:[],errors:[],xhrError:[]};' +
                                'window.__capDiag={};' +
                                'window.__capCaptchaJson=null;' +
                                'window.__filedlUrl="";' +
                                'window.__capDlPath="";' +
                                '(function(){if(window.__capXHRPatched)return;var oldOpen=XMLHttpRequest.prototype.open;var oldSend=XMLHttpRequest.prototype.send;XMLHttpRequest.prototype.open=function(m,u){this.__capUrl=u;return oldOpen.apply(this,arguments);};XMLHttpRequest.prototype.send=function(b){try{if(this.__capUrl){window.__capLogger.requests.push({url:this.__capUrl,body:b?b.toString():""});}}catch(e){window.__capLogger.errors.push("xhrlog:"+e.message);}return oldSend.apply(this,arguments);};window.__capXHRPatched=true;})();' +
                                '(function(){if(window.__capFetchPatched)return;var oldFetch=window.fetch;window.fetch=function(input,init){var url=(typeof input=="string"?input:(input&&input.url?input.url:""));try{window.__capLogger.fetch.push({url:url,init:init?JSON.stringify(init).substring(0,300):""});}catch(e){window.__capLogger.errors.push("fetchlog:"+e.message);}var p=oldFetch.apply(this,arguments);if(!p||!p.then)return p;return p.then(function(resp){try{if(url&&(url.indexOf("Captcha")>=0||url.indexOf("CheckCaptcha")>=0)){var clone=resp.clone();clone.text().then(function(text){try{window.__capDiag={stage:"fetch",url:url,text:text.substring(0,500)};}catch(e){};try{var j=JSON.parse(text);if(j){var s=j.captchaStr||j.captchaImgStr||j.captcha||"";if(s){var v=document.getElementById("vcodeStr");if(v){v.value=s;}}if(j.captchaStr||j.captchaImgStr||j.captcha){window.__capCaptchaJson=j;}if(j.refer){window.__filedlUrl=j.refer;}if(j.result){window.__filedlUrl=j.result;}}}catch(e){window.__capLogger.errors.push("fetchParse:"+e.message);}});}catch(e){window.__capLogger.errors.push("fetchResp:"+e.message);}return resp;});};window.__capFetchPatched=true;})();' +
                                '$(document).ajaxSuccess(function(e,xhr,settings){' +
                                'var url=settings.url||"";window.__capLogger.requests.push({url:url,body:JSON.stringify(settings).substring(0,300)});' +
                                'if(url.indexOf("Captcha")>=0||url.indexOf("CheckCaptcha")>=0){' +
                                'window.__capDiag={stage:"success",text:(xhr.responseText||"").substring(0,500)};try{var _t=xhr.responseText||"";var _j;try{_j=JSON.parse(_t);}catch(e){_j=null;}if(_j){var s=_j.captchaStr||_j.captchaImgStr||_j.captcha||"";if(s){var v=document.getElementById("vcodeStr");if(v){v.value=s;}}if(_j.captchaStr||_j.captchaImgStr||_j.captcha){window.__capCaptchaJson=_j;}if(_j.refer){window.__filedlUrl=_j.refer;}if(_j.result){window.__filedlUrl=_j.result;}}}catch(e){window.__capLogger.errors.push("successParse:"+e.message);} }' +
                                '});' +
                                '$(document).ajaxError(function(e,xhr,settings,error){window.__capLogger.xhrError.push({url:settings.url||"",status:xhr.status,error:error||""});});',
                        );
                    } catch (_) {}
                    // Hook openTips 捕获 dlPath，但不阻止原始函数执行（让页面正常显示验证码并初始化会话）
                    try {
                        await cdp.evaluateJS(
                            '(function(){if(typeof openTips==="function" && !window.__capOpenTipsPatched){' +
                                'var oldOpenTips=openTips; window.openTips=function(dlPath){window.__capDlPath=dlPath; return oldOpenTips.apply(this,arguments);};' +
                                'window.__capOpenTipsPatched=true;} })()',
                        );
                    } catch (_) {}
                    // 注入验证码自动求解器（定时重试）
                    try {
                        await cdp.evaluateJS(
                            '(function(){' +
                                'function __tryRefreshCaptcha(){try{if(typeof refresh=="function"){var ok=refresh();if(!ok){window.__capLogger.errors.push("refresh:returned-false");}return ok;}window.__capLogger.errors.push("refresh:not-defined");return false;}catch(e){window.__capLogger.errors.push("refresh:"+e.message);return false;}}' +
                                'function __trySolveCaptcha(){try{' +
                                'var v=document.getElementById("vcodeStr")?document.getElementById("vcodeStr").value:"";' +
                                'if(!v && window.__capCaptchaJson){' +
                                'var s=window.__capCaptchaJson.captchaStr||window.__capCaptchaJson.captchaImgStr||window.__capCaptchaJson.captcha||"";' +
                                'if(s){v=s;}}' +
                                'var ans=null;' +
                                'if(v){var m=v.match(/(\\d+)\\s*([+\\-])\\s*(\\d+)/);if(!m){try{m=decodeURIComponent(v).match(/(\\d+)\\s*([+\\-])\\s*(\\d+)/);}catch(e){}}if(m){var aa=parseInt(m[1],10),bb=parseInt(m[3],10);ans=(m[2]=="+")?aa+bb:aa-bb;}}' +
                                'if(ans===null){var txt=document.body?document.body.textContent||"":"";var mt=txt.match(/(\\d+)\\s*([+\\-])\\s*(\\d+)\\s*=/);if(mt){ans=(mt[2]=="+")?parseInt(mt[1],10)+parseInt(mt[3],10):parseInt(mt[1],10)-parseInt(mt[3],10);}}' +
                                'if(ans!==null){var inp=document.getElementById("vcode")||document.querySelector("input[type=text],input:not([type])");if(inp){inp.value=ans;var oks=document.querySelectorAll("button,a,input[type=button]");for(var i=0;i<oks.length;i++){var t=(oks[i].textContent||oks[i].value||"").toLowerCase();if(t.indexOf("确定")>=0){try{oks[i].click();}catch(e){window.__capLogger.errors.push("clickOK:"+e.message);}break;}}}}}catch(e){window.__capLogger.errors.push("trySolveCaptcha:"+e.message);}}' +
                                'if(!window.__capSolverTimer){window.__capSolverTimer=setInterval(function(){__trySolveCaptcha();},800);}' +
                                '})()',
                        );
                    } catch (_) {}
                    // 获取 dlPath：从 #dlpdf 链接或所有 openTips 链接中提取
                    try {
                        await cdp.evaluateJS(
                            '(function(){' +
                                'var e=document.getElementById("dlpdf");if(e){var href=e.getAttribute("href")||e.href||"";var mm=href.match(/openTips\\(["\']([^"\']+)["\']\\)/);if(mm)window.__capDlPath=mm[1];}' +
                                'if(!window.__capDlPath){var links=document.querySelectorAll("a");for(var i=0;i<links.length;i++){var h2=links[i].getAttribute("href")||links[i].href||"";if(h2.indexOf("openTips(")>=0){var mm2=h2.match(/openTips\\(["\']([^"\']+)["\']\\)/);if(mm2){window.__capDlPath=mm2[1];break;}}}}' +
                                'return !!window.__capDlPath;})()',
                        );
                    } catch (_) {}
                    // 注入 CheckCaptcha 直调回退
                    try {
                        await cdp.evaluateJS(
                            '(function(){' +
                                'window.__capSubmitCaptcha=function(){try{' +
                                'var v=document.getElementById("vcode")?document.getElementById("vcode").value:"";' +
                                'if(!v){var vs=(document.getElementById("vcodeStr")||{}).value||"";if(!vs && window.__capCaptchaJson){vs=window.__capCaptchaJson.captchaStr||window.__capCaptchaJson.captchaImgStr||window.__capCaptchaJson.captcha||"";}var m=vs.match(/(\\d+)\\s*([+\\-])\\s*(\\d+)/);if(m){v=(m[2]=="+")?((parseInt(m[1],10)+parseInt(m[3],10)).toString()):((parseInt(m[1],10)-parseInt(m[3],10)).toString());}var txt=document.body?document.body.textContent||"":"";var mt=txt.match(/(\\d+)\\s*([+\\-])\\s*(\\d+)\\s*=/);if(!v && mt){v=(mt[2]=="+")?((parseInt(mt[1],10)+parseInt(mt[3],10)).toString()):((parseInt(mt[1],10)-parseInt(mt[3],10)).toString());}}' +
                                'var dlPath=window.__capDlPath||"";var cacheId=(document.getElementById("cacheId")||{}).value||"";' +
                                'if(!v||!dlPath||!cacheId)return JSON.stringify({ok:false,reason:"missing",v:!!v,dlPath:!!dlPath,cacheId:!!cacheId});' +
                                'try{var xhr=new XMLHttpRequest();var url="http://egaz.cnipa.gov.cn/CheckCaptcha?vcodeInput="+encodeURIComponent(v)+"&dlpath="+encodeURIComponent(dlPath)+"&id="+encodeURIComponent(cacheId);xhr.open("GET",url,false);xhr.withCredentials=true;xhr.send(null);var txt=xhr.responseText||"";if(txt&&txt!=="fail"){window.__filedlUrl="http://egaz.cnipa.gov.cn/filedl?path="+txt;return JSON.stringify({ok:true,path:txt});}return JSON.stringify({ok:false,reason:"fail",txt:txt});}catch(e){return JSON.stringify({ok:false,reason:e.message});}};return true;})()',
                        );
                    } catch (_) {}
                    // 用真实鼠标点击"下载PDF"按钮，触发挑战框
                    var dlBtnSet = await cdp.evaluateJS(
                        '(function(){var btns=document.querySelectorAll("button,a,input[type=button]");' +
                            'for(var i=0;i<btns.length;i++){' +
                            'var bt=(btns[i].textContent||btns[i].value||"").toLowerCase();' +
                            'if(bt.indexOf("\u4e0b\u8f7d")>=0||bt.indexOf("pdf")>=0){' +
                            'btns[i].id="_patent_dl_btn";return true;}}return false;})()',
                    );
                    if (dlBtnSet) {
                        await cdp.clickElementReal('#_patent_dl_btn');
                        await sleep(1500);
                        await cdp.evaluateJS('if(typeof refresh==="function"){refresh();}');
                        // 强制显示验证码浮层（openTips 被拦截后页面不会自动显示）
                        await cdp.evaluateJS(
                            '(function(){["tipsDiv","vcodePanel","codePanel","captchaPanel","capPanel"].forEach(function(id){var e=document.getElementById(id);if(e){e.style.display="block";e.style.visibility="visible";e.style.opacity="1";e.style.zIndex="9999";}});return true;})()',
                        );
                        for (var rr = 0; rr < 10; rr++) {
                            await sleep(1000);
                            var capValue = await cdp.evaluateJS(
                                '(function(){var v=document.getElementById("vcodeStr")?document.getElementById("vcodeStr").value:"";if(v)return v;if(window.__capCaptchaJson)return window.__capCaptchaJson.captchaStr||window.__capCaptchaJson.captchaImgStr||window.__capCaptchaJson.captcha||"";var y=document.getElementById("yzm");if(y&&y.src&&y.src.indexOf("base64,")>=0)return y.src;return "";})()',
                            );
                            if (capValue) break;
                            if (rr === 4) {
                                await cdp.evaluateJS('if(typeof refresh==="function"){refresh();}');
                            }
                        }
                    }
                    await sleep(500);
                    try {
                        var diag2 = await cdp.evaluateJS(
                            'JSON.stringify({url:location.href,vcodeStrExists:!!document.getElementById("vcodeStr"),vcodeStrVal:(function(){try{return (document.getElementById("vcodeStr")||{}).value.substring(0,200);}catch(e){return "";}})(),cacheId:(function(){try{return (document.getElementById("cacheId")||{}).value||"";}catch(e){return "";}})(),yzmSrc:(function(){try{return (document.getElementById("yzm")||{}).src||"";}catch(e){return "";}})(),capDiagText:(function(){try{return (window.__capDiag&&window.__capDiag.text)?window.__capDiag.text.substring(0,500):"";}catch(e){return "";}})(),capCaptchaJson:(function(){try{return window.__capCaptchaJson?{captchaStr:window.__capCaptchaJson.captchaStr||"",cacheId:window.__capCaptchaJson.cacheId||""}:null;}catch(e){return null;}})(),tipsDivExists:!!document.getElementById("tipsDiv"),dlPath:(function(){try{return window.__capDlPath||"";}catch(e){return "";}})(),capLogger:(function(){try{return {reqs:window.__capLogger&&window.__capLogger.requests?window.__capLogger.requests.slice(-3):[],fetch:window.__capLogger&&window.__capLogger.fetch?window.__capLogger.fetch.slice(-3):[],errs:window.__capLogger&&window.__capLogger.errors?window.__capLogger.errors.slice(-3):[],xhrErr:window.__capLogger&&window.__capLogger.xhrError?window.__capLogger.xhrError.slice(-3):[]};}catch(e){return {};} })(),title:document.title,bodyLen:(document.body?document.body.innerHTML.length:0)})',
                        );
                        Zotero.debug('[Patent] 点击下载后诊断: ' + diag2);
                    } catch (_) {}
                    Zotero.debug('[Patent] 检测到验证码，显示手动输入对话框');
                    try {
                        var yzmSrc2 = await cdp.evaluateJS(
                            '(function(){var y=document.getElementById("yzm");return y?y.src:"";})()',
                        );
                        if (yzmSrc2 && yzmSrc2.indexOf('base64,') >= 0) {
                            var userAnswer = await showCaptchaDialog(yzmSrc2);
                            if (userAnswer) {
                                Zotero.debug('[Patent] 用户已输入验证码: ' + userAnswer);
                                Zotero.debug('[Patent] 通过 CheckCaptcha API 直调提交验证码...');
                                var capResult = await cdp.evaluateJS(
                                    '(function(){try{' +
                                        'var v=' + JSON.stringify(userAnswer) + ';' +
                                        'var dlPath=window.__capDlPath||"";' +
                                        'var cacheId=(document.getElementById("cacheId")||{}).value||"";' +
                                        'if(!v||!dlPath||!cacheId)return JSON.stringify({ok:false,reason:"missing",v:!!v,dlPath:!!dlPath,cacheId:!!cacheId});' +
                                        'var xhr=new XMLHttpRequest();' +
                                        'var url="http://egaz.cnipa.gov.cn/CheckCaptcha?vcodeInput="+encodeURIComponent(v)+"&dlpath="+encodeURIComponent(dlPath)+"&id="+encodeURIComponent(cacheId);' +
                                        'xhr.open("GET",url,false);xhr.withCredentials=true;xhr.send(null);' +
                                        'var txt=(xhr.responseText||"").trim();' +
                                        'if(txt&&txt!=="fail"){return JSON.stringify({ok:true,path:txt});}' +
                                        'return JSON.stringify({ok:false,reason:"fail",txt:txt,status:xhr.status});' +
                                        '}catch(e){return JSON.stringify({ok:false,reason:"error",msg:e.message});}})()',
                                    true,
                                );
                                if (capResult) {
                                    var capData = JSON.parse(capResult);
                                    Zotero.debug('[Patent] CheckCaptcha 结果: ' + JSON.stringify(capData));
                                    if (capData.ok && capData.path) {
                                        pdfUrl = 'http://egaz.cnipa.gov.cn/filedl?path=' + capData.path;
                                        Zotero.debug('[Patent] 获取到 PDF URL: ' + pdfUrl);
                                        dw = 15;
                                        break;
                                    } else {
                                        Zotero.debug('[Patent] CheckCaptcha 失败: ' + (capData.reason || '未知') + (capData.txt ? ', txt=' + capData.txt : ''));
                                        var origDlPath = await cdp.evaluateJS('window.__capDlPath||""');
                                        if (origDlPath) {
                                            pdfUrl = 'http://egaz.cnipa.gov.cn/filedl?path=' + encodeURIComponent(origDlPath);
                                            Zotero.debug('[Patent] 使用原始 dlPath 尝试: ' + pdfUrl);
                                        }
                                    }
                                } else {
                                    Zotero.debug('[Patent] CheckCaptcha 调用无返回');
                                }
                            } else {
                                Zotero.debug('[Patent] 用户取消了验证码输入');
                            }
                        }
                    } catch (_) {}
                }
            }
        if (pdfUrl) {
            Zotero.debug('[Patent] 获取到 PDF URL: ' + pdfUrl);
        } else {
            Zotero.debug('[Patent] 未获取到 PDF URL');
        }

        Zotero.debug('[Patent] === END ===');
        _keepBrowser = !!pdfUrl;
        return pdfUrl || true;
    } catch (e) {
        Zotero.debug('[Patent] CDP 自动化异常: ' + e);
        return true;
    } finally {
        _running = false;
        if (!_keepBrowser) {
            try {
                await cdp.quitBrowser();
            } catch (_) {}
        }
    }
}

/**
 * 使用 CDP 浏览器自动化获取 PDF 下载地址
 * 返回 PDF URL 或 undefined
 */
export async function cnipaGetPdfUrlViaCdp(searchTitle: string): Promise<string | undefined> {
    try {
        Zotero.debug('[Patent] CDP: 开始自动化获取 PDF URL: ' + searchTitle);
        const result = await openCnipaBrowser(searchTitle);
        // openCnipaBrowser 返回字符串(PDF URL)或 true(其他情况)
        if (typeof result === 'string' && result.startsWith('http')) {
            Zotero.debug('[Patent] CDP: 成功获取 PDF URL: ' + result);
            return result;
        }
        Zotero.debug('[Patent] CDP: 未能获取到 PDF URL');
        return undefined;
    } catch (e) {
        Zotero.debug('[Patent] CDP: 获取 PDF URL 异常: ' + e);
        return undefined;
    }
}

/**
 * 使用 CDP 浏览器上下文下载 PDF（浏览器有 CNIPA 的 cookies/会话）
 * 返回下载后的文件路径，失败返回 null
 */
export async function downloadPdfViaCdp(url: string, savePath: string): Promise<string | null> {
    try {
        Zotero.debug('[Patent] CDP 下载 PDF, URL: ' + url);
        if (url.indexOf('filedl') >= 0) {
            Zotero.debug('[Patent] filedl URL 直接下载');
            return await fetchPdfViaCdp(url, savePath);
        }
        Zotero.debug('[Patent] showpdf URL，导航找链接...');
        await cdp.navigateTo(url);
        for (var dw = 0; dw < 30; dw++) {
            await sleep(1000);
            try {
                var bl = await cdp.evaluateJS(
                    '(function(){try{var h=document.documentElement.outerHTML||"";if(h.length<100)return "loading";' +
                        'var la=document.querySelectorAll("a[href*=\\\"filedl\\\"],a[href*=\\\"showpdf\\\"],a[href*=\\\"egaz\\\"]");' +
                        'if(la.length>0)return "URL:"+la[0].href;' +
                        'var btns=document.querySelectorAll("button");' +
                        'for(var bi=0;bi<btns.length;bi++){var bt=(btns[bi].textContent||btns[bi].value||"").toLowerCase();' +
                        'if(bt.indexOf("\\u4e0b\\u8f7d")>=0||bt.indexOf("pdf")>=0)return "BTN:"+bi;}' +
                        'return "ready";})()',
                );
                Zotero.debug('[Patent] showpdf 页面状态: ' + bl);
                if (typeof bl === 'string' && bl.startsWith('URL:')) {
                    // 找到了 filedl 链接
                    var dlUrl = bl.substring(4);
                    Zotero.debug('[Patent] 从页面提取到下载链接: ' + dlUrl);
                    return await fetchPdfViaCdp(dlUrl, savePath);
                }
                if (typeof bl === 'string' && bl.startsWith('BTN:')) {
                    // 有下载按钮，点击它
                    var btnIdx = parseInt(bl.substring(4), 10);
                    Zotero.debug('[Patent] 点击下载按钮 index=' + btnIdx);
                    await cdp.clickElementRealByIndex('button', btnIdx);
                    // 等待新标签页打开
                    await sleep(3000);
                    var switched = await cdp.findCnipaTabAndAttach();
                    if (switched) {
                        var newUrl = await cdp.evaluateJS('window.location.href');
                        Zotero.debug('[Patent] 按钮点击后新标签页: ' + newUrl);
                        if (newUrl && newUrl.indexOf('filedl') >= 0) {
                            return await fetchPdfViaCdp(newUrl, savePath);
                        }
                    }
                    return null;
                }
                if (bl === 'ready') break;
            } catch (_) {}
        }
        // Step 2: 如果页面中没有直接链接，尝试从 JavaScript 变量或 showPage 响应中获取
        Zotero.debug('[Patent] 页面无直接链接，尝试 JS 提取...');
        var dlUrl2 = await cdp.evaluateJS(
            '(function(){' +
                'try{var w=window;for(var k in w){try{var v=w[k];if(v&&typeof v==="string"&&v.indexOf("filedl")>=0)return v;}catch(_){}}' +
                'var els=document.querySelectorAll("[onclick]");' +
                'for(var ei=0;ei<els.length;ei++){var oc=els[ei].getAttribute("onclick");' +
                'if(oc&&oc.indexOf("filedl")>=0){var m=oc.match(/https?:\\/\\/[^"\'\\s]*filedl[^"\'\\s]*/);if(m)return m[0];}}' +
                'return null;})()',
        );
        if (dlUrl2) {
            Zotero.debug('[Patent] JS 提取到下载链接: ' + dlUrl2);
            return await fetchPdfViaCdp(dlUrl2, savePath);
        }
        Zotero.debug('[Patent] showpdf 页面未找到下载链接');
        return null;
    } catch (e) {
        Zotero.debug('[Patent] downloadPdfViaCdp error: ' + e);
        return null;
    }
}

/**
 * 在 CDP 浏览器页面中 fetch 当前 URL 的 PDF 二进制数据
 */
async function fetchPdfViaCdp(fetchUrl: string, savePath: string): Promise<string | null> {
    try {
        Zotero.debug('[Patent] fetchPdfViaCdp: ' + fetchUrl);
        await cdp.navigateTo(fetchUrl);
        for (var fw = 0; fw < 20; fw++) {
            await sleep(1000);
            try {
                var ready = await cdp.evaluateJS(
                    '(function(){var h=document.documentElement.outerHTML||"";' +
                        'return h.length<100?"loading":"ready";})()',
                );
                if (ready === 'ready') break;
            } catch (_) {}
        }
        var b64 = await cdp.evaluateJS(
            '(async function(){try{' +
                'var r=await fetch("' +
                fetchUrl +
                '",{credentials:"include"});' +
                'if(!r.ok)return "ERROR:"+r.status;' +
                'var b=await r.blob();' +
                'return new Promise(function(q){' +
                'var f=new FileReader();' +
                'f.onload=function(){var d=f.result;var i=d.indexOf(",");q(i>=0?d.substring(i+1):"ERROR:bad")};' +
                'f.onerror=function(){q("ERROR:reader")};' +
                'f.readAsDataURL(b);' +
                '})}catch(e){return "ERROR:"+e.message}})()',
            true,
        );
        if (typeof b64 !== 'string' || b64.startsWith('ERROR:')) {
            Zotero.debug('[Patent] fetchPdfViaCdp 失败: ' + (typeof b64 === 'string' ? b64 : '类型错误'));
            return null;
        }
        var raw = atob(b64);
        var bytes = [];
        for (var bi = 0; bi < raw.length; bi++) bytes.push(raw.charCodeAt(bi));
        var file = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);
        file.initWithPath(savePath);
        var stream = Cc['@mozilla.org/network/file-output-stream;1'].createInstance(Ci.nsIFileOutputStream);
        stream.init(file, 0x02 | 0x08 | 0x20, 0o666, 0);
        var bos = Cc['@mozilla.org/binaryoutputstream;1'].createInstance(Ci.nsIBinaryOutputStream);
        bos.setOutputStream(stream);
        bos.writeByteArray(bytes, bytes.length);
        bos.close();
        stream.close();
        Zotero.debug('[Patent] CDP PDF 下载完成: ' + savePath + ' (' + bytes.length + ' bytes)');
        return savePath;
    } catch (e) {
        Zotero.debug('[Patent] fetchPdfViaCdp error: ' + e);
        return null;
    }
}

function fallbackOpenBrowser(searchTitle) {
    try {
        var uri = Services.io.newURI('http://epub.cnipa.gov.cn/Advanced', null, null);
        var eps = Cc['@mozilla.org/uriloader/external-protocol-service;1'].getService(Ci.nsIExternalProtocolService);
        eps.loadURI(uri);
        Zotero.debug('[Patent] 系统浏览器已打开');
        if (searchTitle) showNotification('请在浏览器中搜索: ' + searchTitle);
    } catch (e) {
        Zotero.debug('[Patent] 打开系统浏览器失败: ' + e);
    }
}
