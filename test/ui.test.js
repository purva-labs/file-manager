const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const publicDirectory = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(publicDirectory, 'index.html'), 'utf8');
const appScript = fs.readFileSync(path.join(publicDirectory, 'app.js'), 'utf8');

test('keeps every frontend element lookup connected to unique markup', () => {
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'index.html contains duplicate element IDs');

  const referencedIds = [...appScript.matchAll(/getElementById\('([^']+)'\)/g)].map((match) => match[1]);
  for (const id of referencedIds) {
    assert.ok(ids.includes(id), `app.js expects #${id} in index.html`);
  }
});

test('renders the functional browser controls in the redesigned shell', () => {
  for (const id of [
    'nodeButtons',
    'searchInput',
    'breadcrumbs',
    'entriesTableBody',
    'selectAllCheckbox',
    'storageDevicesList',
    'filesystemsList',
    'detailsDrawer',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }

  for (const sortKey of ['name', 'type', 'size', 'modifiedAt']) {
    assert.match(html, new RegExp(`data-sort-key="${sortKey}"`));
  }
});
