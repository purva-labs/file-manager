const state = {
  activeNodeId: null,
  nodes: [],
  rootPath: '/srv',
  currentPath: '/srv',
  sizeCache: new Map(),
  searchQuery: '',
  selectedPaths: new Set(),
  entries: [],
  visibleEntries: [],
  entryIndexByPath: new Map(),
  rowByPath: new Map(),
  lastSelectedPath: null,
  clipboardPaths: [],
  history: [],
  historyIndex: -1,
};

const appBasePath = window.location.pathname.startsWith('/admin-proxy/filemanager')
  ? '/admin-proxy/filemanager'
  : '';
const appUrl = (pathValue) => `${appBasePath}${pathValue}`;
const nodeApiUrl = (pathValue) => {
  if (!state.activeNodeId || !pathValue.startsWith('/api')) return appUrl(pathValue);
  return appUrl(`/api/nodes/${encodeURIComponent(state.activeNodeId)}${pathValue.slice(4)}`);
};

const nodesCardEl = document.getElementById('nodesCard');
const nodeButtonsEl = document.getElementById('nodeButtons');
const nodeStatusEl = document.getElementById('nodeStatus');
const rootPathEl = document.getElementById('rootPath');
const storageSummaryEl = document.getElementById('storageSummary');
const storageBarUsedEl = document.getElementById('storageBarUsed');
const storageBarFreeEl = document.getElementById('storageBarFree');
const storageMetaEl = document.getElementById('storageMeta');
const storageDevicesListEl = document.getElementById('storageDevicesList');
const filesystemsListEl = document.getElementById('filesystemsList');
const entriesTableBodyEl = document.getElementById('entriesTableBody');
const breadcrumbsEl = document.getElementById('breadcrumbs');
const searchInputEl = document.getElementById('searchInput');
const toastEl = document.getElementById('toast');
const backButtonEl = document.getElementById('backButton');
const uploadButtonEl = document.getElementById('uploadButton');
const newFolderButtonEl = document.getElementById('newFolderButton');
const uploadInputEl = document.getElementById('uploadInput');
const dropZoneEl = document.getElementById('dropZone');
const refreshButtonEl = document.getElementById('refreshButton');
const selectionActionsEl = document.getElementById('selectionActions');
const selectionCountEl = document.getElementById('selectionCount');
const topCopyButtonEl = document.getElementById('topCopyButton');
const topRenameButtonEl = document.getElementById('topRenameButton');
const topPasteButtonEl = document.getElementById('topPasteButton');
const topDownloadButtonEl = document.getElementById('topDownloadButton');
const topDeleteButtonEl = document.getElementById('topDeleteButton');
const contextMenuEl = document.getElementById('contextMenu');
const contextUploadButtonEl = document.getElementById('contextUploadButton');
const contextCopyButtonEl = document.getElementById('contextCopyButton');
const contextRenameButtonEl = document.getElementById('contextRenameButton');
const contextPasteButtonEl = document.getElementById('contextPasteButton');
const contextDownloadButtonEl = document.getElementById('contextDownloadButton');
const contextDeleteButtonEl = document.getElementById('contextDeleteButton');

function showToast(message, duration = 2200) {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  setTimeout(() => toastEl.classList.remove('show'), duration);
}

function formatBytes(bytes) {
  if (bytes == null || Number.isNaN(bytes)) return '-';
  if (bytes === 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;

  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function formatDate(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString();
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return '0.0%';
  return `${value.toFixed(1)}%`;
}

async function apiGet(url) {
  const response = await fetch(nodeApiUrl(url));
  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.error || `Request failed: ${response.status}`);
  }
  return response.json();
}

async function apiSend(url, method, body) {
  const response = await fetch(nodeApiUrl(url), {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.error || `Request failed: ${response.status}`);
  }

  return response.json().catch(() => ({}));
}

function setNodeStatus(message, status = '') {
  nodeStatusEl.textContent = message;
  nodeStatusEl.className = `node-status ${status}`.trim();
}

