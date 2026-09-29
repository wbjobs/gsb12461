// IndexedDB 消息历史存储
class MessageStore {
  constructor(dbName = 'ws-debugger', storeName = 'messages') {
    this.dbName = dbName;
    this.storeName = storeName;
    this.db = null;
  }
  open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          const os = db.createObjectStore(this.storeName, { keyPath: 'id', autoIncrement: true });
          os.createIndex('ts', 'ts');
        }
      };
      req.onsuccess = () => { this.db = req.result; resolve(); };
      req.onerror = () => reject(req.error);
    });
  }
  _tx(mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.storeName, mode);
      const result = fn(tx.objectStore(this.storeName));
      tx.oncomplete = () => resolve(result && result._value);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  add(record) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.storeName, 'readwrite');
      const req = tx.objectStore(this.storeName).add(record);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  updateTags(id, tags) {
    return this._tx('readwrite', (os) => {
      const get = os.get(id);
      get.onsuccess = () => {
        const rec = get.result;
        if (rec) { rec.tags = tags; os.put(rec); }
      };
    });
  }
  getAll() {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.storeName, 'readonly');
      const req = tx.objectStore(this.storeName).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }
  clear() { return this._tx('readwrite', (os) => os.clear()); }
  close() { if (this.db) { this.db.close(); this.db = null; } }
}
