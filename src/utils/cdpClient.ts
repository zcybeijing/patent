/**
 * CDP (Chrome DevTools Protocol) 浏览器自动化客户端
 * 用于控制 Chrome/Edge 浏览器实现 CNIPA 自动化
 */

// 调试端口
const CDP_PORT = 19222;

/** CDP WebSocket 连接 */
let ws: WebSocket | null = null;
let msgId = 0;
let pending: Record<number, { resolve: (v: any) => void; reject: (e: any) => void }> = {};
let targetId = '';

/** 查找 Chrome/Edge 可执行文件路径 */
function findBrowserPath(): string | null {
    const paths: string[] = [];
    // Edge
    paths.push('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
    paths.push('C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe');
    // Chrome
    paths.push('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
    paths.push('C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe');
    // 环境变量
    const local = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);
    for (const p of paths) {
        local.initWithPath(p);
        if (local.exists()) return p;
    }
    return null;
}

/** 启动浏览器（带远程调试端口） */
export async function launchBrowser(): Promise<boolean> {
    const browserPath = findBrowserPath();
    if (!browserPath) {
        Zotero.debug('[CDP] 未找到 Chrome/Edge 浏览器');
        return false;
    }
    Zotero.debug('[CDP] 浏览器: ' + browserPath);

    try {
        const tmpDir = Cc['@mozilla.org/file/directory_service;1'].getService(Ci.nsIProperties).get('TmpD', Ci.nsIFile);
        tmpDir.append('zoteropatent_cdp');

        var process = Cc['@mozilla.org/process/util;1'].createInstance(Ci.nsIProcess);
        var file = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);
        file.initWithPath(browserPath);
        process.init(file);

        var args = [
            '--remote-debugging-port=' + CDP_PORT,
            '--user-data-dir=' + tmpDir.path,
            '--no-first-run',
            '--no-default-browser-check',
        ];
        // 异步启动（不阻塞）
        process.runwAsync(args, args.length);
        Zotero.debug('[CDP] 浏览器已启动，端口: ' + CDP_PORT);
        return true;
    } catch (e) {
        Zotero.debug('[CDP] 启动失败: ' + e);
        return false;
    }
}

/** 获取 WebSocket 调试 URL */
async function getWsUrl(): Promise<string | null> {
    for (let i = 0; i < 30; i++) {
        try {
            var req = Cc['@mozilla.org/xmlextras/xmlhttprequest;1'].createInstance(Ci.nsIXMLHttpRequest);
            req.open('GET', 'http://127.0.0.1:' + CDP_PORT + '/json/version', false);
            req.send(null);
            if (req.status === 200) {
                var resp = JSON.parse(req.responseText);
                if (resp.webSocketDebuggerUrl) {
                    Zotero.debug('[CDP] WebSocket URL: ' + resp.webSocketDebuggerUrl);
                    return resp.webSocketDebuggerUrl;
                }
            }
        } catch (_) {}
        // 等待浏览器启动
        Zotero.debug('[CDP] 等待浏览器就绪...');
        syncSleep(500);
    }
    return null;
}

function syncSleep(ms: number) {
    var start = Date.now();
    while (Date.now() - start < ms) {}
}

/** 发送 CDP 命令 */
export async function sendCommand(method: string, params: any = {}): Promise<any> {
    if (!ws) throw new Error('CDP 未连接');
    return new Promise((resolve, reject) => {
        msgId++;
        var cmd = JSON.stringify({ id: msgId, method, params });
        pending[msgId] = { resolve, reject };
        ws!.send(cmd);
    });
}

