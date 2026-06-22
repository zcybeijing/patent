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
let sessionId = '';

/** 查找 Node.js */
export function findNodePath(): string | null {
    var env = Cc['@mozilla.org/process/environment;1'].getService(Ci.nsIEnvironment);
    var local = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);
    for (var d of (env.get('PATH') || '').split(';')) {
        try {
            local.initWithPath(d + '\\node.exe');
            if (local.exists()) return local.path;
        } catch (_) {}
    }
    var fallbacks = [
        'C:\\Program Files\\nodejs\\node.exe',
        'C:\\Program Files (x86)\\nodejs\\node.exe',
        env.get('ProgramFiles') + '\\nodejs\\node.exe',
    ];
    for (var p of fallbacks) {
        try {
            local.initWithPath(p);
            if (local.exists()) return p;
        } catch (_) {}
    }
    return null;
}

/** 写文件（nsIFile 写入 UTF-8） */
export function writeTextFile(path: string, content: string) {
    var file = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);
    file.initWithPath(path);
    var stream = Cc['@mozilla.org/network/file-output-stream;1'].createInstance(Ci.nsIFileOutputStream);
    stream.init(file, 0x02 | 0x08 | 0x20, 0o666, 0);
    var bos = Cc['@mozilla.org/binaryoutputstream;1'].createInstance(Ci.nsIBinaryOutputStream);
    bos.setOutputStream(stream);
    var bytes = [];
    for (var i = 0; i < content.length; i++) bytes.push(content.charCodeAt(i));
    bos.writeByteArray(bytes, bytes.length);
    bos.close();
    stream.close();
}

/** Node.js 辅助脚本：taskkill → 启动浏览器 → 等待 CDP 端口 → 写 ready */
const HELPER_TEMPLATE = [
    'const http=require("http"),fs=require("fs"),{spawn,execSync}=require("child_process");',
    'const R=__READY_PATH__,P=' + CDP_PORT + ';',
    'var e;',
    'var ps=["C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe","C:\\\\Program Files (x86)\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe","C:\\\\Program Files (x86)\\\\Microsoft\\\\Edge\\\\Application\\\\msedge.exe","C:\\\\Program Files\\\\Microsoft\\\\Edge\\\\Application\\\\msedge.exe"];',
    'for(var s of ps) if(fs.existsSync(s)){e=s;break}',
    'if(!e){fs.writeFileSync(R,JSON.stringify({status:"error",message:"Chrome and Edge not found"}));process.exit();}',
    'var browserName=e.toLowerCase().indexOf("chrome")>=0?"chrome":"msedge";',
    'try{execSync("taskkill /F /IM "+browserName+".exe",{stdio:"ignore"})}catch(_){}',
    'var d=process.env.TMP||process.env.TEMP||"C:\\\\Users\\\\Public\\\\Temp";',
    'd+="\\\\zoteropatent_cdp_"+Date.now();',
    'fs.mkdirSync(d,{recursive:true});',
    'var c=spawn(e,["--remote-debugging-port=' +
        CDP_PORT +
        '","--remote-allow-origins=*","--user-data-dir="+d,"--no-first-run","--no-default-browser-check","--disable-backgrounding-occluded-windows","--disable-background-networking","--disable-breakpad","--new-window","http://about:blank"],{detached:true,stdio:"ignore"});',
    'c.unref();',
    'var st=Date.now();',
    '(function w(){if(Date.now()-st>60000){fs.writeFileSync(R,JSON.stringify({status:"error",message:"timeout"}));return}',
    'var r=http.get("http://127.0.0.1:' +
        CDP_PORT +
        '/json/version",function(res){var d="";res.on("data",function(x){d+=x});res.on("end",function(){try{var v=JSON.parse(d);if(v.webSocketDebuggerUrl){fs.writeFileSync(R,JSON.stringify({status:"ok",wsUrl:v.webSocketDebuggerUrl}));return}}catch(_){}setTimeout(w,500)})});',
    'r.on("error",function(){setTimeout(w,500)});',
    'r.setTimeout(2000,function(){r.destroy();setTimeout(w,500)});',
    '})()',
].join('\n');

let readyFilePath = '';

