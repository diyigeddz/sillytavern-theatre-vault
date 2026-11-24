(() => {
    'use strict';

    const EXTENSION_ID = 'theatre-vault';
    const DB_NAME = 'sillytavern-theatre-vault';
    const DB_VERSION = 1;
    const STORE_NAME = 'scenes';
    const FALLBACK_KEY = 'sillytavern-theatre-vault-fallback';
    const TAG_COLOR_KEY = 'sillytavern-theatre-vault-tag-colors';
    const MOBILE_POSITION_KEY = 'sillytavern-theatre-vault-mobile-position';
    const PAGE_SIZE = 60;
    const MAX_BATCH_DRAFTS = 50;
    const MOBILE_TARGET_ROWS = 5;
    const MOBILE_FALLBACK_ROWS = 4;
    const CLOSE_ANIMATION_MS = 220;
    const INSERT_FEEDBACK_MS = 520;
    const DRAG_HOLD_MS = 320;
    const DRAG_CANCEL_DISTANCE = 8;
    const MOBILE_EDGE_GAP = 10;

    let dbPromise;
    let useFallbackStorage = false;
    let items = [];
    let editingId = null;
    let editorDrafts = [];
    let expandedId = null;
    let visibleLimit = PAGE_SIZE;
    let searchTimer = null;
    let lastLauncherActivation = 0;
    let overlayCloseTimer = null;
    let pendingInsertTimer = null;
    let mobileFitFrame = null;
    let compactRowOuterHeight = 73;
    let mobilePosition = readMobilePosition();
    let sheetDrag = null;
    let ui = {};
    const searchCache = new Map();
    const tagHueMap = readTagHueMap();

    function readMobilePosition() {
        try {
            const value = JSON.parse(localStorage.getItem(MOBILE_POSITION_KEY) || 'null');
            if (!value || !Number.isFinite(value.x) || !Number.isFinite(value.y)) return null;
            return {
                x: Math.min(1, Math.max(0, value.x)),
                y: Math.min(1, Math.max(0, value.y)),
            };
        } catch {
            return null;
        }
    }

    function saveMobilePosition() {
        try {
            if (mobilePosition) localStorage.setItem(MOBILE_POSITION_KEY, JSON.stringify(mobilePosition));
            else localStorage.removeItem(MOBILE_POSITION_KEY);
        } catch {
            // Position persistence is optional when browser storage is unavailable.
        }
    }

    function readTagHueMap() {
        try {
            const parsed = JSON.parse(localStorage.getItem(TAG_COLOR_KEY) || '{}');
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
            return {};
        }
    }

    function textHash(text) {
        let hash = 2166136261;
        for (const char of String(text)) {
            hash ^= char.codePointAt(0);
            hash = Math.imul(hash, 16777619);
        }
        return Math.abs(hash >>> 0);
    }

    function hueDistance(left, right) {
        const distance = Math.abs(left - right) % 360;
        return Math.min(distance, 360 - distance);
    }

    function getTagHue(category) {
        const key = category || '未分类';
        const stored = Number(tagHueMap[key]);
        if (Number.isFinite(stored)) return stored;

        const used = Object.values(tagHueMap).map(Number).filter(Number.isFinite);
        const base = textHash(key) % 360;
        let hue = base;
        for (let attempt = 0; attempt < 12; attempt += 1) {
            const candidate = (base + attempt * 47) % 360;
            if (used.every(value => hueDistance(candidate, value) >= 26)) {
                hue = candidate;
                break;
            }
        }
        tagHueMap[key] = hue;
        try {
            localStorage.setItem(TAG_COLOR_KEY, JSON.stringify(tagHueMap));
        } catch {
            // The colors remain stable for the current page even if storage is unavailable.
        }
        return hue;
    }

    function applyTagColor(element, category) {
        element.style.setProperty('--tv-tag-h', String(getTagHue(category)));
    }

    function normalizeTags(value, legacyCategory = '') {
        const source = Array.isArray(value) && value.length
            ? value
            : String((Array.isArray(value) ? legacyCategory : value) || legacyCategory || '')
                .split(/[，,、;；\n]+/);
        const tags = [];
        const seen = new Set();
        for (const raw of source) {
            const tag = String(raw || '').trim().slice(0, 32);
            const key = tag.toLocaleLowerCase('zh-CN');
            if (!tag || seen.has(key)) continue;
            tags.push(tag);
            seen.add(key);
            if (tags.length >= 12) break;
        }
        return tags.length ? tags : ['未分类'];
    }

    function getItemTags(item) {
        return normalizeTags(item?.tags, item?.category || '未分类');
    }

    function tagsInputValue(item) {
        const tags = getItemTags(item);
        return tags.length === 1 && tags[0] === '未分类' ? '' : tags.join('，');
    }

    function makeId() {
        if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
        return `tv-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }

    function openDatabase() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise((resolve, reject) => {
            if (!globalThis.indexedDB) {
                reject(new Error('IndexedDB is unavailable'));
                return;
            }
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            const timer = setTimeout(() => reject(new Error('IndexedDB timed out')), 2200);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
                    store.createIndex('updatedAt', 'updatedAt');
                    store.createIndex('category', 'category');
                }
            };
            request.onsuccess = () => {
                clearTimeout(timer);
                resolve(request.result);
            };
            request.onerror = () => {
                clearTimeout(timer);
                reject(request.error);
            };
            request.onblocked = () => {
                clearTimeout(timer);
                reject(new Error('IndexedDB is blocked'));
            };
        });
        return dbPromise;
    }

    function readFallbackItems() {
        try {
            const parsed = JSON.parse(localStorage.getItem(FALLBACK_KEY) || '[]');
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }

    function writeFallbackItems(nextItems) {
        localStorage.setItem(FALLBACK_KEY, JSON.stringify(nextItems));
    }

    async function getAllItems() {
        if (useFallbackStorage) return readFallbackItems();
        try {
            const db = await openDatabase();
            return await new Promise((resolve, reject) => {
                const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
                request.onsuccess = () => resolve(request.result || []);
                request.onerror = () => reject(request.error);
            });
        } catch (error) {
            useFallbackStorage = true;
            console.warn(`[${EXTENSION_ID}] IndexedDB unavailable, using localStorage`, error);
            return readFallbackItems();
        }
    }

    async function putItem(item) {
        if (useFallbackStorage) {
            const stored = readFallbackItems();
            const index = stored.findIndex(entry => entry.id === item.id);
            if (index >= 0) stored[index] = item;
            else stored.push(item);
            writeFallbackItems(stored);
            return item;
        }
        try {
            const db = await openDatabase();
            return await new Promise((resolve, reject) => {
                const request = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(item);
                request.onsuccess = () => resolve(item);
                request.onerror = () => reject(request.error);
            });
        } catch (error) {
            useFallbackStorage = true;
            console.warn(`[${EXTENSION_ID}] Save fell back to localStorage`, error);
            return putItem(item);
        }
    }

    async function putItems(nextItems) {
        if (!nextItems.length) return [];
        if (useFallbackStorage) {
            const stored = readFallbackItems();
            for (const item of nextItems) {
                const index = stored.findIndex(entry => entry.id === item.id);
                if (index >= 0) stored[index] = item;
                else stored.push(item);
            }
            writeFallbackItems(stored);
            return nextItems;
        }
        try {
            const db = await openDatabase();
            return await new Promise((resolve, reject) => {
                const transaction = db.transaction(STORE_NAME, 'readwrite');
                const store = transaction.objectStore(STORE_NAME);
                for (const item of nextItems) store.put(item);
                transaction.oncomplete = () => resolve(nextItems);
                transaction.onerror = () => reject(transaction.error);
                transaction.onabort = () => reject(transaction.error || new Error('Batch save aborted'));
            });
        } catch (error) {
            useFallbackStorage = true;
            console.warn(`[${EXTENSION_ID}] Batch save fell back to localStorage`, error);
            return putItems(nextItems);
        }
    }

    async function removeItem(id) {
        if (useFallbackStorage) {
            writeFallbackItems(readFallbackItems().filter(item => item.id !== id));
            return;
        }
        try {
            const db = await openDatabase();
            return await new Promise((resolve, reject) => {
                const request = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(id);
                request.onsuccess = () => resolve();
                request.onerror = () => reject(request.error);
            });
        } catch (error) {
            useFallbackStorage = true;
            console.warn(`[${EXTENSION_ID}] Delete fell back to localStorage`, error);
            return removeItem(id);
        }
    }

    function formatDate(value) {
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '';
        return new Intl.DateTimeFormat('zh-CN', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
        }).format(date);
    }

    function createElement(tag, className, text) {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (text !== undefined) element.textContent = text;
        return element;
    }

    function makeButton(text, label, className, type = 'button') {
        const button = createElement('button', className, text);
        button.type = type;
        button.title = label;
        button.setAttribute('aria-label', label);
        return button;
    }

    function toast(message, kind = 'ok') {
        const node = createElement('div', `tv-toast tv-toast-${kind}`, message);
        document.body.appendChild(node);
        requestAnimationFrame(() => node.classList.add('is-visible'));
        setTimeout(() => {
            node.classList.remove('is-visible');
            setTimeout(() => node.remove(), 220);
        }, 1800);
    }

    function buildUi() {
        if (document.querySelector('#tv-overlay')) return;

        const overlay = createElement('dialog', 'tv-overlay');
        overlay.id = 'tv-overlay';
        overlay.setAttribute('aria-hidden', 'true');

        const sheet = createElement('section', 'tv-sheet');
        sheet.setAttribute('role', 'dialog');
        sheet.setAttribute('aria-modal', 'true');
        sheet.setAttribute('aria-label', '小剧场仓库');

        const handle = createElement('div', 'tv-drag-handle');
        handle.tabIndex = 0;
        handle.setAttribute('role', 'button');
        handle.setAttribute('aria-label', '长按拖动窗口，双击恢复居中');
        handle.title = '长按拖动，双击恢复居中';
        const header = createElement('header', 'tv-header');
        const titleWrap = createElement('div', 'tv-title-wrap');
        const title = createElement('h2', 'tv-title', '小剧场仓库');
        const count = createElement('span', 'tv-count', '0 篇');
        titleWrap.append(title, count);

        const headerActions = createElement('div', 'tv-header-actions');
        const addButton = makeButton('＋', '新建小剧场', 'tv-icon-button tv-primary-icon');
        const menuWrap = createElement('div', 'tv-menu-wrap');
        const menuButton = makeButton('⋯', '更多操作', 'tv-icon-button tv-more-button');
        const menu = createElement('div', 'tv-menu');
        menu.hidden = true;
        const importButton = makeButton('导入备份', '导入备份', 'tv-menu-item');
        const exportButton = makeButton('导出备份', '导出全部小剧场', 'tv-menu-item');
        const resetPositionButton = makeButton('恢复窗口居中', '恢复悬浮窗默认位置', 'tv-menu-item');
        menu.append(importButton, exportButton, resetPositionButton);
        menuWrap.append(menuButton, menu);
        const closeButton = makeButton('×', '关闭', 'tv-icon-button');
        headerActions.append(addButton, menuWrap, closeButton);
        header.append(titleWrap, headerActions);

        const tools = createElement('div', 'tv-tools');
        const search = document.createElement('input');
        search.className = 'tv-search';
        search.type = 'search';
        search.placeholder = '搜索名称或正文…';
        search.setAttribute('aria-label', '搜索小剧场');
        const categoryFilter = document.createElement('select');
        categoryFilter.className = 'tv-category-filter';
        categoryFilter.setAttribute('aria-label', '按标签筛选');
        const statusFilter = document.createElement('select');
        statusFilter.className = 'tv-status-filter';
        statusFilter.setAttribute('aria-label', '按游玩状态筛选');
        statusFilter.append(
            new Option('状态', ''),
            new Option('没玩', 'unplayed'),
            new Option('玩过', 'played'),
        );
        tools.append(search, categoryFilter, statusFilter);

        const main = createElement('main', 'tv-main');
        const list = createElement('div', 'tv-list');

        const editor = createElement('form', 'tv-editor');
        editor.hidden = true;
        const editorTitle = createElement('div', 'tv-editor-title', '新建小剧场');
        const draftList = createElement('div', 'tv-draft-list');
        const categoryOptions = document.createElement('datalist');
        categoryOptions.id = 'tv-category-options';
        const editorActions = createElement('div', 'tv-editor-actions');
        const cancelEdit = makeButton('取消', '取消编辑', 'tv-button tv-muted', 'button');
        const addDraft = makeButton('＋ 再加一篇', '继续添加小剧场', 'tv-button tv-add-draft', 'button');
        const saveEdit = makeButton('保存全部', '保存小剧场', 'tv-button tv-accent', 'submit');
        editorActions.append(cancelEdit, addDraft, saveEdit);
        editor.append(editorTitle, draftList, categoryOptions, editorActions);

        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = '.json,application/json';
        fileInput.hidden = true;

        main.append(list, editor);
        sheet.append(handle, header, tools, main, fileInput);
        overlay.appendChild(sheet);
        document.body.appendChild(overlay);

        ui = {
            overlay,
            sheet,
            handle,
            count,
            addButton,
            tools,
            search,
            categoryFilter,
            statusFilter,
            categoryOptions,
            menu,
            main,
            list,
            editor,
            editorTitle,
            draftList,
            addDraft,
            saveEdit,
            fileInput,
        };

        closeButton.addEventListener('click', closeVault);
        overlay.addEventListener('cancel', event => {
            event.preventDefault();
            closeVault();
        });
        overlay.addEventListener('click', event => {
            if (event.target === overlay) closeVault();
        });
        sheet.addEventListener('click', event => {
            event.stopPropagation();
            if (!event.target.closest('.tv-menu-wrap')) menu.hidden = true;
        });
        addButton.addEventListener('click', () => openEditor());
        menuButton.addEventListener('click', event => {
            event.stopPropagation();
            menu.hidden = !menu.hidden;
        });
        importButton.addEventListener('click', () => {
            menu.hidden = true;
            fileInput.click();
        });
        exportButton.addEventListener('click', () => {
            menu.hidden = true;
            exportBackup();
        });
        resetPositionButton.addEventListener('click', () => {
            menu.hidden = true;
            resetMobilePosition();
        });
        fileInput.addEventListener('change', importBackup);
        cancelEdit.addEventListener('click', cancelEditor);
        addDraft.addEventListener('click', addEditorDraft);
        editor.addEventListener('submit', saveEditor);
        search.addEventListener('input', () => {
            visibleLimit = PAGE_SIZE;
            clearTimeout(searchTimer);
            searchTimer = setTimeout(renderList, 160);
        });
        categoryFilter.addEventListener('change', () => {
            visibleLimit = PAGE_SIZE;
            renderList();
        });
        statusFilter.addEventListener('change', () => {
            visibleLimit = PAGE_SIZE;
            renderList();
        });
        setupMobileSheetDrag(handle);
        const refitForViewport = () => {
            if (!ui.list?.hidden) scheduleMobileSheetFit();
            else requestAnimationFrame(applyMobilePosition);
        };
        window.addEventListener('resize', refitForViewport, { passive: true });
        globalThis.visualViewport?.addEventListener('resize', refitForViewport, { passive: true });
        document.addEventListener('keydown', event => {
            if (event.key !== 'Escape' || !overlay.classList.contains('is-open')) return;
            if (!menu.hidden) menu.hidden = true;
            else if (!editor.hidden) cancelEditor();
            else closeVault();
        });
    }

    function ensureLauncher() {
        if (document.querySelector('#tv-launcher')) return true;
        const sendButton = document.querySelector('#send_but');
        const sendForm = document.querySelector('#send_form');
        if (!sendButton && !sendForm) return false;

        const launcher = makeButton('🎭', '打开小剧场仓库', 'tv-launcher');
        launcher.id = 'tv-launcher';
        if (sendButton?.parentElement) sendButton.parentElement.insertBefore(launcher, sendButton);
        else sendForm.appendChild(launcher);
        return true;
    }

    function eventCameFromLauncher(event) {
        const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
        if (path.some(node => node?.id === 'tv-launcher')) return true;
        return event.target instanceof Element && Boolean(event.target.closest('#tv-launcher'));
    }

    function handleLauncherActivation(event) {
        if (!eventCameFromLauncher(event)) return;
        const now = Date.now();
        if (now - lastLauncherActivation < 350) return;
        lastLauncherActivation = now;
        event.preventDefault();
        event.stopPropagation();
        void openVault();
    }

    function setVaultOpen(open) {
        if (!ui.overlay || !ui.sheet) return;
        clearTimeout(overlayCloseTimer);
        if (open) {
            if (!ui.overlay.open) {
                try {
                    ui.overlay.showModal();
                } catch (error) {
                    console.warn(`[${EXTENSION_ID}] showModal fallback`, error);
                    ui.overlay.setAttribute('open', '');
                }
            }
            ui.overlay.classList.add('is-open');
            ui.overlay.setAttribute('aria-hidden', 'false');
            ui.sheet.style.opacity = '1';
            ui.sheet.style.removeProperty('transform');
            requestAnimationFrame(applyMobilePosition);
        } else {
            ui.overlay.classList.remove('is-open');
            ui.overlay.setAttribute('aria-hidden', 'true');
            ui.sheet.style.removeProperty('opacity');
            ui.sheet.style.removeProperty('transform');
            overlayCloseTimer = setTimeout(() => {
                if (!ui.overlay.classList.contains('is-open') && ui.overlay.open) ui.overlay.close();
            }, CLOSE_ANIMATION_MS);
        }
    }

    async function openVault() {
        buildUi();
        showView('list');
        setVaultOpen(true);
        ui.count.textContent = '读取中…';
        try {
            items = await getAllItems();
            rebuildSearchCache();
        } catch (error) {
            console.error(`[${EXTENSION_ID}]`, error);
            toast('仓库读取失败，请稍后重试', 'error');
        }
        refreshCategories();
        renderList();
    }

    function closeVault() {
        if (!ui.overlay) return;
        ui.menu.hidden = true;
        clearEditor();
        showView('list');
        setVaultOpen(false);
    }

    function showView(view) {
        if (!ui.list) return;
        ui.addButton.hidden = view === 'editor';
        ui.tools.hidden = view !== 'list';
        ui.list.hidden = view !== 'list';
        ui.editor.hidden = view !== 'editor';
        if (view === 'list') renderList();
    }

    function openEditor(item = null) {
        editingId = item?.id || null;
        editorDrafts = [makeEditorDraft(item)];
        ui.editorTitle.textContent = item ? '编辑小剧场' : '批量新建小剧场';
        ui.addDraft.hidden = Boolean(item);
        showView('editor');
        renderEditorDrafts(editorDrafts[0].key);
    }

    function makeEditorDraft(item = null) {
        return {
            key: makeId(),
            title: item?.title || '',
            category: item ? tagsInputValue(item) : '',
            content: item?.content || '',
            expanded: true,
        };
    }

    function validEditorDrafts() {
        return editorDrafts.filter(draft => draft.content.trim());
    }

    function updateEditorSaveLabel() {
        if (editingId) {
            ui.saveEdit.textContent = '保存';
            ui.saveEdit.setAttribute('aria-label', '保存小剧场');
            return;
        }
        const count = validEditorDrafts().length;
        ui.saveEdit.textContent = count ? `保存全部（${count}）` : '保存全部';
        ui.saveEdit.setAttribute('aria-label', count ? `保存全部 ${count} 篇小剧场` : '保存全部小剧场');
    }

    function draftSummaryTitle(draft, index) {
        return draft.title.trim() || `第 ${index + 1} 篇`;
    }

    function draftSummaryMeta(draft) {
        const content = draft.content.trim();
        const tags = normalizeTags(draft.category);
        const tagSummary = `${tags[0]}${tags.length > 1 ? ` +${tags.length - 1}` : ''}`;
        if (!content) return draft.category.trim() ? `${tagSummary} · 等待正文` : '空白，保存时会跳过';
        return `${tagSummary} · ${content.length} 字`;
    }

    function renderEditorDrafts(focusKey = null) {
        ui.draftList.replaceChildren();
        editorDrafts.forEach((draft, index) => {
            const card = createElement('section', `tv-draft-card${draft.expanded ? ' is-expanded' : ''}${draft.content.trim() ? ' is-ready' : ''}`);
            if (editingId) card.classList.add('is-single-edit');
            card.dataset.draftKey = draft.key;
            const header = createElement('div', 'tv-draft-header');
            const toggle = makeButton('', `打开第 ${index + 1} 篇`, 'tv-draft-toggle');
            toggle.setAttribute('aria-expanded', String(draft.expanded));
            const summary = createElement('span', 'tv-draft-summary');
            const summaryTitle = createElement('span', 'tv-draft-summary-title', draftSummaryTitle(draft, index));
            const summaryMeta = createElement('span', 'tv-draft-summary-meta', draftSummaryMeta(draft));
            const chevron = createElement('span', 'tv-draft-chevron', '⌄');
            summary.append(summaryTitle, summaryMeta);
            toggle.append(summary, chevron);
            const remove = makeButton('×', `删除第 ${index + 1} 个输入框`, 'tv-draft-remove');
            remove.hidden = Boolean(editingId);
            header.append(toggle, remove);

            const body = createElement('div', 'tv-draft-body');
            body.hidden = !draft.expanded;
            const nameInput = document.createElement('input');
            nameInput.className = 'tv-input';
            nameInput.placeholder = '给它起个名字';
            nameInput.maxLength = 120;
            nameInput.value = draft.title;
            const categoryInput = document.createElement('input');
            categoryInput.className = 'tv-input';
            categoryInput.placeholder = '标签，用逗号分开：剧情，现代，甜宠';
            categoryInput.setAttribute('list', 'tv-category-options');
            categoryInput.maxLength = 240;
            categoryInput.value = draft.category;
            const contentInput = document.createElement('textarea');
            contentInput.className = 'tv-content-input';
            contentInput.placeholder = '点这里，从输入法的剪贴板粘贴…';
            contentInput.value = draft.content;
            body.append(nameInput, categoryInput, contentInput);
            card.append(header, body);
            ui.draftList.appendChild(card);

            const refreshSummary = () => {
                const ready = Boolean(draft.content.trim());
                card.classList.toggle('is-ready', ready);
                summaryTitle.textContent = draftSummaryTitle(draft, index);
                summaryMeta.textContent = draftSummaryMeta(draft);
                updateEditorSaveLabel();
            };
            nameInput.addEventListener('input', () => {
                draft.title = nameInput.value;
                refreshSummary();
            });
            nameInput.addEventListener('keydown', event => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                categoryInput.focus();
            });
            categoryInput.addEventListener('input', () => {
                draft.category = categoryInput.value;
                refreshSummary();
            });
            categoryInput.addEventListener('keydown', event => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                contentInput.focus();
            });
            contentInput.addEventListener('input', () => {
                draft.content = contentInput.value;
                refreshSummary();
            });
            toggle.addEventListener('click', () => {
                const shouldExpand = !draft.expanded;
                for (const entry of editorDrafts) entry.expanded = false;
                draft.expanded = shouldExpand;
                renderEditorDrafts(shouldExpand ? draft.key : null);
            });
            remove.addEventListener('click', () => removeEditorDraft(draft.key));
        });
        updateEditorSaveLabel();

        if (focusKey) {
            const card = [...ui.draftList.querySelectorAll('.tv-draft-card')]
                .find(node => node.dataset.draftKey === focusKey);
            const input = card?.querySelector('.tv-content-input');
            // Focus synchronously while the tap is still active so mobile keyboards open reliably.
            try {
                input?.focus({ preventScroll: true });
            } catch {
                input?.focus();
            }
            requestAnimationFrame(() => {
                card?.scrollIntoView({ block: 'nearest' });
            });
        }
    }

    function addEditorDraft() {
        if (editingId) return;
        if (editorDrafts.length >= MAX_BATCH_DRAFTS) {
            toast(`一次最多添加 ${MAX_BATCH_DRAFTS} 个输入框`, 'info');
            return;
        }
        for (const draft of editorDrafts) draft.expanded = false;
        const draft = makeEditorDraft();
        editorDrafts.push(draft);
        renderEditorDrafts(draft.key);
    }

    function removeEditorDraft(key) {
        const index = editorDrafts.findIndex(draft => draft.key === key);
        if (index < 0) return;
        editorDrafts.splice(index, 1);
        if (!editorDrafts.length) editorDrafts.push(makeEditorDraft());
        if (!editorDrafts.some(draft => draft.expanded)) {
            editorDrafts[Math.min(index, editorDrafts.length - 1)].expanded = true;
        }
        const active = editorDrafts.find(draft => draft.expanded);
        renderEditorDrafts(active?.key || null);
    }

    function clearEditor() {
        editingId = null;
        editorDrafts = [];
        ui.draftList?.replaceChildren();
    }

    function cancelEditor() {
        clearEditor();
        showView('list');
    }

    async function saveEditor(event) {
        event.preventDefault();
        const validDrafts = validEditorDrafts();
        if (!validDrafts.length) {
            toast('还没有可以保存的正文呀', 'error');
            const first = editorDrafts[0];
            if (first) {
                for (const draft of editorDrafts) draft.expanded = draft === first;
                renderEditorDrafts(first.key);
            }
            return;
        }

        const old = editingId ? items.find(item => item.id === editingId) : null;
        const baseTime = Date.now();
        const nextItems = validDrafts.map((draft, index) => {
            const now = new Date(baseTime - index).toISOString();
            const tags = normalizeTags(draft.category);
            return {
                id: old?.id || makeId(),
                title: draft.title.trim() || '未命名小剧场',
                category: tags[0],
                tags,
                content: draft.content.trim(),
                played: old?.played === true,
                playedAt: old?.playedAt || null,
                createdAt: old?.createdAt || now,
                updatedAt: now,
            };
        });
        const skipped = editorDrafts.length - validDrafts.length;
        ui.saveEdit.disabled = true;
        ui.addDraft.disabled = true;
        ui.saveEdit.textContent = '保存中…';

        try {
            if (old) await putItem(nextItems[0]);
            else await putItems(nextItems);
            items = await getAllItems();
            rebuildSearchCache();
            clearEditor();
            refreshCategories();
            expandedId = old ? nextItems[0].id : null;
            showView('list');
            requestAnimationFrame(() => {
                [...ui.list.querySelectorAll('.tv-row')]
                    .find(row => row.dataset.id === nextItems[0].id)
                    ?.scrollIntoView({ block: 'nearest' });
            });
            toast(old
                ? '修改已保存'
                : `已保存 ${nextItems.length} 篇${skipped ? `，跳过 ${skipped} 个空白` : ''}`);
        } catch (error) {
            console.error(`[${EXTENSION_ID}]`, error);
            toast('保存失败，请导出备份后重试', 'error');
        } finally {
            ui.saveEdit.disabled = false;
            ui.addDraft.disabled = false;
            if (!ui.editor.hidden) updateEditorSaveLabel();
        }
    }

    function rebuildSearchCache() {
        searchCache.clear();
        for (const item of items) {
            searchCache.set(item.id, `${item.title}\n${getItemTags(item).join('\n')}\n${item.content}`.toLocaleLowerCase('zh-CN'));
        }
    }

    function refreshCategories() {
        const selected = ui.categoryFilter.value;
        const categories = [...new Set(items.flatMap(item => getItemTags(item)))]
            .sort((a, b) => a.localeCompare(b, 'zh-CN'));

        ui.categoryFilter.replaceChildren();
        ui.categoryFilter.appendChild(new Option('全部', ''));
        ui.categoryOptions.replaceChildren();
        for (const category of categories) {
            ui.categoryFilter.appendChild(new Option(category, category));
            ui.categoryOptions.appendChild(new Option(category, category));
        }
        if (categories.includes(selected)) ui.categoryFilter.value = selected;
    }

    function filteredItems() {
        const query = ui.search.value.trim().toLocaleLowerCase('zh-CN');
        const category = ui.categoryFilter.value;
        const status = ui.statusFilter.value;
        return items
            .filter(item => !category || getItemTags(item).includes(category))
            .filter(item => !status || (status === 'played') === (item.played === true))
            .filter(item => !query || searchCache.get(item.id)?.includes(query))
            .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    }

    function renderList() {
        if (!ui.list) return;
        const matches = filteredItems();
        const visible = matches.slice(0, visibleLimit);
        ui.count.textContent = matches.length === items.length
            ? `${items.length} 篇`
            : `${matches.length} / ${items.length} 篇`;
        ui.list.replaceChildren();

        if (!matches.length) {
            const empty = createElement('div', 'tv-empty');
            const face = createElement('div', 'tv-empty-face', '🎭');
            const text = createElement('div', 'tv-empty-text', items.length ? '没有找到匹配的小剧场' : '仓库还是空的，先放一篇进来吧');
            empty.append(face, text);
            ui.list.appendChild(empty);
            scheduleMobileSheetFit();
            return;
        }

        for (const item of visible) ui.list.appendChild(buildRow(item));
        if (visible.length < matches.length) {
            const more = makeButton(`再显示 ${Math.min(PAGE_SIZE, matches.length - visible.length)} 篇`, '继续加载', 'tv-load-more');
            more.addEventListener('click', () => {
                visibleLimit += PAGE_SIZE;
                renderList();
            });
            ui.list.appendChild(more);
        }
        scheduleMobileSheetFit();
    }

    function scheduleMobileSheetFit() {
        cancelAnimationFrame(mobileFitFrame);
        mobileFitFrame = requestAnimationFrame(() => {
            mobileFitFrame = null;
            fitMobileSheetToRows();
        });
    }

    function cssPixels(value) {
        const number = Number.parseFloat(value);
        return Number.isFinite(number) ? number : 0;
    }

    function mobileViewportSize() {
        return {
            width: globalThis.visualViewport?.width || globalThis.innerWidth || 0,
            height: globalThis.visualViewport?.height || globalThis.innerHeight || 0,
        };
    }

    function mobileOffsetLimits() {
        const viewport = mobileViewportSize();
        const rect = ui.sheet?.getBoundingClientRect();
        if (!rect || !viewport.width || !viewport.height) return { x: 0, y: 0 };
        return {
            x: Math.max(0, (viewport.width - rect.width) / 2 - MOBILE_EDGE_GAP),
            y: Math.max(0, (viewport.height - rect.height) / 2 - MOBILE_EDGE_GAP),
        };
    }

    function clampMobileOffset(x, y) {
        const limits = mobileOffsetLimits();
        return {
            x: Math.min(limits.x, Math.max(-limits.x, x)),
            y: Math.min(limits.y, Math.max(-limits.y, y)),
        };
    }

    function setMobileOffset(x, y) {
        const offset = clampMobileOffset(x, y);
        ui.sheet.style.setProperty('--tv-mobile-offset-x', `${Math.round(offset.x)}px`);
        ui.sheet.style.setProperty('--tv-mobile-offset-y', `${Math.round(offset.y)}px`);
        return offset;
    }

    function currentMobileOffset() {
        const style = getComputedStyle(ui.sheet);
        return {
            x: cssPixels(style.getPropertyValue('--tv-mobile-offset-x')),
            y: cssPixels(style.getPropertyValue('--tv-mobile-offset-y')),
        };
    }

    function applyMobilePosition() {
        if (!ui.sheet || sheetDrag?.active) return;
        const mobileLayout = globalThis.matchMedia?.('(max-width: 767px)');
        if (!mobileLayout?.matches) {
            ui.sheet.style.removeProperty('--tv-mobile-offset-x');
            ui.sheet.style.removeProperty('--tv-mobile-offset-y');
            return;
        }
        if (!mobilePosition) {
            setMobileOffset(0, 0);
            return;
        }
        const viewport = mobileViewportSize();
        setMobileOffset(
            (mobilePosition.x - 0.5) * viewport.width,
            (mobilePosition.y - 0.5) * viewport.height,
        );
    }

    function rememberCurrentMobilePosition() {
        const viewport = mobileViewportSize();
        const offset = currentMobileOffset();
        if (!viewport.width || !viewport.height) return;
        mobilePosition = {
            x: Math.min(1, Math.max(0, 0.5 + offset.x / viewport.width)),
            y: Math.min(1, Math.max(0, 0.5 + offset.y / viewport.height)),
        };
        saveMobilePosition();
    }

    function resetMobilePosition() {
        mobilePosition = null;
        saveMobilePosition();
        setMobileOffset(0, 0);
        toast('已恢复居中', 'info');
    }

    function setupMobileSheetDrag(handle) {
        let holdTimer = null;

        const clearHold = () => {
            clearTimeout(holdTimer);
            holdTimer = null;
        };

        const finishDrag = event => {
            clearHold();
            if (!sheetDrag || event.pointerId !== sheetDrag.pointerId) return;
            const wasActive = sheetDrag.active;
            sheetDrag = null;
            ui.sheet.classList.remove('is-positioning');
            handle.classList.remove('is-dragging');
            if (handle.hasPointerCapture?.(event.pointerId)) handle.releasePointerCapture(event.pointerId);
            if (wasActive) {
                rememberCurrentMobilePosition();
                toast('位置已固定', 'info');
                event.preventDefault();
            }
        };

        handle.addEventListener('pointerdown', event => {
            if (event.button !== undefined && event.button !== 0) return;
            if (!globalThis.matchMedia?.('(max-width: 767px)')?.matches) return;
            clearHold();
            const startOffset = currentMobileOffset();
            sheetDrag = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                offsetX: startOffset.x,
                offsetY: startOffset.y,
                active: false,
            };
            handle.setPointerCapture?.(event.pointerId);
            holdTimer = setTimeout(() => {
                if (!sheetDrag || sheetDrag.pointerId !== event.pointerId) return;
                sheetDrag.active = true;
                ui.sheet.classList.add('is-positioning');
                handle.classList.add('is-dragging');
                globalThis.navigator?.vibrate?.(18);
            }, DRAG_HOLD_MS);
        });

        handle.addEventListener('pointermove', event => {
            if (!sheetDrag || event.pointerId !== sheetDrag.pointerId) return;
            const deltaX = event.clientX - sheetDrag.startX;
            const deltaY = event.clientY - sheetDrag.startY;
            if (!sheetDrag.active) {
                if (Math.hypot(deltaX, deltaY) > DRAG_CANCEL_DISTANCE) {
                    clearHold();
                    sheetDrag = null;
                    if (handle.hasPointerCapture?.(event.pointerId)) handle.releasePointerCapture(event.pointerId);
                }
                return;
            }
            setMobileOffset(sheetDrag.offsetX + deltaX, sheetDrag.offsetY + deltaY);
            event.preventDefault();
        });

        handle.addEventListener('pointerup', finishDrag);
        handle.addEventListener('pointercancel', finishDrag);
        handle.addEventListener('lostpointercapture', () => {
            clearHold();
            if (!sheetDrag) return;
            const wasActive = sheetDrag.active;
            sheetDrag = null;
            ui.sheet.classList.remove('is-positioning');
            handle.classList.remove('is-dragging');
            if (wasActive) rememberCurrentMobilePosition();
        });
        handle.addEventListener('dblclick', event => {
            event.preventDefault();
            resetMobilePosition();
        });
        handle.addEventListener('contextmenu', event => event.preventDefault());
        handle.addEventListener('keydown', event => {
            if (event.key !== 'Home' && event.key !== 'Enter') return;
            event.preventDefault();
            resetMobilePosition();
        });
    }

    function fitMobileSheetToRows() {
        if (!ui.sheet || !ui.main || !ui.list) return;
        const mobileLayout = globalThis.matchMedia?.('(max-width: 767px)');
        if (!mobileLayout?.matches) {
            ui.sheet.style.removeProperty('--tv-mobile-sheet-height');
            delete ui.sheet.dataset.visibleRows;
            return;
        }
        if (ui.list.hidden) return;

        const compactRows = [...ui.list.querySelectorAll('.tv-row:not(.is-expanded)')].slice(0, MOBILE_TARGET_ROWS);
        if (compactRows.length) {
            const heights = compactRows
                .map(row => {
                    const style = getComputedStyle(row);
                    return row.getBoundingClientRect().height
                        + cssPixels(style.marginTop)
                        + cssPixels(style.marginBottom);
                })
                .filter(height => height > 40)
                .sort((left, right) => left - right);
            if (heights.length) compactRowOuterHeight = heights[Math.floor(heights.length / 2)];
        }

        const sheetRect = ui.sheet.getBoundingClientRect();
        const mainRect = ui.main.getBoundingClientRect();
        if (!sheetRect.height || !mainRect.height) return;

        const mainStyle = getComputedStyle(ui.main);
        const listStyle = getComputedStyle(ui.list);
        const fixedHeight = sheetRect.height - mainRect.height;
        const listStart = cssPixels(mainStyle.borderTopWidth)
            + cssPixels(mainStyle.borderBottomWidth)
            + cssPixels(listStyle.paddingTop);
        const chromeHeight = fixedHeight + listStart;
        const viewportHeight = globalThis.visualViewport?.height || globalThis.innerHeight || sheetRect.height;
        const availableHeight = Math.max(0, viewportHeight - 24);
        const fiveRowHeight = chromeHeight + compactRowOuterHeight * MOBILE_TARGET_ROWS;
        const visibleRows = fiveRowHeight <= availableHeight + 1
            ? MOBILE_TARGET_ROWS
            : MOBILE_FALLBACK_ROWS;
        const targetHeight = Math.min(
            availableHeight,
            Math.ceil(chromeHeight + compactRowOuterHeight * visibleRows),
        );

        ui.sheet.style.setProperty('--tv-mobile-sheet-height', `${targetHeight}px`);
        ui.sheet.dataset.visibleRows = String(visibleRows);
        applyMobilePosition();
    }

    function buildRow(item) {
        const row = createElement('article', 'tv-row');
        row.dataset.id = item.id;
        row.classList.add(item.played === true ? 'is-played-item' : 'is-unplayed-item');
        const isExpanded = expandedId === item.id;
        if (isExpanded) row.classList.add('is-expanded');
        const open = makeButton('', `查看 ${item.title}`, 'tv-row-main');
        open.setAttribute('aria-expanded', String(isExpanded));
        const heading = createElement('span', 'tv-row-heading');
        const name = createElement('span', 'tv-row-name', item.title);
        const meta = createElement('span', 'tv-row-meta');
        const tags = getItemTags(item);
        const category = createElement('span', 'tv-row-category', tags[0]);
        applyTagColor(category, tags[0]);
        const tagMore = tags.length > 1
            ? createElement('span', 'tv-row-tag-more', `+${tags.length - 1}`)
            : null;
        if (tagMore) {
            tagMore.title = tags.slice(1).join('、');
            meta.classList.add('has-more-tags');
        }
        const playState = createElement(
            'span',
            `tv-row-play-state ${item.played === true ? 'is-played' : 'is-unplayed'}`,
            item.played === true ? '✓ 已玩' : '○ 未玩',
        );
        const details = createElement('span', 'tv-row-details', `${formatDate(item.updatedAt)} · ${item.content.length} 字`);
        meta.append(category);
        if (tagMore) meta.append(tagMore);
        meta.append(playState, details);
        const previewText = item.content.replace(/\s+/g, ' ').trim();
        const preview = createElement('span', 'tv-row-preview', previewText || '（空正文）');
        heading.append(name, meta, preview);
        const chevron = createElement('span', 'tv-row-chevron', '⌄');
        open.append(heading, chevron);
        const insert = makeButton('插入', `将 ${item.title} 插入输入框`, 'tv-row-insert');

        const body = createElement('div', 'tv-row-body');
        body.hidden = !isExpanded;
        const allTags = createElement('div', 'tv-row-all-tags');
        if (tags.length <= 1) allTags.hidden = true;
        for (const tag of tags) {
            const tagNode = createElement('span', 'tv-row-full-tag', tag);
            applyTagColor(tagNode, tag);
            allTags.appendChild(tagNode);
        }
        const content = createElement('pre', 'tv-row-content', item.content);
        const actions = createElement('div', 'tv-row-body-actions');
        const togglePlayed = makeButton(
            item.played === true ? '改回没玩过' : '标记为玩过',
            item.played === true ? '将这个小剧场改回没玩过' : '将这个小剧场标记为玩过',
            `tv-button tv-played-toggle${item.played === true ? ' is-played' : ''}`,
        );
        const edit = makeButton('编辑', '编辑小剧场', 'tv-button tv-muted');
        const remove = makeButton('删除', '删除小剧场', 'tv-button tv-danger');
        actions.append(togglePlayed, edit, remove);
        body.append(allTags, content, actions);

        row.append(open, insert, body);
        open.addEventListener('click', () => toggleExpandedRow(row, item.id));
        insert.addEventListener('click', () => insertIntoPrompt(item.content, insert));
        togglePlayed.addEventListener('click', () => void togglePlayedState(item, row));
        edit.addEventListener('click', () => openEditor(item));
        remove.addEventListener('click', () => void deleteScene(item));
        return row;
    }

    async function togglePlayedState(item, row) {
        const played = item.played !== true;
        const listScrollTop = ui.list?.scrollTop || 0;
        const rowTop = row?.getBoundingClientRect().top ?? null;
        const contentScrollTop = row?.querySelector('.tv-row-content')?.scrollTop || 0;
        try {
            await putItem({
                ...item,
                played,
                playedAt: played ? new Date().toISOString() : null,
            });
            items = await getAllItems();
            rebuildSearchCache();
            renderList();
            const nextRow = [...ui.list.querySelectorAll('.tv-row')]
                .find(candidate => candidate.dataset.id === item.id);
            if (nextRow && rowTop !== null) {
                // Re-rendering should not move the card the user just acted on.
                ui.list.scrollTop += nextRow.getBoundingClientRect().top - rowTop;
                const nextContent = nextRow.querySelector('.tv-row-content');
                if (nextContent) nextContent.scrollTop = contentScrollTop;
            } else {
                // The card can disappear under a status filter; keep the list itself in place.
                ui.list.scrollTop = listScrollTop;
            }
            toast(played ? '已经标记为玩过' : '已经改回没玩过');
        } catch (error) {
            console.error(`[${EXTENSION_ID}]`, error);
            toast('状态保存失败', 'error');
        }
    }

    function setRowExpanded(row, expanded) {
        row.classList.toggle('is-expanded', expanded);
        const button = row.querySelector('.tv-row-main');
        const body = row.querySelector('.tv-row-body');
        button?.setAttribute('aria-expanded', String(expanded));
        if (body) body.hidden = !expanded;
    }

    function toggleExpandedRow(row, id) {
        const shouldExpand = !row.classList.contains('is-expanded');
        const previous = ui.list.querySelector('.tv-row.is-expanded');
        if (previous && previous !== row) setRowExpanded(previous, false);
        setRowExpanded(row, shouldExpand);
        expandedId = shouldExpand ? id : null;

        if (shouldExpand) {
            requestAnimationFrame(() => row.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
        }
    }

    function insertIntoPrompt(content, button) {
        if (pendingInsertTimer) return;
        const textarea = document.querySelector('#send_textarea')
            || document.querySelector('#send_form textarea')
            || document.querySelector('textarea[name="prompt"]');
        if (!textarea) {
            toast('没有找到酒馆输入框', 'error');
            return;
        }

        const current = textarea.value || '';
        const start = Number.isInteger(textarea.selectionStart) ? textarea.selectionStart : current.length;
        const end = Number.isInteger(textarea.selectionEnd) ? textarea.selectionEnd : start;
        const before = current.slice(0, start);
        const after = current.slice(end);
        const leftGap = before && !before.endsWith('\n') ? '\n\n' : '';
        const rightGap = after && !after.startsWith('\n') ? '\n\n' : '';
        textarea.value = `${before}${leftGap}${content}${rightGap}${after}`;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
        const caret = before.length + leftGap.length + content.length;
        textarea.setSelectionRange?.(caret, caret);

        if (button) {
            button.disabled = true;
            button.classList.add('is-success');
            button.textContent = '已插入 ✓';
        }
        toast('已经放进输入框啦');
        pendingInsertTimer = setTimeout(() => {
            pendingInsertTimer = null;
            closeVault();
            setTimeout(() => textarea.focus(), CLOSE_ANIMATION_MS);
        }, INSERT_FEEDBACK_MS);
    }

    async function deleteScene(item) {
        if (!window.confirm(`确定删除“${item.title}”吗？`)) return;
        try {
            await removeItem(item.id);
            items = await getAllItems();
            rebuildSearchCache();
            if (expandedId === item.id) expandedId = null;
            refreshCategories();
            showView('list');
            toast('已删除');
        } catch (error) {
            console.error(`[${EXTENSION_ID}]`, error);
            toast('删除失败', 'error');
        }
    }

    function exportBackup() {
        const payload = {
            type: 'sillytavern-theatre-vault',
            version: 2,
            exportedAt: new Date().toISOString(),
            items: items.map(item => {
                const tags = getItemTags(item);
                return { ...item, category: tags[0], tags };
            }),
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
        const link = document.createElement('a');
        const date = new Date().toISOString().slice(0, 10);
        link.href = URL.createObjectURL(blob);
        link.download = `小剧场仓库备份_${date}.json`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
        toast(`已导出 ${items.length} 篇`);
    }

    async function importBackup(event) {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        try {
            const parsed = JSON.parse(await file.text());
            const incoming = Array.isArray(parsed) ? parsed : parsed.items;
            if (!Array.isArray(incoming)) throw new Error('Invalid backup');
            let imported = 0;
            for (const raw of incoming) {
                if (!raw || typeof raw.content !== 'string' || !raw.content.trim()) continue;
                const now = new Date().toISOString();
                const tags = normalizeTags(raw.tags, raw.category || '未分类');
                await putItem({
                    id: typeof raw.id === 'string' ? raw.id : makeId(),
                    title: String(raw.title || '未命名小剧场').slice(0, 120),
                    category: tags[0],
                    tags,
                    content: raw.content.trim(),
                    played: raw.played === true,
                    playedAt: raw.played === true && raw.playedAt ? raw.playedAt : null,
                    createdAt: raw.createdAt || now,
                    updatedAt: raw.updatedAt || now,
                });
                imported += 1;
            }
            items = await getAllItems();
            rebuildSearchCache();
            refreshCategories();
            visibleLimit = PAGE_SIZE;
            showView('list');
            toast(`成功导入 ${imported} 篇`);
        } catch (error) {
            console.error(`[${EXTENSION_ID}]`, error);
            toast('这个备份文件读不出来', 'error');
        }
    }

    function initialize() {
        buildUi();
        document.addEventListener('click', handleLauncherActivation, true);
        if (!ensureLauncher()) {
            const observer = new MutationObserver(() => {
                if (ensureLauncher()) observer.disconnect();
            });
            observer.observe(document.body, { childList: true, subtree: true });
            setTimeout(() => observer.disconnect(), 30000);
        }
        console.info(`[${EXTENSION_ID}] ready v0.6.3`);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize, { once: true });
    } else {
        initialize();
    }
})();