/** 连接到 CDP */
export async function connectCDP(): Promise<boolean> {
    var wsUrl = await getWsUrl();
    if (!wsUrl) { Zotero.debug('[CDP] 无法获取调试 URL'); return false; }

    return new Promise((resolve) => {
        try {
            ws = new WebSocket(wsUrl);
            ws.onopen = function () { Zotero.debug('[CDP] 已连接'); };
            ws.onmessage = function (e) {
                try {
                    var msg = JSON.parse(e.data);
                    if (msg.id && pending[msg.id]) {
                        pending[msg.id].resolve(msg.result);
                        delete pending[msg.id];
                    }
                    if (msg.method === 'Target.targetCreated' && msg.params?.targetInfo?.type === 'page') {
                        targetId = msg.params.targetInfo.targetId;
                    }
                } catch (_) {}
            };
            ws.onerror = function () { Zotero.debug('[CDP] 连接错误'); resolve(false); };
            ws.onclose = function () { Zotero.debug('[CDP] 连接关闭'); ws = null; };

            // 等待连接建立
            var check = function () {
                if (ws && ws.readyState === WebSocket.OPEN) resolve(true);
                else if (!ws) resolve(false);
                else setTimeout(check, 200);
            };
            setTimeout(check, 200);
            setTimeout(function () { resolve(false); }, 10000);
        } catch (e) { Zotero.debug('[CDP] 连接异常: ' + e); resolve(false); }
    });
}

/** 创建新页面（Tab） */
export async function createTab(url: string): Promise<string> {
    var result = await sendCommand('Target.createTarget', { url });
    targetId = result.targetId;
    return targetId;
}

/** 导航到 URL */
export async function navigateTo(url: string): Promise<void> {
    await sendCommand('Page.enable', {});
    await sendCommand('Page.navigate', { url });
    // 等待页面加载
    await new Promise<void>((resolve) => {
        var handler = function (e: MessageEvent) {
            try {
                var msg = JSON.parse(e.data);
                if (msg.method === 'Page.frameStoppedLoading') {
                    ws?.removeEventListener('message', handler);
                    resolve();
                }
            } catch (_) {}
        };
        ws?.addEventListener('message', handler);
        setTimeout(function () { ws?.removeEventListener('message', handler); resolve(); }, 30000);
    });
}

/** 在页面中执行 JavaScript */
export async function evaluateJS(expression: string): Promise<any> {
    var result = await sendCommand('Runtime.evaluate', {
        expression,
        returnByValue: true,
    });
    if (result.exceptionDetails) {
        throw new Error('JS Error: ' + result.exceptionDetails.text);
    }
    return result.result?.value;
}

/** 查找页面元素并获取属性 */
export async function querySelector(selector: string, attr: string = 'outerHTML'): Promise<string | null> {
    var result = await evaluateJS(
        '(function(){var e=document.querySelector("' + selector.replace(/"/g, '\\"') + '");return e?e.' + attr + ':null})()'
    );
    return result;
}

/** 点击元素 */
export async function clickElement(selector: string): Promise<boolean> {
    var result = await evaluateJS(
        '(function(){var e=document.querySelector("' + selector.replace(/"/g, '\\"') + '");if(!e)return false;e.click();return true})()'
    );
    return !!result;
}

/** 填充输入框 */
export async function fillInput(selector: string, value: string): Promise<boolean> {
    var result = await evaluateJS(
        '(function(){var e=document.querySelector("' + selector.replace(/"/g, '\\"') + '");if(!e)return false;e.value="' + value.replace(/"/g, '\\"') + '";e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}));return true})()'
    );
    return !!result;
}

/** 获取页面文本 */
export async function getPageText(): Promise<string> {
    return (await evaluateJS('document.body?document.body.innerText:""')) || '';
}

/** 等待元素出现 */
export async function waitForElement(selector: string, timeoutMs: number = 15000): Promise<boolean> {
    var start = Date.now();
    while (Date.now() - start < timeoutMs) {
        var result = await evaluateJS('document.querySelector("' + selector.replace(/"/g, '\\"') + '")?true:false');
        if (result) return true;
        syncSleep(500);
    }
    return false;
}

/** 关闭浏览器 */
export async function closeBrowser(): Promise<void> {
    if (ws) { try { ws.close(); } catch (_) {} ws = null; }
    try {
        var req = Cc['@mozilla.org/xmlextras/xmlhttprequest;1'].createInstance(Ci.nsIXMLHttpRequest);
        req.open('GET', 'http://127.0.0.1:' + CDP_PORT + '/json/close/' + targetId, false);
        req.send(null);
    } catch (_) {}
}

/** 断开 CDP 连接 */
export async function disconnectCDP(): Promise<void> {
    await closeBrowser();
}
