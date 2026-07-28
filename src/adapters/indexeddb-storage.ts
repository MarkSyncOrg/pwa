import type { StorageArea } from '@marksyncorg/core';

// IndexedDB-backed StorageArea: the PWA's durable key/value store for all sync
// state (sync info, last-updated, cached tree, settings) and the local bookmark
// tree. A thin wrapper over a single object store — no ORM, no schema migrations.

const DB_NAME = 'marksync';
const STORE = 'kv';
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export class IndexedDbStorageArea implements StorageArea {
  private dbPromise: Promise<IDBDatabase> | undefined;

  private db(): Promise<IDBDatabase> {
    return (this.dbPromise ??= openDb());
  }

  private async run<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest): Promise<T> {
    const db = await this.db();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = op(tx.objectStore(STORE));
      request.onsuccess = () => resolve(request.result as T);
      request.onerror = () => reject(request.error);
    });
  }

  async get<T>(key: string): Promise<T | undefined> {
    const value = await this.run<T | undefined>('readonly', (store) => store.get(key));
    return value ?? undefined;
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.run('readwrite', (store) => store.put(value, key));
  }

  async remove(key: string): Promise<void> {
    await this.run('readwrite', (store) => store.delete(key));
  }
}
