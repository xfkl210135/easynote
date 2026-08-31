import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

test("restores verified local backup instead of seeding an empty database", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "critical recovery flow runs once");
  const backupPath = path.resolve("recovery/EasyNote-Recovery-2026-08-15-231636.json");
  const backup = await readFile(backupPath);
  await page.route("**/__easynote/recovery-candidate", (route) => route.fulfill({ status: 200, contentType: "application/json; charset=utf-8", body: backup }));
  await page.route("**/__easynote/automatic-backup", (route) => route.fulfill({ status: 200, contentType: "application/json; charset=utf-8", body: JSON.stringify({ ok: true, createdAt: new Date().toISOString(), checksum: "test-recovery", name: "test-recovery.json" }) }));

  await page.goto("/#/notes");
  await expect(page.locator("#workspace")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#allCount")).toHaveText("25");
  const counts = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("easynote-db");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const count = (storeName: string) => new Promise<number>((resolve, reject) => {
      const request = db.transaction(storeName, "readonly").objectStore(storeName).count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const result = { notes: await count("notes"), attachments: await count("attachments") };
    db.close();
    return result;
  });
  expect(counts).toEqual({ notes: 41, attachments: 39 });
});

test("replaces an untouched seed database with the verified local backup", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "critical recovery flow runs once");
  const backupPath = path.resolve("recovery/EasyNote-Recovery-2026-08-15-231636.json");
  const backup = await readFile(backupPath);
  await page.route("**/__easynote/recovery-candidate", (route) => route.fulfill({ status: 404 }));
  await page.route("**/__easynote/automatic-backup", (route) => route.fulfill({ status: 200, contentType: "application/json; charset=utf-8", body: JSON.stringify({ ok: true, createdAt: new Date().toISOString(), checksum: "test-recovery", name: "test-recovery.json" }) }));

  await page.goto("/#/notes");
  await expect(page.locator("#workspace")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#allCount")).toHaveText("3");
  await page.unroute("**/__easynote/recovery-candidate");
  await page.route("**/__easynote/recovery-candidate", (route) => route.fulfill({ status: 200, contentType: "application/json; charset=utf-8", body: backup }));
  await page.reload();
  await expect(page.locator("#allCount")).toHaveText("25", { timeout: 30_000 });
  const notes = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("easynote-db");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const request = db.transaction("notes", "readonly").objectStore("notes").getAll();
    const result = await new Promise<unknown[]>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return result.length;
  });
  expect(notes).toBe(41);
});
