(function exposeSort(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.FileManagerSort = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : window, () => {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

  function compareText(a, b) {
    return collator.compare(String(a || ''), String(b || ''));
  }

  function entrySize(entry, sizeCache) {
    if (entry.type === 'file') {
      const size = Number(entry.size);
      return Number.isFinite(size) ? size : null;
    }
    const cached = sizeCache && sizeCache.get(entry.path);
    return Number.isFinite(cached) ? cached : null;
  }

  function compareOptionalNumbers(a, b, direction) {
    if (a == null && b == null) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    return (a - b) * direction;
  }

  function sortEntries(entries, sortKey = 'name', sortDirection = 'asc', sizeCache = new Map()) {
    const direction = sortDirection === 'desc' ? -1 : 1;
    return [...entries].sort((a, b) => {
      let result = 0;
      if (sortKey === 'name') {
        if (a.type === 'directory' && b.type !== 'directory') return -1;
        if (a.type !== 'directory' && b.type === 'directory') return 1;
        result = compareText(a.name, b.name) * direction;
      } else if (sortKey === 'type') {
        result = compareText(a.type, b.type) * direction;
      } else if (sortKey === 'size') {
        result = compareOptionalNumbers(entrySize(a, sizeCache), entrySize(b, sizeCache), direction);
      } else if (sortKey === 'modifiedAt') {
        const aTime = Date.parse(a.modifiedAt);
        const bTime = Date.parse(b.modifiedAt);
        result = compareOptionalNumbers(
          Number.isFinite(aTime) ? aTime : null,
          Number.isFinite(bTime) ? bTime : null,
          direction
        );
      }

      return result || compareText(a.name, b.name);
    });
  }

  return { sortEntries };
}));