function renderNodeButtons() {
  nodeButtonsEl.innerHTML = '';
  for (const node of state.nodes) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'node-button';
    button.classList.toggle('active', node.id === state.activeNodeId);
    button.textContent = node.name;
    button.addEventListener('click', () => void selectNode(node.id));
    nodeButtonsEl.appendChild(button);
  }
}

async function loadNodes() {
  const response = await fetch(appUrl('/api/nodes'));
  if (response.status === 404) return false;
  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.error || `Unable to load nodes: ${response.status}`);
  }
  const data = await response.json();
  state.nodes = Array.isArray(data.nodes) ? data.nodes : [];
  if (state.nodes.length === 0) throw new Error('The hub has no configured nodes.');
  nodesCardEl.hidden = false;
  return true;
}

async function selectNode(nodeId) {
  const node = state.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return;

  state.activeNodeId = node.id;
  state.history = [];
  state.historyIndex = -1;
  state.sizeCache.clear();
  state.clipboardPaths = [];
  state.entries = [];
  clearSelection();
  renderNodeButtons();
  setNodeStatus(`Connecting to ${node.name}...`, 'connecting');

  try {
    await loadConfig();
    await loadFilesystems();
    await loadDirectory(state.currentPath);
    setNodeStatus(`${node.name} online`, 'online');
  } catch (error) {
    setNodeStatus(`${node.name} unavailable`, 'offline');
    showToast(error.message);
  }
}

async function loadConfig() {
  const config = await apiGet('/api/config');
  state.rootPath = config.rootPath;
  state.currentPath = config.rootPath;
  rootPathEl.textContent = config.rootPath;
}

async function loadFilesystems() {
  try {
    const data = await apiGet('/api/filesystems');
    const filesystems = Array.isArray(data.filesystems) ? data.filesystems : [];
    const localSummary = data.localSummary || filesystems
      .filter((filesystem) => !filesystem.network && !['cifs', 'nfs', 'nfs4'].includes(filesystem.type))
      .filter((filesystem, index, all) => all.findIndex((candidate) =>
        (candidate.source || candidate.mountPath) === (filesystem.source || filesystem.mountPath)) === index)
      .reduce((summary, filesystem) => ({
        filesystemCount: summary.filesystemCount + 1,
        totalBytes: summary.totalBytes + Number(filesystem.totalBytes || 0),
        usedBytes: summary.usedBytes + Number(filesystem.usedBytes || 0),
        freeBytes: summary.freeBytes + Number(filesystem.freeBytes || 0),
        availableBytes: summary.availableBytes + Number(filesystem.availableBytes || 0),
      }), { filesystemCount: 0, totalBytes: 0, usedBytes: 0, freeBytes: 0, availableBytes: 0 });
    const total = Number(localSummary.totalBytes || 0);
    const free = Number(localSummary.freeBytes || 0);
    const available = Number(localSummary.availableBytes || 0);
    const used = Number(localSummary.usedBytes || 0);
    const usedPercent = total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : 0;
    const freePercent = total > 0 ? Math.min(100, Math.max(0, (free / total) * 100)) : 0;

    storageSummaryEl.textContent = `${formatBytes(free)} free of ${formatBytes(total)}`;
    storageBarUsedEl.style.width = `${usedPercent}%`;
    storageBarFreeEl.style.width = `${freePercent}%`;
    storageMetaEl.textContent = `${formatPercent(usedPercent)} used • ${localSummary.filesystemCount} local filesystem(s) • network mounts excluded`;
    const localDevices = Array.isArray(data.localDevices) ? data.localDevices : buildLocalDeviceSummaries(filesystems);
    renderStorageDevices(localDevices);
    filesystemsListEl.innerHTML = '';

    if (filesystems.length === 0) {
      filesystemsListEl.innerHTML = '<p class="storage-meta">No persistent mounts discovered.</p>';
      return;
    }

    for (const filesystem of filesystems) {
      const total = Number(filesystem.totalBytes || 0);
      const free = Number(filesystem.freeBytes || 0);
      const used = Number(filesystem.usedBytes || 0);
      const usedPercent = total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : 0;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'filesystem-button';

      const heading = document.createElement('span');
      heading.className = 'filesystem-heading';
      heading.textContent = filesystem.mountPath;
      const source = document.createElement('span');
      source.className = 'filesystem-source';
      source.textContent = `${filesystem.source} • ${filesystem.type}${filesystem.writable ? ' • rw' : ' • ro'}`;
      const usage = document.createElement('span');
      usage.className = 'filesystem-usage';
      usage.textContent = `${formatBytes(free)} free of ${formatBytes(total)} • ${formatPercent(usedPercent)} used`;

      button.append(heading, source, usage);
      button.addEventListener('click', () => void navigateTo(filesystem.mountPath));
      filesystemsListEl.appendChild(button);
    }
  } catch (error) {
    storageSummaryEl.textContent = 'Disk usage unavailable';
    storageBarUsedEl.style.width = '0%';
    storageBarFreeEl.style.width = '100%';
    storageMetaEl.textContent = error.message;
    storageDevicesListEl.innerHTML = '';
    filesystemsListEl.innerHTML = '';
    const message = document.createElement('p');
    message.className = 'storage-meta';
    message.textContent = `Mount discovery unavailable: ${error.message}`;
    filesystemsListEl.appendChild(message);
  }
}

