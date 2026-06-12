import { downloadPdfViaCdp as cdpDownloadPdf } from './cnipaClient';

export interface PatentMetadata {
    title?: string;
    pubNumber?: string;
    applicationNumber?: string;
    filingDate?: string;
    issueDate?: string;
    pubDate?: string;
    assignees?: string[];
    inventors?: string[];
    abstract?: string;
    country?: string;
    issuingAuthority?: string;
    patentType?: 'invention' | 'utility' | 'design' | 'unknown';
    extra?: string;
}

export async function getAttachments(item: any): Promise<any[]> {
    try {
        const attachments: any[] = [];
        let attachmentIDs: number[] = [];
        if (item.attachments) {
            attachmentIDs = item.attachments.map((a: any) => a.id);
        } else if (item.getAttachments) {
            attachmentIDs = await item.getAttachments();
        }
        if (attachmentIDs.length > 0) {
            for (const id of attachmentIDs) {
                const attachmentItem = await Zotero.Items.getAsync(id);
                if (attachmentItem) {
                    attachments.push(attachmentItem);
                }
            }
        }
        Zotero.debug('[Patent] getAttachments: loaded ' + attachments.length + ' attachment objects');
        return attachments;
    } catch (e) {
        Zotero.debug('[Patent] getAttachments error: ' + e);
        return [];
    }
}

export async function extractTextFromPdf(attachmentItem: any, pageIndex: number = 0): Promise<string> {
    try {
        const itemID = attachmentItem.id || attachmentItem.getID?.();
        if (!itemID) throw new Error('Cannot get attachment ID');
        Zotero.debug('[Patent] Extracting text from PDF item ID: ' + itemID + ', page: ' + pageIndex);
        if (Zotero.PDFWorker && typeof Zotero.PDFWorker.getFullText === 'function') {
            const result = await Zotero.PDFWorker.getFullText(itemID, pageIndex);
            if (result && result.text) {
                Zotero.debug('[Patent] Extracted text length: ' + result.text.length);
                return result.text;
            }
            throw new Error('PDF text extraction returned empty result');
        }
        throw new Error('PDF text extraction not available');
    } catch (e) {
        Zotero.debug('[Patent] extractTextFromPdf error: ' + e);
        throw e;
    }
}

export async function extractPatentInfoFromPdf(attachmentItem: any): Promise<PatentMetadata> {
    // Extract from the first full page of the PDF (not just first 500 chars)
    const text = await extractTextFromPdf(attachmentItem, 0);
    Zotero.debug('[Patent] PDF first page text length: ' + text.length);
    // Log more for debugging
    Zotero.debug(
        '[Patent] PDF text around (57): ' +
            text.substring(
                text.indexOf('(57)') !== -1 ? text.indexOf('(57)') : 0,
                text.indexOf('(57)') !== -1 ? text.indexOf('(57)') + 500 : 1000,
            ),
    );
    const metadata = parsePatentInfoFromText(text);
    Zotero.debug('[Patent] Parsed PDF metadata: ' + JSON.stringify(metadata));
    return metadata;
}

