const toastEl = document.getElementById('toast');
const viewerTitleEl = document.getElementById('viewerTitle');
const viewerContentEl = document.getElementById('viewerContent');
const backButtonEl = document.getElementById('backButton');

const appBasePath = window.location.pathname.startsWith('/admin-proxy/filemanager')
  ? '/admin-proxy/filemanager'
  : '';
const appUrl = (pathValue) => `${appBasePath}${pathValue}`;
const query = new URLSearchParams(window.location.search);
const nodeId = query.get('node');
const nodeApiUrl = (pathValue) => {
  if (!nodeId || !pathValue.startsWith('/api')) return appUrl(pathValue);
  return appUrl(`/api/nodes/${encodeURIComponent(nodeId)}${pathValue.slice(4)}`);
};

function showToast(message, duration = 2200) {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  setTimeout(() => toastEl.classList.remove('show'), duration);
}

async function apiGet(url) {
  const response = await fetch(nodeApiUrl(url));
  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.error || `Request failed: ${response.status}`);
  }
  return response.json();
}

function setViewer(name, content) {
  viewerTitleEl.textContent = name || 'File Viewer';
  viewerContentEl.textContent = content || '';
}

backButtonEl.addEventListener('click', () => {
  window.history.back();
});

(async function initializeViewer() {
  const filePath = query.get('path');

  if (!filePath) {
    setViewer('File Viewer', 'No file path was provided.');
    return;
  }

  setViewer('Loading file...', 'Loading...');

  try {
    const data = await apiGet(`/api/file?path=${encodeURIComponent(filePath)}`);
    setViewer(data.name, data.content);
    document.title = `File Manager - ${data.name}`;
  } catch (error) {
    setViewer('File Viewer', `Unable to open file.\n${error.message}`);
    showToast(error.message);
  }
})();
