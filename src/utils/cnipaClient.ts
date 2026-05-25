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

    // 尝试 CDP 浏览器自动化
    var useCDP = false;
    try {
        Zotero.debug('[Patent] 尝试 CDP 自动化...');
        var cdp = await import('./cdpClient');

        var launched = await cdp.launchBrowser();
        if (launched) {
            var connected = await cdp.connectCDP();
            if (connected) {
                useCDP = true;
                await cdp.createTab('about:blank');

                // 导航到 CNIPA Advanced
                Zotero.debug('[Patent] CDP: 导航到 Advanced');
                await cdp.navigateTo('http://epub.cnipa.gov.cn/Advanced');
                await cdp.waitForElement('#query_form', 20000);

                if (searchTitle) {
                    // 填入搜索标题
                    Zotero.debug('[Patent] CDP: 填入搜索词');
                    await cdp.fillInput('input[name="searchCatalogInfo.Ti"]', searchTitle);

                    // 点击查询按钮
                    Zotero.debug('[Patent] CDP: 点击查询');
                    await cdp.clickElement('button[type="submit"].btn');

                    // 等待结果
                    await cdp.waitForElement('[onclick*="zl_xm"]', 20000);
                    Zotero.debug('[Patent] CDP: 搜索结果已加载');

                    // 提取专利号
                    var pageText = await cdp.getPageText();
                    var pubMatch = pageText.match(/CN\s*\d+[A-Z]?/);
                    if (pubMatch) {
                        Zotero.debug('[Patent] CDP 提取到专利号: ' + pubMatch[0]);
                        showNotification('提取到: ' + pubMatch[0]);
                    }

                    // 点击第一个发明专利按钮
                    var clicked = await cdp.clickElement('[onclick*="zl_xm"]');
                    Zotero.debug('[Patent] CDP: 发明专利按钮点击: ' + clicked);

                    // 等待 SwDetail 页面
                    await cdp.waitForElement('#patd', 15000);
                    var swUrl = await cdp.evaluateJS('window.location.href');
                    Zotero.debug('[Patent] CDP: 当前 URL: ' + swUrl);

                    // 提取 filedl 链接
                    var swHtml = await cdp.evaluateJS('document.documentElement.outerHTML');
                    var filedlMatch = (swHtml || '').match(/https?:\/\/egaz\.cnipa\.gov\.cn\/[^"'\s]*/);
                    if (filedlMatch) {
                        Zotero.debug('[Patent] CDP 发现 filedl: ' + filedlMatch[0]);
                        showNotification('PDF 下载链接已获取');
                    }
                }

                await cdp.disconnectCDP();
                Zotero.debug('[Patent] CDP 自动化完成');
            }
        }
    } catch (e) {
        Zotero.debug('[Patent] CDP 自动化失败: ' + e);
    }

    // CDP 失败时的兜底：系统浏览器打开
    if (!useCDP) {
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

    Zotero.debug('[Patent] === END ===');
    return true;
}
