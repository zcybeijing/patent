import { config } from '../../package.json';
import { showNotification } from './uiHelpers';

export { isWindowAlive, openCnipaBrowser, closeCnipaBrowser, automatePatentSearch };

let cnipaWindow: Window | null = null;

/**
 * Check if the window is alive.
 */
function isWindowAlive(win?: Window | any) {
    return win && !win.closed;
}

/**
 * Open a browser window for CNIPA patent search with automation
 */
async function openCnipaBrowser(searchTitle?: string): Promise<Window | null> {
    const mainWindow = Zotero.getMainWindow();
    if (!mainWindow) {
        Zotero.debug('[Patent] No main window');
        return null;
    }

    const url = 'http://epub.cnipa.gov.cn/Advanced';
    Zotero.debug('[Patent] Opening CNIPA: ' + url);

    // Try different approaches
    try {
        // Check what window properties are available
        Zotero.debug(
            '[Patent] mainWindow keys: ' +
                Object.keys(mainWindow)
                    .filter((k) => k.toLowerCase().includes('browser') || k.toLowerCase().includes('tab'))
                    .join(', '),
        );
    } catch (e) {
        Zotero.debug('[Patent] Cannot list window keys: ' + e);
    }

    // Try Zotero_Tabs - the tab system
    try {
        const zoteroTabs = mainWindow.Zotero_Tabs;
        if (zoteroTabs) {
            Zotero.debug('[Patent] Zotero_Tabs exists, type: ' + typeof zoteroTabs);

            // Try add method first
            if (zoteroTabs.add) {
                Zotero.debug('[Patent] Trying Zotero_Tabs.add');
                const tab = zoteroTabs.add(url, { title: 'CNIPA Patent' });
                Zotero.debug('[Patent] Zotero_Tabs.add result: ' + (tab ? 'tab created' : 'null'));

                if (tab && searchTitle) {
                    // Try to find and use the browser for automation
                    setTimeout(() => {
                        try {
                            // Get browser for the tab
                            const browser = mainWindow.gBrowser?.getBrowserForTab?.(tab);
                            if (browser?.contentWindow) {
                                Zotero.debug('[Patent] Got browser for tab');
                                automatePatentSearch(browser.contentWindow as Window, searchTitle);
                            }
                        } catch (e2) {
                            Zotero.debug('[Patent] Automation error: ' + e2);
                        }
                    }, 5000);
                }

                return mainWindow;
            }

            // Try calling open method
            if (zoteroTabs.open) {
                Zotero.debug('[Patent] Calling Zotero_Tabs.open');
                zoteroTabs.open(url, 'CNIPA', true);
                Zotero.debug('[Patent] Zotero_Tabs.open called');

                return mainWindow;
            }
        }
    } catch (e) {
        Zotero.debug('[Patent] Zotero_Tabs error: ' + e);
    }

    // Try tab bar
    try {
        const tabBar = mainWindow._tabBar || mainWindow._tabBar2;
        if (tabBar) {
            Zotero.debug('[Patent] tabBar exists');
            if (tabBar.addTab) {
                Zotero.debug('[Patent] Trying tabBar.addTab');
                tabBar.addTab(url);
                Zotero.debug('[Patent] tabBar.addTab called');
                return mainWindow;
            }
        }
    } catch (e) {
        Zotero.debug('[Patent] tabBar error: ' + e);
    }

    // Try HiddenBrowser - use the async load() method
    try {
        const HiddenBrowser = mainWindow.HiddenBrowser;
        if (HiddenBrowser) {
            Zotero.debug('[Patent] HiddenBrowser exists, creating new instance');

            const hiddenBrowser = new HiddenBrowser();
            Zotero.debug('[Patent] Created HiddenBrowser instance');

            // Wait for initialization
            await hiddenBrowser._createdPromise;
            Zotero.debug('[Patent] HiddenBrowser initialized');

            // Use the async load() method
            Zotero.debug('[Patent] Trying HiddenBrowser.load()');
            try {
                // Use http (not https - CNIPA doesn't support HTTPS)
                const httpUrl = url.replace('https://', 'http://');
                Zotero.debug('[Patent] Loading: ' + httpUrl);
                await hiddenBrowser.load(httpUrl);
                Zotero.debug('[Patent] HiddenBrowser.load() completed');

                // 检查响应状态
                try {
                    const pageData = await hiddenBrowser.getPageData(['channelInfo']);
                    const status = pageData?.channelInfo?.responseStatus || 0;
                    Zotero.debug('[Patent] Page response status: ' + status);
                    // 202可能是重定向，继续尝试获取文档
                    if (status >= 400) {
                        Zotero.debug('[Patent] Page load failed with status: ' + status);
                        showNotification('页面加载失败: ' + status);
                    }
                } catch (pdError) {
                    Zotero.debug('[Patent] getPageData error: ' + pdError);
                }

                // Wait for document to be ready
                Zotero.debug('[Patent] Waiting for document...');
                try {
                    await hiddenBrowser.waitForDocument();
                    Zotero.debug('[Patent] Document ready');
                } catch (waitError) {
                    Zotero.debug('[Patent] waitForDocument error: ' + waitError);
                }

                // Use getDocument() to get the parsed document
                Zotero.debug('[Patent] Trying getDocument()');
                try {
                    let doc = await hiddenBrowser.getDocument();
                    Zotero.debug('[Patent] getDocument() returned: ' + (doc ? 'document' : 'null'));
                    Zotero.debug('[Patent] Document title: ' + (doc?.title || 'null'));
                    
                    // Check if there's content
                    const bodyText = doc?.body?.innerText?.substring(0, 100) || '';
                    Zotero.debug('[Patent] Body text: ' + bodyText);

                    if (!doc || !searchTitle) {
                        Zotero.debug('[Patent] No document or search title');
                        return mainWindow;
                    }
                    
                    // If page is empty, try reloading
                    if (!doc.title || bodyText.length < 10) {
                        Zotero.debug('[Patent] Page empty, retrying...');
                        await hiddenBrowser.load('http://epub.cnipa.gov.cn/Advanced');
                        await hiddenBrowser.waitForDocument();
                        doc = await hiddenBrowser.getDocument();
                        Zotero.debug('[Patent] Retry title: ' + (doc?.title || 'null'));
                    }

                    if (!doc || !searchTitle) {
                        Zotero.debug('[Patent] No document or search title after retry');
                        return mainWindow;
                    }

                    // Get CSRF token
                    const tokenInput = doc.querySelector(
                        'input[name="__RequestVerificationToken"]',
                    ) as HTMLInputElement;
                    const csrfToken = tokenInput?.value || '';
                    Zotero.debug('[Patent] CSRF token: ' + (csrfToken ? 'found' : 'not found'));

                    if (!csrfToken) {
                        Zotero.debug('[Patent] No CSRF token found, cannot search');
                        showNotification('无法获取CSRF令牌');
                        return mainWindow;
                    }

                    // Build complete POST body matching CNIPA format (from pcap analysis)
                    const searchTerm = encodeURIComponent(searchTitle);
                    const postBody =
                        'sortField=ggr_desc' +
                        '&showMode=1' +
                        '&pageSize=3' +
                        '&pageNum=1' +
                        '&isFmgb=true' +
                        '&isFmsq=true' +
                        '&isXx=true' +
                        '&isWg=true' +
                        '&catalogInfo.Pn=' +
                        '&catalogInfo.Pd_Begin=' +
                        '&catalogInfo.Pd_End=' +
                        '&catalogInfo.Ggr_Begin=' +
                        '&catalogInfo.Ggr_End=' +
                        '&catalogInfo.An=' +
                        '&catalogInfo.Edz=' +
                        '&catalogInfo.Ad_Begin=' +
                        '&catalogInfo.Ad_End=' +
                        '&catalogInfo.E71_73=' +
                        '&catalogInfo.E72=' +
                        '&catalogInfo.E51=' +
                        '&catalogInfo.Ti=' +
                        searchTerm +
                        '&catalogInfo.Abs=' +
                        '&catalogInfo.E74=' +
                        '&catalogInfo.Edl=' +
                        '&catalogInfo.E30=' +
                        '&catalogInfo.E66=' +
                        '&catalogInfo.E62=' +
                        '&catalogInfo.E83=' +
                        '&catalogInfo.E86=' +
                        '&catalogInfo.E87=' +
                        '&catalogInfo.E85=' +
                        '&trsSql=' +
                        '&__RequestVerificationToken=' +
                        csrfToken +
                        '&isFmgb=false' +
                        '&isFmsq=false' +
                        '&isXx=false' +
                        '&isWg=false';

                    Zotero.debug('[Patent] POST body length: ' + postBody.length);

                    // Step 1: 获取页面Cookie - 先访问确保会话建立
                    Zotero.debug('[Patent] Step 1: 获取Cookie');

// Load homepage then Advanced page in HiddenBrowser
                    await hiddenBrowser.load('http://epub.cnipa.gov.cn');
                    await hiddenBrowser.waitForDocument();
                    Zotero.debug('[Patent] Visited homepage');

                    await hiddenBrowser.load('http://epub.cnipa.gov.cn/Advanced');
                    await hiddenBrowser.waitForDocument();
                    Zotero.debug('[Patent] Visited Advanced page');

                    // Wait for JS to set cookies
                    await new Promise(resolve => setTimeout(resolve, 2000));

                    // Get cookies from browser
                    const cookies = await hiddenBrowser.getPageData(['cookie']);
                    let cookieStr = cookies?.cookie || '';
                    Zotero.debug('[Patent] Browser cookies length: ' + cookieStr.length);
                    Zotero.debug('[Patent] Has Antiforgery: ' + cookieStr.includes('.AspNetCore.Antiforgery'));
                    Zotero.debug('[Patent] Has NOh8RTWx6K2dS: ' + cookieStr.includes('NOh8RTWx6K2dS'));

                    try {
                        // First request to get cookies (will set some initial cookies)
                        const initialResp = await Zotero.HTTP.request(
                            'GET',
                            'http://epub.cnipa.gov.cn/',
                            {
                                headers: {
                                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                                    Accept: 'text/html',
                                },
                            },
                        );
                        
                        // Get cookies from this request
                        cookieStr = initialResp.headers.get?.('set-cookie') || '';
                        Zotero.debug('[Patent] Initial cookies from GET: ' + cookieStr.length + ' chars');
                    } catch (initErr) {
                        Zotero.debug('[Patent] Initial GET error: ' + initErr);
                    }
                    
                    // Now use HiddenBrowser to load page (will set more cookies via JS)
                    Zotero.debug('[Patent] Step 2: Load Advanced page via HiddenBrowser');
                    await hiddenBrowser.load('http://epub.cnipa.gov.cn/Advanced');
                    await hiddenBrowser.waitForDocument();
                    
                    // Wait for JS to execute
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    
                    // Get additional cookies from browser
                    const browserCookies = await hiddenBrowser.getPageData(['cookie']);
                    const browserCookieStr = browserCookies?.cookie || '';
                    Zotero.debug('[Patent] Browser cookies: ' + browserCookieStr.length);
                    
                    // Combine cookies
                    cookieStr = cookieStr + '; ' + browserCookieStr;
                    Zotero.debug('[Patent] Combined cookies: ' + cookieStr.length);
                    
Zotero.debug('[Patent] Has Antiforgery: ' + cookieStr.includes('.AspNetCore.Antiforgery'));
                    Zotero.debug('[Patent] Has NOh8RTWx6K2dS: ' + cookieStr.includes('NOh8RTWx6K2dS'));

                    try {
                        const httpResp = await Zotero.HTTP.request(
                            'GET',
                            'http://epub.cnipa.gov.cn/Advanced',
                            {
                                headers: {
                                    'User-Agent':
                                        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 Edg/147.0.0.0',
                                    Accept: 'text/html,application/xhtml+xml',
                                },
                            },
                        );
                        
                        // Extract cookies from response headers
                        const setCookie = httpResp.getResponseHeader('Set-Cookie') || '';
                        Zotero.debug('[Patent] Set-Cookie header: ' + setCookie.length + ' chars');
                        
                        // Also get cookies from getPageData
                        const browserCookies = await hiddenBrowser.getPageData(['cookie']);
                        const browserCookieStr = browserCookies?.cookie || '';
                        Zotero.debug('[Patent] Browser cookies: ' + browserCookieStr.length);
                        
                        // Combine both
                        cookieStr = setCookie + '; ' + browserCookieStr;
                        Zotero.debug('[Patent] Combined cookie length: ' + cookieStr.length);
                    } catch (httpErr) {
                        Zotero.debug('[Patent] HTTP GET error: ' + httpErr);
                        const cookies = await hiddenBrowser.getPageData(['cookie']);
                        cookieStr = cookies?.cookie || '';
                    }
                    
                    Zotero.debug('[Patent] Has Antiforgery: ' + cookieStr.includes('.AspNetCore.Antiforgery'));
                    Zotero.debug('[Patent] Has NOh8RTWx6K2dS: ' + cookieStr.includes('NOh8RTWx6K2dS'));

                    try {
                        const searchResponse = await Zotero.HTTP.request(
                            'POST',
                            'http://epub.cnipa.gov.cn/Dxb/AdvancedQuery',
                            {
                                body: postBody,
                                headers: {
                                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                                    'User-Agent':
                                        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 Edg/147.0.0.0',
                                    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                                    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                                    'Accept-Encoding': 'gzip, deflate',
                                    Referer: 'http://epub.cnipa.gov.cn/Advanced',
                                    Origin: 'http://epub.cnipa.gov.cn',
                                    'Upgrade-Insecure-Requests': '1',
                                    'Cache-Control': 'max-age=0',
                                    Cookie: cookieStr,
                                },
                            },
                        );

                        Zotero.debug('[Patent] Search response status: ' + searchResponse.status);

                        if (searchResponse.status === 200) {
                            const resultsHtml = searchResponse.responseText || '';
                            Zotero.debug('[Patent] Response length: ' + resultsHtml.length);

                            const resultsParser = new DOMParser();
                            const resultsDoc = resultsParser.parseFromString(resultsHtml, 'text/html');
                            const resultsTitle = resultsDoc?.title || '';
                            Zotero.debug('[Patent] Results page title: ' + resultsTitle);

                            const resultLinks = resultsDoc.querySelectorAll(
                                'a[href*="/Sw/SwDetail"], a[href*="/Dxb/Detail"]',
                            );
                            Zotero.debug('[Patent] Found ' + resultLinks.length + ' result links');

                            if (resultLinks.length > 0) {
                                const firstResultUrl = (resultLinks[0] as HTMLAnchorElement).href;
                                Zotero.debug('[Patent] First result URL: ' + firstResultUrl);
                                showNotification('找到 ' + resultLinks.length + ' 个结果，正在打开...');

                                await hiddenBrowser.load(firstResultUrl);
                                await hiddenBrowser.waitForDocument();

                                const detailDoc = await hiddenBrowser.getDocument();
                                const detailTitle = detailDoc?.title || '';
                                Zotero.debug('[Patent] Detail page title: ' + detailTitle);

                                showNotification('已打开专利详情页');
                            } else {
                                showNotification('未找到匹配专利');
                            }
                        } else if (searchResponse.status === 400) {
                            Zotero.debug('[Patent] Bad request - 可能缺少必需字段');
                            showNotification('搜索请求失败，请重试');
                        } else {
                            Zotero.debug('[Patent] Response status: ' + searchResponse.status);
                            showNotification('搜索失败: ' + searchResponse.status);
                        }

                        return mainWindow;
                    } catch (postError) {
                        Zotero.debug('[Patent] POST error: ' + postError);
                    }
                    
                    // Fallback: Open in browserDOMWindow (Zotero's internal browser)
                    Zotero.debug('[Patent] Opening in internal browser');
                    try {
                        const browserDOMWindow = mainWindow.browserDOMWindow;
                        if (browserDOMWindow && browserDOMWindow.openURI) {
                            const searchUrl = 'http://epub.cnipa.gov.cn/Advanced?wd=' + encodeURIComponent(searchTitle);
                            const uri = Services.io.newURI(searchUrl, null, null);
                            browserDOMWindow.openURI(uri, null, null, null, null);
                            showNotification('已在Zotero浏览器中打开CNIPA');
                            return mainWindow;
                        }
                    } catch (e) {
                        Zotero.debug('[Patent] browserDOMWindow error: ' + e);
                    }
                    
                    // Final fallback: Open in system browser
                    showNavigation('http://epub.cnipa.gov.cn/Advanced?wd=' + encodeURIComponent(searchTitle));
                    
                    return mainWindow;
                } catch (docError) {
                    Zotero.debug('[Patent] Error: ' + docError);
                    showNotification('获取专利信息失败');
                }

                return mainWindow;
            } catch (loadError) {
                Zotero.debug('[Patent] HiddenBrowser.load() error: ' + loadError);
            }
        }
    } catch (e) {
        Zotero.debug('[Patent] HiddenBrowser error: ' + e);
    }

    Zotero.debug('[Patent] After HiddenBrowser, continuing to browserDOMWindow...');

    // CNIPA doesn't support URL parameters - just open the search page
    const searchUrl = 'http://epub.cnipa.gov.cn/Advanced';
    Zotero.debug('[Patent] Opening CNIPA: ' + searchUrl);
    
    // Try browserDOMWindow - opens in internal browser
    try {
        const browserDOMWindow = mainWindow.browserDOMWindow;
        if (browserDOMWindow) {
            Zotero.debug('[Patent] browserDOMWindow exists');
            if (browserDOMWindow.openURI) {
                Zotero.debug('[Patent] Trying browserDOMWindow.openURI');
                const uri = Services.io.newURI(searchUrl, null, null);
                browserDOMWindow.openURI(uri, null, null, null, null);
                Zotero.debug('[Patent] browserDOMWindow.openURI called');
                showNotification('已在Zotero浏览器中打开CNIPA高级搜索页面，请手动搜索');
                return mainWindow;
            }
        }
    } catch (e) {
        Zotero.debug('[Patent] browserDOMWindow error: ' + e);
    }

    Zotero.debug('[Patent] After browserDOMWindow, continuing...');

    // Try calling window.open directly on mainWindow
    try {
        Zotero.debug('[Patent] Trying mainWindow.open');
        const newWin = mainWindow.open(url, '_blank', 'width=1200,height=800');
        if (newWin) {
            Zotero.debug('[Patent] mainWindow.open returned window');
            return newWin;
        }
    } catch (e) {
        Zotero.debug('[Patent] mainWindow.open error: ' + e);
    }

    // Try using Zotero API directly
    try {
        if (typeof Zotero.launchURL === 'function') {
            Zotero.debug('[Patent] Using Zotero.launchURL');
            Zotero.launchURL(url);
            Zotero.debug('[Patent] launchURL called');
            return mainWindow;
        }
    } catch (e) {
        Zotero.debug('[Patent] launchURL error: ' + e);
    }

    // Try to use external protocol service
    try {
        Zotero.debug('[Patent] Trying external protocol service');
        const eps = Components.classes['@mozilla.org/uriloader/external-protocol-service;1'].getService(
            Components.interfaces.nsIExternalProtocolService,
        );
        const uri = Services.io.newURI(url, null, null);
        eps.loadURI(uri, null);
        Zotero.debug('[Patent] External protocol service called');
        return mainWindow;
    } catch (e) {
        Zotero.debug('[Patent] External protocol service error: ' + e);
    }

    // Final: copy URL to clipboard
    try {
        Zotero.debug('[Patent] Copying URL to clipboard');
        const searchUrl = searchTitle ? `http://epub.cnipa.gov.cn/Advanced?wd=${encodeURIComponent(searchTitle)}` : url;

        // Use clipboard
        const clip = Components.classes['@mozilla.org/widget/clipboard;1'].getService(
            Components.interfaces.nsIClipboard,
        );
        const str = Components.classes['@mozilla.org/supports-string;1'].createInstance(
            Components.interfaces.nsISupportsString,
        );
        str.data = searchUrl;
        clip.setData(str, null, clip.kGlobalClipboard);

        Zotero.debug('[Patent] URL copied to clipboard');

        // Notify user
        mainWindow.alert('已复制搜索链接到剪贴板。\n\n请在浏览器中粘贴打开。\n\n' + searchUrl);

        return mainWindow;
    } catch (e) {
        Zotero.debug('[Patent] Clipboard error: ' + e);

        // Last fallback: alert
        const searchUrl = searchTitle ? `http://epub.cnipa.gov.cn/Advanced?wd=${encodeURIComponent(searchTitle)}` : url;
        mainWindow.alert('请在浏览器中打开：\n\n' + searchUrl);
    }

    Zotero.debug('[Patent] All methods failed');
    return null;
}

