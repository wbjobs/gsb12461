/*
 * IndexedDB 持久化层：消息历史 + 元数据。
 * 无框架，全部基于原生 IndexedDB API 的 Promise 封装。
 */
(function (global) {
  'use strict';

  const DB_NAME = 'ws-debugger';
  const DB_VERSION = 1;
  const STORE_MSG = 'messages';
  const STORE_META = 'meta';
  const MESSAGE_CAP = 5000; // 最多保留 5000 条，超出后删除最旧记录

  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_MSG)) {
          const store = db.createObjectStore(STORE_MSG, { keyPath: 'id', autoIncrement: true });
          store.createIndex('ts', 'ts');
          store.createIndex('sessionId', 'sessionId');
          store.createIndex('dir', 'dir');
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('IndexedDB 被其它标签页阻塞'));
    });
    return dbPromise;
  }

  function tx(storeName, mode) {
    return openDB().then((db) => {
      const transaction = db.transaction(storeName, mode);
      return { transaction, store: transaction.objectStore(storeName) };
    });
  }

  function wrapRequest(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  const DB = {
    isAvailable() {
      return typeof indexedDB !== 'undefined';
    },

    /**
     * 保存一条消息。msg 结构：
     * { ts, dir: 'send'|'recv'|'event', seq, clientSeq, sessionId,
     *   kind: 'data'|'event', text, flags: {outOfOrder,duplicate,compensated,gap}, note }
     */
    async putMessage(msg) {
      const { transaction, store } = await tx(STORE_MSG, 'readwrite');
      const id = await wrapRequest(store.add(msg));
      const count = await wrapRequest(store.count());
      if (count > MESSAGE_CAP) {
        const excess = count - MESSAGE_CAP;
        const cursorReq = store.index('ts').openCursor();
        let deleted = 0;
        await new Promise((resolve, reject) => {
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (cursor && deleted < excess) {
              cursor.delete();
              deleted += 1;
              cursor.continue();
            } else {
              resolve();
            }
          };
          cursorReq.onerror = () => reject(cursorReq.error);
        });
      }
      return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve(Object.assign({ id }, msg));
        transaction.onerror = () => reject(transaction.error);
      });
    },

    /** 读取最近 limit 条（按时间升序返回） */
    async getRecent(limit = 1000) {
      const { store } = await tx(STORE_MSG, 'readonly');
      const all = await wrapRequest(store.getAll());
      return all.sort((a, b) => a.id - b.id).slice(-limit);
    },

    async clearMessages() {
      const { transaction, store } = await tx(STORE_MSG, 'readwrite');
      await wrapRequest(store.clear());
      return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
    },

    async getMeta(key, fallback = null) {
      const { store } = await tx(STORE_META, 'readonly');
      const value = await wrapRequest(store.get(key));
      return value === undefined ? fallback : value;
    },

    async setMeta(key, value) {
      const { transaction, store } = await tx(STORE_META, 'readwrite');
      await wrapRequest(store.put(value, key));
      return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
    },
  };

  global.DB = DB;
})(window);