function storageDeviceSource(source) {
  const value = String(source || '').trim();
  if (/^\/dev\/(nvme\d+n\d+|mmcblk\d+|md\d+)p\d+$/.test(value)) return value.replace(/p\d+$/, '');
  if (/^\/dev\/(sd|vd|xvd|hd)[a-z]+\d+$/.test(value)) return value.replace(/\d+$/, '');
  return value;
}

function buildLocalDeviceSummaries(filesystems) {
  const devices = new Map();
  const seenSources = new Set();
  for (const filesystem of filesystems) {
    if (filesystem.network || ['cifs', 'nfs', 'nfs4'].includes(filesystem.type)) continue;
    const source = filesystem.source || filesystem.mountPath;
    if (!source || seenSources.has(source)) continue;
    seenSources.add(source);
    const device = storageDeviceSource(source) || source;
    const summary = devices.get(device) || {
      device,
      primary: false,
      filesystemCount: 0,
      mountPaths: [],
      totalBytes: 0,
      usedBytes: 0,
      freeBytes: 0,
    };
    summary.primary ||= filesystem.mountPath === state.rootPath;
    summary.filesystemCount += 1;
    summary.mountPaths.push(filesystem.mountPath);
    summary.totalBytes += Number(filesystem.totalBytes || 0);
    summary.usedBytes += Number(filesystem.usedBytes || 0);
    summary.freeBytes += Number(filesystem.freeBytes || 0);
    devices.set(device, summary);
  }
  return [...devices.values()].sort((a, b) => Number(b.primary) - Number(a.primary) || a.device.localeCompare(b.device));
}