/**
 * Automate the patent search process in the browser window
 */
async function automatePatentSearch(win: Window | any, searchTitle: string) {
    if (!win || !isWindowAlive(win)) {
        Zotero.debug('[Patent] Window not alive');
        return;
    }

    Zotero.debug('[Patent] Starting automated search for: ' + searchTitle);

    try {
        // Wait longer for page to be fully loaded
        await new Promise((resolve) => setTimeout(resolve, 5000));

        // Try to get document from window
        let doc = win.document;
        Zotero.debug('[Patent] win.document: ' + (doc ? 'available' : 'null'));

        if (!doc) {
            // Try getting from browsingContext if win is a browser
            try {
                const bc = win.browsingContext;
                Zotero.debug('[Patent] win.browsingContext: ' + (bc ? 'available' : 'null'));

                if (bc?.top) {
                    doc = bc.top.document;
                    win = bc.top.window;
                    Zotero.debug('[Patent] Got document from browsingContext.top: ' + (doc ? 'available' : 'null'));

                    // Try getting window from top
                    if (!win && bc.top) {
                        win = bc.top.window;
                        Zotero.debug('[Patent] Got window from bc.top.window: ' + (win ? 'available' : 'null'));
                        doc = win?.document;
                        Zotero.debug('[Patent] doc from new win: ' + (doc ? 'available' : 'null'));
                    }
                }
            } catch (e) {
                Zotero.debug('[Patent] browsingContext access error: ' + e);
            }
        }

        // Try getting via contentDocument
        if (!doc && win.contentDocument) {
            doc = win.contentDocument;
            Zotero.debug('[Patent] Got via contentDocument: ' + (doc ? 'available' : 'null'));
        }

        // Try via eval - might work for XPCOM wrapped windows
        if (!doc) {
            try {
                doc = win.eval('document');
                Zotero.debug('[Patent] Got via eval: ' + (doc ? 'available' : 'null'));
            } catch (e) {}
        }

        // Try getting innerHTML directly
        if (!doc) {
            try {
                const html = win.eval('document.documentElement.innerHTML');
                if (html && html.length > 100) {
                    Zotero.debug('[Patent] Got HTML via eval: ' + html.substring(0, 100));
                    // Parse HTML manually
                    const parser = new DOMParser();
                    doc = parser.parseFromString(html, 'text/html');
                    Zotero.debug('[Patent] Parsed HTML to doc');
                }
            } catch (e) {
                Zotero.debug('[Patent] eval innerHTML error: ' + e);
            }
        }

        if (!doc) {
            Zotero.debug('[Patent] Cannot access document - trying XHR fallback');
            // Last resort: use Zotero's HTTP client to fetch the page
            try {
                const { HiddenBrowser } = mainWindow.HiddenBrowser;
                const hb = new HiddenBrowser();
                await hb._createdPromise;
                await hb.load(url);
                await hb.waitForDocument();

                // Try to get content via webChannel or similar
                const html = await hb.webChannel?.capture();
                Zotero.debug('[Patent] Tried webChannel capture: ' + (html ? 'got content' : 'failed'));
            } catch (xhre) {
                Zotero.debug('[Patent] XHR fallback error: ' + xhre);
            }

            Zotero.debug('[Patent] Cannot access document');
            return;
        }

        // Check current URL
        const currentUrl = win.location?.href || '';
        Zotero.debug('[Patent] Current URL: ' + currentUrl);

        // Find search input - multiple selectors to try
        const searchSelectors = [
            '#searchWord',
            'input[name="searchWord"]',
            'input[name="Searchword"]',
            'input[type="text"][placeholder*="专利"]',
            'input[type="text"]',
            '#keyword',
            'input[name="keyword"]',
        ];

        let searchInput: HTMLInputElement | null = null;
        for (const selector of searchSelectors) {
            const el = doc.querySelector(selector) as HTMLInputElement;
            if (el) {
                searchInput = el;
                Zotero.debug('[Patent] Found search input: ' + selector);
                break;
            }
        }

        if (searchInput) {
            searchInput.value = searchTitle;
            searchInput.dispatchEvent(new win.Event('input', { bubbles: true }));
            Zotero.debug('[Patent] Filled search term');

            // Find and click search button - use valid CSS selectors only
            const buttonSelectors = [
                'input[type="submit"]',
                'button[type="submit"]',
                'input[value*="查询"]',
                'input[value*="搜索"]',
                'input[value*="查询"]',
                '.search-btn',
                '#searchBtn',
                'button.submit',
            ];

            let searchButton: HTMLElement | null = null;
            for (const selector of buttonSelectors) {
                const btn = doc.querySelector(selector);
                if (btn) {
                    searchButton = btn as HTMLElement;
                    break;
                }
            }

            if (searchButton) {
                searchButton.click();
                Zotero.debug('[Patent] Clicked search button');

                // Wait for results
                await new Promise((resolve) => setTimeout(resolve, 3000));

                // Try to find and click first result - look for "发明专利" links first
                const allLinks = doc.querySelectorAll('a');
                Zotero.debug('[Patent] Found ' + allLinks.length + ' total links on results page');

                // First, try to find a link with "发明专利" text
                let resultLink: HTMLAnchorElement | null = null;
                for (const link of allLinks) {
                    const text = link.textContent?.trim() || '';
                    if (text.includes('发明专利') || text.includes('发明专利')) {
                        resultLink = link as HTMLAnchorElement;
                        Zotero.debug('[Patent] Found 发明专利 link: ' + text);
                        break;
                    }
                }

                // If no "发明专利" link, try other selectors
                if (!resultLink) {
                    const resultSelectors = [
                        'a[href*="sw"]',
                        'a[href*="detail"]',
                        'table.list-table a',
                        '.result-list a',
                    ];
                    for (const selector of resultSelectors) {
                        const links = doc.querySelectorAll(selector);
                        if (links.length > 0) {
                            resultLink = links[0] as HTMLAnchorElement;
                            break;
                        }
                    }
                }

                if (resultLink) {
                    Zotero.debug('[Patent] Found result, clicking...');
                    resultLink.click();

                    // Wait for detail page to load
                    await new Promise((resolve) => setTimeout(resolve, 3000));

                    // Try to find and click PDF download - look for "下载PDF" button in top right
                    // First check top right area
                    const topRightSelectors = ['.top-right', '.header-right', '.right', 'header', '.topbar'];
                    let pdfLink: HTMLElement | null = null;

                    for (const selector of topRightSelectors) {
                        const container = doc.querySelector(selector);
                        if (container) {
                            const links = container.querySelectorAll('a, button');
                            for (const link of links) {
                                const text = link.textContent?.trim() || '';
                                if (
                                    text.includes('下载PDF') ||
                                    text.includes('PDF下载') ||
                                    text.includes('下载') ||
                                    text.includes('PDF')
                                ) {
                                    pdfLink = link as HTMLElement;
                                    Zotero.debug('[Patent] Found PDF button in top right: ' + text);
                                    break;
                                }
                            }
                            if (pdfLink) break;
                        }
                    }

                    // If not found in top right, search all links
                    if (!pdfLink) {
                        const allElements = doc.querySelectorAll('a, button');
                        for (const el of allElements) {
                            const text = el.textContent?.trim() || '';
                            if (
                                text.includes('下载PDF') ||
                                text.includes('PDF下载') ||
                                text.includes('下载') ||
                                (text.toLowerCase().includes('pdf') && text.includes('下载'))
                            ) {
                                pdfLink = el as HTMLElement;
                                Zotero.debug('[Patent] Found PDF button: ' + text);
                                break;
                            }
                        }
                    }

                    if (pdfLink) {
                        pdfLink.click();
                        Zotero.debug('[Patent] PDF download clicked');
                    } else {
                        Zotero.debug('[Patent] PDF button not found');
                        // Log all button/link text for debugging
                        const allElements = doc.querySelectorAll('a, button');
                        for (const el of allElements) {
                            const text = el.textContent?.trim() || '';
                            if (text.length > 0 && text.length < 50) {
                                Zotero.debug('[Patent] Element text: ' + text);
                            }
                        }
                    }
                } else {
                    Zotero.debug('[Patent] No results found');
                }
            } else {
                Zotero.debug('[Patent] Search button not found, trying Enter key');

                // Try multiple ways to submit
                try {
                    // Use direct JavaScript execution to search - more reliable than simulated events
                    Zotero.debug('[Patent] Trying direct JS search');

                    const searchJs = `
                    (function() {
                        // Find the search input
                        var input = document.querySelector('input[name="searchWord"]') || document.querySelector('#searchWord') || document.querySelector('input[type="text"]');
                        if (!input) return 'No input found';
                        
                        // Set value
                        input.value = "${searchTitle.replace(/"/g, '\\"')}";
                        
                        // Try to find and click the search button
                        var btnSelectors = ['input[type="submit"]', 'button[type="submit"]', 'input[value*="查询"]', 'input[value*="搜索"]', '.search-btn'];
                        for (var i = 0; i < btnSelectors.length; i++) {
                            var btn = document.querySelector(btnSelectors[i]);
                            if (btn) {
                                btn.click();
                                return 'Clicked button: ' + btnSelectors[i];
                            }
                        }
                        
                        // Try form submit
                        var form = input.form;
                        if (form) {
                            form.submit();
                            return 'Submitted form';
                        }
                        
                        // Try triggering Enter key properly
                        var event = new Event('keyup', {bubbles: true});
                        input.dispatchEvent(event);
                        
                        return 'Search triggered';
                    })()
                `;

                    try {
                        const result = win.eval(searchJs);
                        Zotero.debug('[Patent] JS search result: ' + result);
                    } catch (e) {
                        Zotero.debug('[Patent] JS search error: ' + e);
                    }

                    // Wait for results to load
                    await new Promise((resolve) => setTimeout(resolve, 5000));

                    // Check URL change
                    const currentUrl = win.location.href;
                    Zotero.debug('[Patent] Current URL after search: ' + currentUrl);

                    // Check input value
                    const inputValue = searchInput?.value || '';
                    Zotero.debug('[Patent] Input value after search: ' + inputValue);

                    // Wait and check results
                    const links = doc.querySelectorAll('a[href*="sw"], a[href*="detail"], a[href*="CNIPA"]');
                    Zotero.debug('[Patent] Results after Enter: ' + links.length + ' links');

                    // Debug: print page title and some content
                    const pageTitle = doc.title || 'no title';
                    const bodyText = doc.body?.innerText?.substring(0, 500) || 'no body';
                    Zotero.debug('[Patent] Page title: ' + pageTitle);
                    Zotero.debug('[Patent] Page body preview: ' + bodyText.substring(0, 200));

                    // Check for any table with results
                    const tables = doc.querySelectorAll('table');
                    Zotero.debug('[Patent] Found ' + tables.length + ' tables');

                    // Check for any links at all
                    const allLinks = doc.querySelectorAll('a');
                    Zotero.debug('[Patent] Total links on page: ' + allLinks.length);

                    // Try form submission directly
                    if (links.length === 0) {
                        const forms = doc.querySelectorAll('form');
                        Zotero.debug('[Patent] Found ' + forms.length + ' forms');

                        for (const form of forms) {
                            const action = form.getAttribute('action') || 'no action';
                            const method = form.getAttribute('method') || 'GET';
                            Zotero.debug('[Patent] Form action: ' + action + ', method: ' + method);

                            // Get all input fields
                            const inputs = form.querySelectorAll('input');
                            for (const input of inputs) {
                                const name = input.getAttribute('name') || 'unnamed';
                                const value = (input as HTMLInputElement).value || '';
                                Zotero.debug('[Patent] Form input: ' + name + ' = ' + value);
                            }
                        }
                    }
                } catch (e) {
                    Zotero.debug('[Patent] Search trigger error: ' + e);
                }
            }
        } else {
            Zotero.debug('[Patent] Search input not found');
            // Try executing JavaScript to search
            try {
                const script = `
                    document.querySelectorAll('input[type="text"]')[0].value = "${searchTitle}";
                    document.querySelectorAll('input[type="text"]')[0].dispatchEvent(new Event('input'));
                    document.querySelectorAll('input[type="text"]')[0].form.submit();
                `;
                win.eval(script);
                Zotero.debug('[Patent] Executed search via eval');
            } catch (e) {
                Zotero.debug('[Patent] Eval failed: ' + e);
            }
        }
    } catch (e) {
        Zotero.debug('[Patent] Automation error: ' + e);
    }
}

/**
 * Close the CNIPA browser window if open
 */
function closeCnipaBrowser() {
    if (cnipaWindow && isWindowAlive(cnipaWindow)) {
        try {
            cnipaWindow.close();
        } catch (e) {}
        cnipaWindow = null;
    }
}
