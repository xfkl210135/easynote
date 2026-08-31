import { spawn } from "node:child_process";
import path from "node:path";
import { chromium } from "playwright";

const inputPath = path.resolve(process.argv[2]);
const preview = spawn(process.execPath, [path.resolve("node_modules/vite/bin/vite.js"), "preview", "--host", "127.0.0.1", "--port", "4174", "--strictPort"], {
  cwd: process.cwd(),
  stdio: ["ignore", "pipe", "pipe"],
});

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch("http://127.0.0.1:4174/");
      if (response.ok) return;
    } catch { /* preview is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Vite preview did not start");
}

let browser;
try {
  await waitForServer();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const browserErrors = [];
  const idbTrace = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
    if (message.text().startsWith("IDBTRACE")) idbTrace.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.addInitScript(() => {
    for (const method of ["put", "delete", "clear"]) {
      const original = IDBObjectStore.prototype[method];
      IDBObjectStore.prototype[method] = function (...args) {
        if (this.name === "attachments") console.log("IDBTRACE", method, this.name, args[0]?.id || args[0] || "");
        return original.apply(this, args);
      };
    }
  });
  await page.goto("http://127.0.0.1:4174/#/notes", { waitUntil: "domcontentloaded" });
  await page.locator("#importFile").setInputFiles(inputPath);
  await page.locator("#dialogBackdrop:not([hidden])").waitFor({ state: "visible" });
  const promptText = await page.locator("#dialogMessage").innerText();
  await page.locator("#dialogConfirm").click();
  await page.waitForTimeout(2500);
  const result = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("easynote-db");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const notes = await new Promise((resolve, reject) => {
      const request = db.transaction("notes", "readonly").objectStore("notes").getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const attachments = await new Promise((resolve, reject) => {
      const request = db.transaction("attachments", "readonly").objectStore("attachments").getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return {
      noteCount: notes.length,
      attachmentCount: attachments.length,
      attachmentRefs: notes.reduce((sum, note) => sum + (String(note.content || "").match(/data-attachment-id=/g)?.length || 0), 0),
      inlineImages: notes.reduce((sum, note) => sum + (String(note.content || "").match(/src=["']data:image\//g)?.length || 0), 0),
      maxContentLength: Math.max(0, ...notes.map((note) => String(note.content || "").length)),
      toast: document.querySelector("#toast")?.textContent || "",
      saveStatus: document.querySelector("#saveIndicator")?.textContent || "",
    };
  });
  console.log(JSON.stringify({ promptText, ...result, idbTrace, browserErrors }, null, 2));
} finally {
  if (browser) await browser.close();
  preview.kill();
}