function renderStorageDevices(devices) {
  storageDevicesListEl.innerHTML = '';
  for (const device of devices) {
    const total = Number(device.totalBytes || 0);
    const used = Number(device.usedBytes || 0);
    const free = Number(device.freeBytes || 0);
    const usedPercent = total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : 0;
    const card = document.createElement('div');
    card.className = 'storage-device';

    const heading = document.createElement('div');
    heading.className = 'storage-device-heading';
    const title = document.createElement('strong');
    title.textContent = `${device.primary ? 'System ' : ''}${device.mediaType || 'disk'}`;
    const source = document.createElement('span');
    source.textContent = device.device;
    heading.append(title, source);

    const usage = document.createElement('p');
    usage.className = 'storage-device-usage';
    usage.textContent = `${formatBytes(free)} free of ${formatBytes(total)} • ${formatPercent(usedPercent)} used`;
    const meter = document.createElement('div');
    meter.className = 'storage-device-meter';
    meter.setAttribute('role', 'progressbar');
    meter.setAttribute('aria-label', `${title.textContent} usage`);
    meter.setAttribute('aria-valuenow', usedPercent.toFixed(1));
    meter.setAttribute('aria-valuemin', '0');
    meter.setAttribute('aria-valuemax', '100');
    const usedBar = document.createElement('span');
    usedBar.style.width = `${usedPercent}%`;
    meter.appendChild(usedBar);

    const mounts = document.createElement('p');
    mounts.className = 'storage-device-mounts';
    mounts.textContent = device.mountPaths.join(' • ');
    card.append(heading, usage, meter, mounts);
    storageDevicesListEl.appendChild(card);
  }
}

function fileIcon(type) {
  if (type === 'directory') return ['DIR', 'dir'];
  return ['FIL', 'file'];
}

function clearSelection() {
  state.selectedPaths.clear();
  state.lastSelectedPath = null;
  syncSelectedRows();
}

function syncSelectedRows() {
  for (const [pathValue, row] of state.rowByPath.entries()) {
    row.classList.toggle('selected', state.selectedPaths.has(pathValue));
  }
  updateActionControls();
}

function selectOnly(pathValue) {
  state.selectedPaths.clear();
  if (pathValue) {
    state.selectedPaths.add(pathValue);
    state.lastSelectedPath = pathValue;
  }
  syncSelectedRows();
}

function togglePathSelection(pathValue) {
  if (state.selectedPaths.has(pathValue)) {
    state.selectedPaths.delete(pathValue);
  } else {
    state.selectedPaths.add(pathValue);
    state.lastSelectedPath = pathValue;
  }
  syncSelectedRows();
}

function selectRange(pathValue) {
  if (!state.lastSelectedPath || !state.entryIndexByPath.has(state.lastSelectedPath)) {
    selectOnly(pathValue);
    return;
  }

  const start = state.entryIndexByPath.get(state.lastSelectedPath);
  const end = state.entryIndexByPath.get(pathValue);
  if (start == null || end == null) {
    selectOnly(pathValue);
    return;
  }

  const [low, high] = start <= end ? [start, end] : [end, start];
  state.selectedPaths.clear();
  for (let index = low; index <= high; index += 1) {
    state.selectedPaths.add(state.visibleEntries[index].path);
  }
  state.lastSelectedPath = pathValue;
  syncSelectedRows();
}

function selectFromClick(pathValue, event) {
  if (event.shiftKey) {
    selectRange(pathValue);
    return;
  }

  if (event.metaKey || event.ctrlKey) {
    togglePathSelection(pathValue);
    return;
  }

  selectOnly(pathValue);
}

function ensureSelectionContains(pathValue) {
  if (state.selectedPaths.has(pathValue)) return;
  selectOnly(pathValue);
}

function hideContextMenu() {
  contextMenuEl.classList.remove('show');
  contextMenuEl.setAttribute('aria-hidden', 'true');
}

function setContextMenuState() {
  updateActionControls();
}

function updateActionControls() {
  const hasSelection = state.selectedPaths.size > 0;
  const hasClipboard = state.clipboardPaths.length > 0;
  selectionActionsEl.classList.toggle('show', hasSelection);
  selectionActionsEl.setAttribute('aria-hidden', String(!hasSelection));
  selectionCountEl.textContent = `${state.selectedPaths.size} selected`;

  topCopyButtonEl.disabled = !hasSelection;
  topRenameButtonEl.disabled = state.selectedPaths.size !== 1;
  topDownloadButtonEl.disabled = !hasSelection;
  topDeleteButtonEl.disabled = !hasSelection;
  topPasteButtonEl.disabled = !hasClipboard;

  contextCopyButtonEl.disabled = !hasSelection;
  contextRenameButtonEl.disabled = state.selectedPaths.size !== 1;
  contextDownloadButtonEl.disabled = !hasSelection;
  contextDeleteButtonEl.disabled = !hasSelection;
  contextPasteButtonEl.disabled = !hasClipboard;
}