/** 启动 Edge（通过 Node.js 辅助脚本） */
export async function launchBrowser(): Promise<boolean> {
    var nodePath = findNodePath();
    if (!nodePath) {
        Zotero.debug('[CDP] 未找到 Node.js');
        return false;
    }

    try {
        var tmpDir = Cc['@mozilla.org/file/directory_service;1'].getService(Ci.nsIProperties).get('TmpD', Ci.nsIFile);
        tmpDir.append('zoteropatent_cdp');
        if (!tmpDir.exists()) tmpDir.create(Ci.nsIFile.DIRECTORY_TYPE, 0o777);

        readyFilePath = tmpDir.path + '\\ready_' + Date.now() + '.json';
        var scriptPath = tmpDir.path + '\\helper_' + Date.now() + '.js';

        var helperCode = HELPER_TEMPLATE.replace('__READY_PATH__', JSON.stringify(readyFilePath));
        writeTextFile(scriptPath, helperCode);
        Zotero.debug('[CDP] Helper: ' + scriptPath);
        Zotero.debug('[CDP] Ready: ' + readyFilePath);

        var nodeFile = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);
        nodeFile.initWithPath(nodePath);
        var proc = Cc['@mozilla.org/process/util;1'].createInstance(Ci.nsIProcess);
        proc.init(nodeFile);
        proc.runwAsync([scriptPath], 1);

        Zotero.debug('[CDP] Node.js 辅助脚本已启动');
        return true;
    } catch (e) {
        Zotero.debug('[CDP] 启动失败: ' + e);
        return false;
    }
}

/** 读文件（nsIFile） */
export function readTextFile(path: string): string | null {
    try {
        var file = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);
        file.initWithPath(path);
        if (!file.exists()) return null;
        var stream = Cc['@mozilla.org/network/file-input-stream;1'].createInstance(Ci.nsIFileInputStream);
        stream.init(file, 0x01, 0, 0);
        var bis = Cc['@mozilla.org/binaryinputstream;1'].createInstance(Ci.nsIBinaryInputStream);
        bis.setInputStream(stream);
        var bytes = bis.readByteArray(bis.available());
        bis.close();
        stream.close();
        var text = '';
        for (var i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
        return text;
    } catch (_) {
        return null;
    }
}

/** 获取 WebSocket 调试 URL（从 helper 写入的 ready 文件中读取） */
async function getWsUrl(): Promise<string | null> {
    var start = Date.now();
    while (Date.now() - start < 60000) {
        if (!readyFilePath) {
            await new Promise(function (r) {
                setTimeout(r, 500);
            });
            continue;
        }
        var readyText = readTextFile(readyFilePath);
        if (readyText) {
            try {
                var readyState = JSON.parse(readyText);
                if (readyState.status === 'ok' && readyState.wsUrl) {
                    Zotero.debug('[CDP] WebSocket URL: ' + readyState.wsUrl);
                    return readyState.wsUrl;
                }
                if (readyState.status === 'error') {
                    Zotero.debug('[CDP] Helper 错误: ' + readyState.message);
                    return null;
                }
                // status=ok but no wsUrl yet — helper found CDP port but no page; wait
                Zotero.debug('[CDP] 等待页面就绪...');
            } catch (_) {}
        }
        await new Promise(function (r) {
            setTimeout(r, 1000);
        });
    }
    return null;
}

/** 发送 CDP 命令（自动注入 sessionId） */
function sendRaw(method: string, params: any, useSession: boolean): Promise<any> {
    if (!ws) throw new Error('CDP 未连接');
    return new Promise((resolve, reject) => {
        msgId++;
        var cmd: any = { id: msgId, method, params };
        if (useSession && sessionId) cmd.sessionId = sessionId;
        pending[msgId] = { resolve, reject };
        ws!.send(JSON.stringify(cmd));
    });
}

export async function sendCommand(method: string, params: any = {}): Promise<any> {
    // Target.* methods are browser-level (no session); everything else needs session
    var isBrowserMethod = method.startsWith('Target.');
    return sendRaw(method, params, !isBrowserMethod);
}

