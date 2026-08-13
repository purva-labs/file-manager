const assert = require('node:assert/strict');
const test = require('node:test');

const { sortEntries } = require('../public/sort');

const entries = [
  { name: 'file10.txt', path: '/file10.txt', type: 'file', size: 10, modifiedAt: '2026-01-03T00:00:00Z' },
  { name: 'Folder 2', path: '/Folder 2', type: 'directory', size: null, modifiedAt: '2026-01-01T00:00:00Z' },
  { name: 'file2.txt', path: '/file2.txt', type: 'file', size: 2, modifiedAt: '2026-01-02T00:00:00Z' },
  { name: 'Unknown', path: '/Unknown', type: 'directory', size: null, modifiedAt: null },
];

test('sorts names naturally while keeping directories first', () => {
  assert.deepEqual(
    sortEntries(entries, 'name', 'asc').map((entry) => entry.name),
    ['Folder 2', 'Unknown', 'file2.txt', 'file10.txt']
  );
  assert.deepEqual(
    sortEntries(entries, 'name', 'desc').map((entry) => entry.name),
    ['Unknown', 'Folder 2', 'file10.txt', 'file2.txt']
  );
});

test('sorts type and uses name as a stable tie breaker', () => {
  assert.deepEqual(
    sortEntries(entries, 'type', 'asc').map((entry) => entry.name),
    ['Folder 2', 'Unknown', 'file2.txt', 'file10.txt']
  );
});

test('sorts numeric sizes and leaves unknown directory sizes last', () => {
  const sizeCache = new Map([['/Folder 2', 5]]);
  assert.deepEqual(
    sortEntries(entries, 'size', 'asc', sizeCache).map((entry) => entry.name),
    ['file2.txt', 'Folder 2', 'file10.txt', 'Unknown']
  );
  assert.deepEqual(
    sortEntries(entries, 'size', 'desc', sizeCache).map((entry) => entry.name),
    ['file10.txt', 'Folder 2', 'file2.txt', 'Unknown']
  );
});

test('sorts modification timestamps and leaves missing dates last', () => {
  assert.deepEqual(
    sortEntries(entries, 'modifiedAt', 'desc').map((entry) => entry.name),
    ['file10.txt', 'file2.txt', 'Folder 2', 'Unknown']
  );
});
