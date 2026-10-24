import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'script/update-contributors.mjs');
const open = '<!--AUTO_GENERATED_PLEASE_DONT_DELETE_IT-->';
const close = '<!--AUTO_GENERATED_PLEASE_DONT_DELETE_IT-END-->';

function runUpdate(t, source, html) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'github-chinese-contributors-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filename = path.join(directory, 'README.md');
    fs.writeFileSync(filename, source);
    const result = spawnSync(process.execPath, [script, filename], {
        cwd: directory, encoding: 'utf8',
        env: { ...process.env, CONTRIBUTORS_HTML: html }
    });
    return { result, directory, source: fs.readFileSync(filename, 'utf8') };
}

test('contributor update preserves multiline HTML, quotes and shell text without executing it', t => {
    const prefix = '# 文档\nKeep this text.\n';
    const suffix = '\n## Installation\nKeep this too.\n';
    const html = '<a title="O\'Brien & 中文">$(touch injected) `touch injected2`</a>\n<img src="https://example.test/a?b=1&c=2" />';
    const source = prefix + open + '\nold contributors\n' + close + suffix;
    const updated = runUpdate(t, source, html);
    assert.equal(updated.result.status, 0, updated.result.stderr);
    assert.equal(updated.source, prefix + open + '\n' + html + '\n' + close + suffix);
    assert.ok(!fs.existsSync(path.join(updated.directory, 'injected')));
    assert.ok(!fs.existsSync(path.join(updated.directory, 'injected2')));
});

test('empty contributor output fails without removing the existing list', t => {
    const source = open + '\nexisting list\n' + close;
    const updated = runUpdate(t, source, '  \n ');
    assert.notEqual(updated.result.status, 0);
    assert.match(updated.result.stderr, /HTML is empty/);
    assert.equal(updated.source, source);
});

test('missing, reversed or duplicate contributor markers fail without changing the README', t => {
    for (const source of ['No markers here', close + open, open + close + open, open + close + close]) {
        const updated = runUpdate(t, source, '<a>new list</a>');
        assert.notEqual(updated.result.status, 0);
        assert.match(updated.result.stderr, /ordered pair/);
        assert.equal(updated.source, source);
    }
});
