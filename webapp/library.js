// Label library. Labels are stored as one JSON file per label in a folder the
// user picks (File System Access API); until a folder is chosen they live in
// the browser's localStorage. The folder handle is remembered in IndexedDB.

const LOCAL_KEY = 'nameland-library-v1';
const EXT = '.nlabel.json';

export const supportsFolder = 'showDirectoryPicker' in window;

// ---- tiny IndexedDB key/value store for the directory handle ----
function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('nameland', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('kv', mode);
      const req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
    };
  });
}

let dir = null; // FileSystemDirectoryHandle

export async function restoreFolder() {
  if (!supportsFolder) return null;
  try {
    dir = (await idb('readonly', (s) => s.get('dir'))) || null;
  } catch {
    dir = null;
  }
  return dir;
}

export function folderName() {
  return dir ? dir.name : '';
}

// 'granted' | 'prompt' | 'denied' | 'none'
export async function folderPermission() {
  if (!dir) return 'none';
  return dir.queryPermission({ mode: 'readwrite' });
}

// Must be called from a click handler (the browser asks the user).
export async function requestFolderPermission() {
  if (!dir) return 'none';
  return dir.requestPermission({ mode: 'readwrite' });
}

// Must be called from a click handler. Moves labels kept in the browser into the folder.
export async function chooseFolder() {
  const handle = await window.showDirectoryPicker({ id: 'nameland-labels', mode: 'readwrite', startIn: 'documents' });
  dir = handle;
  await idb('readwrite', (s) => s.put(handle, 'dir'));
  const moved = [];
  for (const item of readLocal()) {
    if (!(await exists(item.name))) {
      await writeFile(item);
      moved.push(item.name);
    }
  }
  try { localStorage.removeItem(LOCAL_KEY); } catch { /* ignore */ }
  return moved;
}

async function usingFolder() {
  return dir && (await folderPermission()) === 'granted';
}

// ---- localStorage fallback ----
function readLocal() {
  try { return JSON.parse(localStorage.getItem(LOCAL_KEY)) || []; } catch { return []; }
}

function writeLocal(items) {
  localStorage.setItem(LOCAL_KEY, JSON.stringify(items));
}

// ---- folder files ----
function fileName(name) {
  const safe = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').slice(0, 100) || 'label';
  return safe + EXT;
}

async function exists(name) {
  try {
    await dir.getFileHandle(fileName(name));
    return true;
  } catch {
    return false;
  }
}

async function writeFile(item) {
  const fh = await dir.getFileHandle(fileName(item.name), { create: true });
  const w = await fh.createWritable();
  await w.write(JSON.stringify(item, null, 2));
  await w.close();
}

// ---- public API ----
export async function list() {
  if (!(await usingFolder())) return readLocal();
  const items = [];
  for await (const [fname, h] of dir.entries()) {
    if (h.kind !== 'file' || !fname.endsWith(EXT)) continue;
    try {
      const item = JSON.parse(await (await h.getFile()).text());
      if (item && item.settings) items.push({ ...item, name: item.name || fname.slice(0, -EXT.length) });
    } catch { /* skip unreadable files */ }
  }
  return items.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
}

export async function has(name) {
  if (await usingFolder()) return exists(name);
  return readLocal().some((x) => x.name === name);
}

export async function save(item) {
  if (await usingFolder()) return writeFile(item);
  const items = readLocal().filter((x) => x.name !== item.name);
  items.unshift(item);
  writeLocal(items);
}

export async function remove(name) {
  if (await usingFolder()) {
    await dir.removeEntry(fileName(name)).catch(() => {});
    return;
  }
  writeLocal(readLocal().filter((x) => x.name !== name));
}