/** 连接到 CDP */
export async function connectCDP(): Promise<boolean> {
    var wsUrl = await getWsUrl();
    if (!wsUrl) {
        Zotero.debug('[CDP] 无法获取调试 URL');
        return false;
    }

    // Zotero bootstrap sandbox 没有全局 WebSocket，从主窗口获取
    var mainWin = Zotero.getMainWindow();
    var WS = mainWin.WebSocket;
    if (!WS) {
        Zotero.debug('[CDP] 主窗口无 WebSocket');
        return false;
    }

    return new Promise((resolve) => {
        try {
            ws = new WS(wsUrl);
            ws.onopen = function () {
                Zotero.debug('[CDP] 已连接');
            };
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
                    if (msg.method === 'Target.attachedToTarget' && msg.params?.sessionId) {
                        sessionId = msg.params.sessionId;
                    }
                } catch (_) {}
            };
            ws.onerror = function () {
                Zotero.debug('[CDP] 连接错误');
            };
            ws.onclose = function () {
                Zotero.debug('[CDP] 连接关闭');
                ws = null;
            };

            // 等待连接建立（onerror 只打日志，check 根据 ws 状态决定成败）
            var timeoutId = setTimeout(function () {
                ws = null;
                resolve(false);
            }, 10000);
            var check = function () {
                if (ws && ws.readyState === WS.OPEN) {
                    clearTimeout(timeoutId);
                    resolve(true);
                } else if (!ws) {
                    clearTimeout(timeoutId);
                    resolve(false);
                } else setTimeout(check, 200);
            };
            setTimeout(check, 200);
        } catch (e) {
            Zotero.debug('[CDP] 连接异常: ' + e);
            resolve(false);
        }
    });
}

/** 创建新页面（Tab）并附加 session */
export async function createTab(url: string): Promise<string> {
    var result = await sendCommand('Target.createTarget', { url });
    targetId = result.targetId;
    // 附加到目标以获取 sessionId（flatten 让 sessionId 直接在返回中）
    var attachResult = await sendCommand('Target.attachToTarget', { targetId, flatten: true });
    sessionId = attachResult.sessionId;
    Zotero.debug('[CDP] 目标已创建: ' + targetId + ', session: ' + sessionId);
    return targetId;
}

/** 查找已有的 CNIPA 标签页并附加 */
export async function findCnipaTabAndAttach(): Promise<boolean> {
    var result = await sendCommand('Target.getTargets', {});
    var targets = result.targetInfos || [];
    // 优先找 SwDetail 页面（真实点击后打开的新标签页）
    for (var t of targets) {
        if (t.url && t.url.indexOf('SwDetail') >= 0) {
            Zotero.debug('[CDP] 找到 SwDetail 页面: ' + t.targetId + ' url=' + t.url);
            targetId = t.targetId;
            var attachResult = await sendCommand('Target.attachToTarget', { targetId, flatten: true });
            sessionId = attachResult.sessionId;
            return true;
        }
    }
    // 找 egaz 页面（showpdf/filedl）
    for (var t of targets) {
        if (t.url && t.url.indexOf('egaz.cnipa.gov.cn') >= 0) {
            Zotero.debug('[CDP] 找到 egaz 页面: ' + t.targetId + ' url=' + t.url);
            targetId = t.targetId;
            var attachResult = await sendCommand('Target.attachToTarget', { targetId, flatten: true });
            sessionId = attachResult.sessionId;
            return true;
        }
    }
    // 降级：任何 CNIPA 页面
    for (var t of targets) {
        if (t.url && (t.url.indexOf('epub.cnipa.gov.cn') >= 0 || t.url.indexOf('cnipa.gov.cn') >= 0)) {
            Zotero.debug('[CDP] 找到 CNIPA 页面: ' + t.targetId + ' url=' + t.url);
            targetId = t.targetId;
            var attachResult = await sendCommand('Target.attachToTarget', { targetId, flatten: true });
            sessionId = attachResult.sessionId;
            Zotero.debug('[CDP] 已附加到 CNIPA 页面, session: ' + sessionId);
            return true;
        }
    }
    Zotero.debug('[CDP] 未找到 CNIPA 页面');
    return false;
}