function showContextMenu(event) {
  setContextMenuState();
  contextMenuEl.classList.add('show');
  contextMenuEl.setAttribute('aria-hidden', 'false');
  const margin = 8;
  const menuRect = contextMenuEl.getBoundingClientRect();
  const left = Math.min(event.clientX, window.innerWidth - menuRect.width - margin);
  const top = Math.min(event.clientY, window.innerHeight - menuRect.height - margin);
  contextMenuEl.style.left = `${Math.max(margin, left)}px`;
  contextMenuEl.style.top = `${Math.max(margin, top)}px`;
}

function parseFilenameFromDisposition(disposition) {
  if (!disposition) return null;
  const match = disposition.match(/filename\*?=(?:UTF-8''|\")?([^\";]+)/i);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function updateBackButton() {
  backButtonEl.disabled = state.historyIndex <= 0;
}

function pushHistory(pathValue) {
  if (state.history[state.historyIndex] === pathValue) {
    updateBackButton();
    return;
  }

  state.history = state.history.slice(0, state.historyIndex + 1);
  state.history.push(pathValue);
  state.historyIndex = state.history.length - 1;
  updateBackButton();
}

async function getEntrySize(pathValue) {
  if (state.sizeCache.has(pathValue)) {
    return state.sizeCache.get(pathValue);
  }

  const sizeInfo = await apiGet(`/api/size?path=${encodeURIComponent(pathValue)}`);
  state.sizeCache.set(pathValue, sizeInfo.size);
  return sizeInfo.size;
}

function getFilteredEntries() {
  const query = state.searchQuery.trim().toLowerCase();
  if (!query) {
    return state.entries;
  }

  return state.entries.filter((entry) => {
    const haystack = `${entry.name} ${entry.type}`.toLowerCase();
    return haystack.includes(query);
  });
}

async function revealSize(entry, sizeCell) {
  if (entry.type === 'file') {
    sizeCell.textContent = formatBytes(entry.size);
    return;
  }

  sizeCell.textContent = 'Calculating...';
  try {
    const dirSize = await getEntrySize(entry.path);
    sizeCell.textContent = formatBytes(dirSize);
  } catch (error) {
    sizeCell.textContent = 'Unavailable';
    showToast(error.message);
  }
}

function openEntry(entry) {
  if (entry.type === 'directory') {
    void navigateTo(entry.path);
    return;
  }

  const query = new URLSearchParams({ path: entry.path });
  if (state.activeNodeId) query.set('node', state.activeNodeId);
  window.location.href = appUrl(`/viewer.html?${query.toString()}`);
}

async function animateAndOpenEntry(entry, row) {
  row.classList.add('opening');
  await new Promise((resolve) => setTimeout(resolve, 140));
  row.classList.remove('opening');
  openEntry(entry);
}

function renderEntries(entries) {
  state.visibleEntries = entries;
  state.entryIndexByPath = new Map(entries.map((entry, index) => [entry.path, index]));
  state.rowByPath.clear();
  entriesTableBodyEl.innerHTML = '';

  if (entries.length === 0) {
    const row = document.createElement('tr');
    row.className = 'empty-row';
    row.innerHTML = `
      <td colspan="4">${state.searchQuery.trim() ? 'No matches found.' : 'This folder is empty.'}</td>
    `;
    entriesTableBodyEl.appendChild(row);
    syncSelectedRows();
    return;
  }

  for (const entry of entries) {
    const row = document.createElement('tr');
    row.className = 'entry-row';
    const [label, className] = fileIcon(entry.type);
    const cachedSize = state.sizeCache.get(entry.path);
    const sizeLabel =
      entry.type === 'file' ? formatBytes(entry.size) : cachedSize != null ? formatBytes(cachedSize) : 'Click to load';

    row.innerHTML = `
      <td>
        <div class="file-name">
          <span class="file-icon ${className}">${label}</span>
          <span>${entry.name}</span>
        </div>
      </td>
      <td>${entry.type}</td>
      <td class="size-cell">${sizeLabel}</td>
      <td>${formatDate(entry.modifiedAt)}</td>
    `;

    const sizeCell = row.querySelector('.size-cell');

    row.addEventListener('click', (event) => {
      hideContextMenu();
      selectFromClick(entry.path, event);
      void revealSize(entry, sizeCell);
    });

    row.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      if (event.detail > 1) {
        event.preventDefault();
      }
    });

    row.addEventListener('dblclick', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void animateAndOpenEntry(entry, row);
    });

    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      ensureSelectionContains(entry.path);
      showContextMenu(event);
    });

    state.rowByPath.set(entry.path, row);
    entriesTableBodyEl.appendChild(row);
  }

  syncSelectedRows();
}

