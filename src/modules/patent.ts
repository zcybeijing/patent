import { config } from '../../package.json';
import { showNotification, showInputDialog, showCaptchaDialog, askUserToPick } from '../utils/uiHelpers';
import {
    searchCnipaByTitle,
    fetchPatentDetailPdfUrl,
    fetchPatentDetails,
    cnipaGetPdfUrlViaCdp,
    downloadPdfViaCdp,
    PatentSearchResult,
} from '../utils/cnipaClient';
import { getAttachments, extractPatentInfoFromPdf, PatentMetadata } from '../utils/pdfHelpers';
import * as cdp from '../utils/cdpClient';

let menuElements: Element[] = [];

export function registerMenu() {
    Zotero.debug('[Patent] registerMenu called');

    const doc = Zotero.getMainWindow().document;
    if (!doc) {
        Zotero.debug('[Patent] ERROR: main window document not available');
        return;
    }
    const popup = doc.getElementById('zotero-itemmenu');

    if (!popup) {
        Zotero.debug('[Patent] ERROR: zotero-itemmenu popup not found!');
        return;
    }

    menuElements.forEach((el) => el.remove());
    menuElements = [];

    // Separator
    const separator = doc.createXULElement('menuseparator');
    separator.id = config.addonRef + '-separator';
    popup.appendChild(separator);
    menuElements.push(separator);

    // Metadata menu item
    const metadataItem = doc.createXULElement('menuitem');
    metadataItem.id = config.addonRef + '-get-metadata';
    metadataItem.setAttribute('label', '获取专利元数据');
    metadataItem.setAttribute('image', 'chrome://zoteroPatent/content/icons/favicon.png');
    metadataItem.addEventListener('command', async () => {
        Zotero.debug('[Patent] metadata menu clicked');
        const items = Zotero.getActiveZoteroPane().getSelectedItems();
        if (items.length > 0) {
            await handleGetMetadata(items[0]);
        }
    });
    popup.appendChild(metadataItem);
    menuElements.push(metadataItem);

    // Get patent file (CDP browser automation + PDF download)
    const fileItem = doc.createXULElement('menuitem');
    fileItem.id = config.addonRef + '-get-file';
    fileItem.setAttribute('label', '查询并下载专利文件');
    fileItem.setAttribute('image', 'chrome://zoteroPatent/content/icons/favicon.png');
    fileItem.addEventListener('command', async () => {
        Zotero.debug('[Patent] get-file menu clicked');
        const items = Zotero.getActiveZoteroPane().getSelectedItems();
        if (items.length === 0) {
            showNotification('请选中一个专利条目');
            return;
        }
        const item = items[0];
        const title = item.getField ? item.getField('title') : item.title;
        if (!title) {
            showNotification('条目没有标题');
            return;
        }
        // Show input dialog for patent name before CDP
        var searchTitle = await showInputDialog('请输入专利申请号或名称', title);
        if (!searchTitle) {
            showNotification('已取消');
            return;
        }
        showNotification('正在查询并下载专利 PDF……');
        try {
            const pdfUrl = await cnipaGetPdfUrlViaCdp(searchTitle);
            if (pdfUrl) {
                // 用 CDP 浏览器下载（有 CNIPA 会话，避免 502）
                const safeTitle = (title || 'patent')
                    .replace(/[/\\?%*:|"<>]/g, '')
                    .replace(/\s+/g, '_')
                    .substring(0, 100);
                const filename = safeTitle + '.pdf';
                const tmpDir = Cc['@mozilla.org/file/directory_service;1']
                    .getService(Ci.nsIProperties)
                    .get('TmpD', Ci.nsIFile);
                tmpDir.append('zoteropatent');
                if (!tmpDir.exists()) tmpDir.create(Ci.nsIFile.DIRECTORY_TYPE, 0o777);
                const tmpFile = tmpDir.clone();
                tmpFile.append(filename);
                const savePath = tmpFile.path;
                const downloaded = await downloadPdfViaCdp(pdfUrl, savePath);
                if (downloaded) {
                    // 移除旧的 PDF 附件
                    const oldAttachments = await getAttachments(item);
                    for (const old of oldAttachments) {
                        let ct = '';
                        if (old.attachmentContentType) ct = old.attachmentContentType;
                        else if (typeof old.getField === 'function')
                            try {
                                ct = old.getField('contentType') || '';
                            } catch {}
                        if (ct === 'application/pdf') {
                            Zotero.debug('[Patent] 移除旧附件: ' + old.id);
                            await Zotero.Items.erase(old.id);
                        }
                    }
                    await Zotero.Attachments.importFromFile({ file: savePath, parentItemID: item.id });
                    showNotification('PDF 已下载并附加到条目');
                } else {
                    showNotification('CDP 下载未能完成，请手动处理');
                }
            } else {
                showNotification('未能获取 PDF 下载地址');
            }
        } catch (e) {
            Zotero.debug('[Patent] get-file error: ' + e);
            showNotification('查询失败：' + e);
        } finally {
            try {
                await cdp.quitBrowser();
                Zotero.debug('[Patent] CDP 浏览器已关闭');
            } catch (_) {}
        }
    });
    popup.appendChild(fileItem);
    menuElements.push(fileItem);

    // Batch metadata menu item
    const batchMetadataItem = doc.createXULElement('menuitem');
    batchMetadataItem.id = config.addonRef + '-batch-metadata';
    batchMetadataItem.setAttribute('label', '批量获取专利元数据');
    batchMetadataItem.setAttribute('image', 'chrome://zoteroPatent/content/icons/favicon.png');
    batchMetadataItem.addEventListener('command', async () => {
        Zotero.debug('[Patent] batch metadata menu clicked');
        const items = Zotero.getActiveZoteroPane().getSelectedItems();
        if (items.length > 0) {
            await handleBatchMetadata(items);
        }
    });
    popup.appendChild(batchMetadataItem);
    menuElements.push(batchMetadataItem);

    // Batch download menu item
    const batchFileItem = doc.createXULElement('menuitem');
    batchFileItem.id = config.addonRef + '-batch-file';
    batchFileItem.setAttribute('label', '批量获取专利文件');
    batchFileItem.setAttribute('image', 'chrome://zoteroPatent/content/icons/favicon.png');
    batchFileItem.addEventListener('command', async () => {
        Zotero.debug('[Patent] batch file menu clicked');
        const items = Zotero.getActiveZoteroPane().getSelectedItems();
        if (items.length > 0) {
            await handleBatchDownload(items);
        }
    });
    popup.appendChild(batchFileItem);
    menuElements.push(batchFileItem);

    // Show/hide menus based on selection
    popup.addEventListener('popupshowing', () => {
        const items = Zotero.getActiveZoteroPane().getSelectedItems();
        const hasPatent = items.some((item: any) => item.itemType === 'patent');
        separator.hidden = !hasPatent;
        fileItem.hidden = !hasPatent;
        metadataItem.hidden = !hasPatent;
        batchMetadataItem.hidden = !hasPatent || items.length < 2;
        batchFileItem.hidden = !hasPatent || items.length < 2;
        Zotero.debug('[Patent] popupshowing: hasPatent=' + hasPatent + ', count=' + items.length);
    });

    Zotero.debug('[Patent] menus registered successfully');
}

export function unregisterMenu() {
    Zotero.debug('[Patent] unregisterMenu called');
    menuElements.forEach((el) => el.remove());
    menuElements = [];
}

async function handleGetMetadata(item: any) {
    Zotero.debug('[Patent] handleGetMetadata called');
    if (!item) {
        showNotification('未选中条目');
        return;
    }

    const itemTypeID = item.itemTypeID;
    const itemTypeName = item.itemType;
    Zotero.debug('[Patent] itemTypeID: ' + itemTypeID + ', itemTypeName: ' + itemTypeName);

    const patentTypeID = Zotero.ItemTypes.getID('patent');
    if (itemTypeID !== patentTypeID && itemTypeName?.toLowerCase() !== 'patent') {
        Zotero.debug('[Patent] Not a patent item, itemTypeID: ' + itemTypeID + ', patentTypeID: ' + patentTypeID);
        showNotification('请选中类型为专利的条目');
        return;
    }

    showNotification('正在获取专利元数据...');

    try {
        const attachments = await getAttachments(item);
        Zotero.debug('[Patent] Found ' + attachments.length + ' attachments');

        let pdfAttachment = null;
        for (const att of attachments) {
            try {
                let filename = '';
                let contentType = '';

                if (typeof att.getFilename === 'function') {
                    filename = await att.getFilename();
                } else if (typeof att.getField === 'function') {
                    try {
                        filename = att.getField('filename') || '';
                    } catch {}
                }
                if (!filename && att.attachmentFilename) {
                    filename = att.attachmentFilename;
                }

                if (att.attachmentContentType) {
                    contentType = att.attachmentContentType;
                } else if (typeof att.getField === 'function') {
                    try {
                        contentType = att.getField('contentType') || '';
                    } catch {}
                }

                Zotero.debug('[Patent] Attachment: filename=' + filename + ', contentType=' + contentType);

                if (contentType === 'application/pdf' || filename?.toLowerCase().endsWith('.pdf')) {
                    pdfAttachment = att;
                    break;
                }
            } catch (e) {
                Zotero.debug('[Patent] Error checking attachment: ' + e);
            }
        }

        if (pdfAttachment) {
            Zotero.debug('[Patent] Found PDF attachment, extracting metadata...');
            const metadata = await extractPatentInfoFromPdf(pdfAttachment);
            if (metadata && (metadata.title || metadata.pubNumber || metadata.inventors?.length)) {
                await applyMetadataFromPdf(item, metadata);
                showNotification('已从PDF提取并更新元数据');
                return;
            } else {
                showNotification('从PDF未提取到有效元数据，将尝试从网络搜索...');
            }
        } else {
            Zotero.debug('[Patent] No PDF attachment found, searching online...');
        }

        const title = item.getField ? item.getField('title') : item.title;
        if (!title) {
            showNotification('条目没有标题，无法搜索');
            return;
        }
        showNotification('正在从中国专利网搜索……');
        const results = await searchCnipaByTitle(title);
        if (!results || results.length === 0) {
            showNotification('未找到匹配的专利');
            return;
        }
        const chosen: PatentSearchResult =
            results.length === 1 ? results[0] : await askUserToPick(results, '选择专利记录');
        if (!chosen) return;

        // 获取详情页完整元数据
        if (chosen.detailUrl) {
            showNotification('正在获取专利详情……');
            const details = await fetchPatentDetails(chosen.detailUrl);
            Object.assign(chosen, details);
        }

        await applyMetadataToItem(item, chosen);
        showNotification('已更新条目元数据');
    } catch (err: any) {
        Zotero.debug('获取专利元数据失败: ' + (err.message || err));
        showNotification('获取专利元数据失败：' + (err.message || err));
    }
}

async function handleBatchMetadata(items: any[]) {
    Zotero.debug('[Patent] handleBatchMetadata called, count: ' + items.length);

    const patentTypeID = Zotero.ItemTypes.getID('patent');
    const patentItems = items.filter((item: any) => {
        const itemTypeID = item.itemTypeID;
        const itemTypeName = item.itemType;
        return itemTypeID === patentTypeID || itemTypeName?.toLowerCase() === 'patent';
    });

    if (patentItems.length === 0) {
        showNotification('请选中专利类型的条目');
        return;
    }

    showNotification('正在批量提取 ' + patentItems.length + ' 个条目的PDF元数据...');

    let successCount = 0;
    let failCount = 0;
    const skippedItems: string[] = [];

    for (let i = 0; i < patentItems.length; i++) {
        const item = patentItems[i];
        const title = item.getField ? item.getField('title') : item.title;
        Zotero.debug('[Patent] Processing ' + (i + 1) + '/' + patentItems.length + ': ' + title);

        try {
            const attachments = await getAttachments(item);

            let pdfAttachment = null;
            for (const att of attachments) {
                try {
                    let filename = '';
                    let contentType = '';

                    if (typeof att.getFilename === 'function') {
                        filename = await att.getFilename();
                    } else if (typeof att.getField === 'function') {
                        try {
                            filename = att.getField('filename') || '';
                        } catch {}
                    }
                    if (!filename && att.attachmentFilename) {
                        filename = att.attachmentFilename;
                    }

                    if (att.attachmentContentType) {
                        contentType = att.attachmentContentType;
                    } else if (typeof att.getField === 'function') {
                        try {
                            contentType = att.getField('contentType') || '';
                        } catch {}
                    }

                    if (contentType === 'application/pdf' || filename?.toLowerCase().endsWith('.pdf')) {
                        pdfAttachment = att;
                        break;
                    }
                } catch (e) {
                    Zotero.debug('[Patent] Error checking attachment: ' + e);
                }
            }

            if (!pdfAttachment) {
                skippedItems.push(title || 'Unknown');
                failCount++;
                continue;
            }

            const metadata = await extractPatentInfoFromPdf(pdfAttachment);
            if (metadata && (metadata.title || metadata.pubNumber || metadata.inventors?.length)) {
                await applyMetadataFromPdf(item, metadata);
                successCount++;
                Zotero.debug('[Patent] Successfully extracted metadata for: ' + title);
            } else {
                skippedItems.push(title || 'Unknown');
                failCount++;
            }
        } catch (err: any) {
            Zotero.debug('[Patent] Error processing item: ' + (err.message || err));
            skippedItems.push(title || 'Unknown');
            failCount++;
        }
    }

    let message = '完成：成功 ' + successCount + ' 个';
    if (failCount > 0) {
        message += '，失败 ' + failCount + ' 个';
    }
    if (skippedItems.length > 0) {
        message += '（无PDF: ' + skippedItems.slice(0, 3).join(', ') + (skippedItems.length > 3 ? '...' : '') + ')';
    }
    showNotification(message);
}

async function handleBatchDownload(items: any[]) {
    Zotero.debug('[Patent] handleBatchDownload called, count: ' + items.length);

    const patentTypeID = Zotero.ItemTypes.getID('patent');
    const patentItems = items.filter((item: any) => {
        const itemTypeID = item.itemTypeID;
        const itemTypeName = item.itemType;
        return itemTypeID === patentTypeID || itemTypeName?.toLowerCase() === 'patent';
    });

    if (patentItems.length === 0) {
        showNotification('请选中专利类型的条目');
        return;
    }

    showNotification('正在批量下载 ' + patentItems.length + ' 个专利文件...');

    let successCount = 0;
    let failCount = 0;
    const failedItems: string[] = [];

    for (let i = 0; i < patentItems.length; i++) {
        const item = patentItems[i];
        const title = item.getField ? item.getField('title') : item.title;
        Zotero.debug('[Patent] Batch downloading ' + (i + 1) + '/' + patentItems.length + ': ' + title);

        // Check if item already has a PDF attachment
        try {
            const attachments = await getAttachments(item);
            let hasPdf = false;
            for (const att of attachments) {
                let filename = '';
                let contentType = '';
                if (typeof att.getFilename === 'function') {
                    filename = await att.getFilename();
                } else if (typeof att.getField === 'function') {
                    try {
                        filename = att.getField('filename') || '';
                    } catch {}
                }
                if (!filename && att.attachmentFilename) {
                    filename = att.attachmentFilename;
                }
                if (att.attachmentContentType) {
                    contentType = att.attachmentContentType;
                } else if (typeof att.getField === 'function') {
                    try {
                        contentType = att.getField('contentType') || '';
                    } catch {}
                }
                if (contentType === 'application/pdf' || filename?.toLowerCase().endsWith('.pdf')) {
                    hasPdf = true;
                    break;
                }
            }
            if (hasPdf) {
                Zotero.debug('[Patent] Item already has PDF, skipping: ' + title);
                successCount++;
                continue;
            }
        } catch (e) {
            Zotero.debug('[Patent] Error checking attachments: ' + e);
        }

        // Try to download PDF
        try {
            const appNumber = item.getField ? item.getField('applicationNumber') : item.applicationNumber;
            const searchTerm = appNumber ? `${title} ${appNumber}` : title;

            let pdfUrl: string | undefined;

            // Try HTTP first
            try {
                const results = await searchCnipaByTitle(searchTerm);
                if (results && results.length > 0) {
                    const chosen = results[0];
                    pdfUrl = await fetchPatentDetailPdfUrl(chosen.detailUrl);
                }
            } catch (err: any) {
                Zotero.debug('[Patent] HTTP search failed for: ' + title + ', ' + (err.message || err));
            }

            // Fallback to CDP
            if (!pdfUrl) {
                try {
                    pdfUrl = await cnipaGetPdfUrlViaCdp(title);
                } catch (err: any) {
                    Zotero.debug('[Patent] CDP failed for: ' + title + ', ' + (err.message || err));
                }
            }

            if (pdfUrl) {
                const safeTitle = (title || 'patent')
                    .replace(/[/\\?%*:|"<>]/g, '')
                    .replace(/\s+/g, '_')
                    .substring(0, 100);
                const filename = safeTitle + '.pdf';
                const tmpDir = Cc['@mozilla.org/file/directory_service;1']
                    .getService(Ci.nsIProperties)
                    .get('TmpD', Ci.nsIFile);
                tmpDir.append('zoteropatent');
                if (!tmpDir.exists()) tmpDir.create(Ci.nsIFile.DIRECTORY_TYPE, 0o777);
                const tmpFile = tmpDir.clone();
                tmpFile.append(filename);
                const savePath = tmpFile.path;
                const downloaded = await downloadPdfViaCdp(pdfUrl, savePath);
                if (downloaded) {
                    const oldAttachments = await getAttachments(item);
                    for (const old of oldAttachments) {
                        let ct = '';
                        if (old.attachmentContentType) ct = old.attachmentContentType;
                        else if (typeof old.getField === 'function')
                            try {
                                ct = old.getField('contentType') || '';
                            } catch {}
                        if (ct === 'application/pdf') {
                            Zotero.debug('[Patent] 移除旧附件: ' + old.id);
                            await Zotero.Items.erase(old.id);
                        }
                    }
                    await Zotero.Attachments.importFromFile({ file: savePath, parentItemID: item.id });
                    successCount++;
                    Zotero.debug('[Patent] Successfully downloaded PDF for: ' + title);
                } else {
                    failCount++;
                    failedItems.push(title || 'Unknown');
                    Zotero.debug('[Patent] CDP 下载失败: ' + title);
                }
            } else {
                failCount++;
                failedItems.push(title || 'Unknown');
            }
        } catch (err: any) {
            Zotero.debug('[Patent] Error downloading for: ' + title + ', ' + (err.message || err));
            failCount++;
            failedItems.push(title || 'Unknown');
        }
    }

    let message = '完成：成功 ' + successCount + ' 个';
    if (failCount > 0) {
        message += '，失败 ' + failCount + ' 个';
    }
    if (failedItems.length > 0) {
        message += '（' + failedItems.slice(0, 3).join(', ') + (failedItems.length > 3 ? '...' : '') + '）';
    }
    showNotification(message);
}

async function applyMetadataToItem(item: any, metadata: any) {
    if (!item.setField) {
        Zotero.debug('applyMetadataToItem：item.setField 不可用');
        return;
    }

    if (metadata.title) item.setField('title', metadata.title);
    if (metadata.pubNumber) item.setField('patentNumber', metadata.pubNumber);
    if (metadata.applicationNumber) item.setField('applicationNumber', metadata.applicationNumber);
    if (metadata.filingDate) item.setField('filingDate', metadata.filingDate);
    if (metadata.issueDate) item.setField('issueDate', metadata.issueDate);
    if (metadata.abstractNote) item.setField('abstractNote', metadata.abstractNote);
    if (metadata.country) item.setField('country', metadata.country);
    if (metadata.issuingAuthority) item.setField('issuingAuthority', metadata.issuingAuthority);
    if (metadata.pubDate) item.setField('date', metadata.pubDate);

    const newCreators: any[] = [];
    if (metadata.inventors && metadata.inventors.length) {
        for (const name of metadata.inventors) {
            newCreators.push({
                creatorType: 'inventor',
                firstName: '',
                lastName: name,
            });
        }
    }
    if (newCreators.length > 0 && typeof item.setCreators === 'function') {
        item.setCreators(newCreators);
    }
    // 专利权人使用专利专有字段
    if (metadata.assignees && metadata.assignees.length) {
        item.setField('assignee', metadata.assignees.join(', '));
    }

    await Zotero.Items.saveTx([item]);
}

async function applyMetadataFromPdf(item: any, metadata: PatentMetadata) {
    if (!item.setField) {
        Zotero.debug('applyMetadataFromPdf：item.setField 不可用');
        return;
    }

    if (metadata.title) {
        item.setField('title', metadata.title);
        Zotero.debug('[Patent] Updated title: ' + metadata.title);
    }
    if (metadata.pubNumber) {
        item.setField('patentNumber', metadata.pubNumber);
        Zotero.debug('[Patent] Updated patentNumber: ' + metadata.pubNumber);
    }
    if (metadata.pubDate) {
        item.setField('date', metadata.pubDate);
        Zotero.debug('[Patent] Updated date: ' + metadata.pubDate);
    }
    if (metadata.abstract) {
        item.setField('abstractNote', metadata.abstract);
        Zotero.debug('[Patent] Updated abstract: ' + metadata.abstract.substring(0, 100) + '...');
    }

    if (metadata.applicationNumber) {
        item.setField('applicationNumber', metadata.applicationNumber);
        Zotero.debug('[Patent] Updated applicationNumber: ' + metadata.applicationNumber);
    }

    if (metadata.filingDate) {
        item.setField('filingDate', metadata.filingDate);
        Zotero.debug('[Patent] Updated filingDate: ' + metadata.filingDate);
    }

    if (metadata.extra) {
        item.setField('extra', metadata.extra);
        Zotero.debug('[Patent] Updated extra (IPC): ' + metadata.extra);
    }

    if (metadata.country) {
        item.setField('country', metadata.country);
        Zotero.debug('[Patent] Updated country: ' + metadata.country);
    }

    if (metadata.issuingAuthority) {
        item.setField('issuingAuthority', metadata.issuingAuthority);
        Zotero.debug('[Patent] Updated issuingAuthority: ' + metadata.issuingAuthority);
    }

    const newCreators: any[] = [];

    // Use different creator type based on patent type
    // invention: inventor, utility model: creator (or applicant)
    const creatorType = metadata.patentType === 'utility' ? 'creator' : 'inventor';
    Zotero.debug('[Patent] Using creatorType: ' + creatorType);

    if (metadata.inventors && metadata.inventors.length > 0) {
        for (const name of metadata.inventors) {
            newCreators.push({
                creatorType: creatorType,
                firstName: '',
                lastName: name,
            });
        }
        Zotero.debug('[Patent] Updated inventors: ' + metadata.inventors.join(', '));
    }

    if (newCreators.length > 0 && typeof item.setCreators === 'function') {
        item.setCreators(newCreators);
    }

    // 专利权人使用专利专有字段
    if (metadata.assignees && metadata.assignees.length > 0) {
        item.setField('assignee', metadata.assignees.join(', '));
        Zotero.debug('[Patent] Updated assignees: ' + metadata.assignees.join(', '));
    }

    await item.saveTx();
    Zotero.debug('[Patent] Metadata from PDF applied successfully');
}

export default {
    registerMenu,
    unregisterMenu,
    handleGetMetadata,
};
