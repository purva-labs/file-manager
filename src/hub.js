const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT || 3090);
const LISTEN_HOST = process.env.FILEMANAGER_LISTEN_HOST || '127.0.0.1';
const NODES_CONFIG_FILE = process.env.FILEMANAGER_NODES_FILE || '/run/file-manager/nodes.json';
const SECRETS_DIRECTORY = process.env.FILEMANAGER_SECRETS_DIR || '/run/file-manager/secrets';
const ENROLLMENT_TTL_MS = 15 * 60 * 1000;
const ENROLLMENT_URL = process.env.FILEMANAGER_ENROLLMENT_URL
  || (!['127.0.0.1', '::1', 'localhost'].includes(LISTEN_HOST) ? `http://${LISTEN_HOST}:${PORT}` : '');

function validateNodeEntry(entry, seenIds = new Set()) {
  const id = String(entry.id || '').trim();
  const name = String(entry.name || id).trim();
  const url = new URL(String(entry.url || ''));
  const tokenFile = String(entry.tokenFile || '').trim();

  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) {
    throw new Error(`Invalid node id: ${id || '<empty>'}`);
  }
  if (seenIds.has(id)) {
    throw new Error(`Duplicate node id: ${id}`);
  }
  if (!name || name.length > 80) {
    throw new Error(`Invalid node name for ${id}.`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error(`Unsupported URL for node ${id}.`);
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`Node ${id} URL must contain only an origin.`);
  }
  if (!tokenFile) {
    throw new Error(`Node ${id} requires tokenFile.`);
  }

  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  if (!token) {
    throw new Error(`Node ${id} token file is empty.`);
  }
  if (Buffer.byteLength(token) < 32) {
    throw new Error(`Node ${id} token must contain at least 32 bytes.`);
  }

  seenIds.add(id);
  return { id, name, url, token, tokenFile };
}

function loadNodes(configFile = NODES_CONFIG_FILE) {
  if (!fs.existsSync(configFile)) return [];
  const parsed = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  if (!Array.isArray(parsed.nodes)) {
    throw new Error('Node configuration must contain a nodes array.');
  }

  const ids = new Set();
  return parsed.nodes.map((entry) => validateNodeEntry(entry, ids));
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function tokenDigest(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function writeJsonFile(filePath, value) {
  const tempPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const content = `${JSON.stringify(value, null, 2)}\n`;
  try {
    fs.writeFileSync(tempPath, content, { mode: 0o600 });
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try { fs.rmSync(tempPath, { force: true }); } catch {}
    if (!['EBUSY', 'EXDEV', 'EPERM'].includes(error.code)) throw error;
    fs.writeFileSync(filePath, content, { mode: 0o600 });
  }
}

function verifyAgent(nodeUrl, token) {
  return new Promise((resolve, reject) => {
    const endpoint = new URL('/api/config', nodeUrl);
    const transport = endpoint.protocol === 'https:' ? https : http;
    const request = transport.request(endpoint, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
      timeout: 10000,
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
        if (body.length > 8192) request.destroy(new Error('Agent verification response is too large.'));
      });
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`Agent verification returned HTTP ${response.statusCode}.`));
          return;
        }
        try {
          const config = JSON.parse(body);
          if (typeof config.rootPath !== 'string' || !config.rootPath.startsWith('/')) {
            throw new Error('Agent returned an invalid root path.');
          }
          resolve();
        } catch (error) {
          reject(new Error(`Agent verification failed: ${error.message}`));
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('Agent verification timed out.')));
    request.on('error', reject);
    request.end();
  });
}

