// =====================================================================
// 저장 대기열 (기기 안 IndexedDB)
// 전표는 먼저 여기에 넣고 서버로 보냅니다. 오프라인이면 남아 있다가 연결되면 자동 전송됩니다.
// 항목: { id, ledgerId, payload, createdAt, status: 'pending'|'failed', error }
// IndexedDB를 쓸 수 없는 환경(일부 사생활 보호 모드)에서는 메모리에만 보관합니다.
// =====================================================================

const DB_NAME = 'de-housekeeping';
const STORE = 'outbox';
let dbPromise = null;
const memory = new Map();   // IndexedDB를 못 쓸 때 대체

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return dbPromise;
}

async function tx(mode, fn) {
  const db = await openDb();
  if (!db) return fn(null);
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    Promise.resolve(fn(store)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const req2promise = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

/** 대기열에 넣기 (같은 id면 덮어씀) */
export async function put(item) {
  return tx('readwrite', (store) => (store ? req2promise(store.put(item)) : memory.set(item.id, item)));
}

/** 대기열에서 빼기 */
export async function remove(id) {
  return tx('readwrite', (store) => (store ? req2promise(store.delete(id)) : memory.delete(id)));
}

/** 전체 목록 (오래된 순) */
export async function list() {
  const items = await tx('readonly', (store) => (store ? req2promise(store.getAll()) : [...memory.values()]));
  return (items ?? []).sort((a, b) => a.createdAt - b.createdAt);
}

/** 기기에 영구 저장되는지 (false면 앱을 닫으면 대기 중 전표가 사라질 수 있음) */
export async function isPersistent() {
  return (await openDb()) !== null;
}