export function parsePatentInfoFromText(text: string): PatentMetadata {
    const result: PatentMetadata = {};
    Zotero.debug('[Patent] parsePatentInfoFromText input length: ' + text.length);

    // Skip noise patterns at start of PDF text (page numbers, etc.)
    const cleanedText = text.replace(/^\s*\d+\s*[\n\r]+\s*/, '');

    // Helper: parse date like "2024 .09 .24" or "2024.09.24" -> "2024-09-24"
    function parseDate(dateStr: string): string {
        if (!dateStr) return '';
        let date = dateStr.trim().replace(/[\s.]/g, '-').replace(/--/g, '-');
        const parts = date.split('-');
        if (parts.length >= 3) {
            const year = parts[0].padStart(4, '0');
            const month = parts[1].padStart(2, '0');
            const day = parts[2].padStart(2, '0');
            return `${year}-${month}-${day}`;
        }
        return dateStr.trim();
    }

    // Helper: check if string is a valid Chinese name (2-10 Chinese chars, may have · for transliteration)
    function isChineseName(str: string): boolean {
        if (!str || str.length < 2 || str.length > 15) return false;
        // Must contain Chinese characters, may contain · (for names like 司马·中原)
        const chineseCount = (str.match(/[\u4e00-\u9fff]/g) || []).length;
        if (chineseCount < 2) return false;
        // Should not contain numbers or English letters (except · for transliteration)
        if (/[a-zA-Z0-9]/.test(str.replace(/·/g, ''))) return false;
        // Should not contain common non-name keywords
        if (
            /^(地址|邮编|联系人|电话|专利|代理|机构|事务所|公司|审查员|发明人|申请日|公告日|授权日|对比文件|分类号|Int)/i.test(
                str,
            )
        )
            return false;
        return true;
    }

    // Helper: check if string looks like an organization/company
    function isOrganization(str: string): boolean {
        if (!str || str.length < 4) return false;
        const orgKeywords = [
            '公司',
            '研究院',
            '研究所',
            '大学',
            '学院',
            '企业',
            '集团',
            '有限',
            '股份',
            '有限公司',
            '股份公司',
        ];
        return orgKeywords.some((kw) => str.includes(kw));
    }

    // Extract title (54) - handle both invention patents (发明专利) and utility model patents (实用新型)
    // Chinese patent PDF formats:
    // - (54)发明名称 for invention patents
    // - (54)实用新型名称 for utility model patents
    const namePatterns = [
        // Match either 发明名称 or 实用新型名称
        /\(\s*54\s*\)\s*(?:发明|实用新型)[名称]*\s*([^\(]+?)(?=\(\s*57\s*\))/i,
        // Alternative fallback
        /\(\s*54\s*\)[\s\S]*?(?=\(\s*57\s*\))/i,
    ];
    for (const pattern of namePatterns) {
        const match = cleanedText.match(pattern);
        if (match && match[1]) {
            let title = match[1].trim().replace(/\s+/g, '');
            // Remove leading "发明" or "实用新型" or "名称" if present
            title = title.replace(/^(发明|实用新型)?名称/, '');
            if (title && title.length > 2) {
                result.title = title;
                Zotero.debug('[Patent] Parsed title from (54): ' + title);
                break;
            }
        }
    }

    // Extract application number (21) - 申请号 like 202411335048 .8
    const appNumMatch = cleanedText.match(/\(21\)[^)]*申请号\s+([\d.\s]+)/);
    if (appNumMatch && appNumMatch[1]) {
        const appNum = appNumMatch[1].trim().replace(/\s/g, '');
        if (appNum && /\d/.test(appNum) && appNum.length >= 8) {
            result.applicationNumber = appNum;
            Zotero.debug('[Patent] Parsed applicationNumber: ' + appNum);
        }
    }

    // Extract filing date (22) - more flexible
    let appDateMatch = cleanedText.match(/\(22\)\s*申请日\s*([\d.]{8,15})/);
    if (!appDateMatch) {
        appDateMatch = cleanedText.match(/\(22\)\s*申请日\s*([^\n]{5,20})/);
    }
    if (appDateMatch && appDateMatch[1]) {
        const dateStr = parseDate(appDateMatch[1]);
        if (dateStr && dateStr.length >= 8) {
            result.filingDate = dateStr;
            Zotero.debug('[Patent] Parsed filingDate: ' + dateStr);
        }
    }

    // Extract issue date (45)
    const grantDateMatch = cleanedText.match(/\(45\)\s*授权公告日\s*([\d.\s]+)/);
    if (grantDateMatch && grantDateMatch[1]) {
        const dateStr = parseDate(grantDateMatch[1]);
        if (dateStr) {
            result.issueDate = dateStr;
            result.pubDate = dateStr;
        }
    }

    // Extract patent number / grant number (10) - 授权公告号 like CN 119986713 B
    const grantNumMatch = cleanedText.match(/\(10\)[^)]*授权公告号\s+([A-Z]{2}\s*\d+[A-Z])/i);
    if (grantNumMatch && grantNumMatch[1]) {
        let pn = grantNumMatch[1].trim().replace(/\s/g, '');
        if (pn && pn.length > 4) {
            result.pubNumber = pn;
            Zotero.debug('[Patent] Parsed patentNumber from (10): ' + pn);
        }
    }

    // Fallback: extract from (65) - publication number like CN 119986713 A
    if (!result.pubNumber) {
        const pubNumMatch = cleanedText.match(/申请公布号\s+([A-Z]{2}\s*\d+[A-Z]?)/i);
        if (pubNumMatch && pubNumMatch[1]) {
            const pn = pubNumMatch[1].trim().replace(/\s/g, '');
            if (pn && pn.length > 5) {
                result.pubNumber = pn;
                Zotero.debug('[Patent] Parsed patentNumber from (65): ' + pn);
            }
        }
    }

    // Use application number as fallback for pubNumber if nothing else found
    if (!result.pubNumber && result.applicationNumber) {
        result.pubNumber = result.applicationNumber;
    }

    // Extract IPC classification (51) - more flexible to handle "Int .Cl ."
    const ipcMatch = cleanedText.match(/\(51\)\s*Int[\s.]*Cl[\s.]*([^\n(]{3,60})/i);
    if (ipcMatch && ipcMatch[1]) {
        let ipc = ipcMatch[1].trim();
        // Clean up - remove extra spaces
        ipc = ipc
            .replace(/\s+/g, ' ')
            .replace(/\(.*?\)/g, '')
            .trim();
        if (ipc && ipc.length > 2) {
            result.extra = 'IPC: ' + ipc;
            Zotero.debug('[Patent] Parsed IPC: ' + ipc);
        }
    }

    // Fallback: publication date (43)
    if (!result.pubDate) {
        const pubDateAltMatch = cleanedText.match(/\(43\)\s*申请公布日\s*([\d.\s]+)/);
        if (pubDateAltMatch && pubDateAltMatch[1]) {
            const dateStr = parseDate(pubDateAltMatch[1]);
            if (dateStr) result.pubDate = dateStr;
        }
    }

    // Extract abstract (57) - handle formats like "(57)" or "( 57 )"
    const abstractMatch = cleanedText.match(/\(\s*57\s*\)\s*摘要\s*([\s\S]*?)(?=\s*\(\d{2}\)|权利要求)/i);
    if (abstractMatch && abstractMatch[1]) {
        let abstract = abstractMatch[1].trim().replace(/\s+/g, '');
        if (abstract && abstract.length > 5) {
            result.abstract = abstract;
            Zotero.debug('[Patent] Parsed abstract: ' + abstract.substring(0, 100) + '...');
        }
    }

    // Assignees (73): extract after (73) until next field
    const assigneeBlockMatch = cleanedText.match(
        /\(\s*73\s*\)\s*(?:专利权人\s*)?([\s\S]*?)(?=\s*\(\s*72\s*\)|\s*\(\s*74\s*\)|\s*\(\s*57\s*\)|\s*\(\s*54\s*\)|(?:\n\s*){2,})/i,
    );
    if (assigneeBlockMatch && assigneeBlockMatch[1]) {
        let blockText = assigneeBlockMatch[1];
        // Remove address lines - more comprehensive pattern
        blockText = blockText.replace(/地址\s*[^\n]*/gi, '');
        blockText = blockText.replace(/邮编[：:]?\s*\d{6}/gi, '');
        blockText = blockText.replace(/电话[：:]?\s*[\d\-]+/gi, '');
        blockText = blockText.replace(/联系人[：:]?[^\n]*/gi, '');

        // Split by common separators
        const parts = blockText
            .split(/[;；,，\n\r\t]+|\s{2,}|、/)
            .map((p) => p.trim())
            .filter((p) => p);
        const assignees: string[] = [];

        // Merge fragmented organizations - only merge when prev is clearly incomplete
        const mergedParts: string[] = [];
        for (const part of parts) {
            let candidate = part.replace(/^(专利权人|专利权|申请人)[:：]?\s*/i, '').trim();
            if (!candidate || /^\d+$/.test(candidate)) continue;

            // Skip if too short after cleaning
            if (candidate.length < 4) continue;

            // Only merge if previous is a clear incomplete fragment
            if (mergedParts.length > 0) {
                const prev = mergedParts[mergedParts.length - 1];
                // Only merge if prev ends with partial suffix like "科学" (incomplete) and candidate completes it
                // or prev ends with location (like "北京市") and candidate is an org
                const shouldMerge =
                    // prev ends with "科" or "科学" and candidate starts with continuation
                    (/科$/.test(prev) && /(?:学院|研究院|大学)/.test(candidate)) ||
                    // prev ends with partial place name and candidate starts with org keywords
                    (/市$/.test(prev) && /^(?:中国|国家|国网)/.test(candidate)) ||
                    // prev ends with "电力" or "电" and candidate completes like "科学研究院"
                    (/电$/.test(prev) && /^(?:科学|研究院)/.test(candidate));

                if (shouldMerge) {
                    mergedParts[mergedParts.length - 1] = prev + candidate;
                    continue;
                }
            }

            if (isOrganization(candidate)) {
                mergedParts.push(candidate);
            }
        }

        for (const candidate of mergedParts) {
            const cleaned = candidate.replace(/[;；,，.。\s]+$/g, '');
            if (cleaned && cleaned.length >= 4 && !assignees.includes(cleaned)) {
                assignees.push(cleaned);
            }
        }

        if (assignees.length > 0) {
            result.assignees = assignees;
            Zotero.debug('[Patent] Parsed assignees: ' + JSON.stringify(assignees));
        }
    }

    // Inventors (72): extract after (72) until next field - improved filtering
    const inventorBlockMatch = cleanedText.match(
        /\(\s*72\s*\)\s*(?:发明人\s*)?([\s\S]*?)(?=\s*\(\s*73\s*\)|\s*\(\s*74\s*\)|\s*\(\s*57\s*\)|\s*\(\s*54\s*\)|(?:\n\s*){2,})/i,
    );
    if (inventorBlockMatch && inventorBlockMatch[1]) {
        let inventorText = inventorBlockMatch[1].trim();
        // Remove address fragments
        inventorText = inventorText.replace(/地址[：:][^\n]*/gi, '');
        inventorText = inventorText.replace(/邮编[：:]?\s*\d{6}/gi, '');

        // Split by common separators first
        let names = inventorText
            .split(/[;；,，\n\r\t]+|\s{2,}|、|及|和|与/)
            .map((s) => s.trim())
            .filter((n) => n);

        // Further split candidates that contain single spaces between Chinese names
        const finalNames: string[] = [];
        for (const name of names) {
            const subNames = name
                .split(/\s+/)
                .map((s) => s.trim())
                .filter((s) => s);
            for (const subName of subNames) {
                let candidate = subName.replace(/^(发明人)[:：]?\s*/i, '').trim();
                if (isChineseName(candidate) && !finalNames.includes(candidate)) {
                    finalNames.push(candidate);
                }
            }
        }

        if (finalNames.length > 0) {
            result.inventors = finalNames;
            Zotero.debug('[Patent] Parsed inventors: ' + JSON.stringify(finalNames));
        }
    }

    // Set default country and issuing authority
    result.country = 'CN';
    result.issuingAuthority = 'CNIPA';

    // Detect patent type from the PDF
    if (/\(12\)[\s]*发明专利/i.test(cleanedText)) {
        result.patentType = 'invention';
        Zotero.debug('[Patent] Detected patent type: invention');
    } else if (/\(12\)[\s]*实用新型/i.test(cleanedText)) {
        result.patentType = 'utility';
        Zotero.debug('[Patent] Detected patent type: utility');
    } else if (/\(12\)[\s]*外观设计/i.test(cleanedText)) {
        result.patentType = 'design';
        Zotero.debug('[Patent] Detected patent type: design');
    }

    Zotero.debug('[Patent] Final parsed metadata: ' + JSON.stringify(result));
    return result;
}