function createHubApp(options = {}) {
  const configFile = options.configFile || NODES_CONFIG_FILE;
  const secretsDirectory = options.secretsDirectory || SECRETS_DIRECTORY;
  const enrollmentTtlMs = options.enrollmentTtlMs || ENROLLMENT_TTL_MS;
  const installUrl = options.installUrl || '';
  const enrollmentUrl = options.enrollmentUrl ?? ENROLLMENT_URL;
  fs.mkdirSync(path.dirname(configFile), { recursive: true, mode: 0o700 });
  fs.mkdirSync(secretsDirectory, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(configFile)) writeJsonFile(configFile, { nodes: [] });
  let nodes = loadNodes(configFile);
  let nodesById = new Map(nodes.map((node) => [node.id, node]));
  const enrollmentTokens = new Map();
  const app = express();

  function pruneEnrollmentTokens() {
    const now = Date.now();
    for (const [digest, enrollment] of enrollmentTokens.entries()) {
      if (enrollment.expiresAt <= now) enrollmentTokens.delete(digest);
    }
  }

  function persistNode({ id, name, url, token }) {
    fs.mkdirSync(secretsDirectory, { recursive: true, mode: 0o700 });
    const tokenFile = path.join(secretsDirectory, `${id}.token`);
    if (fs.existsSync(tokenFile)) throw new Error(`Credential already exists for node ${id}.`);
    fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600, flag: 'wx' });

    const node = { id, name, url: new URL(url), token, tokenFile };
    const updatedNodes = [...nodes, node];
    try {
      writeJsonFile(configFile, {
        nodes: updatedNodes.map((candidate) => ({
          id: candidate.id,
          name: candidate.name,
          url: candidate.url.origin,
          tokenFile: candidate.tokenFile,
        })),
      });
    } catch (error) {
      fs.rmSync(tokenFile, { force: true });
      throw error;
    }

    nodes = updatedNodes;
    nodesById = new Map(nodes.map((candidate) => [candidate.id, candidate]));
    return node;
  }

  app.disable('x-powered-by');
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/install-agent.sh', (req, res) => {
    res.type('text/x-shellscript');
    res.sendFile(path.join(__dirname, '..', 'deploy', 'install-agent.sh'));
  });

  app.get('/healthz', (req, res) => {
    res.json({ ok: true, mode: 'hub', nodes: nodes.length });
  });

  app.get('/api/nodes', (req, res) => {
    res.json({ nodes: nodes.map(({ id, name }) => ({ id, name })) });
  });

  app.get('/api/enrollment-info', (req, res) => {
    res.json({ hubUrl: enrollmentUrl, expiresInSeconds: Math.round(enrollmentTtlMs / 1000) });
  });

  app.get('/api/agent-bundle', (req, res, next) => {
    const projectRoot = path.join(__dirname, '..');
    res.type('application/gzip');
    res.setHeader('content-disposition', 'attachment; filename="file-manager-agent.tar.gz"');
    const archive = spawn('tar', [
      '-czf', '-', '-C', projectRoot,
      'package.json', 'package-lock.json', 'src', 'public', 'deploy/file-manager-agent.service',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let errorOutput = '';
    archive.stderr.on('data', (chunk) => { errorOutput += chunk.toString(); });
    archive.on('error', next);
    archive.on('close', (code) => {
      if (code !== 0 && !res.headersSent) next(new Error(errorOutput.trim() || 'Unable to package the agent.'));
    });
    res.on('close', () => {
      if (!archive.killed) archive.kill();
    });
    archive.stdout.pipe(res);
  });

  app.post('/api/enrollment-tokens', express.json({ limit: '8kb' }), (req, res) => {
    try {
      pruneEnrollmentTokens();
      const name = String(req.body?.name || '').trim();
      const requestedHubUrl = String(req.body?.hubUrl || '').trim();
      const hubUrl = new URL(requestedHubUrl);
      if (!name || name.length > 80) return res.status(400).json({ error: 'Node name is required.' });
      if (!['http:', 'https:'].includes(hubUrl.protocol) || hubUrl.username || hubUrl.password) {
        return res.status(400).json({ error: 'Hub URL must be an HTTP or HTTPS private-network URL.' });
      }

      const token = crypto.randomBytes(32).toString('base64url');
      const expiresAt = Date.now() + enrollmentTtlMs;
      enrollmentTokens.set(tokenDigest(token), { name, expiresAt });
      const installerUrl = installUrl || new URL('/install-agent.sh', hubUrl).toString();
      const sourceUrl = new URL('/api/agent-bundle', hubUrl).toString();
      const command = `curl -fsSL ${shellQuote(installerUrl)} | sudo bash -s -- --source-url ${shellQuote(sourceUrl)} --hub-url ${shellQuote(hubUrl.origin)} --enrollment-token ${shellQuote(token)} --name ${shellQuote(name)}`;
      res.status(201).json({ token, expiresAt: new Date(expiresAt).toISOString(), command });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/api/enroll', express.json({ limit: '16kb' }), async (req, res) => {
    const authorization = String(req.get('authorization') || '');
    const enrollmentToken = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    pruneEnrollmentTokens();
    const enrollment = enrollmentTokens.get(tokenDigest(enrollmentToken));
    if (!enrollment) return res.status(401).json({ error: 'Enrollment token is invalid or expired.' });
    enrollmentTokens.delete(tokenDigest(enrollmentToken));

    try {
      const id = String(req.body?.id || '').trim();
      const name = String(req.body?.name || enrollment.name).trim();
      const url = new URL(String(req.body?.url || ''));
      const token = String(req.body?.token || '').trim();
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) throw new Error('Agent supplied an invalid node id.');
      if (nodesById.has(id)) return res.status(409).json({ error: `Node ${id} already exists.` });
      if (!name || name.length > 80) throw new Error('Agent supplied an invalid node name.');
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
        throw new Error('Agent URL must contain only an HTTP or HTTPS origin.');
      }
      if (Buffer.byteLength(token) < 32) throw new Error('Agent credential must contain at least 32 bytes.');

      await verifyAgent(url, token);
      const node = persistNode({ id, name, url, token });
      res.status(201).json({ ok: true, node: { id: node.id, name: node.name } });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  function proxyNodeRequest(req, res) {
    const node = nodesById.get(req.params.nodeId);
    if (!node) return res.status(404).json({ error: 'Unknown node.' });

    const transport = node.url.protocol === 'https:' ? https : http;
    const upstreamPath = `/api${req.url || '/'}`;
    const headers = { ...req.headers };
    headers.host = node.url.host;
    headers.authorization = `Bearer ${node.token}`;
    headers['x-file-manager-hub'] = '1';
    delete headers.connection;

    const upstream = transport.request({
      protocol: node.url.protocol,
      hostname: node.url.hostname,
      port: node.url.port,
      method: req.method,
      path: upstreamPath,
      headers,
      timeout: 10 * 60 * 1000,
    }, (upstreamResponse) => {
      const responseHeaders = { ...upstreamResponse.headers };
      delete responseHeaders.connection;
      res.writeHead(upstreamResponse.statusCode || 502, responseHeaders);
      upstreamResponse.pipe(res);
    });

    upstream.on('timeout', () => upstream.destroy(new Error('Node request timed out.')));
    upstream.on('error', (error) => {
      if (!res.headersSent) res.status(502).json({ error: `Node unavailable: ${error.message}` });
      else res.destroy(error);
    });
    req.pipe(upstream);
  }

  app.use('/api/nodes/:nodeId', proxyNodeRequest);
  app.use('/api', (req, res) => res.status(404).json({ error: 'API route not found.' }));
  return app;
}

const app = createHubApp();

if (require.main === module) {
  app.listen(PORT, LISTEN_HOST, () => {
    // eslint-disable-next-line no-console
    console.log(`File Manager hub listening on ${LISTEN_HOST}:${PORT}.`);
  });
}

module.exports = { app, createHubApp, loadNodes, shellQuote, verifyAgent, writeJsonFile };
