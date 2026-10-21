/**
 * TdyTripPWA2026 - IndexedDB Storage Layer (Phase 3)
 * Quản lý 3 Object Stores:
 * 1. trip_snapshot: keyPath "tripId" (lưu snapshot đầy đủ: members, expenses, settlements, tripMeta)
 * 2. pending_ops: keyPath "opId", index "timestamp", index "status" (hàng đợi outbox tuần tự)
 * 3. sync_meta: keyPath "key" (lưu serverRevision, lastSyncTime, syncStatus, lastError)
 * 
 * Hỗ trợ cả trình duyệt thực tế (IndexedDB) và môi trường Node.js kiểm thử (In-Memory Shim).
 */

export const DB_NAME = 'tdytrip_db';
export const DB_VERSION = 1;

export const STORES = {
  SNAPSHOT: 'trip_snapshot',
  PENDING_OPS: 'pending_ops',
  SYNC_META: 'sync_meta'
};

export const SYNC_STATUS = {
  IDLE: 'IDLE',
  SYNCING: 'SYNCING',
  ERROR: 'ERROR',
  CONFLICT: 'CONFLICT'
};

export const OP_STATUS = {
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  ACKED: 'ACKED',
  REJECTED: 'REJECTED',
  ABORTED: 'ABORTED',
  NEEDS_ATTENTION: 'NEEDS_ATTENTION'
};

// ============================================================================
// In-Memory Fallback Store (Cho môi trường Node.js test runner)
// ============================================================================
class MemoryStore {
  constructor() {
    this.stores = {
      [STORES.SNAPSHOT]: new Map(),
      [STORES.PENDING_OPS]: new Map(),
      [STORES.SYNC_META]: new Map()
    };
  }

  clear() {
    for (const key of Object.keys(this.stores)) {
      this.stores[key].clear();
    }
  }
}

const memoryFallback = new MemoryStore();

function isIDBAvailable() {
  return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

// ============================================================================
// Database Connection & Schema Initialization
// ============================================================================
let dbPromise = null;

export function openDatabase() {
  if (!isIDBAvailable()) {
    return Promise.resolve(null);
  }

  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      // 1. trip_snapshot store
      if (!db.objectStoreNames.contains(STORES.SNAPSHOT)) {
        db.createObjectStore(STORES.SNAPSHOT, { keyPath: 'tripId' });
      }

      // 2. pending_ops store
      if (!db.objectStoreNames.contains(STORES.PENDING_OPS)) {
        const opStore = db.createObjectStore(STORES.PENDING_OPS, { keyPath: 'opId' });
        opStore.createIndex('timestamp', 'timestamp', { unique: false });
        opStore.createIndex('status', 'status', { unique: false });
      }

      // 3. sync_meta store
      if (!db.objectStoreNames.contains(STORES.SYNC_META)) {
        db.createObjectStore(STORES.SYNC_META, { keyPath: 'key' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = null;
      reject(request.error);
    };
  });

  return dbPromise;
}

// ============================================================================
// Snapshot Store CRUD
// ============================================================================
export async function getSnapshot(tripId = 'default_trip') {
  if (!isIDBAvailable()) {
    return memoryFallback.stores[STORES.SNAPSHOT].get(tripId) || null;
  }
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.SNAPSHOT, 'readonly');
    const store = tx.objectStore(STORES.SNAPSHOT);
    const req = store.get(tripId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function saveSnapshot(snapshot) {
  if (!snapshot || !snapshot.tripId) {
    throw new TypeError('Snapshot must have tripId');
  }
  if (!isIDBAvailable()) {
    memoryFallback.stores[STORES.SNAPSHOT].set(snapshot.tripId, JSON.parse(JSON.stringify(snapshot)));
    return snapshot;
  }
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.SNAPSHOT, 'readwrite');
    const store = tx.objectStore(STORES.SNAPSHOT);
    const req = store.put(snapshot);
    req.onsuccess = () => resolve(snapshot);
    req.onerror = () => reject(req.error);
  });
}

