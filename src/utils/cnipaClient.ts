/**
 * CNIPA 抓取客户端：中国专利网 (epub.cnipa.gov.cn)
 *
 * 说明：
 * - 使用 fetch + DOMParser 解析页面
 * - 支持按专利名称搜索和获取PDF下载链接
 */

import { showNotification } from './uiHelpers';

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
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    );
    headers.set('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
    headers.set('Accept-Language', 'zh-CN,zh;q=0.9,en;q=0.8');
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

    // 方法1: 尝试通过首页搜索
    try {
        const searchUrl = `http://epub.cnipa.gov.cn/?wd=${encodeURIComponent(title)}`;
        Zotero.debug('[Patent] Trying homepage: ' + searchUrl);
        const html = await fetchText(searchUrl);
        if (html && html.length > 500) {
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
        Zotero.debug('[Patent] Homepage search failed: ' + e);
    }

    // 方法2: 尝试GET请求搜索
    if (results.length === 0) {
        try {
            const url = `http://epub.cnipa.gov.cn/patent/search/searchByCondition?searchWord=${encodeURIComponent(title)}&pageNo=1`;
            Zotero.debug('[Patent] Trying GET: ' + url);
            const html = await fetchText(url);
            if (html && html.length > 200) {
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
            Zotero.debug('[Patent] GET search failed: ' + e);
        }
    }

    // 方法3: 尝试POST带CSRF token
    if (results.length === 0 && cnipaCsrfToken) {
        const postData = `searchWord=${encodeURIComponent(title)}&pageNo=1&pageSize=20&__RequestVerificationToken=${encodeURIComponent(cnipaCsrfToken)}`;

        try {
            Zotero.debug('[Patent] Trying POST with CSRF token');
            const html = await fetchText('http://epub.cnipa.gov.cn/Dxb/IndexQuery', {
                method: 'POST',
                body: postData,
            });
            Zotero.debug('[Patent] POST with token result: ' + (html?.length || 0) + ' chars');

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

    // 方法4: 尝试最简单的POST
    if (results.length === 0) {
        const postData = `searchWord=${encodeURIComponent(title)}&pageNo=1&pageSize=20`;

        try {
            Zotero.debug('[Patent] Trying simple POST without token');
            const html = await fetchText('http://epub.cnipa.gov.cn/Dxb/IndexQuery', {
                method: 'POST',
                body: postData,
            });
            Zotero.debug('[Patent] Simple POST result: ' + (html?.length || 0) + ' chars');

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
            Zotero.debug('[Patent] Simple POST failed: ' + e);
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
                    result.inventors = value.split(/[,;，；、\n]/).map((s) => s.trim()).filter((s) => s.length > 1);
                }
                // 申请人/专利权人
                if (/申请人|专利权人|权利人/.test(label)) {
                    result.assignees = value.split(/[,;，；、\n]/).map((s) => s.trim()).filter((s) => s.length > 1);
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
        const downloadLinks = doc.querySelectorAll('a[href*="download"], a[href*="Down"], a:contains("PDF"), a:contains("下载")');
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
                    const fullUrl = urlMatch[1].startsWith('http') ? urlMatch[1] : `http://epub.cnipa.gov.cn${urlMatch[1]}`;
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