/** 查找 CNIPA 查询结果页 Dxb/IndexQuery 并附加 */
export async function findCnipaIndexQueryTabAndAttach(): Promise<boolean> {
    var result = await sendCommand('Target.getTargets', {});
    var targets = result.targetInfos || [];
    for (var t of targets) {
        if (t.url && t.url.indexOf('Dxb/IndexQuery') >= 0) {
            Zotero.debug('[CDP] 找到 CNIPA 查询结果页: ' + t.targetId + ' url=' + t.url);
            targetId = t.targetId;
            var attachResult = await sendCommand('Target.attachToTarget', { targetId, flatten: true });
            sessionId = attachResult.sessionId;
            Zotero.debug('[CDP] 已附加到 CNIPA 查询结果页, session: ' + sessionId);
            return true;
        }
    }
    Zotero.debug('[CDP] 未找到 CNIPA 查询结果页');
    return false;
}

/** 查找 showpdf/filedl 标签页（egaz.cnipa.gov.cn）并附加 */
export async function findShowpdfTabAndAttach(): Promise<boolean> {
    var result = await sendCommand('Target.getTargets', {});
    var targets = result.targetInfos || [];
    for (var t of targets) {
        if (t.type === 'page' && t.url && (t.url.indexOf('showpdf') >= 0 || t.url.indexOf('filedl') >= 0)) {
            Zotero.debug('[CDP] 找到 showpdf/filedl 页面: ' + t.targetId + ' url=' + t.url);
            targetId = t.targetId;
            var attachResult = await sendCommand('Target.attachToTarget', { targetId, flatten: true });
            sessionId = attachResult.sessionId;
            Zotero.debug('[CDP] 已附加到 showpdf/filedl 页面, session: ' + sessionId);
            return true;
        }
    }
    return false;
}

/** 查找 egaz.cnipa.gov.cn 标签页（验证码页面）并附加，优先 showpdf/filedl 其次任何 egaz 页面 */
export async function findEgazTabAndAttach(): Promise<boolean> {
    var result = await sendCommand('Target.getTargets', {});
    var targets = result.targetInfos || [];
    // 优先 showpdf/filedl
    for (var t of targets) {
        if (t.type === 'page' && t.url && (t.url.indexOf('showpdf') >= 0 || t.url.indexOf('filedl') >= 0)) {
            Zotero.debug('[CDP] 找到 egaz showpdf/filedl: ' + t.targetId + ' url=' + t.url);
            targetId = t.targetId;
            var attachResult = await sendCommand('Target.attachToTarget', { targetId, flatten: true });
            sessionId = attachResult.sessionId;
            return true;
        }
    }
    // 其次任何 egaz.cnipa.gov.cn 页面
    for (var t of targets) {
        if (t.type === 'page' && t.url && t.url.indexOf('egaz.cnipa.gov.cn') >= 0) {
            Zotero.debug('[CDP] 找到 egaz 页面: ' + t.targetId + ' url=' + t.url);
            targetId = t.targetId;
            var attachResult = await sendCommand('Target.attachToTarget', { targetId, flatten: true });
            sessionId = attachResult.sessionId;
            Zotero.debug('[CDP] 已附加到 egaz 页面, session: ' + sessionId);
            return true;
        }
    }
    return false;
}

/** 附加到第一个可用页面标签页（about:blank 或其他），不创建新标签页 */
export async function attachToFirstTab(): Promise<boolean> {
    var result = await sendCommand('Target.getTargets', {});
    var targets = result.targetInfos || [];
    for (var t of targets) {
        if (t.type === 'page') {
            Zotero.debug('[CDP] 附加到页面: ' + t.targetId + ' url=' + t.url);
            targetId = t.targetId;
            var attachResult = await sendCommand('Target.attachToTarget', { targetId, flatten: true });
            sessionId = attachResult.sessionId;
            return true;
        }
    }
    return false;
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
        setTimeout(function () {
            ws?.removeEventListener('message', handler);
            resolve();
        }, 30000);
    });
}

/** 在页面中执行 JavaScript */
export async function evaluateJS(expression: string, awaitPromise: boolean = false): Promise<any> {
    var result = await sendCommand('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: awaitPromise,
    });
    if (result.exceptionDetails) {
        throw new Error('JS Error: ' + result.exceptionDetails.text);
    }
    return result.result?.value;
}

