/* Shared runtime for the three userscript entry points; GPL-3.0-or-later.
 * Keep UI translation local. Only an explicit click on the description button
 * sends that description to the existing translation provider.
 */
(function (window, document) {
    'use strict';

    const LANG = 'zh-CN';
    if (typeof I18N === 'undefined' || !(I18N[LANG] || I18N.zh)?.public) {
        console.error('[github-chinese] 词库未加载，已停止初始化。请检查脚本管理器中的 @require 加载记录。');
        return;
    }

    const dictionary = I18N[LANG] || I18N.zh;
    const conf = I18N.conf || {};
    const features = {
        enable_RegExp: typeof GM_getValue !== 'function' || Boolean(GM_getValue('enable_RegExp', true)),
        enable_transDesc: typeof GM_getValue !== 'function' || Boolean(GM_getValue('enable_transDesc', true))
    };
    const protectedSelectors = [
        'script', 'style', 'noscript', 'pre', 'code', 'svg',
        '[contenteditable]:not([contenteditable="false"])',
        '.cm-editor', '.cm-scroller', '.monaco-editor', '.markdown-body',
        '.blob-code', '.react-code-text', '.CheckStep-line-content',
        '.AppHeader-context-full', '.react-directory-row', '#translate-me'
    ];
    const attributeFields = [
        'title', 'placeholder', 'aria-label', 'data-confirm', 'data-confirm-text',
        'data-confirm-cancel-text', 'cancel-confirm-text', 'data-disable-with',
        'data-visible-text'
    ];
    const siteTypes = {
        'gist.github.com': 'gist', 'www.githubstatus.com': 'status',
        'skills.github.com': 'skills', 'education.github.com': 'education'
    };
    const descriptionSelectors = {
        repository: '.f4.my-3', gist: '.gist-content [itemprop="about"]'
    };
    const invalidSelectors = new Set();
    const translatedValues = new WeakMap();
    const textCache = new Map();
    const pending = new Set();
    let pageConfig;
    let started = false;
    let timer = null;
    let pageDirty = true;
    let titleDirty = true;
    let previousURL = window.location.href;

    function validSelectors(selectors) {
        const probe = document.createElement('div');
        return [...new Set(selectors)].filter(selector => {
            if (typeof selector !== 'string' || !selector.trim()) return false;
            try {
                probe.matches(selector);
                return true;
            } catch {
                if (!invalidSelectors.has(selector)) {
                    invalidSelectors.add(selector);
                    console.warn('[github-chinese] 已跳过无效的词库选择器：', selector);
                }
                return false;
            }
        });
    }

    function buildPageConfig(type) {
        const common = dictionary.public;
        const local = type === 'public' ? {} : (dictionary[type] || {});
        const ignore = conf.ignoreSelectorPage || {};
        const mutation = conf.ignoreMutationSelectorPage || {};
        return {
            type,
            staticDict: { ...common.static, ...local.static },
            regexpRules: [...(local.regexp || []), ...(common.regexp || [])],
            selectors: [...(local.selector || []), ...(common.selector || [])],
            ignore: validSelectors([...protectedSelectors, ...(ignore['*'] || []), ...(ignore[type] || [])]).join(', '),
            ignoreMutation: validSelectors([...(mutation['*'] || []), ...(mutation[type] || [])]).join(', ')
        };
    }

    function supportedType(type) {
        while (type && !dictionary[type]) {
            const separator = type.lastIndexOf('/');
            type = separator < 0 ? '' : type.slice(0, separator);
        }
        return type || 'public';
    }

    function matchPath(pattern, pathname) {
        if (typeof pattern?.exec !== 'function') return null;
        pattern.lastIndex = 0;
        return pattern.exec(pathname);
    }

    function detectPageType() {
        const url = new URL(window.location.href);
        if (siteTypes[url.hostname]) return supportedType(siteTypes[url.hostname]);
        const body = document.body;
        const parts = url.pathname.split('/').filter(Boolean);
        const meta = document.querySelector('meta[name="analytics-location"]')?.content || '';
        if (url.pathname === '/') {
            const loggedIn = body?.classList.contains('logged-in') ||
                Boolean(document.querySelector('meta[name="user-login"]')?.content);
            return supportedType(loggedIn ? 'dashboard' : 'homepage');
        }
        if (body?.classList.contains('session-authentication') &&
            /^\/(?:login|sessions?|signup|password_reset|account_verifications)(?:\/|$)/.test(url.pathname)) {
            return supportedType('session-authentication');
        }
        if (/^\/(?:orgs|organizations)(?:\/|$)/.test(url.pathname) ||
            (parts.length === 1 && /\/<org-login>/.test(meta))) {
            const match = matchPath(conf.rePagePathOrg, url.pathname);
            return supportedType(match ? 'orgs/' + match.slice(1).find(Boolean) : 'orgs');
        }
        const globalMatch = matchPath(conf.rePagePath, url.pathname);
        if (globalMatch) return supportedType(globalMatch.slice(1).find(Boolean));
        const profile = body?.classList.contains('page-profile') || meta === '/<user-name>';
        if (parts.length === 1 || (profile && parts.length === 2 &&
            ['stars', 'followers', 'following', 'repositories', 'projects', 'packages', 'sponsoring'].includes(parts[1]))) {
            const tab = parts[1] === 'stars' ? 'stars' : url.searchParams.get('tab');
            return supportedType(tab ? 'page-profile/' + tab : 'page-profile');
        }
        // Metadata can arrive after a Turbo/React render. The path is a safe
        // fallback for normal owner/repository routes; missing sections inherit
        // their parent dictionary instead of disabling all translation.
        const repositoryMeta = /\/<user-name>\/<repo-name>/.test(meta) ||
            document.querySelector('meta[name="octolytics-dimension-repository_nwo"]');
        if (repositoryMeta || (parts.length >= 2 && parts.slice(0, 2).every(part => /^[\w.-]+$/.test(part)))) {
            const match = matchPath(conf.rePagePathRepo, url.pathname);
            return supportedType(match ? 'repository/' + match[1] : 'repository');
        }
        return 'public';
    }

    function isIgnored(node, mutations = false) {
        const element = node.nodeType === 1 ? node : node.parentElement;
        if (!element) return false;
        // Translate textarea placeholders, never the user's draft/value.
        if (node.nodeType === 3 && element.closest('textarea')) return true;
        return Boolean((pageConfig.ignore && element.closest(pageConfig.ignore)) ||
            (mutations && pageConfig.ignoreMutation && element.closest(pageConfig.ignoreMutation)));
    }

    function translateText(text) {
        if (typeof text !== 'string' || !/[a-zA-Z,.]/.test(text)) return false;
        const trimmed = text.trim();
        const cleaned = trimmed.replace(/\s+/g, ' ');
        if (textCache.has(cleaned)) {
            const result = textCache.get(cleaned);
            return result ? text.replace(trimmed, () => result) : false;
        }
        let result = Object.hasOwn(pageConfig.staticDict, cleaned) ? pageConfig.staticDict[cleaned] : false;
        if (typeof result !== 'string' && features.enable_RegExp) {
            for (const [pattern, replacement] of pageConfig.regexpRules) {
                const candidate = cleaned.replace(pattern, replacement);
                if (candidate !== cleaned) { result = candidate; break; }
            }
        }
        result = typeof result === 'string' && result !== cleaned ? result : false;
        if (textCache.size >= 2000) textCache.delete(textCache.keys().next().value);
        textCache.set(cleaned, result);
        return result ? text.replace(trimmed, () => result) : false;
    }

    function rememberTranslation(target, field, translated) {
        let fields = translatedValues.get(target);
        if (!fields) translatedValues.set(target, fields = new Map());
        fields.set(field, translated);
    }

    function writeTranslation(target, field, text, write) {
        if (!text || translatedValues.get(target)?.get(field) === text) return;
        const translated = translateText(text);
        if (!translated || translated === text) return;
        rememberTranslation(target, field, translated);
        write(translated);
    }

    function translateTime(root) {
        if (!root) return;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode: node => node.parentElement?.closest('style, script') ?
                NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
        });
        let node;
        while ((node = walker.nextNode())) {
            const translated = node.data.replace(/^on\s+/, '');
            if (translated !== node.data) node.data = translated;
        }
    }

    function translateElement(element) {
        if (element.tagName === 'RELATIVE-TIME') {
            if (element.getAttribute('lang') !== LANG) element.setAttribute('lang', LANG);
            translateTime(element.shadowRoot); // A custom element may not be upgraded yet.
        }
        for (const field of attributeFields) {
            if (!element.hasAttribute(field)) continue;
            writeTranslation(element, field, element.getAttribute(field), value => element.setAttribute(field, value));
        }
        if (element.tagName === 'OPTGROUP') {
            writeTranslation(element, 'label', element.label, value => { element.label = value; });
        }
        if (element.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(element.type)) {
            writeTranslation(element, 'value', element.value, value => { element.value = value; });
        }
    }

    function traverseNode(root) {
        if (!root || isIgnored(root)) return;
        const handle = node => {
            if (node.nodeType === 1) translateElement(node);
            else if (node.nodeType === 3 && node.length <= 500) {
                writeTranslation(node, 'data', node.data, value => { node.data = value; });
            }
        };
        // TreeWalker.nextNode() starts AFTER its root. Attribute mutations and
        // newly inserted buttons must also process the root element itself.
        handle(root);
        if (root.nodeType === 3) return;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
            acceptNode: node => isIgnored(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
        });
        let node;
        while ((node = walker.nextNode())) handle(node);
    }

    function translateTitle() {
        const text = document.title;
        const title = dictionary.title || {};
        let translated = title.static?.[text];
        if (typeof translated !== 'string') {
            for (const [pattern, replacement] of title.regexp || []) {
                const candidate = text.replace(pattern, replacement);
                if (candidate !== text) { translated = candidate; break; }
            }
        }
        if (translated && translated !== text) document.title = translated;
    }

    function translateSelectors() {
        for (const [selector, translated] of pageConfig.selectors) {
            if (typeof translated !== 'string') continue;
            let elements;
            try { elements = document.querySelectorAll(selector); } catch { continue; }
            for (const element of elements) {
                if (isIgnored(element)) continue;
                if (element.childElementCount === 0) {
                    if (element.textContent !== translated) element.textContent = translated;
                    if (element.firstChild?.nodeType === 3) rememberTranslation(element.firstChild, 'data', translated);
                } else {
                    // Preserve icons, counters, listeners and nested controls.
                    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
                    const texts = [];
                    let node;
                    while ((node = walker.nextNode())) if (node.data.trim() && !isIgnored(node)) texts.push(node);
                    if (texts.length === 1) {
                        if (texts[0].data !== translated) texts[0].data = translated;
                        rememberTranslation(texts[0], 'data', translated);
                    }
                }
            }
        }
    }

    function nestedProperty(object, path) {
        return path.replace(/\?\./g, '.').split('.').reduce((value, part) => {
            const match = /^(\w+)(?:\[(\d+)\])?$/.exec(part);
            if (!match) return undefined;
            const property = value?.[match[1]];
            return match[2] === undefined ? property : property?.[match[2]];
        }, object);
    }

    function requestRemoteTranslation(text) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest !== 'function') return reject(new Error('request unavailable'));
            GM_xmlhttpRequest({
                method: 'POST',
                url: 'https://fanyi.iflyrec.com/TJHZTranslationService/v2/textAutoTranslation',
                headers: { 'Content-Type': 'application/json', Origin: 'https://fanyi.iflyrec.com' },
                data: JSON.stringify({ from: 2, to: 1, type: 1, contents: [{ text }] }),
                timeout: 15000,
                onload: response => {
                    try {
                        if (response.status !== 200) return reject(new Error('HTTP error'));
                        const result = nestedProperty(JSON.parse(response.responseText), 'biz[0].sectionResult[0].dst');
                        if (typeof result !== 'string' || !result.trim()) return reject(new Error('empty translation'));
                        resolve(result);
                    } catch { reject(new Error('invalid response')); }
                },
                onerror: () => reject(new Error('network error')),
                ontimeout: () => reject(new Error('timeout')),
                onabort: () => reject(new Error('aborted'))
            });
        });
    }

    function translateDescription() {
        const selector = descriptionSelectors[pageConfig.type];
        if (!features.enable_transDesc || !selector) return;
        const element = document.querySelector(selector);
        if (!element || element.nextElementSibling?.id === 'translate-me') return;
        const button = document.createElement('button');
        button.id = 'translate-me';
        button.type = 'button';
        button.style.cssText = 'color:#1b95e0;font-size:small;cursor:pointer;background:none;border:0;';
        button.textContent = LANG === 'zh-TW' ? '翻譯' : '翻译';
        element.after(button);
        button.addEventListener('click', async () => {
            const text = element.textContent.trim();
            const sourceURL = window.location.href;
            if (!text || button.disabled) return;
            button.disabled = true;
            try {
                const translated = await requestRemoteTranslation(text);
                if (!button.isConnected || !element.isConnected || window.location.href !== sourceURL ||
                    element.textContent.trim() !== text) return;
                const result = document.createElement('div');
                result.id = 'translate-me'; // Also marks a completed description.
                const credit = document.createElement('a');
                credit.textContent = LANG === 'zh-TW' ? '由訊飛聽見翻譯' : '由讯飞听见翻译';
                credit.href = 'https://fanyi.iflyrec.com/text-translate';
                credit.target = '_blank';
                credit.rel = 'noopener noreferrer';
                result.append(credit, document.createElement('br'), document.createTextNode(translated));
                button.replaceWith(result);
            } catch {
                button.textContent = LANG === 'zh-TW' ? '翻譯失敗，點擊重試' : '翻译失败，点击重试';
            } finally { button.disabled = false; }
        });
    }

    function schedule(full = false) {
        if (full) { pageDirty = true; titleDirty = true; }
        if (timer === null) timer = window.setTimeout(flush, 24);
    }

    function flush() {
        timer = null;
        if (!document.body) return;
        if (pageDirty || previousURL !== window.location.href) {
            previousURL = window.location.href;
            pageConfig = buildPageConfig(detectPageType());
            textCache.clear();
            pending.clear();
            pending.add(document.body);
            pageDirty = false;
            titleDirty = true;
        }
        if (document.documentElement.lang !== LANG) document.documentElement.lang = LANG;
        const nodes = [...pending];
        pending.clear();
        const roots = new Set(nodes);
        for (const node of nodes) {
            if (!node.isConnected || isIgnored(node, true)) continue;
            let parent = node.parentNode;
            while (parent && !roots.has(parent)) parent = parent.parentNode;
            if (!parent) traverseNode(node);
        }
        if (titleDirty) { translateTitle(); titleDirty = false; }
        translateSelectors();
        translateDescription();
    }

    function watchUpdate() {
        new MutationObserver(mutations => {
            if (previousURL !== window.location.href) pageDirty = true;
            for (const mutation of mutations) {
                const target = mutation.target;
                if (target === document.documentElement && mutation.attributeName === 'lang') {
                    if (document.documentElement.lang !== LANG) schedule();
                    continue;
                }
                if (target.nodeType === 1 && target.matches('meta[name="analytics-location"]')) {
                    pageDirty = true;
                }
                if (target.nodeName === 'TITLE' || target.parentNode?.nodeName === 'TITLE') {
                    titleDirty = true;
                    continue;
                }
                const nodes = mutation.type === 'childList' ? mutation.addedNodes : [target];
                for (const node of nodes) {
                    if (node === document.body) pageDirty = true;
                    if (document.body?.contains(node) && !isIgnored(node, true)) pending.add(node);
                }
            }
            if (pending.size > 200) { pending.clear(); pending.add(document.body); }
            if (pending.size || pageDirty || titleDirty || document.documentElement.lang !== LANG) schedule();
        }).observe(document.documentElement, {
            childList: true, subtree: true, characterData: true, attributes: true,
            attributeFilter: [...attributeFields, 'value', 'label', 'lang', 'content']
        });
    }

    function registerMenu() {
        if (typeof GM_registerMenuCommand !== 'function') return;
        const toggle = (label, key) => {
            let menuId;
            const command = () => {
                features[key] = !features[key];
                if (typeof GM_setValue === 'function') GM_setValue(key, features[key]);
                textCache.clear();
                if (key === 'enable_transDesc' && !features[key]) document.getElementById('translate-me')?.remove();
                schedule(true);
                if (typeof GM_unregisterMenuCommand === 'function') GM_unregisterMenuCommand(menuId);
                menuId = GM_registerMenuCommand((features[key] ? '禁用 ' : '启用 ') + label, command);
            };
            menuId = GM_registerMenuCommand((features[key] ? '禁用 ' : '启用 ') + label, command);
        };
        toggle(LANG === 'zh-TW' ? '正則功能' : '正则功能', 'enable_RegExp');
        toggle(LANG === 'zh-TW' ? '描述翻譯' : '描述翻译', 'enable_transDesc');
        GM_registerMenuCommand(LANG === 'zh-TW' ? '重新翻譯目前頁面' : '重新翻译当前页面', () => schedule(true));
    }

    function start() {
        if (started || !document.body || !document.documentElement) return;
        started = true;
        pageConfig = buildPageConfig('public');
        watchUpdate();
        schedule(true);
    }

    registerMenu();
    for (const event of ['turbo:load', 'turbo:render', 'turbo:frame-load', 'pjax:end']) {
        document.addEventListener(event, () => { start(); schedule(true); });
    }
    for (const event of ['popstate', 'pageshow']) {
        window.addEventListener(event, () => { start(); schedule(true); });
    }
    // @require may finish after DOMContentLoaded. Do not wait for an event
    // that has already happened; other script managers need not replay it.
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
})(window, document);
