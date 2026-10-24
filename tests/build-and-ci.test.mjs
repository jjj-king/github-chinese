import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entries = ['main.user.js', 'main(greasyfork).user.js', 'main_zh-TW.user.js'];

test('entry points use the same runtime and this fork for dictionary/install/update URLs', () => {
    const shared = fs.readFileSync(path.join(root, 'script/runtime.js'), 'utf8').trim();
    for (const entry of entries) {
        const source = fs.readFileSync(path.join(root, entry), 'utf8');
        const end = source.indexOf('// ==/UserScript==') + '// ==/UserScript=='.length;
        const body = source.slice(end).trim().replace("const LANG = 'zh-TW';", "const LANG = 'zh-CN';");
        assert.equal(body, shared, entry);
        for (const key of ['require', 'downloadURL', 'updateURL']) {
            const value = new RegExp('^// @' + key + '\\s+(\\S+)', 'm').exec(source)?.[1];
            assert.ok(value, key + ' must exist in ' + entry);
            assert.equal(new URL(value).hostname, 'raw.githubusercontent.com');
            assert.ok(new URL(value).pathname.startsWith('/jjj-king/github-chinese/gh-pages/'));
        }
        const version = /@version\s+(\S+)/.exec(source)[1];
        assert.ok(source.includes('?v' + version));
    }
});

const hasTools = process.platform !== 'win32' && spawnSync('jq', ['--version']).status === 0;
function mockCommit(t, graphQLFailure = false) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'github-chinese-ci-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const bin = path.join(directory, 'bin'); fs.mkdirSync(bin);
    const mockCurl = '#!/bin/bash\nif [[ "$*" == *"graphql"* ]]; then\n' +
        (graphQLFailure ? "printf '%s' '{\"errors\":[{\"message\":\"rejected\"}]}'\n" :
            "printf '%s' '{\"data\":{\"createCommitOnBranch\":{\"commit\":{\"oid\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"url\":\"https://example.test/commit\"}}}}'\n") +
        "else\nprintf '%s' '{\"login\":\"github-actions[bot]\",\"id\":41898282}'\nfi\n";
    fs.writeFileSync(path.join(bin, 'curl'), mockCurl, { mode: 0o755 });
    const contents = '译文 with quotes " and newline\n'.repeat(1000);
    fs.writeFileSync(path.join(directory, 'locals(greasyfork).js'), contents);
    const result = spawnSync('bash', [path.join(root, 'script/ci_commit_with_signature.sh'),
        '-R', 'owner/repo', '-B', 'gh-pages', '-P', 'b'.repeat(40),
        '-F', 'locals(greasyfork).js', '-D', 'old.js',
        '-h', 'A "quoted" 中文 title', '-b', 'Multiline body\nwith "quotes"'], {
        cwd: directory, encoding: 'utf8',
        env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH,
            GITHUB_TOKEN: 'example-ci-token', APP_SLUG: 'github-actions' }
    });
    return { result, directory, contents };
}

test('CI request supports large files, Unicode, quoted messages and deletions', { skip: !hasTools }, t => {
    const { result, directory, contents } = mockCommit(t);
    assert.equal(result.status, 0, result.stderr);
    const input = JSON.parse(fs.readFileSync(path.join(directory, 'request.json'), 'utf8')).variables.input;
    assert.equal(Buffer.from(input.fileChanges.additions[0].contents, 'base64').toString(), contents);
    assert.deepEqual(input.fileChanges.deletions, [{ path: 'old.js' }]);
    assert.equal(input.message.headline, 'A "quoted" 中文 title');
    assert.match(input.message.body, /Multiline body\nwith "quotes"\nSigned-off-by:/);
    assert.equal(input.expectedHeadOid, 'b'.repeat(40));
});

test('CI helper fails on GraphQL errors even with HTTP 200', { skip: !hasTools }, t => {
    const { result } = mockCommit(t, true);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /rejected/);
});
