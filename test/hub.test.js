const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-manager-hub-'));
const token = 'test-token-that-is-not-a-secret-32-bytes';
const tokenFile = path.join(tempDir, 'node.token');
const configFile = path.join(tempDir, 'nodes.json');
fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });

let upstream;
let hub;

test.before(async () => {
  upstream = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    assert.equal(req.url, '/api/config?check=1');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ rootPath: '/' }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));

  const upstreamPort = upstream.address().port;
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      nodes: [
        {
          id: 'test-node',
          name: 'Test Node',
          url: `http://127.0.0.1:${upstreamPort}`,
          tokenFile,
        },
      ],
    })
  );
  process.env.FILEMANAGER_NODES_FILE = configFile;
  const { app } = require('../src/hub');
  hub = await new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
});

test.after(async () => {
  if (hub) await new Promise((resolve) => hub.close(resolve));
  if (upstream) await new Promise((resolve) => upstream.close(resolve));
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('lists only public node fields', async () => {
  const response = await fetch(`http://127.0.0.1:${hub.address().port}/api/nodes`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    nodes: [{ id: 'test-node', name: 'Test Node' }],
  });
});

test('proxies node API calls with the server-side token', async () => {
  const response = await fetch(
    `http://127.0.0.1:${hub.address().port}/api/nodes/test-node/config?check=1`
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { rootPath: '/' });
});

test('rejects short node tokens', () => {
  const shortTokenFile = path.join(tempDir, 'short.token');
  const shortConfigFile = path.join(tempDir, 'short-nodes.json');
  fs.writeFileSync(shortTokenFile, 'too-short\n', { mode: 0o600 });
  fs.writeFileSync(shortConfigFile, JSON.stringify({
    nodes: [{ id: 'short-token', url: 'http://127.0.0.1:3091', tokenFile: shortTokenFile }],
  }));

  const { loadNodes } = require('../src/hub');
  assert.throws(() => loadNodes(shortConfigFile), /at least 32 bytes/);
});