async function downloadPdfFile(filedlUrl: string, savePath: string, showpdfUrl?: string): Promise<boolean> {
    // CNIPA egaz.cnipa.gov.cn 不支持 Zotero HTTP 下载（总是 502），仅使用 CDP 浏览器下载
    try {
        const cdpUrl = showpdfUrl || filedlUrl;
        var cdpResult = await cdpDownloadPdf(cdpUrl, savePath);
        if (cdpResult === null) return false;
        return true;
    } catch (e) {
        Zotero.debug('[Patent] downloadPdfFile CDP 方式失败: ' + e);
        return false;
    }
}

async function findExistingPdfAttachment(item: any): Promise<any | null> {
    try {
        const attachments = await getAttachments(item);
        for (const att of attachments) {
            try {
                let filename = '';
                let contentType = '';
                if (typeof att.getFilename === 'function') filename = await att.getFilename();
                else if (typeof att.getField === 'function') {
                    try {
                        filename = att.getField('filename') || '';
                    } catch {}
                }
                if (!filename && att.attachmentFilename) filename = att.attachmentFilename;
                if (att.attachmentContentType) contentType = att.attachmentContentType;
                else if (typeof att.getField === 'function') {
                    try {
                        contentType = att.getField('contentType') || '';
                    } catch {}
                }
                if (contentType === 'application/pdf' || filename?.toLowerCase().endsWith('.pdf')) {
                    return att;
                }
            } catch (e) {
                Zotero.debug('[Patent] Error checking attachment: ' + e);
            }
        }
        return null;
    } catch (e) {
        Zotero.debug('[Patent] findExistingPdfAttachment error: ' + e);
        return null;
    }
}

