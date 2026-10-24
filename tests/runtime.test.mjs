import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { JSDOM, VirtualConsole } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = process.env.USERSCRIPT_TEST_ROOT || root;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture() {
    const language = {
        public: { static: { Settings: '设置', Open: '打开', Close: '关闭', Create: '创建',
            'Run workflow': '运行工作流', 'Loading...': '加载中' }, regexp: [], selector: [] },
        title: { static: { 'Known title': '已知标题' }, regexp: [] },
        repository: { static: { 'Context label': '仓库' }, regexp: [] },
        'repository/actions': { static: { 'Context label': '工作流' }, regexp: [] },
        'repository/settings': { static: { 'Context label': '仓库设置' }, regexp: [] },
        'page-profile': { static: {} }, homepage: { static: {} }, dashboard: { static: {} },
        gist: { static: {} }, status: { static: {} }, skills: { static: {} }, education: { static: {} },
        settings: { static: {} }, 'settings/profile': { static: {} },
        orgs: { static: {} }, 'orgs/people': { static: {} }
    };
    return {
        conf: {
            rePagePath: /^\/(settings\/profile|settings|notifications|new)/,
            rePagePathRepo: /^\/[^/]+\/[^/]+\/(actions|settings|issues|blob|tree)/,
            rePagePathOrg: /^\/orgs\/[^/]+\/(people|repositories)/,
            characterDataPage: ['repository/actions'],
            ignoreSelectorPage: { '*': ['pre', 'code', 'script', '.markdown-body'] },
            ignoreMutationSelectorPage: { '*': [] }
        },
        'zh-CN': language, 'zh-TW': language
    };
}

async function setup(t, options = {}) {
    const virtualConsole = new VirtualConsole();
    const errors = [];
    const dom = new JSDOM('<!doctype html><html lang="en"><head><title>Unknown title</title>' +
        '<meta name="analytics-location" content="/<user-name>/<repo-name>"></head>' +
        '<body class="logged-in">' + (options.html || '<button>Settings</button>') + '</body></html>', {
        url: options.url || 'https://github.com/owner/repository',
        runScripts: 'outside-only', virtualConsole
    });
    t.after(() => dom.window.close());
    const window = dom.window;
    const document = window.document;
    window.addEventListener('error', event => { errors.push(event.error || event.message); event.preventDefault(); });
    const menus = new Map();
    const requests = [];
    let nextMenu = 0;
    window.GM_getValue = key => key === 'enable_transDesc' ? Boolean(options.descriptions) : true;
    window.GM_setValue = () => {};
    window.GM_notification = () => {};
    window.GM_registerMenuCommand = (label, callback) => { menus.set(++nextMenu, { label, callback }); return nextMenu; };
    window.GM_unregisterMenuCommand = id => menus.delete(id);
    window.GM_xmlhttpRequest = request => requests.push(request);
    window.alert = message => errors.push(message);
    const stats = { callbacks: 0 };
    const Observer = window.MutationObserver;
    window.MutationObserver = class extends Observer {
        constructor(callback) { super((records, observer) => { stats.callbacks++; callback(records, observer); }); }
    };
    if (options.dictionaryFile) window.eval(fs.readFileSync(path.join(root, options.dictionaryFile), 'utf8'));
    else if (!options.missingDictionary) {
        window.I18N = fixture();
        options.configure?.(window.I18N);
    }
    if (options.late) await delay(5); // The real DOMContentLoaded event has already fired.
    window.eval(fs.readFileSync(path.join(sourceRoot, options.variant || 'main.user.js'), 'utf8'));
    await delay(90);
    return { window, document, errors, menus, requests, stats };
}

function noErrors(environment) { assert.deepEqual(environment.errors, []); }

test('starts when injected after DOMContentLoaded', async t => {
    const env = await setup(t, { late: true });
    assert.equal(env.document.querySelector('button').textContent, '设置');
    noErrors(env);
});

test('starts before DOMContentLoaded without duplicate initialization', async t => {
    const env = await setup(t);
    assert.equal(env.document.querySelector('button').textContent, '设置');
    env.document.dispatchEvent(new env.window.Event('DOMContentLoaded'));
    await delay(60);
    assert.equal(env.menus.size, 3);
    noErrors(env);
});

test('processes root attributes of a newly inserted button', async t => {
    const env = await setup(t);
    const button = env.document.createElement('button');
    button.title = 'Open';
    button.setAttribute('aria-label', 'Close');
    env.document.body.append(button);
    await delay(70);
    assert.equal(button.title, '打开');
    assert.equal(button.getAttribute('aria-label'), '关闭');
    noErrors(env);
});

test('observes subsequent title and aria-label changes on modern controls', async t => {
    const env = await setup(t, { html: '<button id="control"></button>' });
    const control = env.document.getElementById('control');
    control.title = 'Open';
    control.setAttribute('aria-label', 'Close');
    await delay(70);
    assert.equal(control.title, '打开');
    assert.equal(control.getAttribute('aria-label'), '关闭');
    noErrors(env);
});

