const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const multer = require('multer');

const app = express();
const PORT = Number(process.env.PORT || 3088);
const LISTEN_HOST = process.env.FILEMANAGER_LISTEN_HOST || '0.0.0.0';
const MODE = process.env.FILEMANAGER_MODE || 'standalone';
const ROOT_PATH = path.resolve(process.env.FILEMANAGER_ROOT || '/srv');
const DISPLAY_ROOT_PATH = path.resolve(process.env.FILEMANAGER_DISPLAY_ROOT || ROOT_PATH);
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
const MAX_UPLOAD_FILE_BYTES = 512 * 1024 * 1024;
const MAX_UPLOAD_FILES = 100;
const ROOT_REAL_PATH = fs.realpath(ROOT_PATH);

function readAgentToken() {
  if (process.env.FILEMANAGER_AGENT_TOKEN_FILE) {
    return fsSync.readFileSync(process.env.FILEMANAGER_AGENT_TOKEN_FILE, 'utf8').trim();
  }
  return String(process.env.FILEMANAGER_AGENT_TOKEN || '').trim();
}

const AGENT_TOKEN = readAgentToken();

if (MODE === 'agent' && !AGENT_TOKEN) {
  throw new Error('Agent mode requires FILEMANAGER_AGENT_TOKEN_FILE or FILEMANAGER_AGENT_TOKEN.');
}

function tokenMatches(candidate) {
  const actual = Buffer.from(AGENT_TOKEN);
  const supplied = Buffer.from(candidate);
  return actual.length === supplied.length && crypto.timingSafeEqual(actual, supplied);
}

if (MODE === 'agent') {
  app.use((req, res, next) => {
    const authorization = String(req.get('authorization') || '');
    const candidate = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!candidate || !tokenMatches(candidate)) {
      return res.status(401).json({ error: 'Agent authentication required.' });
    }
    next();
  });
}

app.use(express.json({ limit: '1mb' }));
if (MODE !== 'agent') {
  app.use(express.static(path.join(__dirname, '..', 'public')));
}

function isWithin(base, target) {
  const relativePath = path.relative(base, target);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

async function resolveSafePath(inputPath) {
  const rootRealPath = await ROOT_REAL_PATH;
  const rawPath = String(inputPath || '').trim();
  let candidate = rootRealPath;

  if (rawPath) {
    if (path.isAbsolute(rawPath) && DISPLAY_ROOT_PATH !== ROOT_PATH) {
      const displayCandidate = path.resolve(rawPath);
      if (!isWithin(DISPLAY_ROOT_PATH, displayCandidate)) {
        const err = new Error('Path outside of allowed root.');
        err.statusCode = 400;
        throw err;
      }
      candidate = path.resolve(rootRealPath, path.relative(DISPLAY_ROOT_PATH, displayCandidate));
    } else {
      candidate = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(rootRealPath, rawPath);
    }
  }

  if (!isWithin(ROOT_PATH, candidate) && !isWithin(rootRealPath, candidate)) {
    const err = new Error('Path outside of allowed root.');
    err.statusCode = 400;
    throw err;
  }

  let realCandidate;
  try {
    realCandidate = await fs.realpath(candidate);
  } catch (error) {
    if (error.code === 'ENOENT') error.statusCode = 404;
    throw error;
  }

  if (!isWithin(rootRealPath, realCandidate)) {
    const err = new Error('Symbolic link resolves outside of the allowed root.');
    err.statusCode = 403;
    throw err;
  }

  return realCandidate;
}

async function toDisplayPath(safePath) {
  const rootRealPath = await ROOT_REAL_PATH;
  const relativePath = path.relative(rootRealPath, safePath);
  return relativePath ? path.join(DISPLAY_ROOT_PATH, relativePath) : DISPLAY_ROOT_PATH;
}

async function toRelativePath(safePath) {
  const relativePath = path.relative(await ROOT_REAL_PATH, safePath);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    const err = new Error('Invalid path selection.');
    err.statusCode = 400;
    throw err;
  }
  return relativePath;
}

