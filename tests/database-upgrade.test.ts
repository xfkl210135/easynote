import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EasyNoteDataSafety } from "../src/legacy/data-safety";

const DB_NAME = "easynote-db";

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () => reject(transaction.error);
  });
}

function deleteDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("测试数据库仍被占用"));
  });
}

async function createVersion7(withRecovery = true): Promise<void> {
  const request = indexedDB.open(DB_NAME, 7);
  request.onupgradeneeded = () => {
    const db = request.result;
    const notes = db.createObjectStore("notes", { keyPath: "id" });
    notes.put({ id: "note-before-v8", title: "升级前笔记", content: "<p>保留内容</p>" });
    if (withRecovery) {
      db.createObjectStore("recovery", { keyPath: "id" });
      db.createObjectStore("meta", { keyPath: "key" });
    }
  };
  const db = await requestValue(request);
  db.close();
}

describe.sequential("IndexedDB 7 to 8 migration", () => {
  beforeEach(deleteDatabase);
  afterEach(deleteDatabase);

  it("creates a recovery snapshot before adding productivity stores", async () => {
    await createVersion7();
    const safety = new EasyNoteDataSafety();
    const db = await safety.open() as IDBDatabase;

    expect(db.version).toBe(8);
    expect([...db.objectStoreNames]).toEqual(expect.arrayContaining(["focusSessions", "reviews", "goals", "milestones"]));

    const transaction = db.transaction(["recovery", "meta"], "readonly");
    const done = transactionDone(transaction);
    const recoveries = await requestValue(transaction.objectStore("recovery").getAll());
    const prepared = await requestValue(transaction.objectStore("meta").get("databaseV8MigrationPrepared"));
    const completed = await requestValue(transaction.objectStore("meta").get("databaseV8Migration"));
    await done;

    expect(recoveries).toHaveLength(1);
    expect(recoveries[0].payload.notes[0].id).toBe("note-before-v8");
    expect(prepared).toMatchObject({ state: "prepared", fromVersion: 7 });
    expect(completed).toMatchObject({ state: "verified", fromVersion: 7, recoveryPrepared: true });
    db.close();
  });

  it("stops the upgrade when the old database cannot hold a recovery record", async () => {
    await createVersion7(false);
    const safety = new EasyNoteDataSafety();
    await expect(safety.open()).rejects.toThrow("缺少恢复仓库");

    const db = await requestValue(indexedDB.open(DB_NAME));
    expect(db.version).toBe(7);
    expect(db.objectStoreNames.contains("focusSessions")).toBe(false);
    db.close();
  });
});
