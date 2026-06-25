/**
 * UI 助手：通知与选择对话框实现
 *
 * 实现策略：
 * 1. 如果模板提供 ztoolkit.Dialog.select（或类似的选择对话 API），优先使用；
 * 2. 否则在主窗口使用 window.prompt 显示带编号的列表，用户输入编号选择（兼容性高）；
 * 3. 如无可用 UI 环境，返回第一项（便于自动化测试 / 早期迭代）。
 *
 * 注意：你可以将 ztoolkit 的真实选择对话方法名替换到下面的分支中以获得更好的交互体验。
 */

export function showNotification(message: string) {
    // 模板通常提供 ztoolkit.notify
    // @ts-expect-error
    if (typeof ztoolkit !== 'undefined' && ztoolkit.notify) {
        // @ts-expect-error
        ztoolkit.notify(message);
    } else {
        Zotero.debug(message);
    }
}

/**
 * askUserToPick:
 * - items: 带 title（可选）和其他字段的数组
 * - title: 对话框标题
 *
 * 返回选中的项或 undefined（取消）
 */
export async function askUserToPick<T extends { title?: string }>(
    items: T[],
    title = '请选择一项',
): Promise<T | undefined> {
    if (!items || items.length === 0) return undefined;
    if (items.length === 1) return items[0];

    // 1) 优先：使用 ztoolkit 的选择对话（如果模板提供）
    try {
        // @ts-expect-error - 尝试使用模板可能提供的 Dialog.select / Dialog.listSelect 等 API
        if (typeof ztoolkit !== 'undefined' && ztoolkit.Dialog) {
            // 常见实现可能是 ztoolkit.Dialog.select(options) -> 返回索引或值
            // 下面尝试若干常见方法名，按存在性调用
            const labels = items.map((it, i) => ({
                label: it.title || `第 ${i + 1} 项`,
                value: i,
            }));
            // @ts-expect-error
            if (typeof ztoolkit.Dialog.select === 'function') {
                // 假设返回选中 value 或索引
                // @ts-expect-error
                const r = await ztoolkit.Dialog.select({
                    title,
                    items: labels,
                });
                if (r === undefined || r === null) return undefined;
                const idx = typeof r === 'number' ? r : typeof r.value === 'number' ? r.value : parseInt(String(r));
                if (!Number.isNaN(idx) && idx >= 0 && idx < items.length) return items[idx];
            }
            // @ts-expect-error
            if (typeof ztoolkit.Dialog.listSelect === 'function') {
                // @ts-expect-error
                const idx = await ztoolkit.Dialog.listSelect(title, labels);
                if (typeof idx === 'number' && idx >= 0 && idx < items.length) return items[idx];
            }
        }
    } catch (e) {
        // 忽略并回退到 prompt
        Zotero.debug('ztoolkit.Dialog 选择对话使用失败，回退到 prompt: ' + (e?.message || e));
    }

    // 2) 回退：在 window.prompt 中显示带编号的简易选择（最多显示前 10 项）
    try {
        if (typeof window !== 'undefined' && typeof window.prompt === 'function') {
            const max = Math.min(items.length, 10);
            const lines = items.slice(0, max).map((it, i) => `${i + 1}. ${it.title ?? '(无标题)'}`);
            if (items.length > max) lines.push(`... 还有 ${items.length - max} 项未显示`);
            const message = `${title}\n\n${lines.join('\n')}\n\n请输入编号 (1-${max})，取消或留空返回取消：`;
            const input = window.prompt(message, '');
            if (input === null) return undefined; // 用户按取消
            const num = parseInt(input.trim(), 10);
            if (!Number.isNaN(num) && num >= 1 && num <= max) return items[num - 1];
            return undefined;
        }
    } catch (e) {
        Zotero.debug('window.prompt 选择对话使用失败: ' + (e?.message || e));
    }

    // 3) 最后回退：返回第一项以便不中断流程（可根据需要改为返回 undefined）
    return items[0];
}

export async function showInputDialog(prompt: string, defaultVal?: string): Promise<string | null> {
    var mainWin = Zotero.getMainWindow();
    if (!mainWin) return null;
    return new Promise(function (resolve) {
        Services.tm.mainThread.dispatch(async function () {
            try {
                var result = mainWin.prompt(prompt, defaultVal || '');
                resolve(result || null);
            } catch (e) {
                resolve(null);
            }
        }, Ci.nsIThread.DISPATCH_NORMAL);
    });
}

export async function showCaptchaDialog(base64Image: string): Promise<string | null> {
    Zotero.debug('[Patent] showCaptchaDialog: 创建验证码输入浮层');
    var mainWin = Zotero.getMainWindow();
    if (!mainWin) return null;
    var doc = mainWin.document;
    if (!doc) return null;
    var overlay = doc.createElementNS('http://www.w3.org/1999/xhtml', 'div');
    overlay.setAttribute(
        'style',
        'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center;',
    );
    var box = doc.createElementNS('http://www.w3.org/1999/xhtml', 'div');
    box.setAttribute(
        'style',
        'background:#fff;border-radius:8px;padding:20px;min-width:320px;text-align:center;font-family:sans-serif;',
    );
    var heading = doc.createElementNS('http://www.w3.org/1999/xhtml', 'h3');
    heading.textContent = '请输入验证码';
    box.appendChild(heading);
    var img = doc.createElementNS('http://www.w3.org/1999/xhtml', 'img');
    img.setAttribute('src', base64Image);
    img.setAttribute('style', 'max-width:280px;margin:10px 0;border:1px solid #ccc;');
    box.appendChild(img);
    var input = doc.createElementNS('http://www.w3.org/1999/xhtml', 'input');
    input.setAttribute('type', 'text');
    input.setAttribute(
        'style',
        'width:200px;padding:8px;font-size:16px;margin:10px 0;display:block;margin-left:auto;margin-right:auto;',
    );
    box.appendChild(input);
    var btnBox = doc.createElementNS('http://www.w3.org/1999/xhtml', 'div');
    btnBox.setAttribute('style', 'display:flex;gap:10px;justify-content:center;');
    var okBtn = doc.createElementNS('http://www.w3.org/1999/xhtml', 'button');
    okBtn.textContent = '确定';
    okBtn.setAttribute('style', 'padding:8px 24px;font-size:14px;cursor:pointer;');
    btnBox.appendChild(okBtn);
    var cancelBtn = doc.createElementNS('http://www.w3.org/1999/xhtml', 'button');
    cancelBtn.textContent = '取消';
    cancelBtn.setAttribute('style', 'padding:8px 24px;font-size:14px;cursor:pointer;');
    btnBox.appendChild(cancelBtn);
    box.appendChild(btnBox);
    overlay.appendChild(box);
    doc.documentElement.appendChild(overlay);
    input.focus();
    return new Promise(function (resolve) {
        function cleanup() {
            try {
                if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            } catch (_) {}
        }
        okBtn.addEventListener('click', function () {
            var val = input.value.trim();
            if (!val) {
                input.focus();
                return;
            }
            cleanup();
            resolve(val);
        });
        cancelBtn.addEventListener('click', function () {
            cleanup();
            resolve(null);
        });
        input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                okBtn.click();
            }
            if (e.key === 'Escape') {
                cancelBtn.click();
            }
        });
        setTimeout(function () {
            input.focus();
        }, 100);
    });
}
