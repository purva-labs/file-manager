const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-manager-hub-'));
const token = 'test-token-that-is-not-a-secret-32-bytes';
const enrolledToken = 'new-agent-token-that-is-at-least-32-bytes';
const tokenFile = path.join(tempDir, 'node.token');
const configFile = path.join(tempDir, 'nodes.json');
fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });

let upstream;
let hub;

test.before(async () => {
  upstream = http.createServer((req, res) => {
    assert.ok([
      `Bearer ${token}`,
      `Bearer ${enrolledToken}`,
    ].includes(req.headers.authorization));
    assert.ok(['/api/config', '/api/config?check=1'].includes(req.url));
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
  process.env.FILEMANAGER_SECRETS_DIR = tempDir;
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

test('starts with an empty state directory for first-time setup', async () => {
  const emptyState = path.join(tempDir, 'empty-state');
  const emptyApp = require('../src/hub').createHubApp({
    configFile: path.join(emptyState, 'nodes.json'),
    secretsDirectory: path.join(emptyState, 'secrets'),
  });
  const emptyHub = await new Promise((resolve) => {
    const server = emptyApp.listen(0, '127.0.0.1', () => resolve(server));
  });
  try {
    const response = await fetch(`http://127.0.0.1:${emptyHub.address().port}/api/nodes`);
    assert.deepEqual(await response.json(), { nodes: [] });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(emptyState, 'nodes.json'), 'utf8')), { nodes: [] });
  } finally {
    await new Promise((resolve) => emptyHub.close(resolve));
  }
});

test('enrolls a node with a single-use code without restarting the hub', async () => {
  const hubUrl = `http://127.0.0.1:${hub.address().port}`;
  const tokenResponse = await fetch(`${hubUrl}/api/enrollment-tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'New Agent', hubUrl }),
  });
  assert.equal(tokenResponse.status, 201);
  const enrollment = await tokenResponse.json();
  assert.match(enrollment.command, /--enrollment-token/);
  assert.match(enrollment.command, /--source-url/);
  assert.match(enrollment.command, /\/api\/agent-bundle/);
  assert.ok(!enrollment.command.includes(enrolledToken));

  const enrollResponse = await fetch(`${hubUrl}/api/enroll`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${enrollment.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      id: 'new-agent',
      name: 'New Agent',
      url: `http://127.0.0.1:${upstream.address().port}`,
      token: enrolledToken,
    }),
  });
  assert.equal(enrollResponse.status, 201);
  assert.deepEqual(await enrollResponse.json(), {
    ok: true,
    node: { id: 'new-agent', name: 'New Agent' },
  });

  const nodesResponse = await fetch(`${hubUrl}/api/nodes`);
  assert.deepEqual(await nodesResponse.json(), {
    nodes: [
      { id: 'test-node', name: 'Test Node' },
      { id: 'new-agent', name: 'New Agent' },
    ],
  });
  assert.equal(fs.readFileSync(path.join(tempDir, 'new-agent.token'), 'utf8').trim(), enrolledToken);

  const reusedResponse = await fetch(`${hubUrl}/api/enroll`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${enrollment.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({}),
  });
  assert.equal(reusedResponse.status, 401);
});