function renderCurrentView() {
  renderEntries(getFilteredEntries());
}

function renderBreadcrumb(pathValue) {
  breadcrumbsEl.innerHTML = '';
  const relativeParts = pathValue.slice(state.rootPath.length).split('/').filter(Boolean);
  const crumbs = [{ label: state.rootPath, path: state.rootPath }];
  let current = state.rootPath;
  for (const part of relativeParts) {
    current = `${current}/${part}`;
    crumbs.push({ label: part, path: current });
  }

  crumbs.forEach((crumb, index) => {
    if (index > 0) {
      const separator = document.createElement('span');
      separator.className = 'breadcrumb-separator';
      separator.textContent = '/';
      breadcrumbsEl.appendChild(separator);
    }
    const button = document.createElement('button');
    button.className = 'breadcrumb-button';
    button.type = 'button';
    button.textContent = crumb.label;
    button.addEventListener('click', () => void navigateTo(crumb.path));
    breadcrumbsEl.appendChild(button);
  });
}

async function loadDirectory(pathValue, options = {}) {
  const { recordHistory = true } = options;
  hideContextMenu();
  const data = await apiGet(`/api/list?path=${encodeURIComponent(pathValue)}`);
  state.currentPath = data.path;
  renderBreadcrumb(data.path);
  clearSelection();
  state.entries = data.entries;
  renderCurrentView();

  if (recordHistory) {
    pushHistory(data.path);
  } else {
    updateBackButton();
  }
}

async function navigateTo(pathValue, options = {}) {
  try {
    await loadDirectory(pathValue, options);
  } catch (error) {
    showToast(error.message);
  }
}

async function deleteSelected() {
  const selected = [...state.selectedPaths];
  if (selected.length === 0) return;

  const confirmed = window.confirm(`Delete ${selected.length} selected item(s)? This action cannot be undone.`);
  if (!confirmed) return;

  try {
    const response = await apiSend('/api/bulk-delete', 'POST', { paths: selected });
    const deletedCount = Array.isArray(response.deleted) ? response.deleted.length : 0;
    const failedCount = Array.isArray(response.failed) ? response.failed.length : 0;

    showToast(
      failedCount > 0
        ? `Deleted ${deletedCount} item(s), ${failedCount} failed`
        : `Deleted ${deletedCount} item(s)`
    );

    state.sizeCache.clear();
    await loadDirectory(state.currentPath, { recordHistory: false });
  } catch (error) {
    showToast(error.message);
  }
}

async function downloadSelected() {
  const selected = [...state.selectedPaths];
  if (selected.length === 0) return;

  try {
    const response = await fetch(nodeApiUrl('/api/bulk-download'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: selected }),
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      throw new Error(errorBody.error || `Download failed: ${response.status}`);
    }

    const blob = await response.blob();
    const disposition = response.headers.get('content-disposition');
    const fileName = parseFilenameFromDisposition(disposition) || 'file-manager-bulk.tar.gz';

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);

    showToast(`Downloading ${selected.length} item(s)`);
  } catch (error) {
    showToast(error.message);
  }
}

