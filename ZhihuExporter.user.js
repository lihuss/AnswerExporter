// ==UserScript==
// @name         知乎主页一键导出工具 (Zhihu Exporter)
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  一键导出特定知乎用户的所有回答和文章为 Markdown 文件（保存到文件夹）
// @author       残阳血
// @match        *://www.zhihu.com/people/*
// @require      https://cdnjs.cloudflare.com/ajax/libs/turndown/7.1.3/turndown.min.js
// @grant        GM_download
// @grant        GM_addStyle
// ==/UserScript==

(function() {
    'use strict';

    const panelHtml = `
        <div id="zhihu-exporter-panel">
            <h3>Zhihu Exporter</h3>
            <div id="ze-status">就绪</div>
            <div id="ze-progress"></div>
            <button id="ze-export-answers">导出所有回答</button>
            <button id="ze-export-articles">导出所有文章</button>
        </div>
    `;

    GM_addStyle(`
        #zhihu-exporter-panel {
            position: fixed;
            top: 20px;
            right: 20px;
            width: 250px;
            padding: 15px;
            background: #fff;
            border: 1px solid #ccc;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            z-index: 9999;
            font-family: sans-serif;
        }
        #zhihu-exporter-panel h3 { margin: 0 0 10px 0; font-size: 16px; color: #0066ff; }
        #ze-status { font-size: 12px; margin-bottom: 8px; color: #666; }
        #ze-progress { font-size: 12px; margin-bottom: 10px; color: #333; height: 40px; overflow-y: auto; }
        #zhihu-exporter-panel button {
            width: 100%;
            margin-bottom: 5px;
            padding: 8px;
            background: #0066ff;
            color: #fff;
            border: none;
            border-radius: 4px;
            cursor: pointer;
        }
        #zhihu-exporter-panel button:disabled { background: #ccc; cursor: not-allowed; }
    `);

    const container = document.createElement('div');
    container.innerHTML = panelHtml;
    document.body.appendChild(container);

    const statusEl = document.getElementById('ze-status');
    const progressEl = document.getElementById('ze-progress');
    const ansBtn = document.getElementById('ze-export-answers');
    const artBtn = document.getElementById('ze-export-articles');

    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    const randomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

    function cleanTitle(item) {
        if (item.title) return item.title;
        if (item.question && item.question.title) return item.question.title;
        return '无标题_' + (item.id || Date.now());
    }

    function formatDate(timestamp) {
        const date = new Date(timestamp * 1000);
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }

    function cleanFilename(name) {
        return name.replace(/[\\\/:*?"<>|]/g, '_').trim();
    }

    function ensureUniqueFilename(baseName, usedFileNames, fallbackId) {
        if (!usedFileNames.has(baseName)) {
            usedFileNames.add(baseName);
            return baseName;
        }
        const ext = '.md';
        const pure = baseName.endsWith(ext) ? baseName.slice(0, -ext.length) : baseName;
        if (fallbackId) {
            const withId = `${pure} (${fallbackId})${ext}`;
            if (!usedFileNames.has(withId)) {
                usedFileNames.add(withId);
                return withId;
            }
        }
        let index = 2;
        while (true) {
            const candidate = `${pure} (${index})${ext}`;
            if (!usedFileNames.has(candidate)) {
                usedFileNames.add(candidate);
                return candidate;
            }
            index++;
        }
    }

    async function pickOutputDirectory(urlToken, type) {
        if (typeof window.showDirectoryPicker !== 'function') return null;
        try {
            progressEl.innerText = '请选择保存目录...';
            const root = await window.showDirectoryPicker({ mode: 'readwrite' });
            const folderName = `${urlToken}_知乎_${type}`;
            return await root.getDirectoryHandle(folderName, { create: true });
        } catch (e) {
            return null;
        }
    }

    async function saveMarkdownFile({ dirHandle, folderName, fileName, content }) {
        if (dirHandle) {
            const fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write(content);
            await writable.close();
            return;
        }

        const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
        const blobUrl = URL.createObjectURL(blob);
        await new Promise((resolve, reject) => {
            GM_download({
                url: blobUrl,
                name: `${folderName}/${fileName}`,
                saveAs: false,
                onload: resolve,
                onerror: reject,
                ontimeout: reject
            });
        });
        setTimeout(() => URL.revokeObjectURL(blobUrl), 3000);
    }

    function normalizeApiUrl(inputUrl) {
        if (!inputUrl || typeof inputUrl !== 'string') return inputUrl;
        return inputUrl
            .replace(/^http:\/\/www\.zhihu\.com\//i, 'https://www.zhihu.com/')
            .replace(/^http:\/\/zhuanlan\.zhihu\.com\//i, 'https://zhuanlan.zhihu.com/');
    }

    function buildNextOffsetUrl(currentUrl) {
        try {
            const parsed = new URL(normalizeApiUrl(currentUrl));
            const offset = Number(parsed.searchParams.get('offset') || '0');
            const limit = Number(parsed.searchParams.get('limit') || '20');
            parsed.searchParams.set('offset', String(offset + limit));
            parsed.searchParams.set('limit', String(limit));
            return parsed.toString();
        } catch {
            return null;
        }
    }

    async function requestJson(url, retries = 2) {
        const normalizedUrl = normalizeApiUrl(url);
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                const resp = await fetch(normalizedUrl, {
                    method: 'GET',
                    credentials: 'include',
                    headers: {
                        'accept': 'application/json, text/plain, */*'
                    }
                });

                if (resp.status === 401 || resp.status === 403) {
                    const authErr = new Error('AUTH_BLOCKED');
                    authErr.status = resp.status;
                    throw authErr;
                }
                if (!resp.ok) {
                    const httpErr = new Error(`HTTP_${resp.status}`);
                    httpErr.status = resp.status;
                    throw httpErr;
                }
                return await resp.json();
            } catch (error) {
                const isLast = attempt >= retries;
                const retryable = !error.status || error.status >= 500;
                if (isLast || !retryable) throw error;
                const backoff = randomDelay(1200, 2200);
                progressEl.innerText = `网络波动，重试第 ${attempt + 1}/${retries} 次...`;
                await sleep(backoff);
            }
        }
    }

    function buildUniqueId(type, item) {
        const hasId = item && item.id !== undefined && item.id !== null;
        return hasId
            ? `${type}:id:${String(item.id)}`
            : `${type}:fallback:${item?.url || ''}:${item?.created_time || ''}:${JSON.stringify(item || {})}`;
    }

    async function saveItemAsMarkdown({ item, type, turndown, dirHandle, folderName, usedFileNames }) {
        const title = cleanTitle(item);
        const content = item.content || '';
        const createdTime = item.created_time || item.created || 0;
        const hasId = item && item.id !== undefined && item.id !== null;
        const articleUrl = (type === 'answers')
            ? `https://www.zhihu.com/question/${item.question?.id}/answer/${item.id}`
            : `https://zhuanlan.zhihu.com/p/${item.id}`;

        const dateStr = formatDate(createdTime);
        const cleanT = cleanFilename(title);
        const mdContent = `# ${title}\n\n> URL: ${articleUrl}\n> 发布时间: ${dateStr}\n\n---\n\n${turndown.turndown(content)}`;
        const baseFileName = `${dateStr} ${cleanT}.md`;
        const fileName = ensureUniqueFilename(baseFileName, usedFileNames, hasId ? String(item.id) : '');

        await saveMarkdownFile({
            dirHandle,
            folderName,
            fileName,
            content: mdContent
        });
    }

    async function collectPages({ urlToken, type, progressPrefix }) {
        const limit = 20;
        let nextUrl = `https://www.zhihu.com/api/v4/members/${urlToken}/${type}?offset=0&limit=${limit}`;
        const allItems = [];
        const seenIds = new Set();
        let apiTotal = 0;
        const visitedUrls = new Set();

        while (nextUrl) {
            const safePageUrl = normalizeApiUrl(nextUrl);
            if (visitedUrls.has(safePageUrl)) break;
            visitedUrls.add(safePageUrl);

            const offsetText = safePageUrl.includes('offset=') ? (safePageUrl.match(/offset=\d+/)?.[0] || '') : '';
            progressEl.innerText = `${progressPrefix} ${offsetText}`.trim();
            const res = await requestJson(safePageUrl, 2);

            if (!res || !Array.isArray(res.data)) {
                throw new Error('接口返回格式异常');
            }

            if (!apiTotal && res.paging && typeof res.paging.totals === 'number') {
                apiTotal = res.paging.totals;
            }

            for (const item of res.data) {
                const uniqueId = buildUniqueId(type, item);
                if (seenIds.has(uniqueId)) continue;
                seenIds.add(uniqueId);
                allItems.push(item);
            }

            if (res.paging && res.paging.is_end) break;

            const nextFromApi = res.paging && res.paging.next ? normalizeApiUrl(res.paging.next) : null;
            const fallbackNext = buildNextOffsetUrl(safePageUrl);
            nextUrl = nextFromApi || fallbackNext;
            if (nextUrl && visitedUrls.has(nextUrl)) break;

            const delay = randomDelay(1500, 3000);
            await sleep(delay);
        }

        return { items: allItems, apiTotal };
    }

    async function startExport(type) {
        const tokenMatch = window.location.pathname.match(/\/people\/([^/]+)/);
        const urlToken = tokenMatch ? tokenMatch[1] : '';
        if (!urlToken) {
            alert('无法获取用户 ID，请确保在知乎个人主页');
            return;
        }

        statusEl.innerText = '开始导出（同源 fetch 模式）';
        statusEl.style.color = '#666';

        ansBtn.disabled = true;
        artBtn.disabled = true;
        
        const turndown = new TurndownService();
        const usedFileNames = new Set();
        const typeLabel = type === 'answers' ? '回答' : '文章';
        const folderName = `${urlToken}_知乎_${typeLabel}`;
        const dirHandle = await pickOutputDirectory(urlToken, type);

        try {
            statusEl.innerText = `正在抓取${typeLabel}...`;
            const result = await collectPages({
                urlToken,
                type,
                progressPrefix: '正在抓取'
            });

            let savedCount = 0;
            for (let index = 0; index < result.items.length; index++) {
                const item = result.items[index];
                progressEl.innerText = `正在保存 ${index + 1}/${result.items.length}...`;

                await saveItemAsMarkdown({
                    item,
                    type,
                    turndown,
                    dirHandle,
                    folderName,
                    usedFileNames
                });
                savedCount++;

                const saveDelay = randomDelay(180, 380);
                await sleep(saveDelay);
            }

            statusEl.innerText = '导出完成';
            statusEl.style.color = '#258d19';
            const totalText = result.apiTotal ? `（页面显示 ${result.apiTotal}）` : '';
            progressEl.innerText = `已导出 ${savedCount} 篇可访问${typeLabel}${totalText}。`; 

        } catch (err) {
            console.error(err);
            if (err.status === 403 || err.status === 401) {
                statusEl.innerText = '导出失败';
                statusEl.style.color = '#d93025';
                progressEl.innerText = '当前访问受限，请刷新后重试。';
            } else {
                statusEl.innerText = '导出失败';
                statusEl.style.color = '#d93025';
                progressEl.innerText = '网络异常，请稍后重试。';
            }
        } finally {
            ansBtn.disabled = false;
            artBtn.disabled = false;
        }
    }

    ansBtn.addEventListener('click', () => startExport('answers'));
    artBtn.addEventListener('click', () => startExport('articles'));

})();