async function pathExists(targetPath) {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function validateEntryName(inputName) {
  const name = String(inputName || '').trim();
  if (!name || name === '.' || name === '..' || path.basename(name) !== name) {
    const err = new Error('Name must be a single file or folder name.');
    err.statusCode = 400;
    throw err;
  }
  return name;
}

async function resolveSafeChildPath(parentInput, nameInput) {
  const parentPath = await resolveSafePath(parentInput);
  const parentStats = await fs.lstat(parentPath);
  if (!parentStats.isDirectory()) {
    const err = new Error('Parent path must be a directory.');
    err.statusCode = 400;
    throw err;
  }

  const childPath = path.join(parentPath, validateEntryName(nameInput));
  if (!isWithin(await ROOT_REAL_PATH, childPath)) {
    const err = new Error('Path outside of allowed root.');
    err.statusCode = 400;
    throw err;
  }
  return childPath;
}

function buildCopyName(originalName, copyIndex) {
  const parsed = path.parse(originalName);
  if (copyIndex === 1) {
    return `${parsed.name} copy${parsed.ext}`;
  }
  return `${parsed.name} copy ${copyIndex}${parsed.ext}`;
}

async function resolveCopyTargetPath(destinationDir, sourceName) {
  const directPath = path.join(destinationDir, sourceName);
  if (!(await pathExists(directPath))) {
    return directPath;
  }

  for (let copyIndex = 1; copyIndex < 10000; copyIndex += 1) {
    const candidateName = buildCopyName(sourceName, copyIndex);
    const candidatePath = path.join(destinationDir, candidateName);
    if (!(await pathExists(candidatePath))) {
      return candidatePath;
    }
  }

  const err = new Error(`Unable to allocate copy name for ${sourceName}.`);
  err.statusCode = 500;
  throw err;
}

function buildUploadName(originalName, index) {
  const parsed = path.parse(originalName);
  if (index === 0) {
    return `${parsed.name}${parsed.ext}`;
  }
  return `${parsed.name} (${index})${parsed.ext}`;
}

async function resolveUploadTargetName(destinationDir, sourceName) {
  const baseName = path.basename(sourceName || 'upload');
  for (let index = 0; index < 10000; index += 1) {
    const candidateName = buildUploadName(baseName, index);
    const candidatePath = path.join(destinationDir, candidateName);
    if (!(await pathExists(candidatePath))) {
      return candidateName;
    }
  }

  const err = new Error(`Unable to allocate upload name for ${sourceName}.`);
  err.statusCode = 500;
  throw err;
}

const uploadStorage = multer.diskStorage({
  destination(req, file, cb) {
    const destinationInput = req.query && typeof req.query.path === 'string' ? req.query.path : DISPLAY_ROOT_PATH;
    Promise.resolve()
      .then(async () => {
        const destinationPath = await resolveSafePath(destinationInput);
        const stats = await fs.lstat(destinationPath);
        if (!stats.isDirectory()) {
          const err = new Error('Upload destination must be a directory.');
          err.statusCode = 400;
          throw err;
        }
        cb(null, destinationPath);
      })
      .catch((error) => cb(error));
  },
  filename(req, file, cb) {
    const destinationInput = req.query && typeof req.query.path === 'string' ? req.query.path : DISPLAY_ROOT_PATH;
    Promise.resolve()
      .then(async () => {
        const destinationPath = await resolveSafePath(destinationInput);
        const safeName = await resolveUploadTargetName(destinationPath, file.originalname || 'upload');
        cb(null, safeName);
      })
      .catch((error) => cb(error));
  },
});

const uploadMiddleware = multer({
  storage: uploadStorage,
  limits: {
    files: MAX_UPLOAD_FILES,
    fileSize: MAX_UPLOAD_FILE_BYTES,
  },
});

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const err = new Error(stderr.trim() || `${command} failed with exit code ${code}`);
      err.statusCode = 500;
      reject(err);
    });
  });
}

function runCommandWithOutput(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      const err = new Error(stderr.trim() || `${command} failed with exit code ${code}`);
      err.statusCode = 500;
      reject(err);
    });
  });
}