test('handles React text-node updates on pages outside the old allowlist', async t => {
    const env = await setup(t, { html: '<button>Loading...</button>' });
    env.document.querySelector('button').firstChild.data = 'Run workflow';
    await delay(70);
    assert.equal(env.document.querySelector('button').textContent, '运行工作流');
    noErrors(env);
});

test('survives a relative-time element before its shadow root exists', async t => {
    const env = await setup(t, { html: '<relative-time datetime="2026-10-24">just now</relative-time><button>Settings</button>' });
    assert.equal(env.document.querySelector('button').textContent, '设置');
    assert.equal(env.document.querySelector('relative-time').lang, 'zh-CN');
    noErrors(env);
});

test('keeps listening when Turbo replaces the entire body', async t => {
    const env = await setup(t);
    const body = env.document.createElement('body');
    body.innerHTML = '<button>Open</button>';
    env.document.body.replaceWith(body);
    await delay(90);
    assert.equal(body.querySelector('button').textContent, '打开');
    noErrors(env);
});

test('classifies repository URLs before analytics metadata is available', async t => {
    const env = await setup(t, { url: 'https://github.com/owner/repository/actions',
        html: '<button>Context label</button>',
        configure: () => {} });
    env.document.querySelector('meta').remove();
    env.document.querySelector('button').textContent = 'Context label';
    env.document.dispatchEvent(new env.window.Event('turbo:render'));
    await delay(70);
    assert.equal(env.document.querySelector('button').textContent, '工作流');
    noErrors(env);
});

test('falls back to common translations on an unknown route', async t => {
    const env = await setup(t, { url: 'https://github.com/new-page-not-in-the-dictionary' });
    assert.equal(env.document.querySelector('button').textContent, '设置');
    noErrors(env);
});

test('missing dictionary sections inherit their parent instead of disabling translation', async t => {
    const env = await setup(t, { url: 'https://github.com/owner/repository/issues' });
    assert.equal(env.document.querySelector('button').textContent, '设置');
    noErrors(env);
});

test('route changes retranslate the whole reused body', async t => {
    const env = await setup(t, { html: '<button id="context">Context label</button>' });
    assert.equal(env.document.getElementById('context').textContent, '仓库');
    env.window.history.pushState({}, '', '/owner/repository/actions');
    env.document.getElementById('context').textContent = 'Context label';
    env.document.dispatchEvent(new env.window.Event('turbo:render'));
    await delay(70);
    assert.equal(env.document.getElementById('context').textContent, '工作流');
    env.window.history.pushState({}, '', '/settings/profile');
    env.document.body.innerHTML = '<button>Settings</button>';
    env.window.dispatchEvent(new env.window.PopStateEvent('popstate'));
    await delay(70);
    assert.equal(env.document.querySelector('button').textContent, '设置');
    noErrors(env);
});

test('does not alter code, Markdown, editable drafts or textarea contents', async t => {
    const env = await setup(t, { url: 'https://github.com/owner/repository/actions',
        html: '<pre id="code">original</pre><article class="markdown-body">Settings</article>' +
            '<div contenteditable="true">Settings</div><textarea placeholder="Open">Settings</textarea>' });
    env.document.getElementById('code').firstChild.data = 'Settings';
    env.document.querySelector('[contenteditable]').firstChild.data = 'Open';
    await delay(70);
    assert.equal(env.document.getElementById('code').textContent, 'Settings');
    assert.equal(env.document.querySelector('article').textContent, 'Settings');
    assert.equal(env.document.querySelector('[contenteditable]').textContent, 'Open');
    assert.equal(env.document.querySelector('textarea').value, 'Settings');
    assert.equal(env.document.querySelector('textarea').placeholder, '打开');
    noErrors(env);
});

test('does not translate the root of an ignored subtree added later', async t => {
    const env = await setup(t);
    const pre = env.document.createElement('pre');
    pre.textContent = 'Settings';
    env.document.body.append(pre);
    await delay(70);
    assert.equal(pre.textContent, 'Settings');
    noErrors(env);
});

test('one invalid CSS selector cannot abort the translator', async t => {
    const env = await setup(t, { configure: dict => {
        dict.conf.ignoreSelectorPage['*'].push('[invalid');
        dict['zh-CN'].public.selector = [['[invalid', 'bad']];
    } });
    assert.equal(env.document.querySelector('button').textContent, '设置');
    noErrors(env);
});

test('unknown titles are preserved and asynchronously updated titles are translated', async t => {
    const env = await setup(t);
    assert.equal(env.document.title, 'Unknown title');
    env.document.title = 'Known title';
    await delay(70);
    assert.equal(env.document.title, '已知标题');
    noErrors(env);
});

test('selector rules affect all matches while preserving icons and listeners', async t => {
    const env = await setup(t, { html: '<button class="label"><svg></svg><span>untranslated label</span></button>' +
        '<button class="label">another label</button>',
        configure: dict => { dict['zh-CN'].public.selector = [['.label', '指定翻译']]; } });
    assert.deepEqual([...env.document.querySelectorAll('.label')].map(el => el.textContent), ['指定翻译', '指定翻译']);
    assert.ok(env.document.querySelector('.label svg'));
    assert.ok(env.document.querySelector('.label span'));
    noErrors(env);
});

