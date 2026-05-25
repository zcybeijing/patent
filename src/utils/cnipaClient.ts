/**
 * CNIPA 抓取客户端：中国专利网 (epub.cnipa.gov.cn)
 *
 * 说明：
 * - 使用 fetch + DOMParser 解析页面
 * - 支持按专利名称搜索和获取PDF下载链接
 */

import { showNotification } from './uiHelpers';

/**
 * 从 Zotero 的 cookie 服务中提取 CNIPA 的 cookies（由 openInViewer 中 JS 生成的）
 * 合并到本客户端的 cookieJar 中，使 HTTP 请求复用真实浏览器的会话
 */
export function seedCookiesFromService() {
    try {
        const cookies = Services.cookies.getCookiesFromHost('epub.cnipa.gov.cn', {});
        for (const cookie of cookies) {
            const kv = cookie.name + '=' + cookie.value;
            if (!cookieJar.some(c => c.startsWith(cookie.name + '='))) {
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
};

let cnipaCsrfToken = '';

export function getCsrfToken() { return cnipaCsrfToken; }

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
    headers.set('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7');
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
            const postData = 'sortField=ggr_desc&showMode=1&pageSize=20&pageNum=1'
                + '&isFmgb=true&isFmsq=true&isXx=true&isWg=true'
                + '&catalogInfo.Pn=&catalogInfo.Pd_Begin=&catalogInfo.Pd_End='
                + '&catalogInfo.Ggr_Begin=&catalogInfo.Ggr_End='
                + '&catalogInfo.An=&catalogInfo.Edz='
                + '&catalogInfo.Ad_Begin=&catalogInfo.Ad_End='
                + '&catalogInfo.E71_73=&catalogInfo.E72=&catalogInfo.E51='
                + '&catalogInfo.Ti=' + encoded(title)
                + '&catalogInfo.Abs=&catalogInfo.E74='
                + '&catalogInfo.Edl=&catalogInfo.E30=&catalogInfo.E66='
                + '&catalogInfo.E62=&catalogInfo.E83=&catalogInfo.E86=&catalogInfo.E87=&catalogInfo.E85='
                + '&trsSql=&__RequestVerificationToken=' + encoded(cnipaCsrfToken)
                + '&isFmgb=false&isFmsq=false&isXx=false&isWg=false';

            Zotero.debug('[Patent] Trying POST with CSRF token (pcap format)');
            const html = await fetchText('http://epub.cnipa.gov.cn/Dxb/IndexQuery', {
                method: 'POST',
                body: postData,
            });
            Zotero.debug('[Patent] POST with token result: ' + (html?.length || 0) + ' chars');
            if (html) Zotero.debug('[Patent] 返回数据开头: ' + html.substring(0, 600));

            if (html && html.length > 100) {
                const doc = new DOMParser().parseFromString(html, 'text/html');
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

    const win = Zotero.openInViewer('http://epub.cnipa.gov.cn/Advanced');
    Zotero.Utilities.Internal.activate(win);

    await new Promise((r) => {
        if (win.document?.readyState === 'complete') { setTimeout(r, 100); }
        else { win.addEventListener('load', r, { once: true }); }
    });

    const browser = win.document.querySelector('browser');
    if (!browser) return false;

    await new Promise((resolve) => {
        let done = false;
        const p = setInterval(() => {
            try {
                const cur = browser.currentURI?.spec;
                if (cur && cur !== 'about:blank' && !done) { done = true; clearInterval(p); resolve(); }
            } catch (_) {}
        }, 300);
        setTimeout(() => { if (!done) { done = true; clearInterval(p); resolve(); } }, 30000);
    });

    await new Promise((r) => setTimeout(r, 8000));
    seedCookiesFromService();

    const mm = browser.messageManager || browser.frameLoader?.messageManager;
    Zotero.debug('[Patent] mm 状态: ' + (mm ? '存在 browserURI=' + (browser.currentURI?.spec || 'null') : '为空'));
    if (!mm || !searchTitle) return true;

    const bootURI = (typeof rootURI !== 'undefined' ? rootURI : 'chrome://zoteroPatent/content/') + 'content/scripts/boot.js';
    Zotero.debug('[Patent] 加载 boot: ' + bootURI);
    mm.loadFrameScript(bootURI, true);

    mm.addMessageListener('patent:status', function(e) { Zotero.debug('[Patent] 状态: ' + JSON.stringify(e.data)); });
    mm.addMessageListener('patent:pdf', function(e) { Zotero.debug('[Patent] 专利号: ' + e.data.pub); showNotification('提取到: ' + e.data.pub); });

    await new Promise((resolve) => {
        mm.addMessageListener('patent:ready', function onReady() {
            mm.removeMessageListener('patent:ready', onReady);
            mm.sendAsyncMessage('patent:auto', { keyword: searchTitle });
            resolve();
        });
        setTimeout(resolve, 15000);
    });

    await new Promise((resolve) => {
        let done = false;
        mm.addMessageListener('patent:status', function handler(e) {
            if ((e.data.stage === 'sd' || e.data.stage === 'has_content') && !done) { done = true; resolve(); }
        });
        setTimeout(() => { if (!done) { done = true; resolve(); } }, 60000);
    });

    if (mm && searchTitle) {
        try { await navigateAndDownload(mm, browser, searchTitle); }
        catch (e) { Zotero.debug('[Patent] 方案A异常: ' + e); }
    }

    Zotero.debug('[Patent] === END ===');
    return true;
}

async function navigateAndDownload(mm, browser, keyword) {
    Zotero.debug('[Patent] 方案A: 通过现有 FS 导航');
    if (!mm) { Zotero.debug('[Patent] 方案A: mm 为空'); return; }
    const bootURI = (typeof rootURI !== 'undefined' ? rootURI : 'chrome://zoteroPatent/content/') + 'content/scripts/boot.js';

    let savedSwParams = null;
    let swParamsSent = false;
    try { mm.addMessageListener('patent:navStatus', function(e) {
        var d = e.data;
        Zotero.debug('[Patent] 方案A: ' + JSON.stringify(d));
        if (d.stage === 'matched' && d.an && !savedSwParams) {
            savedSwParams = { an: d.an, pt: d.pt, ggr: d.ggr };
            var curUrl = browser?.currentURI?.spec || '';
            if (curUrl.indexOf('/Dxb/AdvancedQuery') >= 0) {
                Zotero.debug('[Patent] 方案A: 已在 AdvQuery，发 swParams');
                swParamsSent = true;
                setTimeout(function() {
                    mm.sendAsyncMessage('patent:swParams', { an: d.an, pt: d.pt, ggr: d.ggr });
                }, 500);
            } else {
                Zotero.debug('[Patent] 方案A: 导航到 /Dxb/AdvancedQuery');
                try {
                    var uri = Services.io.newURI('http://epub.cnipa.gov.cn/Dxb/AdvancedQuery', null, null);
                    browser.loadURI(uri, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
                } catch (e) { Zotero.debug('[Patent] 方案A: 导航失败: ' + e); }
            }
        }
    }); } catch (e) { Zotero.debug('[Patent] 方案A: navStatus注册失败'); }

    // 导航后等待页面加载 + 发送 swParams（备用）
    try { mm.addMessageListener('patent:status', function onBoot(e) {
        var d2 = e.data;
        if (d2.stage === 'boot_run' && d2.url.indexOf('/Dxb/AdvancedQuery') >= 0 && savedSwParams && !swParamsSent) {
            swParamsSent = true;
            Zotero.debug('[Patent] 方案A: 备用发 swParams');
            setTimeout(function() {
                mm.sendAsyncMessage('patent:swParams', { an: savedSwParams.an, pt: savedSwParams.pt, ggr: savedSwParams.ggr });
            }, 500);
        }
    }); } catch (e) {}
    
    // 等待 /Dxb/AdvancedQuery（避免与 iframe 加载冲突，boot 重载改到更晚）
    await new Promise((resolve) => {
        const p = setInterval(() => {
            try {
                const cur = browser?.currentURI?.spec;
                if (cur && cur.indexOf('/Dxb/AdvancedQuery') >= 0) {
                    clearInterval(p);
                    Zotero.debug('[Patent] 方案A: 已到达 /Dxb/AdvancedQuery');
                    resolve();
                }
            } catch (_) {}
        }, 300);
        setTimeout(() => { clearInterval(p); resolve(); }, 20000);
    });

    try { mm.addMessageListener('patent:pdf', function(e) {
        if (e.data.url) { Zotero.debug('[Patent] PDF链接: ' + e.data.url); showNotification('PDF 下载链接已获取'); }
    }); } catch (e) {}

    try { mm.addMessageListener('patent:savePage', function(e) {
        if (!e.data.html) return;
        try {
            var tmpFile = Cc['@mozilla.org/file/directory_service;1'].getService(Ci.nsIProperties).get('TmpD', Ci.nsIFile);
            tmpFile.append('cnipa_page_' + Date.now() + '.html');
            var fos = Cc['@mozilla.org/network/file-output-stream;1'].createInstance(Ci.nsIFileOutputStream);
            fos.init(tmpFile, 0x02 | 0x08 | 0x20, 0o666, 0);
            var converter = Cc['@mozilla.org/intl/converter-output-stream;1'].createInstance(Ci.nsIConverterOutputStream);
            converter.init(fos, 'UTF-8');
            converter.writeString(e.data.html);
            converter.close();
            Zotero.debug('[Patent] 页面已保存到: ' + tmpFile.path);
            showNotification('页面已保存: ' + tmpFile.path);
        } catch (ex) { Zotero.debug('[Patent] 保存失败: ' + ex); }
    }); } catch (e) {}

    Zotero.debug('[Patent] 方案A: 发送 doNav');
    mm.sendAsyncMessage('patent:doNav', { keyword: keyword });

    await new Promise((resolve) => {
        let done = false;
        const p = setInterval(() => {
            try {
                const cur = browser?.currentURI?.spec;
                if (cur && cur.indexOf('/Sw/SwDetail') >= 0 && !done) {
                    done = true; clearInterval(p);
                    Zotero.debug('[Patent] 方案A: 已到达 SwDetail');
                    try { mm.loadFrameScript(bootURI, true); Zotero.debug('[Patent] 方案A: boot re-loaded'); } catch (e) {}
                    resolve();
                }
            } catch (_) {}
        }, 500);
        setTimeout(() => { if (!done) { done = true; clearInterval(p); Zotero.debug('[Patent] 方案A: 超时'); resolve(); } }, 30000);
    });
}