function parseDfUsage(dfOutput) {
  const lines = String(dfOutput || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const rawLine = lines[1];
  if (!rawLine) {
    throw new Error('Unable to parse filesystem usage.');
  }

  const columns = rawLine.split(/\s+/);
  if (columns.length < 6) {
    throw new Error('Unexpected filesystem usage format.');
  }

  const totalKb = Number(columns[1]);
  const usedKb = Number(columns[2]);
  const availableKb = Number(columns[3]);
  if (!Number.isFinite(totalKb) || !Number.isFinite(usedKb) || !Number.isFinite(availableKb)) {
    throw new Error('Invalid filesystem usage values.');
  }

  return {
    totalBytes: totalKb * 1024,
    usedBytes: usedKb * 1024,
    freeBytes: availableKb * 1024,
    availableBytes: availableKb * 1024,
  };
}

async function getFilesystemUsage(targetPath) {
  try {
    const stats = await fs.statfs(targetPath);
    const totalBytes = stats.blocks * stats.bsize;
    const freeBytes = stats.bfree * stats.bsize;
    const availableBytes = stats.bavail * stats.bsize;

    return {
      totalBytes,
      usedBytes: Math.max(0, totalBytes - freeBytes),
      freeBytes,
      availableBytes,
    };
  } catch (error) {
    if (typeof fs.statfs === 'function') {
      throw error;
    }

    const output = await runCommandWithOutput('df', ['-kP', targetPath]);
    return parseDfUsage(output);
  }
}

async function computeDirectorySize(targetPath) {
  let stats;
  try {
    stats = await fs.lstat(targetPath);
  } catch {
    return 0;
  }

  if (stats.isSymbolicLink()) return 0;
  if (stats.isFile()) return stats.size;
  if (!stats.isDirectory()) return 0;

  let total = 0;
  let entries = [];

  try {
    entries = await fs.readdir(targetPath, { withFileTypes: true });
  } catch {
    return 0;
  }

  for (const entry of entries) {
    const fullPath = path.join(targetPath, entry.name);

    if (entry.isFile()) {
      try {
        const fileStats = await fs.lstat(fullPath);
        total += fileStats.size;
      } catch {
        // Skip unreadable files.
      }
    } else if (entry.isDirectory()) {
      total += await computeDirectorySize(fullPath);
    }
  }

  return total;
}

function formatEntryType(entry, stats) {
  if (entry.isDirectory()) return 'directory';
  if (entry.isFile()) return 'file';
  if (entry.isSymbolicLink()) return 'symlink';
  return stats.isDirectory() ? 'directory' : 'other';
}

app.get('/api/config', (req, res) => {
  res.json({
    rootPath: DISPLAY_ROOT_PATH,
  });
});

app.get('/api/storage', async (req, res, next) => {
  try {
    const usage = await getFilesystemUsage(ROOT_PATH);
    res.json({
      rootPath: DISPLAY_ROOT_PATH,
      totalBytes: usage.totalBytes,
      usedBytes: usage.usedBytes,
      freeBytes: usage.freeBytes,
      availableBytes: usage.availableBytes,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/list', async (req, res, next) => {
  try {
    const requestedPath = req.query.path ? String(req.query.path) : DISPLAY_ROOT_PATH;
    const safePath = await resolveSafePath(requestedPath);
    const rootStats = await fs.lstat(safePath);

    if (!rootStats.isDirectory()) {
      return res.status(400).json({ error: 'Path is not a directory.' });
    }

    const dirents = await fs.readdir(safePath, { withFileTypes: true });
    const entries = [];

    for (const dirent of dirents) {
      const itemPath = path.join(safePath, dirent.name);

      try {
        const stats = await fs.lstat(itemPath);
        entries.push({
          name: dirent.name,
          path: await toDisplayPath(itemPath),
          type: formatEntryType(dirent, stats),
          size: stats.isFile() ? stats.size : null,
          modifiedAt: stats.mtime.toISOString(),
        });
      } catch {
        // Ignore files that disappear while listing.
      }
    }

    entries.sort((a, b) => {
      if (a.type === 'directory' && b.type !== 'directory') return -1;
      if (a.type !== 'directory' && b.type === 'directory') return 1;
      return a.name.localeCompare(b.name);
    });

    res.json({ path: await toDisplayPath(safePath), entries });
  } catch (error) {
    next(error);
  }
});

app.get('/api/usage', async (req, res, next) => {
  try {
    const rootEntries = await fs.readdir(ROOT_PATH, { withFileTypes: true });
    const usage = [];

    for (const entry of rootEntries) {
      const entryPath = path.join(ROOT_PATH, entry.name);
      try {
        const stats = await fs.lstat(entryPath);
        const size = stats.isDirectory() ? await computeDirectorySize(entryPath) : stats.size;
        usage.push({
          name: entry.name,
          path: await toDisplayPath(entryPath),
          type: stats.isDirectory() ? 'directory' : 'file',
          size,
          modifiedAt: stats.mtime.toISOString(),
        });
      } catch {
        // Skip inaccessible entries.
      }
    }

    usage.sort((a, b) => b.size - a.size);

    res.json({ rootPath: DISPLAY_ROOT_PATH, usage });
  } catch (error) {
    next(error);
  }
});

app.get('/api/size', async (req, res, next) => {
  try {
    const requestedPath = req.query.path ? String(req.query.path) : DISPLAY_ROOT_PATH;
    const safePath = await resolveSafePath(requestedPath);
    const stats = await fs.lstat(safePath);

    const size = stats.isDirectory() ? await computeDirectorySize(safePath) : stats.size;

    res.json({ path: await toDisplayPath(safePath), size });
  } catch (error) {
    next(error);
  }
});

app.get('/api/file', async (req, res, next) => {
  try {
    const requestedPath = req.query.path ? String(req.query.path) : '';
    if (!requestedPath) {
      return res.status(400).json({ error: 'Missing path query parameter.' });
    }

    const safePath = await resolveSafePath(requestedPath);
    const stats = await fs.lstat(safePath);

    if (!stats.isFile()) {
      return res.status(400).json({ error: 'Only files can be previewed.' });
    }

    if (stats.size > MAX_PREVIEW_BYTES) {
      return res.status(413).json({
        error: `File is too large to preview in UI (max ${MAX_PREVIEW_BYTES} bytes).`,
      });
    }

    const contentBuffer = await fs.readFile(safePath);
    if (contentBuffer.includes(0)) {
      return res.status(415).json({ error: 'Binary file preview is not supported.' });
    }

    const content = contentBuffer.toString('utf8');

    res.json({
      path: await toDisplayPath(safePath),
      name: path.basename(safePath),
      size: stats.size,
      modifiedAt: stats.mtime.toISOString(),
      content,
    });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/delete', async (req, res, next) => {
  try {
    const targetPath = req.body && typeof req.body.path === 'string' ? req.body.path : '';

    if (!targetPath) {
      return res.status(400).json({ error: 'Missing path in request body.' });
    }

    const safePath = await resolveSafePath(targetPath);

    if (safePath === await ROOT_REAL_PATH) {
      return res.status(400).json({ error: 'Refusing to delete root path.' });
    }

    await fs.rm(safePath, { recursive: true, force: false });

    res.json({ ok: true, deleted: await toDisplayPath(safePath) });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return res.status(404).json({ error: 'Path not found.' });
    }

    next(error);
  }
});

app.post('/api/bulk-delete', async (req, res, next) => {
  try {
    const inputPaths = Array.isArray(req.body?.paths) ? req.body.paths : [];

    if (inputPaths.length === 0) {
      return res.status(400).json({ error: 'Missing paths in request body.' });
    }

    const deleted = [];
    const failed = [];
    const deduped = [...new Set(inputPaths.filter((value) => typeof value === 'string' && value.trim() !== ''))];

    for (const targetPath of deduped) {
      try {
        const safePath = await resolveSafePath(targetPath);
        if (safePath === await ROOT_REAL_PATH) {
          throw new Error('Refusing to delete root path.');
        }
        await fs.rm(safePath, { recursive: true, force: false });
        deleted.push(await toDisplayPath(safePath));
      } catch (error) {
        failed.push({
          path: targetPath,
          error: error.code === 'ENOENT' ? 'Path not found.' : error.message || 'Delete failed.',
        });
      }
    }

    res.json({ ok: failed.length === 0, deleted, failed });
  } catch (error) {
    next(error);
  }
});

app.post('/api/bulk-download', async (req, res, next) => {
  const tempDirPrefix = path.join(os.tmpdir(), 'filemanager-bulk-');
  let tempDir = '';

  try {
    const inputPaths = Array.isArray(req.body?.paths) ? req.body.paths : [];

    if (inputPaths.length === 0) {
      return res.status(400).json({ error: 'Missing paths in request body.' });
    }

    const deduped = [...new Set(inputPaths.filter((value) => typeof value === 'string' && value.trim() !== ''))];
    if (deduped.length === 0) {
      return res.status(400).json({ error: 'No valid paths were provided.' });
    }

    const relativePaths = [];

    for (const targetPath of deduped) {
      const safePath = await resolveSafePath(targetPath);
      if (safePath === await ROOT_REAL_PATH) {
        return res.status(400).json({ error: 'Refusing to download root path as bulk archive.' });
      }
      await fs.lstat(safePath);
      relativePaths.push(await toRelativePath(safePath));
    }

    tempDir = await fs.mkdtemp(tempDirPrefix);
    const archivePath = path.join(tempDir, 'selection.tar.gz');
    await runCommand('tar', ['-czf', archivePath, '-C', ROOT_PATH, ...relativePaths]);

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outputName = `file-manager-bulk-${stamp}.tar.gz`;

    res.download(archivePath, outputName, async (error) => {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore temp cleanup errors.
      }
      if (error) {
        next(error);
      }
    });
  } catch (error) {
    if (tempDir) {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore temp cleanup errors.
      }
    }
    next(error);
  }
});

app.post('/api/paste', async (req, res, next) => {
  try {
    const inputSources = Array.isArray(req.body?.sources) ? req.body.sources : [];
    const destinationInput = typeof req.body?.destination === 'string' ? req.body.destination : DISPLAY_ROOT_PATH;

    const dedupedSources = [...new Set(inputSources.filter((value) => typeof value === 'string' && value.trim() !== ''))];
    if (dedupedSources.length === 0) {
      return res.status(400).json({ error: 'Missing sources in request body.' });
    }

    const destinationDir = await resolveSafePath(destinationInput);
    const destinationStats = await fs.lstat(destinationDir);
    if (!destinationStats.isDirectory()) {
      return res.status(400).json({ error: 'Paste destination must be a directory.' });
    }

    const pasted = [];
    const failed = [];

    for (const sourceInput of dedupedSources) {
      try {
        const sourcePath = await resolveSafePath(sourceInput);
        if (sourcePath === await ROOT_REAL_PATH) {
          throw new Error('Refusing to copy root path.');
        }

        const sourceStats = await fs.lstat(sourcePath);
        if (sourceStats.isDirectory() && isWithin(sourcePath, destinationDir)) {
          throw new Error('Cannot paste a folder into itself.');
        }

        const targetPath = await resolveCopyTargetPath(destinationDir, path.basename(sourcePath));
        await fs.cp(sourcePath, targetPath, {
          recursive: true,
          force: false,
          errorOnExist: true,
          preserveTimestamps: true,
        });
        pasted.push(await toDisplayPath(targetPath));
      } catch (error) {
        failed.push({
          path: sourceInput,
          error: error.code === 'ENOENT' ? 'Path not found.' : error.message || 'Paste failed.',
        });
      }
    }

    res.json({ ok: failed.length === 0, pasted, failed });
  } catch (error) {
    next(error);
  }
});

app.post('/api/folder', async (req, res, next) => {
  try {
    const folderPath = await resolveSafeChildPath(req.body?.parent || DISPLAY_ROOT_PATH, req.body?.name);
    await fs.mkdir(folderPath);
    res.status(201).json({
      ok: true,
      path: await toDisplayPath(folderPath),
      name: path.basename(folderPath),
    });
  } catch (error) {
    if (error.code === 'EEXIST') {
      return res.status(409).json({ error: 'A file or folder with that name already exists.' });
    }
    next(error);
  }
});

app.post('/api/rename', async (req, res, next) => {
  try {
    const sourcePath = await resolveSafePath(req.body?.path);
    if (sourcePath === await ROOT_REAL_PATH) {
      return res.status(400).json({ error: 'Refusing to rename the root path.' });
    }

    const targetPath = await resolveSafeChildPath(path.dirname(sourcePath), req.body?.name);
    if (await pathExists(targetPath)) {
      return res.status(409).json({ error: 'A file or folder with that name already exists.' });
    }

    await fs.rename(sourcePath, targetPath);
    res.json({
      ok: true,
      oldPath: await toDisplayPath(sourcePath),
      path: await toDisplayPath(targetPath),
      name: path.basename(targetPath),
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/upload', uploadMiddleware.array('files', MAX_UPLOAD_FILES), async (req, res, next) => {
  try {
    const uploadedFiles = Array.isArray(req.files) ? req.files : [];
    if (uploadedFiles.length === 0) {
      return res.status(400).json({ error: 'No files were uploaded.' });
    }

    const uploaded = await Promise.all(uploadedFiles.map(async (file) => ({
      name: file.filename,
      path: await toDisplayPath(file.path),
      size: file.size,
    })));

    res.json({ ok: true, uploaded });
  } catch (error) {
    next(error);
  }
});

app.use((error, req, res, next) => {
  const statusCode = Number(error.statusCode || 500);
  const message = error.message || 'Unexpected server error.';

  res.status(statusCode).json({ error: message });
});

if (require.main === module) {
  app.listen(PORT, LISTEN_HOST, () => {
    // eslint-disable-next-line no-console
    console.log(`File Manager ${MODE} listening on ${LISTEN_HOST}:${PORT}. Root: ${ROOT_PATH}`);
  });
}

module.exports = {
  app,
  isWithin,
  resolveSafePath,
  resolveSafeChildPath,
  toDisplayPath,
  validateEntryName,
};