function copySelected() {
  const selected = [...state.selectedPaths];
  if (selected.length === 0) return;
  state.clipboardPaths = selected;
  updateActionControls();
  showToast(`Copied ${selected.length} item(s)`);
}

async function pasteClipboard() {
  if (state.clipboardPaths.length === 0) return;

  try {
    const response = await apiSend('/api/paste', 'POST', {
      sources: state.clipboardPaths,
      destination: state.currentPath,
    });
    const pastedCount = Array.isArray(response.pasted) ? response.pasted.length : 0;
    showToast(`Pasted ${pastedCount} item(s)`);
    state.sizeCache.clear();
    await loadDirectory(state.currentPath, { recordHistory: false });
  } catch (error) {
    showToast(error.message);
  }
}

async function createFolder() {
  const name = window.prompt('Folder name');
  if (!name?.trim()) return;
  try {
    await apiSend('/api/folder', 'POST', { parent: state.currentPath, name: name.trim() });
    showToast(`Created ${name.trim()}`);
    await loadDirectory(state.currentPath, { recordHistory: false });
  } catch (error) {
    showToast(error.message);
  }
}

async function renameSelected() {
  if (state.selectedPaths.size !== 1) return;
  const sourcePath = [...state.selectedPaths][0];
  const currentName = sourcePath.split('/').pop() || '';
  const name = window.prompt('New name', currentName);
  if (!name?.trim() || name.trim() === currentName) return;
  try {
    await apiSend('/api/rename', 'POST', { path: sourcePath, name: name.trim() });
    showToast(`Renamed to ${name.trim()}`);
    state.sizeCache.delete(sourcePath);
    await loadDirectory(state.currentPath, { recordHistory: false });
  } catch (error) {
    showToast(error.message);
  }
}

async function uploadFiles(fileList) {
  const files = Array.from(fileList || []).filter((file) => file && file.size >= 0);
  if (files.length === 0) return;

  const formData = new FormData();
  for (const file of files) {
    formData.append('files', file, file.name);
  }

  try {
    const response = await fetch(nodeApiUrl(`/api/upload?path=${encodeURIComponent(state.currentPath)}`), {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      throw new Error(errorBody.error || `Upload failed: ${response.status}`);
    }

    const data = await response.json().catch(() => ({}));
    const uploadedCount = Array.isArray(data.uploaded) ? data.uploaded.length : files.length;
    showToast(`Uploaded ${uploadedCount} item(s)`);
    state.sizeCache.clear();
    await loadDirectory(state.currentPath, { recordHistory: false });
    await loadFilesystems();
  } catch (error) {
    showToast(error.message);
  }
}

function openUploadPicker() {
  hideContextMenu();
  uploadInputEl.click();
}

function focusSearch() {
  searchInputEl.focus();
  searchInputEl.select();
}

backButtonEl.addEventListener('click', async () => {
  if (state.historyIndex <= 0) return;
  state.historyIndex -= 1;
  const previousPath = state.history[state.historyIndex];
  await navigateTo(previousPath, { recordHistory: false });
});

refreshButtonEl.addEventListener('click', async () => {
  hideContextMenu();
  await loadDirectory(state.currentPath, { recordHistory: false });
  await loadFilesystems();
  showToast('Refreshed');
});

uploadButtonEl.addEventListener('click', () => {
  openUploadPicker();
});

newFolderButtonEl.addEventListener('click', () => void createFolder());
topRenameButtonEl.addEventListener('click', () => void renameSelected());
contextRenameButtonEl.addEventListener('click', () => {
  hideContextMenu();
  void renameSelected();
});

uploadInputEl.addEventListener('change', async () => {
  await uploadFiles(uploadInputEl.files);
  uploadInputEl.value = '';
});

for (const eventName of ['dragenter', 'dragover']) {
  dropZoneEl.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZoneEl.classList.add('drag-active');
  });
}

