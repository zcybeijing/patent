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
