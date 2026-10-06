/**
 * Temporary client-side persistence for the student's CURRENT unfinished order.
 * File bytes live in IndexedDB (never localStorage). Independent of React unmounts.
 * Does not touch server/Supabase storage or the 24-hour PDF cleanup job.
 */

export const CURRENT_UNFINISHED_ORDER = 'CURRENT_UNFINISHED_ORDER';
export const MAX_ORDER_FILES = 10;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

const DB_NAME = 'campus-print-unfinished-order';
const DB_VERSION = 1;
const META_STORE = 'orderMeta';
const FILE_STORE = 'orderFiles';
const SAVE_DEBOUNCE_MS = 400;

export class OrderStorageError extends Error {
  constructor(message, { quota = false } = {}) {
    super(message);
    this.name = 'OrderStorageError';
    this.quota = quota;
  }
}

export const EMPTY_ORDER_META = {
  guestDetails: null,
  colorOption: 'bw',
  paperSize: 'A4',
  printingSide: 'single',
  spiralBinding: false,
  expressDelivery: false,
  classroomDelivery: false,
  selectedLocationId: null,
  selectedLocationName: null,
  selectedTimeSlot: null,
};

function isQuotaError(err) {
  if (!err) return false;
  if (err instanceof OrderStorageError) return err.quota;
  if (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED') return true;
  if (err.code === 22 || err.code === 1014) return true;
  const msg = String(err.message || err);
  return /quota|storage/i.test(msg) && /exceed|full|insufficient|not enough/i.test(msg);
}

export function storageErrorMessage(err) {
  if (isQuotaError(err)) {
    return 'Not enough browser storage to save your files. Your current order is still here — finish it on this tab, or remove some files and try again.';
  }
  return 'Could not save your unfinished order in this browser. Your files are still here until you leave or refresh.';
}

function blobToFile(blob, name, type) {
  const mime = type || blob?.type || 'application/octet-stream';
  const fileName = name || 'document';
  try {
    return new File([blob], fileName, { type: mime, lastModified: Date.now() });
  } catch {
    const fallback = blob instanceof Blob ? blob : new Blob([blob], { type: mime });
    try {
      Object.defineProperty(fallback, 'name', { value: fileName, configurable: true });
    } catch {
      fallback.name = fileName;
    }
    return fallback;
  }
}

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new OrderStorageError('Browser storage is not available in this session.'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE);
      }
      if (!db.objectStoreNames.contains(FILE_STORE)) {
        db.createObjectStore(FILE_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      reject(new OrderStorageError(request.error?.message || 'Could not open browser storage.'));
    };
  });
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}

function serializeMeta(meta = {}) {
  const guest = meta.guestDetails && typeof meta.guestDetails === 'object'
    ? {
      fullName: String(meta.guestDetails.fullName || meta.guestDetails.name || ''),
      phone: String(meta.guestDetails.phone || ''),
      classroom: String(meta.guestDetails.classroom || meta.guestDetails.classSection || ''),
    }
    : null;

  return {
    id: CURRENT_UNFINISHED_ORDER,
    guestDetails: guest,
    colorOption: meta.colorOption === 'color' ? 'color' : 'bw',
    paperSize: 'A4',
    printingSide: meta.printingSide === 'double' ? 'double' : 'single',
    spiralBinding: !!meta.spiralBinding,
    expressDelivery: !!meta.expressDelivery,
    classroomDelivery: !!meta.classroomDelivery,
    selectedLocationId: meta.selectedLocationId || null,
    selectedLocationName: meta.selectedLocationName || null,
    selectedTimeSlot: meta.selectedTimeSlot || null,
    filesMeta: Array.isArray(meta.filesMeta) ? meta.filesMeta : [],
    updatedAt: Date.now(),
  };
}

function fileEntriesFromInput(files) {
  if (!Array.isArray(files)) return [];
  return files
    .filter((entry) => entry && (entry.file instanceof Blob || entry.blob instanceof Blob))
    .slice(0, MAX_ORDER_FILES)
    .map((entry, index) => {
      const file = entry.file || entry.blob;
      const id = String(entry.key ?? entry.id ?? `file-${index}-${Date.now()}`);
      const name = entry.name || file.name || 'document';
      const type = entry.type || file.type || 'application/octet-stream';
      const size = typeof file.size === 'number' ? file.size : 0;
      return {
        id,
        key: entry.key ?? id,
        name,
        type,
        size,
        pages: entry.pages == null ? null : Number(entry.pages),
        estimated: !!entry.estimated,
        copies: Math.max(1, parseInt(entry.copies, 10) || 1),
        printingSide: entry.printingSide === 'double' ? 'double' : 'single',
        colorMode: entry.colorMode === 'color' ? 'color' : 'bw',
        blob: file,
      };
    });
}

function validateFileSizes(fileRecords) {
  for (const rec of fileRecords) {
    if (rec.size > MAX_FILE_BYTES) {
      throw new OrderStorageError(
        `${rec.name} is larger than 20 MB, which is the maximum allowed file size.`,
      );
    }
  }
  if (fileRecords.length > MAX_ORDER_FILES) {
    throw new OrderStorageError('Max 10 files allowed.');
  }
}

let writeChain = Promise.resolve();

function enqueueWrite(task) {
  const next = writeChain.then(task, task);
  writeChain = next.then(() => undefined, () => undefined);
  return next;
}