test('manual retry menu applies newly available translations', async t => {
    const env = await setup(t, { html: '<button>Future label</button>' });
    env.window.I18N['zh-CN'].public.static['Future label'] = '新增译文';
    const retry = [...env.menus.values()].find(menu => menu.label === '重新翻译当前页面');
    assert.ok(retry);
    retry.callback();
    await delay(70);
    assert.equal(env.document.querySelector('button').textContent, '新增译文');
    noErrors(env);
});

test('language setting survives Github resetting html lang', async t => {
    const env = await setup(t);
    env.document.documentElement.lang = 'en';
    await delay(70);
    assert.equal(env.document.documentElement.lang, 'zh-CN');
    noErrors(env);
});

test('missing I18N stops cleanly without an uncaught ReferenceError', async t => {
    const env = await setup(t, { missingDictionary: true });
    noErrors(env);
    assert.equal(env.menus.size, 0);
    assert.equal(env.document.querySelector('button').textContent, 'Settings');
});

test('description timeout enables retry and never sends automatically', async t => {
    const env = await setup(t, { descriptions: true, html: '<p class="f4 my-3">An English description</p>' });
    assert.equal(env.requests.length, 0);
    const button = env.document.getElementById('translate-me');
    assert.ok(button);
    button.click();
    assert.equal(env.requests.length, 1);
    assert.equal(env.requests[0].timeout, 15000);
    env.requests[0].ontimeout();
    await delay(30);
    assert.equal(button.disabled, false);
    assert.match(button.textContent, /重试/);
    noErrors(env);
});

test('description translation inserts text safely and does not duplicate the button', async t => {
    const env = await setup(t, { descriptions: true, html: '<p class="f4 my-3">An English description</p>' });
    env.document.getElementById('translate-me').click();
    env.requests[0].onload({ status: 200, responseText: JSON.stringify({ biz: [{ sectionResult: [{ dst: '<img src=x onerror=alert(1)>' }] }] }) });
    await delay(90);
    assert.equal(env.document.querySelectorAll('#translate-me').length, 1);
    assert.equal(env.document.querySelector('#translate-me img'), null);
    assert.match(env.document.getElementById('translate-me').textContent, /<img/);
    noErrors(env);
});

test('a late description response is not inserted next to changed content', async t => {
    const env = await setup(t, { descriptions: true, html: '<p class="f4 my-3">First repository description</p>' });
    const button = env.document.getElementById('translate-me');
    button.click();
    env.document.querySelector('p').textContent = 'A different description';
    env.requests[0].onload({ status: 200, responseText: JSON.stringify({ biz: [{ sectionResult: [{ dst: '旧描述的翻译' }] }] }) });
    await delay(70);
    assert.equal(env.document.getElementById('translate-me'), button);
    assert.equal(button.disabled, false);
    assert.ok(!env.document.body.textContent.includes('旧描述的翻译'));
    noErrors(env);
});

test('bursts are batched and translated output does not cause endless observer work', async t => {
    const env = await setup(t);
    const fragment = env.document.createDocumentFragment();
    for (let i = 0; i < 300; i++) {
        const node = env.document.createElement('button'); node.textContent = 'Settings'; fragment.append(node);
    }
    const before = env.stats.callbacks;
    env.document.body.append(fragment);
    await delay(150);
    assert.equal([...env.document.querySelectorAll('button')].filter(el => el.textContent === '设置').length, 301);
    assert.ok(env.stats.callbacks - before <= 4, 'observer should settle after its own translations');
    noErrors(env);
});

test('selector output containing English is not repeatedly retranslated', async t => {
    const env = await setup(t, { html: '<button class="label">original label</button>',
        configure: dict => {
            dict['zh-CN'].public.selector = [['.label', 'Wrapped value']];
            dict['zh-CN'].public.regexp = [[/^Wrapped (.*)$/, 'Wrapped 译文$1']];
        } });
    const before = env.stats.callbacks;
    await delay(150);
    assert.equal(env.document.querySelector('.label').textContent, 'Wrapped value');
    assert.ok(env.stats.callbacks - before <= 2);
    noErrors(env);
});

for (const [variant, dictionaryFile, lang] of [
    ['main.user.js', 'locals.js', 'zh-CN'],
    ['main(greasyfork).user.js', 'locals(greasyfork).js', 'zh-CN'],
    ['main_zh-TW.user.js', 'locals_zh-TW.js', 'zh-TW']
]) {
    test('works with the shipped dictionary: ' + variant, async t => {
        const env = await setup(t, { variant, dictionaryFile, late: true });
        const expected = env.window.I18N[lang].public.static.Settings;
        assert.equal(env.document.querySelector('button').textContent, expected);
        noErrors(env);
    });
}
