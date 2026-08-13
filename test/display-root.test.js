const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-manager-display-root-'));
fs.writeFileSync(path.join(root, 'hello.txt'), 'hello');
process.env.FILEMANAGER_ROOT = root;
process.env.FILEMANAGER_DISPLAY_ROOT = '/';

const { resolveSafePath, toDisplayPath } = require('../src/server');

test.after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test('maps display-root paths to the mounted host root and back', async () => {
  const safePath = await resolveSafePath('/hello.txt');
  assert.equal(safePath, path.join(fs.realpathSync(root), 'hello.txt'));
  assert.equal(await toDisplayPath(safePath), '/hello.txt');
});

test('rejects display-root traversal', async () => {
  await assert.rejects(resolveSafePath('../../escape.txt'));
});