export async function saveCurrentOrder({ meta, files } = {}) {
  const fileRecords = fileEntriesFromInput(files);
  validateFileSizes(fileRecords);

  const filesMeta = fileRecords.map(({ blob, ...rest }) => rest);
  const record = serializeMeta({ ...EMPTY_ORDER_META, ...meta, filesMeta });

  return enqueueWrite(async () => {
    let db;
    try {
      db = await openDb();
      const tx = db.transaction([META_STORE, FILE_STORE], 'readwrite');
      const metaStore = tx.objectStore(META_STORE);
      const fileStore = tx.objectStore(FILE_STORE);

      const existingFiles = await requestToPromise(fileStore.getAll());
      const keepIds = new Set(fileRecords.map((f) => String(f.id)));
      for (const old of existingFiles || []) {
        if (!keepIds.has(String(old.id))) {
          fileStore.delete(old.id);
        }
      }

      for (const rec of fileRecords) {
        fileStore.put({
          id: String(rec.id),
          name: rec.name,
          type: rec.type,
          size: rec.size,
          blob: rec.blob,
        });
      }

      metaStore.put(record, CURRENT_UNFINISHED_ORDER);
      await txDone(tx);
    } catch (err) {
      if (isQuotaError(err)) {
        throw new OrderStorageError(storageErrorMessage(err), { quota: true });
      }
      throw new OrderStorageError(storageErrorMessage(err), { quota: false });
    } finally {
      db?.close();
    }
  });
}

export async function loadCurrentOrder() {
  return enqueueWrite(async () => {
  let db;
  try {
    db = await openDb();
    const tx = db.transaction([META_STORE, FILE_STORE], 'readonly');
    const meta = await requestToPromise(tx.objectStore(META_STORE).get(CURRENT_UNFINISHED_ORDER));
    const storedFiles = await requestToPromise(tx.objectStore(FILE_STORE).getAll());
    await txDone(tx);
    if (!meta) return null;

    const filesById = new Map((storedFiles || []).map((row) => [String(row.id), row]));
    const filesMeta = Array.isArray(meta.filesMeta) ? meta.filesMeta : [];
    const files = [];

    for (const info of filesMeta) {
      const row = filesById.get(String(info.id ?? info.key));
      if (!row?.blob) continue;
      const file = blobToFile(row.blob, info.name || row.name, info.type || row.type);
      files.push({
        key: info.key ?? info.id,
        file,
        pages: info.pages == null ? null : info.pages,
        estimated: !!info.estimated,
        copies: Math.max(1, parseInt(info.copies, 10) || 1),
        printingSide: info.printingSide || 'single',
        colorMode: info.colorMode || 'bw',
      });
    }

    // Recover blobs that still exist if metadata list was incomplete.
    if (files.length === 0 && storedFiles?.length) {
      for (const row of storedFiles) {
        if (!row?.blob) continue;
        files.push({
          key: row.id,
          file: blobToFile(row.blob, row.name, row.type),
          pages: null,
          estimated: false,
          copies: 1,
        });
      }
    }

    return {
      ...EMPTY_ORDER_META,
      guestDetails: meta.guestDetails || null,
      colorOption: meta.colorOption === 'color' ? 'color' : 'bw',
      paperSize: meta.paperSize === 'A3' ? 'A3' : 'A4',
      printingSide: meta.printingSide === 'double' ? 'double' : 'single',
      spiralBinding: !!meta.spiralBinding,
      expressDelivery: !!meta.expressDelivery,
      classroomDelivery: !!meta.classroomDelivery,
      selectedLocationId: meta.selectedLocationId || null,
      selectedLocationName: meta.selectedLocationName || null,
      selectedTimeSlot: meta.selectedTimeSlot || null,
      files,
      updatedAt: meta.updatedAt || null,
    };
  } catch {
    return null;
  } finally {
    db?.close();
  }
  });
}

export async function updateCurrentOrder(patch = {}, files) {
  const current = (await loadCurrentOrder()) || { ...EMPTY_ORDER_META, files: [] };
  const nextFiles = files !== undefined ? files : current.files;
  const { files: _ignored, ...currentMeta } = current;
  return saveCurrentOrder({
    meta: { ...currentMeta, ...patch },
    files: nextFiles,
  });
}

export async function removeCurrentOrder() {
  pendingSave = null;
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  return enqueueWrite(async () => {
    let db;
    try {
      db = await openDb();
      const tx = db.transaction([META_STORE, FILE_STORE], 'readwrite');
      tx.objectStore(META_STORE).delete(CURRENT_UNFINISHED_ORDER);
      tx.objectStore(FILE_STORE).clear();
      await txDone(tx);
    } catch (err) {
      throw new OrderStorageError(storageErrorMessage(err), { quota: isQuotaError(err) });
    } finally {
      db?.close();
    }
  });
}

export function clearCompletedOrder() {
  return removeCurrentOrder();
}

let debounceTimer = null;
let pendingSave = null;

export function scheduleSaveCurrentOrder(payload) {
  pendingSave = payload;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    const toSave = pendingSave;
    pendingSave = null;
    if (!toSave) return;
    saveCurrentOrder(toSave).catch((err) => {
      if (typeof toSave.onError === 'function') toSave.onError(err);
    });
  }, SAVE_DEBOUNCE_MS);
}

export async function flushSaveCurrentOrder() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  const toSave = pendingSave;
  pendingSave = null;
  if (!toSave) return;
  const { onError, ...payload } = toSave;
  try {
    await saveCurrentOrder(payload);
  } catch (err) {
    if (typeof onError === 'function') onError(err);
    throw err;
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    flushSaveCurrentOrder().catch(() => {});
  });
}