/** 查找页面元素并获取属性 */
export async function querySelector(selector: string, attr: string = 'outerHTML'): Promise<string | null> {
    var result = await evaluateJS(
        '(function(){var e=document.querySelector("' +
            selector.replace(/"/g, '\\"') +
            '");return e?e.' +
            attr +
            ':null})()',
    );
    return result;
}

/** 获取元素坐标（用于 CDP 真实鼠标点击） */
async function getElementRect(selector: string): Promise<{ x: number; y: number; w: number; h: number } | null> {
    var result = await evaluateJS(
        '(function(){var e=document.querySelector("' +
            selector.replace(/"/g, '\\"') +
            '");if(!e)return null;var r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})()',
    );
    return result;
}

/** 点击元素（通过 JS .click()） */
export async function clickElement(selector: string): Promise<boolean> {
    var result = await evaluateJS(
        '(function(){var e=document.querySelector("' +
            selector.replace(/"/g, '\\"') +
            '");if(!e)return false;e.click();return true})()',
    );
    return !!result;
}

/** 模拟真实鼠标点击（通过 CDP Input.dispatchMouseEvent） */
export async function clickElementReal(selector: string): Promise<boolean> {
    var rect = await getElementRect(selector);
    if (!rect) return false;
    await clickAtPoint(Math.round(rect.x + rect.w / 2), Math.round(rect.y + rect.h / 2));
    return true;
}

/** 获取第 N 个匹配元素的坐标（通过 querySelectorAll） */
async function getElementRectByIndex(
    selector: string,
    index: number,
): Promise<{ x: number; y: number; w: number; h: number } | null> {
    var result = await evaluateJS(
        '(function(){var e=document.querySelectorAll("' +
            selector.replace(/"/g, '\\"') +
            '");if(!e||!e[' +
            index +
            '])return null;var r=e[' +
            index +
            '].getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})()',
    );
    return result;
}

/** 通过真实鼠标点击第 N 个匹配元素（绕过弹窗拦截） */
export async function clickElementRealByIndex(selector: string, index: number): Promise<boolean> {
    var rect = await getElementRectByIndex(selector, index);
    if (!rect) return false;
    await clickAtPoint(Math.round(rect.x + rect.w / 2), Math.round(rect.y + rect.h / 2));
    return true;
}

/** 在指定坐标执行真实鼠标点击 */
export async function clickAtPoint(x: number, y: number): Promise<void> {
    await sendCommand('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: x,
        y: y,
        button: 'left',
        clickCount: 1,
    });
    await new Promise(function (r) {
        setTimeout(r, 80);
    });
    await sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: x,
        y: y,
        button: 'left',
        clickCount: 1,
    });
}

/** 填充输入框 */
export async function fillInput(selector: string, value: string): Promise<boolean> {
    var result = await evaluateJS(
        '(function(){var e=document.querySelector("' +
            selector.replace(/"/g, '\\"') +
            '");if(!e)return false;e.value="' +
            value.replace(/"/g, '\\"') +
            '";e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}));return true})()',
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
        await new Promise(function (r) {
            setTimeout(r, 500);
        });
    }
    return false;
}

/** 关闭当前标签页 */
export async function closeCurrentTab(): Promise<void> {
    if (targetId) {
        try {
            await sendCommand('Target.closeTarget', { targetId });
            targetId = '';
            sessionId = '';
            Zotero.debug('[CDP] 已关闭当前标签页');
        } catch (e) {
            Zotero.debug('[CDP] 关闭标签页失败: ' + e);
        }
    }
}

/** 关闭浏览器 */
export async function closeBrowser(): Promise<void> {
    if (ws) {
        try {
            ws.close();
        } catch (_) {}
        ws = null;
    }
    try {
        var req = Cc['@mozilla.org/xmlextras/xmlhttprequest;1'].createInstance(Ci.nsIXMLHttpRequest);
        req.open('GET', 'http://127.0.0.1:' + CDP_PORT + '/json/close/' + targetId, false);
        req.send(null);
    } catch (_) {}
}

/** CDP 是否已连接（浏览器未关闭） */
export function isConnected(): boolean {
    return ws !== null && ws.readyState === 1;
}

/** 断开 CDP 连接 */
export async function disconnectCDP(): Promise<void> {
    await closeBrowser();
}
