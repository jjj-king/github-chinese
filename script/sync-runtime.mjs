import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = fs.readFileSync(path.join(root, 'script/runtime.js'), 'utf8').trim();
const check = process.argv.includes('--check');
const requestedVersion = process.argv.find(arg => arg.startsWith('--version='))?.slice('--version='.length);
const variants = [
    ['main.user.js', 'locals.js', 'zh-CN'],
    ['main(greasyfork).user.js', 'locals(greasyfork).js', 'zh-CN'],
    ['main_zh-TW.user.js', 'locals_zh-TW.js', 'zh-TW']
];
let stale = false;
for (const [file, dictionary, language] of variants) {
    const target = path.join(root, file);
    const original = fs.readFileSync(target, 'utf8');
    let header = original.slice(0, original.indexOf('// ==/UserScript==') + '// ==/UserScript=='.length);
    const version = requestedVersion || /@version\s+(\S+)/.exec(header)?.[1];
    if (!version) throw new Error('Missing version: ' + file);
    const url = 'https://raw.githubusercontent.com/jjj-king/github-chinese/gh-pages/';
    const set = (key, value) => {
        const line = '// @' + key.padEnd(14) + value;
        const pattern = new RegExp('^// @' + key + '\\s+.*$', 'm');
        header = pattern.test(header) ? header.replace(pattern, () => line) : header.replace('// ==/UserScript==', line + '\n// ==/UserScript==');
    };
    set('version', version);
    set('require', url + encodeURIComponent(dictionary) + '?v' + version);
    set('run-at', 'document-start');
    set('connect', 'fanyi.iflyrec.com');
    set('homepageURL', 'https://github.com/jjj-king/github-chinese');
    set('updateURL', url + encodeURIComponent(file));
    set('downloadURL', url + encodeURIComponent(file));
    if (!header.includes('https://education.github.com/*')) header = header.replace('// @match        https://www.githubstatus.com/*', '// @match        https://education.github.com/*\n// @match        https://www.githubstatus.com/*');
    const output = header + '\n\n' + runtime.replace("const LANG = 'zh-CN';", "const LANG = '" + language + "';") + '\n';
    if (check) {
        if (original !== output) { console.error('Runtime is out of sync: ' + file); stale = true; }
    } else fs.writeFileSync(target, output);
}
if (stale) process.exitCode = 1;
