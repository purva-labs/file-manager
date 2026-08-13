const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-manager-test-'));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'file-manager-outside-'));
const realRoot = fs.realpathSync(root);
process.env.FILEMANAGER_ROOT = root;

const {
  getStorageDeviceSource,
  parseMountInfo,
  resolveSafeChildPath,
  resolveSafePath,
  summarizeLocalFilesystems,
  summarizeLocalDevices,
  validateEntryName,
} = require('../src/server');

test.after(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test('groups partitions by their underlying local device', () => {
  assert.equal(getStorageDeviceSource('/dev/sda16'), '/dev/sda');
  assert.equal(getStorageDeviceSource('/dev/nvme0n1p2'), '/dev/nvme0n1');
  assert.equal(getStorageDeviceSource('/dev/mmcblk0p1'), '/dev/mmcblk0');

  assert.deepEqual(summarizeLocalDevices([
    { mountPath: realRoot, source: '/dev/sda1', type: 'ext4', totalBytes: 100, usedBytes: 40, freeBytes: 60, availableBytes: 55 },
    { mountPath: '/boot', source: '/dev/sda16', type: 'ext4', totalBytes: 10, usedBytes: 2, freeBytes: 8, availableBytes: 7 },
    { mountPath: '/media', source: '/dev/sdb1', type: 'ext4', totalBytes: 900, usedBytes: 200, freeBytes: 700, availableBytes: 690 },
    { mountPath: '/backups', source: '/dev/sdb2', type: 'ext4', totalBytes: 300, usedBytes: 50, freeBytes: 250, availableBytes: 245 },
    { mountPath: '/remote', source: 'nas:/data', type: 'nfs4', network: true, totalBytes: 5000, usedBytes: 1000, freeBytes: 4000, availableBytes: 3900 },
  ]), [
    {
      device: '/dev/sda', primary: true, filesystemCount: 2, mountPaths: [realRoot, '/boot'],
      totalBytes: 110, usedBytes: 42, freeBytes: 68, availableBytes: 62,
    },
    {
      device: '/dev/sdb', primary: false, filesystemCount: 2, mountPaths: ['/media', '/backups'],
      totalBytes: 1200, usedBytes: 250, freeBytes: 950, availableBytes: 935,
    },
  ]);
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

test('parses persistent mount metadata and escaped paths', () => {
  const mounts = parseMountInfo(
    '29 23 8:1 / /host rw,relatime - ext4 /dev/sda1 rw\n' +
      '30 29 8:17 / /host/srv/My\\040Disk rw,relatime - ext4 /dev/sdb1 rw\n'
  );
  assert.deepEqual(mounts, [
    { mountPath: '/host', options: ['rw', 'relatime'], type: 'ext4', source: '/dev/sda1' },
    {
      mountPath: '/host/srv/My Disk',
      options: ['rw', 'relatime'],
      type: 'ext4',
      source: '/dev/sdb1',
    },
  ]);
});

test('summarizes unique local filesystems and excludes network mounts', () => {
  const summary = summarizeLocalFilesystems([
    { mountPath: '/', source: '/dev/sda1', type: 'ext4', totalBytes: 100, usedBytes: 40, freeBytes: 60, availableBytes: 55 },
    { mountPath: '/bind', source: '/dev/sda1', type: 'ext4', totalBytes: 100, usedBytes: 40, freeBytes: 60, availableBytes: 55 },
    { mountPath: '/data', source: '/dev/sdb1', type: 'xfs', totalBytes: 900, usedBytes: 200, freeBytes: 700, availableBytes: 690 },
    { mountPath: '/remote', source: 'nas:/data', type: 'nfs4', network: true, totalBytes: 5000, usedBytes: 1000, freeBytes: 4000, availableBytes: 3900 },
  ]);

  assert.deepEqual(summary, {
    filesystemCount: 2,
    totalBytes: 1000,
    usedBytes: 240,
    freeBytes: 760,
    availableBytes: 745,
  });
});