// ============================================================================
// Pending Ops Store CRUD (FIFO Outbox)
// ============================================================================
export async function enqueueOp(op) {
  if (!op || !op.opId || !op.type) {
    throw new TypeError('Operation must have opId and type');
  }
  const item = {
    ...op,
    timestamp: op.timestamp || new Date().toISOString(),
    status: op.status || OP_STATUS.PENDING
  };

  if (!isIDBAvailable()) {
    memoryFallback.stores[STORES.PENDING_OPS].set(item.opId, JSON.parse(JSON.stringify(item)));
    return item;
  }
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.PENDING_OPS, 'readwrite');
    const store = tx.objectStore(STORES.PENDING_OPS);
    const req = store.put(item);
    req.onsuccess = () => resolve(item);
    req.onerror = () => reject(req.error);
  });
}

export async function getOp(opId) {
  if (!isIDBAvailable()) {
    return memoryFallback.stores[STORES.PENDING_OPS].get(opId) || null;
  }
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.PENDING_OPS, 'readonly');
    const store = tx.objectStore(STORES.PENDING_OPS);
    const req = store.get(opId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function updateOp(op) {
  if (!op || !op.opId) throw new TypeError('op must have opId');
  if (!isIDBAvailable()) {
    memoryFallback.stores[STORES.PENDING_OPS].set(op.opId, JSON.parse(JSON.stringify(op)));
    return op;
  }
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.PENDING_OPS, 'readwrite');
    const store = tx.objectStore(STORES.PENDING_OPS);
    const req = store.put(op);
    req.onsuccess = () => resolve(op);
    req.onerror = () => reject(req.error);
  });
}

export async function removeOp(opId) {
  if (!isIDBAvailable()) {
    return memoryFallback.stores[STORES.PENDING_OPS].delete(opId);
  }
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.PENDING_OPS, 'readwrite');
    const store = tx.objectStore(STORES.PENDING_OPS);
    const req = store.delete(opId);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

export async function getAllPendingOps() {
  if (!isIDBAvailable()) {
    const all = Array.from(memoryFallback.stores[STORES.PENDING_OPS].values());
    return all.sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
  }
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.PENDING_OPS, 'readonly');
    const store = tx.objectStore(STORES.PENDING_OPS);
    const req = store.getAll();
    req.onsuccess = () => {
      const items = req.result || [];
      // Sắp xếp tăng dần theo timestamp để đảm bảo thứ tự thời gian FIFO
      items.sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
      resolve(items);
    };
    req.onerror = () => reject(req.error);
  });
}

// ============================================================================
// Sync Meta Store CRUD
// ============================================================================
export async function getMeta(key) {
  if (!isIDBAvailable()) {
    const entry = memoryFallback.stores[STORES.SYNC_META].get(key);
    return entry ? entry.value : null;
  }
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.SYNC_META, 'readonly');
    const store = tx.objectStore(STORES.SYNC_META);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result ? req.result.value : null);
    req.onerror = () => reject(req.error);
  });
}

export async function setMeta(key, value) {
  const item = { key, value, updatedAt: new Date().toISOString() };
  if (!isIDBAvailable()) {
    memoryFallback.stores[STORES.SYNC_META].set(key, item);
    return value;
  }
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.SYNC_META, 'readwrite');
    const store = tx.objectStore(STORES.SYNC_META);
    const req = store.put(item);
    req.onsuccess = () => resolve(value);
    req.onerror = () => reject(req.error);
  });
}

// ============================================================================
// Safe Boot Recovery
// Tự động khôi phục các ops bị kẹt ở trạng thái PROCESSING về lại PENDING khi khởi động
// ============================================================================
export async function recoverStuckProcessingOps() {
  const ops = await getAllPendingOps();
  let recoveredCount = 0;
  for (const op of ops) {
    if (op.status === OP_STATUS.PROCESSING) {
      op.status = OP_STATUS.PENDING;
      await updateOp(op);
      recoveredCount++;
    }
  }
  return recoveredCount;
}

// Hàm reset phục vụ unit tests
export function _resetMemoryStoreForTesting() {
  memoryFallback.clear();
}
