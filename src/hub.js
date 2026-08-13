const express = require('express');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT || 3090);
const LISTEN_HOST = process.env.FILEMANAGER_LISTEN_HOST || '127.0.0.1';
const NODES_CONFIG_FILE = process.env.FILEMANAGER_NODES_FILE || '/run/file-manager/nodes.json';

function loadNodes(configFile = NODES_CONFIG_FILE) {
  const parsed = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  if (!Array.isArray(parsed.nodes) || parsed.nodes.length === 0) {
    throw new Error('Node configuration must contain a non-empty nodes array.');
  }

  const ids = new Set();
  return parsed.nodes.map((entry) => {
    const id = String(entry.id || '').trim();
    const name = String(entry.name || id).trim();
    const url = new URL(String(entry.url || ''));
    const tokenFile = String(entry.tokenFile || '').trim();

    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) {
      throw new Error(`Invalid node id: ${id || '<empty>'}`);
    }
    if (ids.has(id)) {
      throw new Error(`Duplicate node id: ${id}`);
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error(`Unsupported protocol for node ${id}.`);
    }
    if (!tokenFile) {
      throw new Error(`Node ${id} requires tokenFile.`);
    }

    const token = fs.readFileSync(tokenFile, 'utf8').trim();
    if (!token) {
      throw new Error(`Node ${id} token file is empty.`);
    }

    ids.add(id);
    return { id, name, url, token };
  });
}

const nodes = loadNodes();
const nodesById = new Map(nodes.map((node) => [node.id, node]));

app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/healthz', (req, res) => {
  res.json({ ok: true, mode: 'hub', nodes: nodes.length });
});

app.get('/api/nodes', (req, res) => {
  res.json({
    nodes: nodes.map(({ id, name }) => ({ id, name })),
  });
});

function proxyNodeRequest(req, res) {
  const node = nodesById.get(req.params.nodeId);
  if (!node) {
    return res.status(404).json({ error: 'Unknown node.' });
  }

  const transport = node.url.protocol === 'https:' ? https : http;
  const upstreamPath = `/api${req.url || '/'}`;
  const headers = { ...req.headers };
  headers.host = node.url.host;
  headers.authorization = `Bearer ${node.token}`;
  headers['x-file-manager-hub'] = '1';
  delete headers.connection;

  const upstream = transport.request(
    {
      protocol: node.url.protocol,
      hostname: node.url.hostname,
      port: node.url.port,
      method: req.method,
      path: upstreamPath,
      headers,
      timeout: 10 * 60 * 1000,
    },
    (upstreamResponse) => {
      const responseHeaders = { ...upstreamResponse.headers };
      delete responseHeaders.connection;
      res.writeHead(upstreamResponse.statusCode || 502, responseHeaders);
      upstreamResponse.pipe(res);
    }
  );

  upstream.on('timeout', () => {
    upstream.destroy(new Error('Node request timed out.'));
  });
  upstream.on('error', (error) => {
    if (!res.headersSent) {
      res.status(502).json({ error: `Node unavailable: ${error.message}` });
    } else {
      res.destroy(error);
    }
  });
  req.pipe(upstream);
}

app.use('/api/nodes/:nodeId', proxyNodeRequest);

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'API route not found.' });
});

if (require.main === module) {
  app.listen(PORT, LISTEN_HOST, () => {
    // eslint-disable-next-line no-console
    console.log(`File Manager hub listening on ${LISTEN_HOST}:${PORT} with ${nodes.length} node(s).`);
  });
}

module.exports = { app, loadNodes };