for (const eventName of ['dragleave', 'drop']) {
  dropZoneEl.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZoneEl.classList.remove('drag-active');
  });
}

dropZoneEl.addEventListener('drop', (event) => {
  void uploadFiles(event.dataTransfer?.files);
});

searchInputEl.addEventListener('input', () => {
  state.searchQuery = searchInputEl.value;
  clearSelection();
  renderCurrentView();
});

searchInputEl.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    searchInputEl.value = '';
    state.searchQuery = '';
    clearSelection();
    renderCurrentView();
    searchInputEl.blur();
  }
});

entriesTableBodyEl.addEventListener('contextmenu', (event) => {
  if (event.target.closest('.entry-row')) return;
  event.preventDefault();
  showContextMenu(event);
});

document.addEventListener('click', (event) => {
  hideContextMenu();
  const target = event.target;
  if (
    target.closest('.entry-row') ||
    target.closest('#contextMenu') ||
    target.closest('#selectionActions')
  ) {
    return;
  }

  clearSelection();
});

document.addEventListener('selectstart', (event) => {
  if (event.target.closest('.entry-row')) {
    event.preventDefault();
  }
});

document.addEventListener('keydown', (event) => {
  const isEditableTarget =
    event.target instanceof HTMLElement &&
    (event.target.matches('input, textarea, [contenteditable="true"]') ||
      event.target.closest('input, textarea, [contenteditable="true"]'));

  if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    focusSearch();
    return;
  }

  if (event.key === 'Escape') {
    hideContextMenu();
    return;
  }

  if (isEditableTarget) {
    return;
  }

  if (event.metaKey || event.ctrlKey) {
    if (event.key.toLowerCase() === 'a') {
      event.preventDefault();
      state.selectedPaths = new Set(state.visibleEntries.map((entry) => entry.path));
      if (state.visibleEntries.length > 0) {
        state.lastSelectedPath = state.visibleEntries[state.visibleEntries.length - 1].path;
      }
      syncSelectedRows();
      return;
    }

    if (event.key.toLowerCase() === 'c') {
      copySelected();
      return;
    }

    if (event.key.toLowerCase() === 'v') {
      void pasteClipboard();
    }
    return;
  }

  if (event.key === 'Delete' || event.key === 'Backspace') {
    void deleteSelected();
  }
});

window.addEventListener('scroll', () => {
  hideContextMenu();
});

contextCopyButtonEl.addEventListener('click', async () => {
  hideContextMenu();
  copySelected();
});

contextUploadButtonEl.addEventListener('click', async () => {
  openUploadPicker();
});

contextPasteButtonEl.addEventListener('click', async () => {
  hideContextMenu();
  await pasteClipboard();
});

contextDownloadButtonEl.addEventListener('click', async () => {
  hideContextMenu();
  await downloadSelected();
});

contextDeleteButtonEl.addEventListener('click', async () => {
  hideContextMenu();
  await deleteSelected();
});

topCopyButtonEl.addEventListener('click', async () => {
  hideContextMenu();
  copySelected();
});

topPasteButtonEl.addEventListener('click', async () => {
  hideContextMenu();
  await pasteClipboard();
});

topDownloadButtonEl.addEventListener('click', async () => {
  hideContextMenu();
  await downloadSelected();
});

topDeleteButtonEl.addEventListener('click', async () => {
  hideContextMenu();
  await deleteSelected();
});

(async function initialize() {
  try {
    const distributed = await loadNodes();
    if (distributed) {
      await selectNode(state.nodes[0].id);
      return;
    }
    await loadConfig();
    await loadFilesystems();
    await loadDirectory(state.currentPath);
  } catch (error) {
    showToast(`Initialization failed: ${error.message}`);
  }
})();
