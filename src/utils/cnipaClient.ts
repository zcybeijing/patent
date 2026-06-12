/**
 * CNIPA 抓取客户端：中国专利网 (epub.cnipa.gov.cn)
 *
 * 说明：
 * - 使用 fetch + DOMParser 解析页面
 * - 支持按专利名称搜索和获取PDF下载链接
 */

import { showNotification } from './uiHelpers';
import * as cdp from './cdpClient';

var _running = false;

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
            return true;
        }

        // ---- 在搜索前保存首页的 CSRF token（后续 /Sw/SwDetail POST 可能需要）----
        var homeCsrfToken = await cdp.evaluateJS(
            '(function(){var t=document.querySelector("input[name=\'__RequestVerificationToken\']");return t?t.value:"";})()'
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

        // ---- 步骤4: 在页面内通过 fetch POST 获取 SwDetail HTML，提取 PDF URL ----
        // 不打开新标签页（避免弹窗拦截），不消耗 zl_xm 一次性状态
        var pdfUrl = null;
        Zotero.debug('[Patent] 通过同步 XHR 获取 SwDetail 内容...');
        var spExpr =
            'var sp=new URLSearchParams();' +
            'sp.set("an",' + JSON.stringify(match.an) + ');' +
            'sp.set("pubType",' + JSON.stringify(match.pt) + ');' +
            'sp.set("ggr",' + JSON.stringify(match.ggr) + ');' +
            'sp.set("trsSql","");' +
            'sp.set("__RequestVerificationToken",(document.querySelector("input[name=\\"__RequestVerificationToken\\"]")||{}).value||"");';
        var swRaw = await cdp.evaluateJS(
            '(function(){' +
                'return new Promise(function(r){' +
                spExpr +
                'var url="/Sw/SwDetail";' +
                'var body=sp.toString();' +
                'fetch(url,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded","Referer":location.href},body:body,credentials:"include"})' +
                '.then(function(fr){return fr.text();})' +
                '.then(function(h){' +
                'var fm=h.match(/https?:\\/\\/egaz\\.cnipa\\.gov\\.cn\\/(showpdf|filedl)[^"\'\\s]*/);' +
                'if(fm)r(JSON.stringify({pdfUrl:fm[0],htmlLen:h.length}));' +
                'else r(JSON.stringify({pdfUrl:"",htmlLen:h.length,sample:h.substring(0,2000)}));' +
                '})' +
                '.catch(function(e){r(JSON.stringify({error:e.message}));});' +
                '});' +
            '})()',
            true,
        );
        if (swRaw) {
            var swData = JSON.parse(swRaw);
            Zotero.debug('[Patent] SwDetail: htmlLen=' + swData.htmlLen + ', pdfUrl=' + (swData.pdfUrl || '无') + (swData.error ? ', error=' + swData.error : '') + (swData.sample ? ', sample=' + swData.sample : ''));
            if (swData.pdfUrl) pdfUrl = swData.pdfUrl;
        }

        // 步骤4a: 如果 XHR 没拿到 PDF URL（可能页面有验证码或下载按钮），用鼠标点击导航降级
        if (!pdfUrl) {
            Zotero.debug('[Patent] XHR 未获取到 PDF URL，尝试鼠标点击打开 SwDetail...');
            try {
                await cdp.evaluateJS(
                    '(function(){var e=document.querySelectorAll("[onclick*=\\"zl_xm\\"]");' +
                    'if(e&&e[' + matchIdx + ']){e[' + matchIdx + '].scrollIntoView({block:"center"});return true;}return false;})()',
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
                try { curUrl = await cdp.evaluateJS('window.location.href'); } catch (_) {}
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
                    // 诊断：查看 SwDetail 页面状态
                    try {
                        var diag = await cdp.evaluateJS(
                            'JSON.stringify({url:location.href,title:document.title,hLen:(document.body?document.body.innerHTML.length:0),dLen:(document.documentElement?document.documentElement.outerHTML.length:0)})',
                        );
                        Zotero.debug('[Patent] SwDetail 诊断: ' + diag);
                    } catch (e) {
                        Zotero.debug('[Patent] SwDetail 诊断失败: ' + e);
                    }
                    // Hook jQuery AJAX 事件：捕获验证码响应 和 CheckVcode 结果
                    try {
                        await cdp.evaluateJS(
                            'window.__capDiag={};' +
                            'window.__filedlUrl="";' +
                            '$(document).ajaxSuccess(function(e,xhr,settings){' +
                            'var url=settings.url||"";' +
                            'if(url.indexOf("egaz.cnipa.gov.cn/Captcha")>=0){' +
                            'window.__capDiag={stage:"success",text:(xhr.responseText||"").substring(0,500)};}' +
                            'if(url.indexOf("/CheckVcode")>=0||url.indexOf("CheckVcode")>=0){' +
                            'try{var d=JSON.parse(xhr.responseText);' +
                            'if(d&&d.refer){window.__filedlUrl=d.refer;}}catch(_){}}' +
                            '});',
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
                    if (dlBtnSet) await cdp.clickElementReal('#_patent_dl_btn');
                    await sleep(2000);
                    try {
                        var diag2 = await cdp.evaluateJS(
                            'JSON.stringify({url:location.href,vcodeStrExists:!!document.getElementById("vcodeStr"),tipsDivExists:!!document.getElementById("tipsDiv"),title:document.title,bodyLen:(document.body?document.body.innerHTML.length:0)})',
                        );
                        Zotero.debug('[Patent] 点击下载后诊断: ' + diag2);
                    } catch (_) {}
                    Zotero.debug('[Patent] 已点击下载PDF按钮，请在浏览器中手动输入验证码');
                    showNotification('请在浏览器中手动输入验证码并点击确定，等待PDF下载');
                    // 等待最多 180 秒：验证码解决后系统自动下载 PDF
                    for (var dw2 = 0; dw2 < 180; dw2++) {
                        if (!cdp.isConnected()) {
                            Zotero.debug('[Patent] 浏览器已关闭');
                            throw new Error('BROWSER_CLOSED');
                        }
                        await sleep(1000);
                        try {
                            // 1. AJAX hook 捕获到 CheckVcode 返回的 filedl URL
                            var filedlFromAjax = await cdp.evaluateJS('window.__filedlUrl||""');
                            if (filedlFromAjax) {
                                Zotero.debug('[Patent] 通过 AJAX 捕获到 filedl URL: ' + filedlFromAjax);
                                pdfUrl = filedlFromAjax;
                                if (pdfUrl.indexOf('http') < 0) {
                                    if (pdfUrl.startsWith('/')) pdfUrl = 'http://egaz.cnipa.gov.cn' + pdfUrl;
                                    else pdfUrl = 'http://egaz.cnipa.gov.cn/' + pdfUrl;
                                }
                                break;
                            }
                            // 2. 检查 filedl 新标签页
                            var dlSw = await cdp.findShowpdfTabAndAttach();
                            if (dlSw) {
                                var dlNu = await cdp.evaluateJS('window.location.href');
                                if (dlNu && dlNu.indexOf('filedl') >= 0) {
                                    pdfUrl = dlNu;
                                    Zotero.debug('[Patent] 新标签页 filedl URL: ' + pdfUrl);
                                    break;
                                }
                            }
                            // 3. 检查当前页面是否有 filedl URL
                            var hHtml = await cdp.evaluateJS('(document.documentElement.outerHTML||"")');
                            if (hHtml && hHtml.indexOf('filedl') >= 0) {
                                var egazFm = hHtml.match(/filedl\?path=[^'"\s]+/);
                                if (egazFm) {
                                    pdfUrl = 'http://egaz.cnipa.gov.cn/' + egazFm[0];
                                    Zotero.debug('[Patent] 当前页面发现 filedl URL: ' + pdfUrl);
                                    break;
                                }
                            }
                            // 4. 检查当前 URL 跳转到了 filedl
                            var curUrl2 = await cdp.evaluateJS('window.location.href');
                            if (curUrl2 && curUrl2.indexOf('filedl') >= 0) {
                                pdfUrl = curUrl2;
                                Zotero.debug('[Patent] 页面跳转到 filedl: ' + pdfUrl);
                                break;
                            }
                        } catch (_) {}
                    }
                    if (pdfUrl) {
                        Zotero.debug('[Patent] 获取到 filedl URL: ' + pdfUrl);
                        break;
                    } else {
                        Zotero.debug('[Patent] 等待验证码超时，未捕获到 filedl URL');
                    }
                }
            }
        }
        if (pdfUrl) {
            Zotero.debug('[Patent] 获取到 PDF URL: ' + pdfUrl);
        } else {
            Zotero.debug('[Patent] 未获取到 PDF URL');
        }

        Zotero.debug('[Patent] === END ===');
        _running = false;
        return pdfUrl || true;
    } catch (e) {
        Zotero.debug('[Patent] CDP 自动化异常: ' + e);
        _running = false;
        return true;
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
                'var r=await fetch("' + fetchUrl + '",{credentials:"include"});' +
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