async function removeAttachment(attachmentItem: any): Promise<void> {
    try {
        await Zotero.Items.erase(attachmentItem.id);
        Zotero.debug('[Patent] Removed existing attachment: ' + attachmentItem.id);
    } catch (e) {
        Zotero.debug('[Patent] removeAttachment error: ' + e);
    }
}

function convertShowpdfToFiledl(url: string): string {
    if (url.indexOf('/showpdf') < 0) return url;
    const idx = url.indexOf('path=');
    if (idx < 0) return url;
    const path = url.substring(idx + 5);
    const ampIdx = path.indexOf('&');
    const pathValue = ampIdx >= 0 ? path.substring(0, ampIdx) : path;
    return 'http://egaz.cnipa.gov.cn/filedl?path=' + pathValue;
}

export async function downloadPdfAndAttach(item: any, pdfUrl: string, filename?: string): Promise<boolean> {
    try {
        const downloadUrl = convertShowpdfToFiledl(pdfUrl);
        Zotero.debug('[Patent] Download URL: ' + downloadUrl);
        if (!filename) {
            const title = item.getField ? item.getField('title') : item.title;
            const safeTitle = (title || 'patent')
                .replace(/[/\\?%*:|"<>]/g, '')
                .replace(/\s+/g, '_')
                .substring(0, 100);
            filename = safeTitle + '.pdf';
        }
        if (!filename.endsWith('.pdf')) {
            filename += '.pdf';
        }
        const tmpDir = Cc['@mozilla.org/file/directory_service;1'].getService(Ci.nsIProperties).get('TmpD', Ci.nsIFile);
        tmpDir.append('zoteropatent');
        if (!tmpDir.exists()) tmpDir.create(Ci.nsIFile.DIRECTORY_TYPE, 0o777);
        const tmpFile = tmpDir.clone();
        tmpFile.append(filename);
        const savePath = tmpFile.path;
        const downloaded = await downloadPdfFile(downloadUrl, savePath, pdfUrl);
        if (!downloaded) throw new Error('Failed to download PDF');
        const existing = await findExistingPdfAttachment(item);
        if (existing) {
            await removeAttachment(existing);
        }
        await Zotero.Attachments.importFromFile({ file: savePath, parentItemID: item.id });
        Zotero.debug('[Patent] PDF attached to item: ' + item.id);
        return true;
    } catch (e) {
        Zotero.debug('[Patent] downloadPdfAndAttach error: ' + e);
        return false;
    }
}
