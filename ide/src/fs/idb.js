const DB_NAME = "lumen";
const DB_VERSION = 1;
const STORES = ["kv", "files", "chats", "skills"];

function memoryStore() {
  const tables = Object.fromEntries(STORES.map((name) => [name, new Map()]));
  return {
    async get(store, key) {
      return tables[store].get(key);
    },
    async put(store, value, key) {
      tables[store].set(key, value);
    },
    async delete(store, key) {
      tables[store].delete(key);
    },
    async all(store) {
      return [...tables[store].values()];
    },
    async clear(store) {
      tables[store].clear();
    },
    kind: "memory",
  };
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function createStore() {
  if (!globalThis.indexedDB) return memoryStore();
  try {
    const db = await openDb();
    const requestStore = (store, mode, fn) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const request = fn(tx.objectStore(store));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    return {
      kind: "idb",
      get: (store, key) => requestStore(store, "readonly", (objectStore) => objectStore.get(key)),
      put: (store, value, key) => requestStore(store, "readwrite", (objectStore) => objectStore.put(value, key)),
      delete: (store, key) => requestStore(store, "readwrite", (objectStore) => objectStore.delete(key)),
      all: async (store) => (await requestStore(store, "readonly", (objectStore) => objectStore.getAll())) || [],
      clear: (store) => requestStore(store, "readwrite", (objectStore) => objectStore.clear()),
    };
  } catch {
    return memoryStore();
  }
}
