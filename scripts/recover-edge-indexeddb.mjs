import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright";

const recoveryRoot = path.resolve(process.argv[2] || "recovery/edge-localhost-4173-2026-08-11");
const sourceLevelDb = path.join(recoveryRoot, "leveldb");
const sourceBlob = path.join(recoveryRoot, "blob");
const sourceLocalStorage = path.join(recoveryRoot, "local-storage-leveldb");
const probeProfile = path.join(recoveryRoot, `probe-profile-${Date.now()}`);
const indexedDbRoot = path.join(probeProfile, "Default", "IndexedDB");
const targetLevelDb = path.join(indexedDbRoot, "http_localhost_4173.indexeddb.leveldb");
const targetBlob = path.join(indexedDbRoot, "http_localhost_4173.indexeddb.blob");
const targetLocalStorage = path.join(probeProfile, "Default", "Local Storage", "leveldb");
const outputPath = path.join(recoveryRoot, "edge-indexeddb-dump.json");

if (!fs.existsSync(sourceLevelDb)) throw new Error(`Missing LevelDB rescue copy: ${sourceLevelDb}`);
fs.mkdirSync(indexedDbRoot, { recursive: true });
fs.cpSync(sourceLevelDb, targetLevelDb, { recursive: true });
if (fs.existsSync(sourceBlob)) fs.cpSync(sourceBlob, targetBlob, { recursive: true });
if (fs.existsSync(sourceLocalStorage)) fs.cpSync(sourceLocalStorage, targetLocalStorage, { recursive: true });

const server = http.createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  response.end("<!doctype html><meta charset=utf-8><title>EasyNote recovery probe</title>");
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(4173, resolve);
});

let context;
try {
  context = await chromium.launchPersistentContext(probeProfile, { headless: true });
  const page = context.pages()[0] || await context.newPage();
  await page.goto("http://localhost:4173/", { waitUntil: "domcontentloaded" });
  const dump = await page.evaluate(async () => {
    const listed = typeof indexedDB.databases === "function" ? await indexedDB.databases() : [];
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("easynote-db");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Unable to open easynote-db"));
    });

    const serialize = async (value) => {
      if (value instanceof Blob) {
        const bytes = new Uint8Array(await value.arrayBuffer());
        let binary = "";
        for (let index = 0; index < bytes.length; index += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
        }
        return { __easynoteBlob: true, type: value.type, size: value.size, base64: btoa(binary) };
      }
      if (Array.isArray(value)) return Promise.all(value.map(serialize));
      if (value && typeof value === "object") {
        const result = {};
        for (const [key, child] of Object.entries(value)) result[key] = await serialize(child);
        return result;
      }
      return value;
    };

    const stores = {};
    for (const storeName of Array.from(db.objectStoreNames)) {
      const records = await new Promise((resolve, reject) => {
        const request = db.transaction(storeName, "readonly").objectStore(storeName).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error(`Unable to read ${storeName}`));
      });
      stores[storeName] = await serialize(records);
    }
    const localStorageValues = Object.fromEntries(Array.from({ length: localStorage.length }, (_, index) => {
      const key = localStorage.key(index);
      return [key, localStorage.getItem(key)];
    }));
    const result = { origin: location.origin, databases: listed, version: db.version, localStorage: localStorageValues, stores };
    db.close();
    return result;
  });
  fs.writeFileSync(outputPath, JSON.stringify(dump, null, 2));
  const counts = Object.fromEntries(Object.entries(dump.stores).map(([name, records]) => [name, records.length]));
  const localStorage = Object.fromEntries(Object.entries(dump.localStorage).map(([key, value]) => [key, String(value).length]));
  console.log(JSON.stringify({ outputPath, version: dump.version, localStorage, counts }, null, 2));
} finally {
  if (context) await context.close();
  await new Promise((resolve) => server.close(resolve));
}
