const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-manager-test-'));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'file-manager-outside-'));
const realRoot = fs.realpathSync(root);
process.env.FILEMANAGER_ROOT = root;

const { resolveSafeChildPath, resolveSafePath, validateEntryName } = require('../src/server');

test.after(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test('accepts files beneath the configured root', async () => {
  const file = path.join(root, 'hello.txt');
  fs.writeFileSync(file, 'hello');
  assert.equal(await resolveSafePath(file), path.join(realRoot, 'hello.txt'));
});

test('accepts paths relative to the configured root', async () => {
  assert.equal(await resolveSafePath('hello.txt'), path.join(realRoot, 'hello.txt'));
});

test('rejects lexical traversal outside the configured root', async () => {
  await assert.rejects(resolveSafePath(path.join(root, '..', 'escape.txt')), /outside of allowed root/);
});

test('rejects symbolic links that resolve outside the configured root', async () => {
  const secret = path.join(outside, 'secret.txt');
  const link = path.join(root, 'outside-link');
  fs.writeFileSync(secret, 'secret');
  fs.symlinkSync(secret, link);
  await assert.rejects(resolveSafePath(link), /Symbolic link resolves outside/);
});

test('validates new entry names and keeps children beneath the root', async () => {
  assert.throws(() => validateEntryName('../escape'), /single file or folder name/);
  assert.equal(await resolveSafeChildPath(root, 'new-folder'), path.join(realRoot, 'new-folder'));
});
