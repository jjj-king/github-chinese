import fs from 'node:fs';

const filename = process.argv[2] || 'README.md';
const open = '<!--AUTO_GENERATED_PLEASE_DONT_DELETE_IT-->';
const close = '<!--AUTO_GENERATED_PLEASE_DONT_DELETE_IT-END-->';

try {
    const html = process.env.CONTRIBUTORS_HTML?.trim();
    if (!html) throw new Error('Contributor HTML is empty; README was not changed.');
    const source = fs.readFileSync(filename, 'utf8');
    const start = source.indexOf(open);
    const end = source.indexOf(close);
    if (start < 0 || end < start + open.length ||
        source.indexOf(open, start + open.length) !== -1 ||
        source.indexOf(close, end + close.length) !== -1) {
        throw new Error('Expected one ordered pair of contributor markers; README was not changed.');
    }
    const updated = source.slice(0, start + open.length) + '\n' + html + '\n' + source.slice(end);
    if (updated !== source) fs.writeFileSync(filename, updated);
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
