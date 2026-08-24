// @ts-nocheck -- compatibility module; typed boundaries live in services/data-repository.ts.
"use strict";

  const DB_NAME = "easynote-db";
  const DB_VERSION = 8;
  const RESCUE_DB_NAME = "easynote-rescue-db";
  const RESCUE_DB_VERSION = 1;
  const RESCUE_STORE = "snapshots";
  const RESCUE_ARCHIVE_LIMIT = 12;
  const RESCUE_ARCHIVE_INTERVAL = 10 * 60 * 1000;
  const LOCAL_AUTOMATIC_BACKUP_ENDPOINT = "/__easynote/automatic-backup";
  const LOCAL_RECOVERY_CANDIDATE_ENDPOINT = "/__easynote/recovery-candidate";
  const DAY = 86400000;
  const HISTORY_LIMIT = 50;
  const HISTORY_AGE = 30 * DAY;
  const BACKUP_INTERVAL = 10 * 60 * 1000;
  const STORES = {
    legacy: "app-state", notes: "notes", folders: "folders", files: "fileEntries",
    attachments: "attachments", history: "history", recovery: "recovery",
    operations: "operations", meta: "meta", settings: "settings",
    tasks: "tasks", taskFields: "taskFields", taskViews: "taskViews", taskHistory: "taskHistory",
    scheduleEntries: "scheduleEntries", scheduleSeries: "scheduleSeries", scheduleOccurrenceStates: "scheduleOccurrenceStates", scheduleDailyNotes: "scheduleDailyNotes", whiteboards: "whiteboards",
    focusSessions: "focusSessions", reviews: "reviews", goals: "goals", milestones: "milestones"
  };
  const scheduleTimeSlots = (item) => {
    if (item?.allDay !== false) return [];
    const source = Array.isArray(item?.timeSlots) ? item.timeSlots : [];
    const slots = source.map((slot) => ({ startTime: String(slot?.startTime || ""), endTime: String(slot?.endTime || "") }))
      .filter((slot) => /^\d{2}:\d{2}$/.test(slot.startTime))
      .filter((slot) => !slot.endTime || /^\d{2}:\d{2}$/.test(slot.endTime))
      .filter((slot) => !slot.endTime || slot.endTime > slot.startTime);
    return slots.length ? slots : (item?.startTime ? [{ startTime: item.startTime, endTime: item.endTime || "" }] : []);
  };

  const makeId = (prefix = "id") => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  const isoNow = () => new Date().toISOString();
  const requestResult = (request) => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
  });
  const transactionDone = (transaction) => new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted"));
  });

  function openRescueDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(RESCUE_DB_NAME, RESCUE_DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(RESCUE_STORE)) db.createObjectStore(RESCUE_STORE, { keyPath: "id" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Unable to open the EasyNote rescue database"));
    });
  }

  async function rescueGet(key) {
    const db = await openRescueDatabase();
    try { return await requestResult(db.transaction(RESCUE_STORE, "readonly").objectStore(RESCUE_STORE).get(key)); }
    finally { db.close(); }
  }

  function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (value && typeof value === "object" && !(value instanceof Blob)) {
      return Object.keys(value).sort().reduce((result, key) => {
        if (value[key] !== undefined) result[key] = stableValue(value[key]);
        return result;
      }, {});
    }
    return value;
  }

  function stableStringify(value) { return JSON.stringify(stableValue(value)); }

  async function sha256(value) {
    let buffer;
    if (value instanceof Blob) {
      buffer = typeof value.arrayBuffer === "function" ? await value.arrayBuffer() : await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error("附件读取失败"));
        reader.readAsArrayBuffer(value);
      });
    }
    else if (value instanceof ArrayBuffer) buffer = value;
    else buffer = new TextEncoder().encode(String(value));
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function dataUrlToBlob(dataUrl) {
    const [header, payload = ""] = String(dataUrl).split(",", 2);
    const mime = header.match(/^data:([^;,]+)/)?.[1] || "application/octet-stream";
    const binary = header.includes(";base64") ? atob(payload) : decodeURIComponent(payload);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type: mime });
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error || new Error("附件读取失败"));
      reader.readAsDataURL(blob);
    });
  }

  function mimeExtension(mime = "") {
    return ({
      "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
      "application/pdf": "pdf", "text/plain": "txt", "application/json": "json"
    })[mime] || "bin";
  }

  class EasyNoteDataSafety {
    constructor(options = {}) {
      this.options = options;
      this.db = null;
      this.attachmentRecords = new Map();
      this.attachmentUrls = new Map();
      this.pendingSnapshot = null;
      this.pendingReason = "auto";
      this.pendingWaiters = [];
      this.saveTimer = null;
      this.saving = false;
      this.lastError = null;
      this.lastStatus = "saved";
      this.autoBackupTimer = null;
      this.localBackupTimer = null;
      this.localBackupPromise = null;
      this.pendingLocalBackupSnapshot = null;
      this.lastProtectionError = null;
      this.lastRescueSnapshotAt = null;
      this.lastLocalBackup = null;
      this.restoredFromRescue = false;
      this.restoredFromFailedSave = false;
      this.integrityReport = null;
      this.backupDirectoryHandle = null;
      this.wasEmpty = false;
      this.versionUpgradeChecked = false;
      this.versionUpgradeFailure = null;
      this.migrationPrepared = false;
      this.migrationFromVersion = null;
      this.instanceId = makeId("tab");
      this.baselines = new Map();
      this.baselineFingerprints = new Map();
      this.syncChannel = typeof BroadcastChannel === "function" ? new BroadcastChannel("easynote-sync-v1") : null;
      if (this.syncChannel) this.syncChannel.onmessage = (event) => {
        const detail = event.data || {};
        if (detail.source === this.instanceId || detail.type !== "commit") return;
        window.dispatchEvent(new CustomEvent("easynote:external-commit", { detail }));
      };
    }

    captureBaseline(storeName, records) {
      this.baselines.set(storeName, new Map((records || []).map((record) => [record.id, record.checksum || ""])));
      this.baselineFingerprints.set(storeName, new Map((records || []).map((record) => [record.id, this.recordFingerprint(record)])));
    }

    baselineChecksum(storeName, id) { return this.baselines.get(storeName)?.get(id) || ""; }
    baselineFingerprint(storeName, id) { return this.baselineFingerprints.get(storeName)?.get(id) || ""; }
    baselineHas(storeName, id) { return this.baselines.get(storeName)?.has(id) || false; }
    recordFingerprint(record) {
      if (!record || typeof record !== "object") return "";
      const { checksum, revision, ...payload } = record;
      return stableStringify(payload);
    }
    updateBaseline(storeName, record) {
      if (!this.baselines.has(storeName)) this.baselines.set(storeName, new Map());
      if (!this.baselineFingerprints.has(storeName)) this.baselineFingerprints.set(storeName, new Map());
      this.baselines.get(storeName).set(record.id, record.checksum || "");
      this.baselineFingerprints.get(storeName).set(record.id, this.recordFingerprint(record));
    }
    removeBaseline(storeName, id) {
      this.baselines.get(storeName)?.delete(id);
      this.baselineFingerprints.get(storeName)?.delete(id);
    }

    captureStateBaselines(state) {
      for (const [storeName, records] of [[STORES.notes, state?.notes], [STORES.folders, state?.categories], [STORES.files, state?.files], [STORES.tasks, state?.tasks], [STORES.taskFields, state?.taskFields], [STORES.taskViews, state?.taskViews], [STORES.scheduleEntries, state?.scheduleEntries], [STORES.scheduleSeries, state?.scheduleSeries], [STORES.scheduleOccurrenceStates, state?.scheduleOccurrenceStates], [STORES.scheduleDailyNotes, state?.scheduleDailyNotes], [STORES.whiteboards, state?.whiteboards], [STORES.focusSessions, state?.focusSessions], [STORES.reviews, state?.reviews], [STORES.goals, state?.goals], [STORES.milestones, state?.milestones]]) this.captureBaseline(storeName, records || []);
    }

    broadcastCommit(result) {
      this.syncChannel?.postMessage({ type: "commit", source: this.instanceId, ...result });
    }

    emitStatus(status, detail = {}) {
      this.lastStatus = status;
      this.options.onStatus?.(status, detail);
      window.dispatchEvent(new CustomEvent("easynote:save-status", { detail: { status, ...detail } }));
    }

    emitSafety(detail = {}) {
      this.options.onSafety?.(detail);
      window.dispatchEvent(new CustomEvent("easynote:safety", { detail }));
    }

    async open() {
      if (this.db) return this.db;
      await this.prepareVersionUpgrade();
      this.db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORES.legacy)) db.createObjectStore(STORES.legacy);
          if (!db.objectStoreNames.contains(STORES.notes)) db.createObjectStore(STORES.notes, { keyPath: "id" });
          if (!db.objectStoreNames.contains(STORES.folders)) db.createObjectStore(STORES.folders, { keyPath: "id" });
          if (!db.objectStoreNames.contains(STORES.files)) db.createObjectStore(STORES.files, { keyPath: "id" });
          if (!db.objectStoreNames.contains(STORES.attachments)) {
            const store = db.createObjectStore(STORES.attachments, { keyPath: "id" });
            store.createIndex("sha256", "sha256", { unique: false });
          }
          if (!db.objectStoreNames.contains(STORES.history)) {
            const store = db.createObjectStore(STORES.history, { keyPath: "id" });
            store.createIndex("noteId", "noteId", { unique: false });
            store.createIndex("createdAt", "createdAt", { unique: false });
          }
          if (!db.objectStoreNames.contains(STORES.recovery)) {
            const store = db.createObjectStore(STORES.recovery, { keyPath: "id" });
            store.createIndex("expiresAt", "expiresAt", { unique: false });
          }
          if (!db.objectStoreNames.contains(STORES.operations)) db.createObjectStore(STORES.operations, { keyPath: "id" });
          if (!db.objectStoreNames.contains(STORES.meta)) db.createObjectStore(STORES.meta, { keyPath: "key" });
          if (!db.objectStoreNames.contains(STORES.settings)) db.createObjectStore(STORES.settings, { keyPath: "key" });
          if (!db.objectStoreNames.contains(STORES.tasks)) db.createObjectStore(STORES.tasks, { keyPath: "id" });
          if (!db.objectStoreNames.contains(STORES.taskFields)) db.createObjectStore(STORES.taskFields, { keyPath: "id" });
          if (!db.objectStoreNames.contains(STORES.taskViews)) db.createObjectStore(STORES.taskViews, { keyPath: "id" });
          if (!db.objectStoreNames.contains(STORES.scheduleEntries)) db.createObjectStore(STORES.scheduleEntries, { keyPath: "id" });
          if (!db.objectStoreNames.contains(STORES.scheduleSeries)) db.createObjectStore(STORES.scheduleSeries, { keyPath: "id" });
          if (!db.objectStoreNames.contains(STORES.scheduleOccurrenceStates)) db.createObjectStore(STORES.scheduleOccurrenceStates, { keyPath: "id" });
          if (!db.objectStoreNames.contains(STORES.scheduleDailyNotes)) db.createObjectStore(STORES.scheduleDailyNotes, { keyPath: "id" });
          if (!db.objectStoreNames.contains(STORES.whiteboards)) db.createObjectStore(STORES.whiteboards, { keyPath: "id" });
          if (!db.objectStoreNames.contains(STORES.focusSessions)) {
            const store = db.createObjectStore(STORES.focusSessions, { keyPath: "id" });
            store.createIndex("status", "status", { unique: false });
            store.createIndex("startedAt", "startedAt", { unique: false });
            store.createIndex("taskId", "taskId", { unique: false });
          }
          if (!db.objectStoreNames.contains(STORES.reviews)) {
            const store = db.createObjectStore(STORES.reviews, { keyPath: "id" });
            store.createIndex("periodType", "periodType", { unique: false });
            store.createIndex("periodStart", "periodStart", { unique: false });
          }
          if (!db.objectStoreNames.contains(STORES.goals)) db.createObjectStore(STORES.goals, { keyPath: "id" });
          if (!db.objectStoreNames.contains(STORES.milestones)) {
            const store = db.createObjectStore(STORES.milestones, { keyPath: "id" });
            store.createIndex("goalId", "goalId", { unique: false });
            store.createIndex("dueDate", "dueDate", { unique: false });
          }
          if (!db.objectStoreNames.contains(STORES.taskHistory)) {
            const store = db.createObjectStore(STORES.taskHistory, { keyPath: "id" });
            store.createIndex("entityId", "entityId", { unique: false });
            store.createIndex("createdAt", "createdAt", { unique: false });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("无法打开 IndexedDB"));
        request.onblocked = () => this.emitSafety({ warning: "数据库升级被其他 EasyNote 页面阻塞，请关闭其他页面后重试。" });
      });
      this.db.onversionchange = () => { this.db.close(); this.emitSafety({ warning: "数据结构已更新，请刷新页面。" }); };
      if (this.migrationPrepared) {
        try {
          const transaction = this.db.transaction(STORES.meta, "readwrite");
          transaction.objectStore(STORES.meta).put({ key: "databaseV8Migration", state: "verified", fromVersion: this.migrationFromVersion, completedAt: isoNow(), recoveryPrepared: true });
          await transactionDone(transaction);
        } catch (error) {
          this.db.close(); this.db = null; this.versionUpgradeFailure = error;
          throw new Error(`数据库升级完成标记写入失败：${error?.message || error}`);
        }
      }
      return this.db;
    }

    async prepareVersionUpgrade() {
      if (this.versionUpgradeFailure) throw this.versionUpgradeFailure;
      if (this.versionUpgradeChecked) return;
      const existing = await new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("无法检查旧数据库"));
        request.onupgradeneeded = () => { /* A new database has no data to preserve. */ };
      });
      try {
        if (existing.version >= DB_VERSION || existing.objectStoreNames.length === 0) { this.versionUpgradeChecked = true; return; }
        if (!existing.objectStoreNames.contains(STORES.recovery) || !existing.objectStoreNames.contains(STORES.meta)) throw new Error("旧数据库缺少恢复仓库，已停止升级以避免覆盖原数据");
        const names = [STORES.notes, STORES.folders, STORES.files, STORES.tasks, STORES.taskFields, STORES.taskViews, STORES.scheduleEntries, STORES.scheduleSeries, STORES.scheduleOccurrenceStates, STORES.scheduleDailyNotes, STORES.whiteboards].filter((name) => existing.objectStoreNames.contains(name));
        const transaction = existing.transaction([...names, STORES.recovery, STORES.meta], "readwrite");
        const values = await Promise.all(names.map((name) => requestResult(transaction.objectStore(name).getAll())));
        const byStore = Object.fromEntries(names.map((name, index) => [name, values[index]]));
        const createdAt = isoNow();
        transaction.objectStore(STORES.recovery).put({ id: makeId("recovery"), kind: "database-v8-migration", label: "升级时间与规划中心前的完整数据", createdAt, expiresAt: new Date(Date.now() + HISTORY_AGE).toISOString(), payload: { version: 8, categories: byStore[STORES.folders] || [], files: byStore[STORES.files] || [], notes: byStore[STORES.notes] || [], tasks: byStore[STORES.tasks] || [], taskFields: byStore[STORES.taskFields] || [], taskViews: byStore[STORES.taskViews] || [], scheduleEntries: byStore[STORES.scheduleEntries] || [], scheduleSeries: byStore[STORES.scheduleSeries] || [], scheduleOccurrenceStates: byStore[STORES.scheduleOccurrenceStates] || [], scheduleDailyNotes: byStore[STORES.scheduleDailyNotes] || [], whiteboards: byStore[STORES.whiteboards] || [] } });
        transaction.objectStore(STORES.meta).put({ key: "databaseV8MigrationPrepared", state: "prepared", createdAt, fromVersion: existing.version });
        await transactionDone(transaction);
        this.migrationPrepared = true; this.migrationFromVersion = existing.version; this.versionUpgradeChecked = true;
      } catch (error) {
        this.versionUpgradeFailure = error;
        throw error;
      } finally { existing.close(); }
    }

    async get(storeName, key) {
      await this.open();
      return requestResult(this.db.transaction(storeName, "readonly").objectStore(storeName).get(key));
    }

    async getAll(storeName) {
      await this.open();
      return requestResult(this.db.transaction(storeName, "readonly").objectStore(storeName).getAll());
    }

    async put(storeName, value) {
      await this.open();
      const transaction = this.db.transaction(storeName, "readwrite");
      transaction.objectStore(storeName).put(value);
      await transactionDone(transaction);
      return value;
    }

    async remove(storeName, key) {
      await this.open();
      const transaction = this.db.transaction(storeName, "readwrite");
      transaction.objectStore(storeName).delete(key);
      await transactionDone(transaction);
    }

    rescueChecksumPayload(snapshot) {
      return {
        version: snapshot.version,
        createdAt: snapshot.createdAt,
        commit: snapshot.commit || null,
        data: snapshot.data,
        safetyArchive: snapshot.safetyArchive,
        attachments: (snapshot.attachments || []).map(({ blob, ...metadata }) => metadata)
      };
    }

    async buildRescueSnapshot() {
      const [notes, folders, files, tasks, taskFields, taskViews, scheduleEntries, scheduleSeries, scheduleOccurrenceStates, scheduleDailyNotes, whiteboards, focusSessions, reviews, goals, milestones, attachments, noteHistory, taskHistory, recovery, commit] = await Promise.all([
        this.getAll(STORES.notes), this.getAll(STORES.folders), this.getAll(STORES.files), this.getAll(STORES.tasks),
        this.getAll(STORES.taskFields), this.getAll(STORES.taskViews), this.getAll(STORES.scheduleEntries), this.getAll(STORES.scheduleSeries),
        this.getAll(STORES.scheduleOccurrenceStates), this.getAll(STORES.scheduleDailyNotes), this.getAll(STORES.whiteboards),
        this.getAll(STORES.focusSessions), this.getAll(STORES.reviews), this.getAll(STORES.goals), this.getAll(STORES.milestones),
        this.getAll(STORES.attachments), this.getAll(STORES.history), this.getAll(STORES.taskHistory), this.getAll(STORES.recovery),
        this.get(STORES.meta, "lastCommit")
      ]);
      const snapshot = {
        version: 1,
        createdAt: isoNow(),
        commit: commit || null,
        data: { version: 8, notes, categories: folders, files, tasks, taskFields, taskViews, scheduleEntries, scheduleSeries, scheduleOccurrenceStates, scheduleDailyNotes, whiteboards, focusSessions, reviews, goals, milestones },
        safetyArchive: { noteHistory, taskHistory, recovery },
        attachments
      };
      snapshot.checksum = await sha256(stableStringify(this.rescueChecksumPayload(snapshot)));
      return snapshot;
    }

    async validateRescueSnapshot(snapshot, verifyAttachmentHashes = false) {
      if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.data?.notes) || !Array.isArray(snapshot.data?.categories) || !Array.isArray(snapshot.attachments)) throw new Error("The EasyNote rescue snapshot structure is invalid");
      const checksum = await sha256(stableStringify(this.rescueChecksumPayload(snapshot)));
      if (checksum !== snapshot.checksum) throw new Error("The EasyNote rescue snapshot checksum is invalid");
      const attachmentIds = new Set();
      for (const attachment of snapshot.attachments) {
        if (!attachment?.id || !(attachment.blob instanceof Blob) || attachment.blob.size !== attachment.size) throw new Error("An attachment in the EasyNote rescue snapshot is incomplete");
        if (verifyAttachmentHashes && await sha256(attachment.blob) !== attachment.sha256) throw new Error("An attachment in the EasyNote rescue snapshot failed verification");
        attachmentIds.add(attachment.id);
      }
      for (const note of snapshot.data.notes) {
        const template = document.createElement("template");
        template.innerHTML = note.content || "";
        for (const image of template.content.querySelectorAll("img[data-attachment-id]")) if (!attachmentIds.has(image.dataset.attachmentId)) throw new Error(`Rescue snapshot is missing an image used by note ${note.title || note.id}`);
      }
      return true;
    }

    async writeRescueSnapshot() {
      const snapshot = await this.buildRescueSnapshot();
      const rescueDb = await openRescueDatabase();
      try {
        const existing = await requestResult(rescueDb.transaction(RESCUE_STORE, "readonly").objectStore(RESCUE_STORE).getAll());
        const archives = existing.filter((item) => String(item.id || "").startsWith("archive-")).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        const makeArchive = !archives[0] || Date.now() - new Date(archives[0].createdAt).getTime() >= RESCUE_ARCHIVE_INTERVAL;
        const transaction = rescueDb.transaction(RESCUE_STORE, "readwrite");
        const store = transaction.objectStore(RESCUE_STORE);
        store.put({ ...snapshot, id: "latest" });
        if (makeArchive) store.put({ ...snapshot, id: `archive-${snapshot.createdAt}` });
        const retainedIds = new Set(archives.slice(0, Math.max(0, RESCUE_ARCHIVE_LIMIT - (makeArchive ? 1 : 0))).map((item) => item.id));
        for (const archive of archives) if (!retainedIds.has(archive.id)) store.delete(archive.id);
        await transactionDone(transaction);
      } finally { rescueDb.close(); }
      const verified = await rescueGet("latest");
      await this.validateRescueSnapshot(verified, false);
      if (verified.checksum !== snapshot.checksum || verified.data.notes.length !== snapshot.data.notes.length || verified.attachments.length !== snapshot.attachments.length) throw new Error("The EasyNote rescue snapshot could not be verified after writing");
      this.lastRescueSnapshotAt = snapshot.createdAt;
      await this.put(STORES.meta, { key: "lastRescueSnapshot", createdAt: snapshot.createdAt, checksum: snapshot.checksum, notes: snapshot.data.notes.length, attachments: snapshot.attachments.length });
      this.emitSafety({ rescueCompleted: true, createdAt: snapshot.createdAt });
      return snapshot;
    }

    failedSaveId() { return `failed-save-${this.instanceId}`; }

    failedSaveChecksumPayload(snapshot) {
      return { version: snapshot.version, createdAt: snapshot.createdAt, reason: snapshot.reason, data: snapshot.data };
    }

    async writeFailedSaveSnapshot(state, reason, error) {
      const snapshot = {
        id: this.failedSaveId(),
        version: 1,
        createdAt: isoNow(),
        reason: reason || "auto",
        error: String(error?.message || error || "Unknown verified save failure"),
        data: structuredClone(state)
      };
      snapshot.checksum = await sha256(stableStringify(this.failedSaveChecksumPayload(snapshot)));
      const rescueDb = await openRescueDatabase();
      try {
        const existing = await requestResult(rescueDb.transaction(RESCUE_STORE, "readonly").objectStore(RESCUE_STORE).getAll());
        const failed = existing.filter((item) => String(item.id || "").startsWith("failed-save-")).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        const retained = new Set(failed.slice(0, 7).map((item) => item.id));
        const transaction = rescueDb.transaction(RESCUE_STORE, "readwrite");
        const store = transaction.objectStore(RESCUE_STORE);
        store.put(snapshot);
        for (const item of failed) if (item.id !== snapshot.id && !retained.has(item.id)) store.delete(item.id);
        await transactionDone(transaction);
      } finally { rescueDb.close(); }
      const verified = await rescueGet(snapshot.id);
      if (!verified || verified.checksum !== snapshot.checksum || await sha256(stableStringify(this.failedSaveChecksumPayload(verified))) !== verified.checksum) throw new Error("保存失败快照写入后校验未通过");
      this.emitSafety({ failedSaveProtected: true, createdAt: snapshot.createdAt, error: snapshot.error });
      return snapshot;
    }

    async removeFailedSaveSnapshot(id = this.failedSaveId()) {
      const rescueDb = await openRescueDatabase();
      try {
        const transaction = rescueDb.transaction(RESCUE_STORE, "readwrite");
        transaction.objectStore(RESCUE_STORE).delete(id);
        await transactionDone(transaction);
      } finally { rescueDb.close(); }
    }

    mergeFailedSaveState(current, pending) {
      const merged = { ...structuredClone(current || {}), ...structuredClone(pending || {}), version: 8 };
      for (const key of ["categories", "files", "notes", "tasks", "taskFields", "taskViews", "scheduleEntries", "scheduleSeries", "scheduleOccurrenceStates", "scheduleDailyNotes", "whiteboards", "focusSessions", "reviews", "goals", "milestones"]) {
        const pendingItems = Array.isArray(pending?.[key]) ? pending[key] : [];
        const pendingIds = new Set(pendingItems.map((item) => item?.id).filter(Boolean));
        const currentOnly = (Array.isArray(current?.[key]) ? current[key] : []).filter((item) => item?.id && !pendingIds.has(item.id));
        merged[key] = [...pendingItems, ...currentOnly];
      }
      return merged;
    }

    async restoreLatestFailedSave(currentState, lastCommit = null) {
      const rescueDb = await openRescueDatabase();
      let candidates;
      try {
        candidates = (await requestResult(rescueDb.transaction(RESCUE_STORE, "readonly").objectStore(RESCUE_STORE).getAll()))
          .filter((item) => String(item.id || "").startsWith("failed-save-"))
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      } finally { rescueDb.close(); }
      for (const snapshot of candidates) {
        if (!snapshot?.data || snapshot.version !== 1 || !Array.isArray(snapshot.data.notes) || !Array.isArray(snapshot.data.categories)) continue;
        const checksum = await sha256(stableStringify(this.failedSaveChecksumPayload(snapshot)));
        if (checksum !== snapshot.checksum) continue;
        if (lastCommit?.committedAt && snapshot.createdAt <= lastCommit.committedAt) { await this.removeFailedSaveSnapshot(snapshot.id); continue; }
        const merged = this.mergeFailedSaveState(currentState, snapshot.data);
        const saved = await this.queueSave(merged, true, "failed-save-restore");
        if (!saved) throw new Error("保存失败快照自动恢复后未能通过回读校验");
        await this.removeFailedSaveSnapshot(snapshot.id);
        this.restoredFromFailedSave = true;
        await this.put(STORES.meta, { key: "failedSaveRestored", createdAt: isoNow(), sourceCreatedAt: snapshot.createdAt, sourceError: snapshot.error || "", notes: merged.notes.length });
        this.emitSafety({ failedSaveRestored: true, createdAt: snapshot.createdAt, notes: merged.notes.length });
        return this.load(true);
      }
      return null;
    }

    async restoreLatestRescue() {
      const snapshot = await rescueGet("latest");
      if (!snapshot) return false;
      await this.validateRescueSnapshot(snapshot, true);
      const attachmentTransaction = this.db.transaction(STORES.attachments, "readwrite");
      for (const attachment of snapshot.attachments) attachmentTransaction.objectStore(STORES.attachments).put(attachment);
      await transactionDone(attachmentTransaction);
      snapshot.attachments.forEach((attachment) => this.attachmentRecords.set(attachment.id, attachment));
      await this.saveState(structuredClone(snapshot.data), "rescue-restore");
      for (const [storeName, records] of [[STORES.history, snapshot.safetyArchive?.noteHistory], [STORES.taskHistory, snapshot.safetyArchive?.taskHistory], [STORES.recovery, snapshot.safetyArchive?.recovery]]) {
        if (!Array.isArray(records) || !records.length) continue;
        const transaction = this.db.transaction(storeName, "readwrite");
        records.forEach((record) => transaction.objectStore(storeName).put(record));
        await transactionDone(transaction);
      }
      this.restoredFromRescue = true;
      await this.put(STORES.meta, { key: "rescueRestored", createdAt: isoNow(), sourceCreatedAt: snapshot.createdAt, checksum: snapshot.checksum });
      this.emitSafety({ rescueRestored: true, createdAt: snapshot.createdAt });
      return true;
    }

    localAutomaticBackupAvailable() {
      return location.protocol === "http:" && (location.hostname === "localhost" || location.hostname === "127.0.0.1");
    }

    async restoreLocalAutomaticBackup({ minimumNoteCount = 0, replacedState = null } = {}) {
      if (!this.localAutomaticBackupAvailable()) return null;
      const response = await fetch(LOCAL_RECOVERY_CANDIDATE_ENDPOINT, { cache: "no-store" });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`Local recovery candidate failed (HTTP ${response.status})`);
      if (!String(response.headers.get("content-type") || "").toLowerCase().includes("application/json")) return null;
      const archive = await response.json();
      if (archive?.format !== "easynote-portable" || Number(archive.version) !== 8 || !Array.isArray(archive.notes) || !Array.isArray(archive.categories)) throw new Error("The local recovery candidate is invalid");
      if (archive.notes.length <= minimumNoteCount) return null;
      if (replacedState) await this.recordRecovery("local-automatic-recovery", "自动恢复前的示例数据", structuredClone(replacedState));
      const saved = await this.queueSave(structuredClone(archive), true, "rescue-restore");
      if (!saved) throw new Error("The local recovery candidate could not be saved and verified");
      this.wasEmpty = false;
      this.restoredFromRescue = true;
      await this.put(STORES.meta, { key: "localAutomaticRecovery", createdAt: isoNow(), notes: archive.notes.length, exportedAt: archive.exportedAt || null });
      const recovered = await this.load(true);
      if (!recovered || recovered.notes.length !== archive.notes.length) throw new Error("The local recovery candidate failed the final read-back check");
      this.emitSafety({ localAutomaticRecovery: true, notes: recovered.notes.length });
      return recovered;
    }

    async repairMissingAttachments(state) {
      if (!this.localAutomaticBackupAvailable()) throw new Error("请在 localhost 安全启动模式下使用附件修复");
      const response = await fetch(LOCAL_RECOVERY_CANDIDATE_ENDPOINT, { cache: "no-store" });
      if (response.status === 404) throw new Error("没有找到可用的自动备份");
      if (!response.ok || !String(response.headers.get("content-type") || "").toLowerCase().includes("application/json")) throw new Error("自动备份读取失败");
      const archive = await response.json();
      if (archive?.format !== "easynote-portable" || !Array.isArray(archive.notes)) throw new Error("自动备份格式无效");
      const archivedNotes = new Map(archive.notes.map((note) => [note.id, note]));
      let repaired = 0;
      for (const note of state?.notes || []) {
        const source = archivedNotes.get(note.id);
        if (!source) continue;
        const currentTemplate = document.createElement("template"); currentTemplate.innerHTML = note.content || "";
        const sourceTemplate = document.createElement("template"); sourceTemplate.innerHTML = source.content || "";
        const sourceImages = new Map();
        sourceTemplate.content.querySelectorAll("img[data-attachment-id]").forEach((image) => { const id = image.dataset.attachmentId; const src = image.getAttribute("src") || ""; if (id && src.startsWith("data:")) sourceImages.set(id, { src, alt: image.alt || "笔记图片" }); });
        for (const image of currentTemplate.content.querySelectorAll("img[data-attachment-id]")) {
          const id = image.dataset.attachmentId || "";
          if (id && this.getAttachmentBlob(id)) continue;
          const replacement = sourceImages.get(id);
          if (!replacement) continue;
          const attachment = await this.resolveInlineAttachment(replacement.src, "", { name: replacement.alt });
          image.dataset.attachmentId = attachment.id; image.src = attachment.url; image.removeAttribute("data-attachment-missing"); repaired++;
        }
        note.content = currentTemplate.innerHTML;
      }
      if (!repaired) return { repaired: 0, state };
      if (!await this.queueSave(state, true, "rescue-restore")) throw new Error(this.lastError?.message || "修复后的附件无法保存");
      const recovered = await this.load(true);
      return { repaired, state: recovered || state };
    }

    scheduleLocalAutomaticBackup(snapshot, immediate = false) {
      if (!this.localAutomaticBackupAvailable()) return;
      this.pendingLocalBackupSnapshot = snapshot;
      clearTimeout(this.localBackupTimer);
      if (immediate) return this.runLocalAutomaticBackup();
      this.localBackupTimer = setTimeout(() => this.runLocalAutomaticBackup(), 1500);
    }

    async runLocalAutomaticBackup() {
      clearTimeout(this.localBackupTimer);
      if (this.localBackupPromise || !this.pendingLocalBackupSnapshot) return this.localBackupPromise;
      const snapshot = this.pendingLocalBackupSnapshot;
      this.pendingLocalBackupSnapshot = null;
      this.localBackupPromise = (async () => {
        const portable = await this.exportPortable(snapshot.data);
        const response = await fetch(LOCAL_AUTOMATIC_BACKUP_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-EasyNote-Backup": "automatic-v1" },
          body: JSON.stringify(portable),
          cache: "no-store"
        });
        if (!response.ok) throw new Error(`Local automatic backup failed (HTTP ${response.status})`);
        const result = await response.json();
        if (!result?.ok || !result?.createdAt || !result?.checksum) throw new Error("The local automatic backup response is invalid");
        this.lastLocalBackup = result;
        await this.put(STORES.meta, { key: "lastLocalAutomaticBackup", ...result });
        this.emitSafety({ localBackupCompleted: true, createdAt: result.createdAt });
        return result;
      })().catch((error) => {
        this.lastProtectionError = error;
        this.emitSafety({ backupError: String(error?.message || error) });
        return null;
      }).finally(() => {
        this.localBackupPromise = null;
        if (this.pendingLocalBackupSnapshot) this.runLocalAutomaticBackup();
      });
      return this.localBackupPromise;
    }

    async protectCommittedState(result, reason) {
      try {
        const rescueSnapshot = await this.writeRescueSnapshot();
        this.lastProtectionError = null;
        const localBackup = this.scheduleLocalAutomaticBackup(rescueSnapshot, ["manual", "switch", "danger", "import", "migration", "rescue-restore"].includes(reason));
        if (localBackup) await localBackup;
        return { ...result, rescueCreatedAt: rescueSnapshot.createdAt };
      } catch (error) {
        this.lastProtectionError = error;
        console.error("EasyNote rescue snapshot failed", error);
        this.emitSafety({ rescueError: String(error?.message || error) });
        return { ...result, protectionWarning: String(error?.message || error) };
      }
    }

    async load(captureBaselines = true) {
      await this.open();
      this.backupDirectoryHandle = (await this.get(STORES.settings, "backupDirectory"))?.value || null;
      let notes = await this.getAll(STORES.notes);
      const legacy = await this.get(STORES.legacy, "main");
      if (!notes.length && legacy?.notes?.length) {
        await this.saveState(structuredClone(legacy), "migration");
        notes = await this.getAll(STORES.notes);
        await this.put(STORES.meta, { key: "migration", state: "verified", migratedAt: isoNow(), source: "app-state/main", legacyRetained: true });
      }
      if (!notes.length && await this.restoreLatestRescue()) notes = await this.getAll(STORES.notes);
      const attachments = await this.getAll(STORES.attachments);
      attachments.forEach((record) => this.attachmentRecords.set(record.id, record));
      const [folders, files, tasks, taskFields, taskViews, scheduleEntries, scheduleSeries, scheduleOccurrenceStates, scheduleDailyNotes, whiteboards, focusSessions, reviews, goals, milestones] = await Promise.all([
        this.getAll(STORES.folders), this.getAll(STORES.files), this.getAll(STORES.tasks),
        this.getAll(STORES.taskFields), this.getAll(STORES.taskViews), this.getAll(STORES.scheduleEntries), this.getAll(STORES.scheduleSeries), this.getAll(STORES.scheduleOccurrenceStates), this.getAll(STORES.scheduleDailyNotes), this.getAll(STORES.whiteboards), this.getAll(STORES.focusSessions), this.getAll(STORES.reviews), this.getAll(STORES.goals), this.getAll(STORES.milestones)
      ]);
      if (!notes.length && !folders.length && !files.length && !tasks.length && !taskFields.length && !taskViews.length && !scheduleEntries.length && !scheduleSeries.length && !scheduleOccurrenceStates.length && !scheduleDailyNotes.length && !whiteboards.length && !focusSessions.length && !reviews.length && !goals.length && !milestones.length) { this.wasEmpty = true; return null; }
      if (captureBaselines) for (const [storeName, records] of [[STORES.notes, notes], [STORES.folders, folders], [STORES.files, files], [STORES.tasks, tasks], [STORES.taskFields, taskFields], [STORES.taskViews, taskViews], [STORES.scheduleEntries, scheduleEntries], [STORES.scheduleSeries, scheduleSeries], [STORES.scheduleOccurrenceStates, scheduleOccurrenceStates], [STORES.scheduleDailyNotes, scheduleDailyNotes], [STORES.whiteboards, whiteboards], [STORES.focusSessions, focusSessions], [STORES.reviews, reviews], [STORES.goals, goals], [STORES.milestones, milestones]]) this.captureBaseline(storeName, records);
      const state = {
        version: 8,
        categories: folders.map((folder) => ({ ...folder })),
        files: files.map((file) => ({ ...file })),
        notes: notes.map((note) => ({ ...note, content: this.hydrateContent(note.content || "") })),
        tasks: tasks.map((task) => ({ ...task })),
        taskFields: taskFields.map((field) => ({ ...field })),
        taskViews: taskViews.map((view) => ({ ...view })),
        scheduleEntries: scheduleEntries.map((entry) => ({ ...entry })),
        scheduleSeries: scheduleSeries.map((series) => ({ ...series })),
        scheduleOccurrenceStates: scheduleOccurrenceStates.map((occurrence) => ({ ...occurrence })),
        scheduleDailyNotes: scheduleDailyNotes.map((dailyNote) => ({ ...dailyNote })),
        focusSessions: focusSessions.map((session) => ({ ...session })),
        reviews: reviews.map((review) => ({ ...review })),
        goals: goals.map((goal) => ({ ...goal })),
        milestones: milestones.map((milestone) => ({ ...milestone })),
        whiteboards: whiteboards.map((board) => ({ ...board }))
      };
      const lastCommit = await this.get(STORES.meta, "lastCommit");
      const failedSaveRecovery = await this.restoreLatestFailedSave(state, lastCommit);
      if (failedSaveRecovery) return failedSaveRecovery;
      if (lastCommit) this.emitStatus("saved", { verifiedAt: lastCommit.committedAt });
      return state;
    }

    getAttachmentRecord(id) { return this.attachmentRecords.get(id) || null; }
    getAttachmentBlob(id) { return this.attachmentRecords.get(id)?.blob || null; }
    getAttachmentIdByUrl(url) { for (const [id, current] of this.attachmentUrls) if (current === url) return id; return ""; }

    getAttachmentUrl(id) {
      if (!id) return null;
      if (this.attachmentUrls.has(id)) return this.attachmentUrls.get(id);
      const blob = this.getAttachmentBlob(id);
      if (!blob) return null;
      const url = URL.createObjectURL(blob);
      this.attachmentUrls.set(id, url);
      return url;
    }

    hydrateContent(html) {
      const template = document.createElement("template");
      template.innerHTML = html || "";
      template.content.querySelectorAll("img[data-attachment-id]").forEach((image) => {
        const url = this.getAttachmentUrl(image.dataset.attachmentId);
        if (url) image.setAttribute("src", url);
        else image.setAttribute("data-attachment-missing", "true");
      });
      return template.innerHTML;
    }

    dehydrateContent(html) {
      const template = document.createElement("template");
      template.innerHTML = html || "";
      template.content.querySelectorAll("img[data-attachment-id]").forEach((image) => {
        image.removeAttribute("src");
        image.removeAttribute("data-attachment-missing");
        image.classList.remove("image-selected", "context-target");
      });
      return template.innerHTML;
    }

    async putAttachment(blob, metadata = {}) {
      if (!(blob instanceof Blob)) throw new Error("附件内容无效");
      const hash = await sha256(blob);
      const duplicate = [...this.attachmentRecords.values()].find((item) => item.sha256 === hash && item.size === blob.size);
      if (duplicate) return { ...duplicate, url: this.getAttachmentUrl(duplicate.id) };
      const record = {
        id: makeId("attachment"), sha256: hash, blob, size: blob.size,
        type: blob.type || metadata.type || "application/octet-stream",
        name: metadata.name || "附件", createdAt: isoNow()
      };
      await this.put(STORES.attachments, record);
      const verified = await this.get(STORES.attachments, record.id);
      if (!verified || verified.size !== record.size || verified.sha256 !== hash) throw new Error("附件写入后校验失败");
      this.attachmentRecords.set(record.id, verified);
      return { ...verified, url: this.getAttachmentUrl(record.id) };
    }

    async resolveInlineAttachment(dataUrl, existingId = "", metadata = {}) {
      if (existingId) {
        const existing = this.attachmentRecords.get(existingId) || await this.get(STORES.attachments, existingId);
        if (existing?.blob) {
          this.attachmentRecords.set(existing.id, existing);
          return { ...existing, url: this.getAttachmentUrl(existing.id) };
        }
      }
      return this.putAttachment(dataUrlToBlob(dataUrl), metadata);
    }

    async verifyAttachmentReferences(state, decodeImages = false) {
      const referenced = new Map();
      const remember = (id, label, image = false) => { if (id) referenced.set(id, { label, image: image || referenced.get(id)?.image }); };
      for (const note of state.notes || []) {
        const template = document.createElement("template");
        template.innerHTML = note.content || "";
        template.content.querySelectorAll("img[data-attachment-id]").forEach((image) => remember(image.dataset.attachmentId, `note ${note.title || note.id}`, true));
      }
      for (const file of state.files || []) remember(file.attachmentId, `file ${file.name || file.id}`);
      for (const task of state.tasks || []) for (const value of Object.values(task.values || {})) if (Array.isArray(value)) for (const item of value) remember(item?.attachmentId, `task attachment ${item?.name || task.id}`);
      for (const board of state.whiteboards || []) for (const node of board.nodes || []) if (node.type === "image") remember(node.attachmentId, `whiteboard image ${node.title || node.id}`, true);
      for (const [id, descriptor] of referenced) {
        const record = this.attachmentRecords.get(id) || await this.get(STORES.attachments, id);
        if (!record?.blob || record.blob.size !== record.size) throw new Error(`Missing or incomplete attachment: ${descriptor.label}`);
        if (await sha256(record.blob) !== record.sha256) throw new Error(`Attachment checksum failed: ${descriptor.label}`);
        this.attachmentRecords.set(id, record);
        if (decodeImages && descriptor.image) {
          const url = URL.createObjectURL(record.blob);
          try {
            await new Promise((resolve, reject) => {
              const image = new Image();
              image.onload = () => image.naturalWidth > 0 && image.naturalHeight > 0 ? resolve(true) : reject(new Error("decoded image has no dimensions"));
              image.onerror = () => reject(new Error("browser could not decode image"));
              image.src = url;
            });
          } catch (error) { throw new Error(`Image cannot be displayed (${descriptor.label}): ${error?.message || error}`); }
          finally { URL.revokeObjectURL(url); }
        }
      }
      return { referenced: referenced.size };
    }

    async prepareInlineAttachments(snapshot) {
      for (const note of snapshot.notes || []) {
        const template = document.createElement("template");
        template.innerHTML = note.content || "";
        for (const image of template.content.querySelectorAll("img")) {
          const source = image.getAttribute("src") || "";
          if (source.startsWith("data:image/")) {
            const attachment = await this.resolveInlineAttachment(source, image.dataset.attachmentId || "", { name: image.alt || "笔记图片" });
            image.dataset.attachmentId = attachment.id;
            image.src = attachment.url;
          }
        }
        note.content = template.innerHTML;
      }
      for (const file of snapshot.files || []) {
        if (file.dataUrl) {
          const attachment = await this.resolveInlineAttachment(file.dataUrl, file.attachmentId || "", { name: file.name, type: file.type });
          file.attachmentId = attachment.id;
          file.size = attachment.size;
          delete file.dataUrl;
        }
      }
      for (const task of snapshot.tasks || []) {
        for (const value of Object.values(task.values || {})) {
          const descriptors = Array.isArray(value) ? value : [];
          for (const descriptor of descriptors) {
            if (!descriptor || typeof descriptor !== "object" || !descriptor.dataUrl) continue;
            const attachment = await this.putAttachment(dataUrlToBlob(descriptor.dataUrl), { name: descriptor.name, type: descriptor.type });
            descriptor.attachmentId = attachment.id;
            descriptor.size = attachment.size;
            descriptor.type = attachment.type;
            delete descriptor.dataUrl;
          }
        }
      }
      for (const board of snapshot.whiteboards || []) {
        for (const node of board.nodes || []) {
          if (node.type !== "image" || !node.dataUrl) continue;
          const attachment = await this.resolveInlineAttachment(node.dataUrl, node.attachmentId || "", { name: node.title || "白板图片" });
          node.attachmentId = attachment.id;
          delete node.dataUrl;
        }
      }
      return snapshot;
    }

    notePayload(note) {
      return {
        id: note.id, title: note.title || "", categoryId: note.categoryId || "", tags: Array.isArray(note.tags) ? note.tags : [],
        favorite: Boolean(note.favorite), createdAt: note.createdAt, updatedAt: note.updatedAt,
        deletedAt: note.deletedAt || null, content: this.dehydrateContent(note.content || "")
      };
    }

    whiteboardPayload(board) {
      const nodeTypes = new Set(["text", "note", "task", "image", "link", "group"]), sides = new Set(["top", "right", "bottom", "left"]), color = (value) => /^#[0-9a-f]{6}$/i.test(String(value || "")) ? String(value) : "#4f7df3";
      const nodes = (Array.isArray(board.nodes) ? board.nodes : []).map((node, index) => ({
        id: node.id, type: nodeTypes.has(node.type) ? node.type : "text", x: Number(node.x) || 0, y: Number(node.y) || 0,
        width: Math.max(140, Number(node.width) || (node.type === "group" ? 460 : 260)), height: Math.max(80, Number(node.height) || (node.type === "group" ? 300 : 160)),
        zIndex: Number.isFinite(node.zIndex) ? node.zIndex : index + 1, color: color(node.color), groupId: node.groupId || "",
        text: node.text || "", noteId: node.noteId || "", taskId: node.taskId || "", attachmentId: node.attachmentId || "", url: node.url || "", title: node.title || ""
      }));
      const edges = (Array.isArray(board.edges) ? board.edges : []).map((edge) => ({
        id: edge.id, sourceId: edge.sourceId || "", targetId: edge.targetId || "", sourceSide: sides.has(edge.sourceSide) ? edge.sourceSide : "right", targetSide: sides.has(edge.targetSide) ? edge.targetSide : "left", color: color(edge.color)
      }));
      const viewport = board.viewport && typeof board.viewport === "object" ? board.viewport : {};
      return {
        id: board.id, title: board.title || "未命名白板", nodes, edges,
        viewport: { x: Number(viewport.x) || 0, y: Number(viewport.y) || 0, zoom: Math.min(2.5, Math.max(.25, Number(viewport.zoom) || 1)) },
        gridEnabled: board.gridEnabled !== false, createdAt: board.createdAt || isoNow(), updatedAt: board.updatedAt || isoNow()
      };
    }

    async saveState(inputState, reason = "auto") {
      if (navigator.locks?.request) return navigator.locks.request("easynote-database-write", () => this.saveStateLocked(inputState, reason));
      return this.saveStateLocked(inputState, reason);
    }

    async saveStateLocked(inputState, reason = "auto") {
      await this.open();
      const snapshot = await this.prepareInlineAttachments(structuredClone(inputState));
      const hydratedNotes = new Map((snapshot.notes || []).map((note) => [note.id, note]));
      (inputState.notes || []).forEach((note) => { const prepared = hydratedNotes.get(note.id); if (prepared) note.content = prepared.content; });
      const preparedInputFiles = new Map((snapshot.files || []).map((file) => [file.id, file]));
      (inputState.files || []).forEach((file) => { const prepared = preparedInputFiles.get(file.id); if (prepared?.attachmentId) { file.attachmentId = prepared.attachmentId; file.size = prepared.size; delete file.dataUrl; } });
      const preparedInputTasks = new Map((snapshot.tasks || []).map((task) => [task.id, task]));
      (inputState.tasks || []).forEach((task) => { const prepared = preparedInputTasks.get(task.id); if (prepared) task.values = prepared.values; });
      const preparedInputBoards = new Map((snapshot.whiteboards || []).map((board) => [board.id, board]));
      (inputState.whiteboards || []).forEach((board) => { const prepared = preparedInputBoards.get(board.id); if (prepared) board.nodes = prepared.nodes; });
      const [existingNotes, existingFolders, existingFiles, existingTasks, existingTaskFields, existingTaskViews, existingScheduleEntries, existingScheduleSeries, existingScheduleOccurrenceStates, existingScheduleDailyNotes, existingWhiteboards, existingFocusSessions, existingReviews, existingGoals, existingMilestones] = await Promise.all([
        this.getAll(STORES.notes), this.getAll(STORES.folders), this.getAll(STORES.files),
        this.getAll(STORES.tasks), this.getAll(STORES.taskFields), this.getAll(STORES.taskViews), this.getAll(STORES.scheduleEntries), this.getAll(STORES.scheduleSeries), this.getAll(STORES.scheduleOccurrenceStates), this.getAll(STORES.scheduleDailyNotes), this.getAll(STORES.whiteboards), this.getAll(STORES.focusSessions), this.getAll(STORES.reviews), this.getAll(STORES.goals), this.getAll(STORES.milestones)
      ]);
      const noteMap = new Map(existingNotes.map((item) => [item.id, item]));
      const folderMap = new Map(existingFolders.map((item) => [item.id, item]));
      const fileMap = new Map(existingFiles.map((item) => [item.id, item]));
      const taskMap = new Map(existingTasks.map((item) => [item.id, item]));
      const taskFieldMap = new Map(existingTaskFields.map((item) => [item.id, item]));
      const taskViewMap = new Map(existingTaskViews.map((item) => [item.id, item]));
      const scheduleMap = new Map(existingScheduleEntries.map((item) => [item.id, item]));
      const scheduleSeriesMap = new Map(existingScheduleSeries.map((item) => [item.id, item]));
      const scheduleOccurrenceMap = new Map(existingScheduleOccurrenceStates.map((item) => [item.id, item]));
      const scheduleDailyNoteMap = new Map(existingScheduleDailyNotes.map((item) => [item.id, item]));
      const whiteboardMap = new Map(existingWhiteboards.map((item) => [item.id, item]));
      const focusSessionMap = new Map(existingFocusSessions.map((item) => [item.id, item]));
      const reviewMap = new Map(existingReviews.map((item) => [item.id, item]));
      const goalMap = new Map(existingGoals.map((item) => [item.id, item]));
      const milestoneMap = new Map(existingMilestones.map((item) => [item.id, item]));
      const preparedNotes = [];
      const changedNotes = [];
      const conflicts = [];
      for (const note of snapshot.notes || []) {
        const payload = this.notePayload(note);
        const checksum = await sha256(stableStringify(payload));
        const previous = noteMap.get(note.id);
        const baseline = this.baselineChecksum(STORES.notes, note.id);
        const baselineKnown = this.baselineHas(STORES.notes, note.id), baselineFingerprint = this.baselineFingerprint(STORES.notes, note.id);
        const locallyChanged = baseline ? checksum !== baseline : !baselineKnown || this.recordFingerprint(payload) !== baselineFingerprint;
        const externalChanged = baseline
          ? !previous || previous.checksum !== baseline
          : baselineKnown
            ? !previous || this.recordFingerprint(previous) !== baselineFingerprint
            : Boolean(previous && previous.checksum !== checksum);
        if (externalChanged) {
          if (!locallyChanged && previous) { preparedNotes.push(previous); continue; }
          if (!locallyChanged) continue;
          const stamp = isoNow();
          const conflictPayload = { ...payload, id: makeId("note-conflict"), title: `${payload.title || "无标题笔记"}（多页面冲突副本）`, createdAt: stamp, updatedAt: stamp, deletedAt: null };
          const conflictChecksum = await sha256(stableStringify(conflictPayload));
          const conflictRecord = { ...conflictPayload, revision: 1, checksum: conflictChecksum };
          if (previous) preparedNotes.push(previous);
          preparedNotes.push(conflictRecord); changedNotes.push(conflictRecord);
          conflicts.push({ kind: "note", originalId: note.id, copy: { ...conflictRecord, content: this.hydrateContent(conflictRecord.content || "") }, remote: previous ? { ...previous, content: this.hydrateContent(previous.content || "") } : null });
          continue;
        }
        const record = { ...payload, revision: previous?.checksum === checksum ? previous.revision || 1 : (previous?.revision || 0) + 1, checksum };
        preparedNotes.push(record);
        if (locallyChanged && (!previous || previous.checksum !== checksum)) changedNotes.push(record);
      }
      const prepareSimple = async (items, previousMap, cleanItem, storeName, kind) => {
        const prepared = [], changed = [];
        for (const item of items || []) {
          const clean = cleanItem(item), checksum = await sha256(stableStringify(clean)), previous = previousMap.get(item.id), baseline = this.baselineChecksum(storeName, item.id);
          const baselineKnown = this.baselineHas(storeName, item.id), baselineFingerprint = this.baselineFingerprint(storeName, item.id);
          const locallyChanged = baseline ? checksum !== baseline : !baselineKnown || this.recordFingerprint(clean) !== baselineFingerprint;
          const externalChanged = baseline
            ? !previous || previous.checksum !== baseline
            : baselineKnown
              ? !previous || this.recordFingerprint(previous) !== baselineFingerprint
              : Boolean(previous && previous.checksum !== checksum);
          if (externalChanged) {
            if (locallyChanged) conflicts.push({ kind, id: item.id, label: clean.name || item.id, local: clean, remote: previous || null });
            if (previous) prepared.push(previous);
            continue;
          }
          const record = { ...clean, checksum };
          prepared.push(record);
          if (locallyChanged && (!previous || previous.checksum !== checksum)) changed.push(record);
        }
        return { prepared, changed };
      };
      const folderResult = await prepareSimple(snapshot.categories, folderMap, (folder) => ({ id: folder.id, name: folder.name || "未命名文件夹", color: folder.color || "", parentId: folder.parentId || null }), STORES.folders, "folder");
      const fileResult = await prepareSimple(snapshot.files, fileMap, (file) => ({ id: file.id, name: file.name || "本地文件", type: file.type || "application/octet-stream", size: file.size || 0, folderId: file.folderId || "", attachmentId: file.attachmentId || "", createdAt: file.createdAt || isoNow() }), STORES.files, "file");
      const preparedFolders = folderResult.prepared, preparedFiles = fileResult.prepared;
      const prepareVersioned = async (items, previousMap, cleanItem, storeName, kind) => {
        const prepared = [], changed = [];
        for (const item of items || []) {
          const clean = cleanItem(item), checksum = await sha256(stableStringify(clean)), previous = previousMap.get(item.id), baseline = this.baselineChecksum(storeName, item.id);
          const baselineKnown = this.baselineHas(storeName, item.id), baselineFingerprint = this.baselineFingerprint(storeName, item.id);
          const locallyChanged = baseline ? checksum !== baseline : !baselineKnown || this.recordFingerprint(clean) !== baselineFingerprint;
          const externalChanged = baseline
            ? !previous || previous.checksum !== baseline
            : baselineKnown
              ? !previous || this.recordFingerprint(previous) !== baselineFingerprint
              : Boolean(previous && previous.checksum !== checksum);
          if (externalChanged) {
            if (locallyChanged) conflicts.push({ kind, id: item.id, label: clean.title || clean.name || item.id, local: clean, remote: previous || null });
            if (previous) prepared.push(previous);
            continue;
          }
          const record = { ...clean, revision: previous?.checksum === checksum ? previous.revision || 1 : (previous?.revision || 0) + 1, checksum };
          prepared.push(record);
          if (locallyChanged && (!previous || previous.checksum !== checksum)) changed.push(record);
        }
        return { prepared, changed };
      };
      const taskResult = await prepareVersioned(snapshot.tasks, taskMap, (task) => ({
        id: task.id, values: task.values && typeof task.values === "object" ? task.values : {}, sortOrder: Number(task.sortOrder) || 0,
        createdAt: task.createdAt || isoNow(), updatedAt: task.updatedAt || isoNow(), completedAt: task.completedAt || null,
        previousIncompleteProgress: Number.isFinite(task.previousIncompleteProgress) ? task.previousIncompleteProgress : null
      }), STORES.tasks, "task");
      const fieldResult = await prepareVersioned(snapshot.taskFields, taskFieldMap, (field) => ({
        id: field.id, name: field.name || "未命名字段", type: field.type || "text", description: field.description || "",
        systemRole: field.systemRole || "", required: Boolean(field.required), hidden: Boolean(field.hidden), width: Math.max(90, Number(field.width) || 160),
        options: Array.isArray(field.options) ? field.options : [], config: field.config && typeof field.config === "object" ? field.config : {},
        order: Number(field.order) || 0, createdAt: field.createdAt || isoNow(), updatedAt: field.updatedAt || isoNow()
      }), STORES.taskFields, "taskField");
      const viewResult = await prepareVersioned(snapshot.taskViews, taskViewMap, (view) => ({
        id: view.id || "main", tableGroupFieldId: view.tableGroupFieldId || "", boardGroupFieldId: view.boardGroupFieldId || "",
        filters: Array.isArray(view.filters) ? view.filters : [], sorts: Array.isArray(view.sorts) ? view.sorts : [],
        cardFieldIds: Array.isArray(view.cardFieldIds) ? view.cardFieldIds.slice(0, 5) : [], collapsedGroups: Array.isArray(view.collapsedGroups) ? view.collapsedGroups : []
      }), STORES.taskViews, "taskView");
      const scheduleResult = await prepareVersioned(snapshot.scheduleEntries, scheduleMap, (entry) => ({
        id: entry.id, title: entry.title || "未命名日程", date: entry.date || "", allDay: entry.allDay !== false,
        startTime: entry.allDay === false ? entry.startTime || "" : "", endTime: entry.allDay === false ? entry.endTime || "" : "",
        timeSlots: scheduleTimeSlots(entry),
        notes: entry.notes || "", color: entry.color || "#4f7df3", completed: Boolean(entry.completed), taskId: entry.taskId || "", noteId: entry.noteId || "", url: entry.url || "", urlLabel: entry.urlLabel || "",
        reminderMode: ["auto", "none", "custom"].includes(entry.reminderMode) ? entry.reminderMode : "auto",
        customReminderAt: entry.reminderMode === "custom" ? entry.customReminderAt || "" : "",
        isTemplate: Boolean(entry.isTemplate), seriesId: entry.seriesId || "",
        recurrenceType: ["daily", "weekdays", "weekly", "monthly"].includes(entry.recurrenceType) ? entry.recurrenceType : "none",
        recurrenceInterval: Math.max(1, Number(entry.recurrenceInterval) || 1), repeatUntil: entry.repeatUntil || "",
        excludedDates: Array.isArray(entry.excludedDates) ? [...new Set(entry.excludedDates)].sort() : [],
        createdAt: entry.createdAt || isoNow(), updatedAt: entry.updatedAt || isoNow()
      }), STORES.scheduleEntries, "schedule");
      const scheduleSeriesResult = await prepareVersioned(snapshot.scheduleSeries, scheduleSeriesMap, (series) => ({
        id: series.id, title: series.title || "未命名固定日程", startDate: series.startDate || "", allDay: series.allDay !== false,
        startTime: series.allDay === false ? series.startTime || "" : "", endTime: series.allDay === false ? series.endTime || "" : "",
        timeSlots: scheduleTimeSlots(series),
        notes: series.notes || "", color: series.color || "#4f7df3", taskId: series.taskId || "", noteId: series.noteId || "", url: series.url || "", urlLabel: series.urlLabel || "", reminderMode: series.reminderMode === "none" ? "none" : "auto",
        recurrenceType: ["daily", "weekdays", "weekly", "monthly"].includes(series.recurrenceType) ? series.recurrenceType : "daily",
        recurrenceInterval: Math.max(1, Number(series.recurrenceInterval) || 1), weekdays: Array.isArray(series.weekdays) ? [...new Set(series.weekdays.map(Number).filter((day) => day >= 0 && day <= 6))].sort() : [],
        dayOfMonth: Math.min(31, Math.max(1, Number(series.dayOfMonth) || 1)), until: series.until || "", active: series.active !== false,
        createdAt: series.createdAt || isoNow(), updatedAt: series.updatedAt || isoNow()
      }), STORES.scheduleSeries, "scheduleSeries");
      const scheduleOccurrenceResult = await prepareVersioned(snapshot.scheduleOccurrenceStates, scheduleOccurrenceMap, (occurrence) => ({
        id: occurrence.id, seriesId: occurrence.seriesId || "", date: occurrence.date || "", completed: Boolean(occurrence.completed), deleted: Boolean(occurrence.deleted),
        override: occurrence.override && typeof occurrence.override === "object" ? occurrence.override : {}, updatedAt: occurrence.updatedAt || isoNow()
      }), STORES.scheduleOccurrenceStates, "scheduleOccurrence");
      const scheduleDailyNoteResult = await prepareVersioned(snapshot.scheduleDailyNotes, scheduleDailyNoteMap, (dailyNote) => ({ id: dailyNote.id || dailyNote.date, date: dailyNote.date || dailyNote.id || "", content: String(dailyNote.content || ""), updatedAt: dailyNote.updatedAt || isoNow() }), STORES.scheduleDailyNotes, "scheduleDailyNote");
      const whiteboardResult = await prepareVersioned(snapshot.whiteboards, whiteboardMap, (board) => this.whiteboardPayload(board), STORES.whiteboards, "whiteboard");
      const focusResult = await prepareVersioned(snapshot.focusSessions, focusSessionMap, (session) => ({ id: session.id, label: String(session.label || "专注"), taskId: session.taskId || "", scheduleEntryId: session.scheduleEntryId || "", phase: ["focus", "awaitingBreak", "break"].includes(session.phase) ? session.phase : "focus", status: ["active", "paused", "completed", "abandoned"].includes(session.status) ? session.status : "completed", focusMinutes: Math.max(1, Number(session.focusMinutes) || 25), breakMinutes: Math.max(1, Number(session.breakMinutes) || 5), startedAt: session.startedAt || isoNow(), phaseStartedAt: session.phaseStartedAt || session.startedAt || isoNow(), endsAt: session.endsAt || isoNow(), pausedAt: session.pausedAt || null, remainingMs: Math.max(0, Number(session.remainingMs) || 0), actualSeconds: Math.max(0, Number(session.actualSeconds) || 0), focusCompletedAt: session.focusCompletedAt || null, completedAt: session.completedAt || null, updatedAt: session.updatedAt || isoNow() }), STORES.focusSessions, "focusSession");
      const reviewResult = await prepareVersioned(snapshot.reviews, reviewMap, (review) => ({ id: review.id, periodType: ["daily", "weekly", "monthly"].includes(review.periodType) ? review.periodType : "daily", periodStart: review.periodStart || "", periodEnd: review.periodEnd || review.periodStart || "", answers: review.answers && typeof review.answers === "object" ? review.answers : {}, freeform: String(review.freeform || ""), metrics: review.metrics && typeof review.metrics === "object" ? review.metrics : { completedTasks: 0, completedSchedules: 0, focusSessions: 0, focusMinutes: 0 }, createdAt: review.createdAt || isoNow(), updatedAt: review.updatedAt || isoNow() }), STORES.reviews, "review");
      const goalResult = await prepareVersioned(snapshot.goals, goalMap, (goal) => ({ id: goal.id, title: String(goal.title || "未命名目标"), description: String(goal.description || ""), startDate: goal.startDate || "", dueDate: goal.dueDate || "", color: goal.color || "#4f7df3", status: ["active", "paused", "completed", "archived"].includes(goal.status) ? goal.status : "active", progressMode: goal.progressMode === "manual" ? "manual" : "automatic", manualProgress: Math.min(100, Math.max(0, Number(goal.manualProgress) || 0)), createdAt: goal.createdAt || isoNow(), updatedAt: goal.updatedAt || isoNow(), deletedAt: goal.deletedAt || null }), STORES.goals, "goal");
      const milestoneResult = await prepareVersioned(snapshot.milestones, milestoneMap, (milestone) => ({ id: milestone.id, goalId: milestone.goalId || "", title: String(milestone.title || "未命名里程碑"), dueDate: milestone.dueDate || "", weight: Math.max(1, Number(milestone.weight) || 1), taskIds: Array.isArray(milestone.taskIds) ? [...new Set(milestone.taskIds)] : [], completed: Boolean(milestone.completed), createdAt: milestone.createdAt || isoNow(), updatedAt: milestone.updatedAt || isoNow(), deletedAt: milestone.deletedAt || null }), STORES.milestones, "milestone");
      const changedScheduleCount = scheduleResult.changed.length + scheduleSeriesResult.changed.length + scheduleOccurrenceResult.changed.length + scheduleDailyNoteResult.changed.length;
      const operation = { id: makeId("op"), state: "pending", reason, createdAt: isoNow(), noteIds: changedNotes.map((item) => item.id), taskIds: taskResult.changed.map((item) => item.id), scheduleIds: scheduleResult.changed.map((item) => item.id), scheduleSeriesIds: scheduleSeriesResult.changed.map((item) => item.id), scheduleOccurrenceIds: scheduleOccurrenceResult.changed.map((item) => item.id), scheduleDailyNoteIds: scheduleDailyNoteResult.changed.map((item) => item.id), whiteboardIds: whiteboardResult.changed.map((item) => item.id) };
      await this.put(STORES.operations, operation);
      try {
        const transaction = this.db.transaction([STORES.notes, STORES.folders, STORES.files, STORES.tasks, STORES.taskFields, STORES.taskViews, STORES.scheduleEntries, STORES.scheduleSeries, STORES.scheduleOccurrenceStates, STORES.scheduleDailyNotes, STORES.whiteboards, STORES.focusSessions, STORES.reviews, STORES.goals, STORES.milestones, STORES.operations, STORES.meta], "readwrite");
        const notesStore = transaction.objectStore(STORES.notes), foldersStore = transaction.objectStore(STORES.folders), filesStore = transaction.objectStore(STORES.files);
        const tasksStore = transaction.objectStore(STORES.tasks), taskFieldsStore = transaction.objectStore(STORES.taskFields), taskViewsStore = transaction.objectStore(STORES.taskViews), scheduleStore = transaction.objectStore(STORES.scheduleEntries), scheduleSeriesStore = transaction.objectStore(STORES.scheduleSeries), scheduleOccurrenceStore = transaction.objectStore(STORES.scheduleOccurrenceStates), scheduleDailyNoteStore = transaction.objectStore(STORES.scheduleDailyNotes), whiteboardStore = transaction.objectStore(STORES.whiteboards), focusStore = transaction.objectStore(STORES.focusSessions), reviewStore = transaction.objectStore(STORES.reviews), goalStore = transaction.objectStore(STORES.goals), milestoneStore = transaction.objectStore(STORES.milestones);
        const nextNoteIds = new Set(preparedNotes.map((item) => item.id));
        const nextFolderIds = new Set(preparedFolders.map((item) => item.id));
        const nextFileIds = new Set(preparedFiles.map((item) => item.id));
        const nextTaskIds = new Set(taskResult.prepared.map((item) => item.id));
        const nextTaskFieldIds = new Set(fieldResult.prepared.map((item) => item.id));
        const nextTaskViewIds = new Set(viewResult.prepared.map((item) => item.id));
        const nextScheduleIds = new Set(scheduleResult.prepared.map((item) => item.id));
        const nextScheduleSeriesIds = new Set(scheduleSeriesResult.prepared.map((item) => item.id));
        const nextScheduleOccurrenceIds = new Set(scheduleOccurrenceResult.prepared.map((item) => item.id));
        const nextScheduleDailyNoteIds = new Set(scheduleDailyNoteResult.prepared.map((item) => item.id));
        const nextWhiteboardIds = new Set(whiteboardResult.prepared.map((item) => item.id));
        const nextFocusIds = new Set(focusResult.prepared.map((item) => item.id));
        const nextReviewIds = new Set(reviewResult.prepared.map((item) => item.id));
        const nextGoalIds = new Set(goalResult.prepared.map((item) => item.id));
        const nextMilestoneIds = new Set(milestoneResult.prepared.map((item) => item.id));
        preparedNotes.forEach((item) => { if (!noteMap.has(item.id) || noteMap.get(item.id).checksum !== item.checksum) notesStore.put(item); });
        preparedFolders.forEach((item) => { if (!folderMap.has(item.id) || folderMap.get(item.id).checksum !== item.checksum) foldersStore.put(item); });
        preparedFiles.forEach((item) => { if (!fileMap.has(item.id) || fileMap.get(item.id).checksum !== item.checksum) filesStore.put(item); });
        taskResult.prepared.forEach((item) => { if (taskMap.get(item.id)?.checksum !== item.checksum) tasksStore.put(item); });
        fieldResult.prepared.forEach((item) => { if (taskFieldMap.get(item.id)?.checksum !== item.checksum) taskFieldsStore.put(item); });
        viewResult.prepared.forEach((item) => { if (taskViewMap.get(item.id)?.checksum !== item.checksum) taskViewsStore.put(item); });
        scheduleResult.prepared.forEach((item) => { if (scheduleMap.get(item.id)?.checksum !== item.checksum) scheduleStore.put(item); });
        scheduleSeriesResult.prepared.forEach((item) => { if (scheduleSeriesMap.get(item.id)?.checksum !== item.checksum) scheduleSeriesStore.put(item); });
        scheduleOccurrenceResult.prepared.forEach((item) => { if (scheduleOccurrenceMap.get(item.id)?.checksum !== item.checksum) scheduleOccurrenceStore.put(item); });
        scheduleDailyNoteResult.prepared.forEach((item) => { if (scheduleDailyNoteMap.get(item.id)?.checksum !== item.checksum) scheduleDailyNoteStore.put(item); });
        whiteboardResult.prepared.forEach((item) => { if (whiteboardMap.get(item.id)?.checksum !== item.checksum) whiteboardStore.put(item); });
        focusResult.prepared.forEach((item) => { if (focusSessionMap.get(item.id)?.checksum !== item.checksum) focusStore.put(item); });
        reviewResult.prepared.forEach((item) => { if (reviewMap.get(item.id)?.checksum !== item.checksum) reviewStore.put(item); });
        goalResult.prepared.forEach((item) => { if (goalMap.get(item.id)?.checksum !== item.checksum) goalStore.put(item); });
        milestoneResult.prepared.forEach((item) => { if (milestoneMap.get(item.id)?.checksum !== item.checksum) milestoneStore.put(item); });
        const deleteKnownMissing = (records, nextIds, storeName, target) => records.forEach((item) => { if (!nextIds.has(item.id) && this.baselineHas(storeName, item.id)) target.delete(item.id); });
        deleteKnownMissing(existingNotes, nextNoteIds, STORES.notes, notesStore);
        deleteKnownMissing(existingFolders, nextFolderIds, STORES.folders, foldersStore);
        deleteKnownMissing(existingFiles, nextFileIds, STORES.files, filesStore);
        deleteKnownMissing(existingTasks, nextTaskIds, STORES.tasks, tasksStore);
        deleteKnownMissing(existingTaskFields, nextTaskFieldIds, STORES.taskFields, taskFieldsStore);
        deleteKnownMissing(existingTaskViews, nextTaskViewIds, STORES.taskViews, taskViewsStore);
        deleteKnownMissing(existingScheduleEntries, nextScheduleIds, STORES.scheduleEntries, scheduleStore);
        deleteKnownMissing(existingScheduleSeries, nextScheduleSeriesIds, STORES.scheduleSeries, scheduleSeriesStore);
        deleteKnownMissing(existingScheduleOccurrenceStates, nextScheduleOccurrenceIds, STORES.scheduleOccurrenceStates, scheduleOccurrenceStore);
        deleteKnownMissing(existingScheduleDailyNotes, nextScheduleDailyNoteIds, STORES.scheduleDailyNotes, scheduleDailyNoteStore);
        deleteKnownMissing(existingWhiteboards, nextWhiteboardIds, STORES.whiteboards, whiteboardStore);
        deleteKnownMissing(existingFocusSessions, nextFocusIds, STORES.focusSessions, focusStore);
        deleteKnownMissing(existingReviews, nextReviewIds, STORES.reviews, reviewStore);
        deleteKnownMissing(existingGoals, nextGoalIds, STORES.goals, goalStore);
        deleteKnownMissing(existingMilestones, nextMilestoneIds, STORES.milestones, milestoneStore);
        const committedAt = isoNow();
        transaction.objectStore(STORES.operations).put({ ...operation, state: "committed", committedAt });
        transaction.objectStore(STORES.meta).put({ key: "lastCommit", id: operation.id, committedAt, reason, changedNotes: changedNotes.length, changedTasks: taskResult.changed.length, changedTaskFields: fieldResult.changed.length, changedSchedules: changedScheduleCount, changedWhiteboards: whiteboardResult.changed.length, changedFocusSessions: focusResult.changed.length, changedReviews: reviewResult.changed.length, changedGoals: goalResult.changed.length, changedMilestones: milestoneResult.changed.length });
        transaction.objectStore(STORES.meta).put({ key: "backupDirty", value: true, commitId: operation.id, updatedAt: committedAt });
        await transactionDone(transaction);
        for (const expected of changedNotes) {
          const actual = await this.get(STORES.notes, expected.id);
          if (!actual || actual.revision !== expected.revision || actual.checksum !== expected.checksum) throw new Error(`笔记“${expected.title || "无标题"}”回读校验失败`);
        }
        for (const expected of [...taskResult.changed, ...fieldResult.changed, ...viewResult.changed, ...scheduleResult.changed, ...scheduleSeriesResult.changed, ...scheduleOccurrenceResult.changed, ...scheduleDailyNoteResult.changed, ...whiteboardResult.changed, ...focusResult.changed, ...reviewResult.changed, ...goalResult.changed, ...milestoneResult.changed]) {
          const store = taskResult.changed.includes(expected) ? STORES.tasks : fieldResult.changed.includes(expected) ? STORES.taskFields : viewResult.changed.includes(expected) ? STORES.taskViews : scheduleResult.changed.includes(expected) ? STORES.scheduleEntries : scheduleSeriesResult.changed.includes(expected) ? STORES.scheduleSeries : scheduleOccurrenceResult.changed.includes(expected) ? STORES.scheduleOccurrenceStates : scheduleDailyNoteResult.changed.includes(expected) ? STORES.scheduleDailyNotes : whiteboardResult.changed.includes(expected) ? STORES.whiteboards : focusResult.changed.includes(expected) ? STORES.focusSessions : reviewResult.changed.includes(expected) ? STORES.reviews : goalResult.changed.includes(expected) ? STORES.goals : STORES.milestones;
          const actual = await this.get(store, expected.id);
          if (!actual || actual.revision !== expected.revision || actual.checksum !== expected.checksum) throw new Error(`结构化数据“${expected.name || expected.title || expected.id}”回读校验失败`);
        }
        const preparedMap = new Map(preparedNotes.map((item) => [item.id, item]));
        (inputState.notes || []).forEach((note) => {
          const saved = preparedMap.get(note.id);
          if (saved) { note.revision = saved.revision; note.checksum = saved.checksum; }
        });
        const savedTasks = new Map(taskResult.prepared.map((item) => [item.id, item]));
        (inputState.tasks || []).forEach((task) => { const saved = savedTasks.get(task.id); if (saved) { task.revision = saved.revision; task.checksum = saved.checksum; } });
        const savedFields = new Map(fieldResult.prepared.map((item) => [item.id, item]));
        (inputState.taskFields || []).forEach((field) => { const saved = savedFields.get(field.id); if (saved) { field.revision = saved.revision; field.checksum = saved.checksum; } });
        const savedSchedules = new Map(scheduleResult.prepared.map((item) => [item.id, item]));
        (inputState.scheduleEntries || []).forEach((entry) => { const saved = savedSchedules.get(entry.id); if (saved) { entry.revision = saved.revision; entry.checksum = saved.checksum; } });
        const savedScheduleSeries = new Map(scheduleSeriesResult.prepared.map((item) => [item.id, item]));
        (inputState.scheduleSeries || []).forEach((series) => { const saved = savedScheduleSeries.get(series.id); if (saved) { series.revision = saved.revision; series.checksum = saved.checksum; } });
        const savedScheduleOccurrences = new Map(scheduleOccurrenceResult.prepared.map((item) => [item.id, item]));
        (inputState.scheduleOccurrenceStates || []).forEach((occurrence) => { const saved = savedScheduleOccurrences.get(occurrence.id); if (saved) { occurrence.revision = saved.revision; occurrence.checksum = saved.checksum; } });
        const savedScheduleDailyNotes = new Map(scheduleDailyNoteResult.prepared.map((item) => [item.id, item]));
        (inputState.scheduleDailyNotes || []).forEach((dailyNote) => { const saved = savedScheduleDailyNotes.get(dailyNote.id); if (saved) { dailyNote.revision = saved.revision; dailyNote.checksum = saved.checksum; } });
        const savedWhiteboards = new Map(whiteboardResult.prepared.map((item) => [item.id, item]));
        (inputState.whiteboards || []).forEach((board) => { const saved = savedWhiteboards.get(board.id); if (saved) { board.revision = saved.revision; board.checksum = saved.checksum; } });
        for (const [items, result] of [[inputState.focusSessions, focusResult], [inputState.reviews, reviewResult], [inputState.goals, goalResult], [inputState.milestones, milestoneResult]]) {
          const savedRecords = new Map(result.prepared.map((item) => [item.id, item]));
          (items || []).forEach((item) => { const saved = savedRecords.get(item.id); if (saved) { item.revision = saved.revision; item.checksum = saved.checksum; } });
        }
        await this.maybeCreateHistory(changedNotes, reason);
        await this.maybeCreateTaskHistory(taskResult.changed, fieldResult.changed, reason);
        for (const conflict of conflicts.filter((item) => item.kind !== "note")) await this.recordRecovery("multi-tab-conflict", `多页面冲突：${conflict.label || conflict.id}`, { kind: conflict.kind, local: conflict.local, remote: conflict.remote });
        for (const [storeName, records] of [[STORES.notes, changedNotes], [STORES.folders, folderResult.changed], [STORES.files, fileResult.changed], [STORES.tasks, taskResult.changed], [STORES.taskFields, fieldResult.changed], [STORES.taskViews, viewResult.changed], [STORES.scheduleEntries, scheduleResult.changed], [STORES.scheduleSeries, scheduleSeriesResult.changed], [STORES.scheduleOccurrenceStates, scheduleOccurrenceResult.changed], [STORES.scheduleDailyNotes, scheduleDailyNoteResult.changed], [STORES.whiteboards, whiteboardResult.changed], [STORES.focusSessions, focusResult.changed], [STORES.reviews, reviewResult.changed], [STORES.goals, goalResult.changed], [STORES.milestones, milestoneResult.changed]]) records.forEach((record) => this.updateBaseline(storeName, record));
        const conflictStores = { note: STORES.notes, folder: STORES.folders, file: STORES.files, task: STORES.tasks, taskField: STORES.taskFields, taskView: STORES.taskViews, schedule: STORES.scheduleEntries, scheduleSeries: STORES.scheduleSeries, scheduleOccurrence: STORES.scheduleOccurrenceStates, scheduleDailyNote: STORES.scheduleDailyNotes, whiteboard: STORES.whiteboards, focusSession: STORES.focusSessions, review: STORES.reviews, goal: STORES.goals, milestone: STORES.milestones };
        for (const conflict of conflicts) {
          const storeName = conflictStores[conflict.kind];
          if (!storeName) continue;
          if (conflict.remote) this.updateBaseline(storeName, conflict.remote);
          else this.removeBaseline(storeName, conflict.originalId || conflict.id);
        }
        for (const [storeName, existing, nextIds] of [[STORES.notes, existingNotes, nextNoteIds], [STORES.folders, existingFolders, nextFolderIds], [STORES.files, existingFiles, nextFileIds], [STORES.tasks, existingTasks, nextTaskIds], [STORES.taskFields, existingTaskFields, nextTaskFieldIds], [STORES.taskViews, existingTaskViews, nextTaskViewIds], [STORES.scheduleEntries, existingScheduleEntries, nextScheduleIds], [STORES.scheduleSeries, existingScheduleSeries, nextScheduleSeriesIds], [STORES.scheduleOccurrenceStates, existingScheduleOccurrenceStates, nextScheduleOccurrenceIds], [STORES.scheduleDailyNotes, existingScheduleDailyNotes, nextScheduleDailyNoteIds], [STORES.whiteboards, existingWhiteboards, nextWhiteboardIds], [STORES.focusSessions, existingFocusSessions, nextFocusIds], [STORES.reviews, existingReviews, nextReviewIds], [STORES.goals, existingGoals, nextGoalIds], [STORES.milestones, existingMilestones, nextMilestoneIds]]) existing.forEach((record) => { if (!nextIds.has(record.id) && this.baselineHas(storeName, record.id)) this.removeBaseline(storeName, record.id); });
        this.lastError = null;
        const totalChanges = changedNotes.length + folderResult.changed.length + fileResult.changed.length + taskResult.changed.length + fieldResult.changed.length + viewResult.changed.length + changedScheduleCount + whiteboardResult.changed.length + focusResult.changed.length + reviewResult.changed.length + goalResult.changed.length + milestoneResult.changed.length;
        return { committedAt, operationId: operation.id, reason, totalChanges, changedNotes: changedNotes.length, changedNoteIds: changedNotes.map((item) => item.id), changedTasks: taskResult.changed.length, changedTaskIds: taskResult.changed.map((item) => item.id), changedSchedules: changedScheduleCount, changedScheduleIds: [...scheduleResult.changed, ...scheduleSeriesResult.changed, ...scheduleOccurrenceResult.changed, ...scheduleDailyNoteResult.changed].map((item) => item.id), changedWhiteboards: whiteboardResult.changed.length, changedWhiteboardIds: whiteboardResult.changed.map((item) => item.id), changedFocusSessions: focusResult.changed.length, changedReviews: reviewResult.changed.length, changedGoals: goalResult.changed.length, changedMilestones: milestoneResult.changed.length, conflicts };
      } catch (error) {
        operation.state = "failed"; operation.failedAt = isoNow(); operation.error = String(error?.message || error);
        try { await this.put(STORES.operations, operation); } catch { /* preserve the original failure */ }
        throw error;
      }
    }

    queueSave(state, immediate = false, reason = "auto") {
      this.pendingSnapshot = structuredClone(state);
      if (reason !== "auto" || this.pendingReason === "auto") this.pendingReason = reason;
      this.emitStatus("dirty");
      const promise = new Promise((resolve) => this.pendingWaiters.push(resolve));
      clearTimeout(this.saveTimer);
      if (immediate) this.drainSaveQueue();
      else this.saveTimer = setTimeout(() => this.drainSaveQueue(), 500);
      return promise;
    }

    async drainSaveQueue() {
      clearTimeout(this.saveTimer);
      if (this.saving || !this.pendingSnapshot) return;
      this.saving = true;
      while (this.pendingSnapshot) {
        const snapshot = this.pendingSnapshot;
        const reason = this.pendingReason;
        const waiters = this.pendingWaiters.splice(0);
        this.pendingSnapshot = null;
        this.pendingReason = "auto";
        this.emitStatus("saving");
        try {
          let result = await this.saveState(snapshot, reason);
          await this.removeFailedSaveSnapshot().catch((error) => console.warn("EasyNote stale failed-save snapshot cleanup failed", error));
          result = await this.protectCommittedState(result, reason);
          this.emitStatus(this.pendingSnapshot ? "dirty" : "saved", { verifiedAt: result.committedAt, conflicts: result.conflicts?.length || 0 });
          if (result.conflicts?.length) window.dispatchEvent(new CustomEvent("easynote:sync-conflict", { detail: { conflicts: result.conflicts } }));
          if (result.totalChanges || result.conflicts?.length || result.reason === "danger") this.broadcastCommit(result);
          waiters.forEach((resolve) => resolve(!result.conflicts?.length));
        } catch (error) {
          console.error("EasyNote verified save failed", error);
          this.lastError = error;
          if (!this.pendingSnapshot) this.pendingSnapshot = snapshot;
          try { await this.writeFailedSaveSnapshot(snapshot, reason, error); }
          catch (protectionError) {
            this.lastProtectionError = protectionError;
            console.error("EasyNote failed-save protection also failed", protectionError);
            this.emitSafety({ failedSaveProtectionError: String(protectionError?.message || protectionError) });
          }
          this.emitStatus("failed", { error: String(error?.message || error) });
          waiters.forEach((resolve) => resolve(false));
          break;
        }
      }
      this.saving = false;
    }

    async flush() {
      if (this.pendingSnapshot) await this.drainSaveQueue();
      while (this.saving) await new Promise((resolve) => setTimeout(resolve, 25));
      if (this.pendingLocalBackupSnapshot) await this.runLocalAutomaticBackup();
      if (this.localBackupPromise) await this.localBackupPromise;
      return !this.pendingSnapshot && !this.lastError;
    }

    async retry() {
      if (!this.pendingSnapshot) return true;
      this.lastError = null;
      await this.drainSaveQueue();
      return !this.pendingSnapshot;
    }

    hasPendingWrites() { return Boolean(this.pendingSnapshot || this.saving || this.lastError); }

    async maybeCreateHistory(changedNotes, reason) {
      const force = ["manual", "switch", "danger", "import", "migration"].includes(reason);
      for (const note of changedNotes) {
        const existing = (await this.getAll(STORES.history)).filter((item) => item.noteId === note.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        if (existing[0]?.checksum === note.checksum) continue;
        if (!force && existing[0] && Date.now() - new Date(existing[0].createdAt).getTime() < BACKUP_INTERVAL) continue;
        await this.put(STORES.history, { id: makeId("history"), noteId: note.id, createdAt: isoNow(), reason, checksum: note.checksum, snapshot: { ...note } });
        await this.pruneHistory(note.id);
      }
    }

    async pruneHistory(noteId) {
      const all = (await this.getAll(STORES.history)).filter((item) => item.noteId === noteId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const cutoff = Date.now() - HISTORY_AGE;
      const remove = all.filter((item, index) => index >= HISTORY_LIMIT || new Date(item.createdAt).getTime() < cutoff);
      for (const item of remove) await this.remove(STORES.history, item.id);
    }

    async maybeCreateTaskHistory(changedTasks, changedFields, reason) {
      const force = ["manual", "switch", "danger", "import", "migration", "field-change"].includes(reason);
      for (const [kind, records] of [["task", changedTasks], ["field", changedFields]]) {
        for (const record of records) {
          const all = (await this.getAll(STORES.taskHistory)).filter((item) => item.entityId === record.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
          if (all[0]?.checksum === record.checksum) continue;
          if (!force && all[0] && Date.now() - new Date(all[0].createdAt).getTime() < BACKUP_INTERVAL) continue;
          await this.put(STORES.taskHistory, { id: makeId("task-history"), entityId: record.id, kind, createdAt: isoNow(), reason, checksum: record.checksum, snapshot: { ...record } });
          const cutoff = Date.now() - HISTORY_AGE;
          for (const [index, item] of all.entries()) if (index >= HISTORY_LIMIT - 1 || new Date(item.createdAt).getTime() < cutoff) await this.remove(STORES.taskHistory, item.id);
        }
      }
    }

    async getTaskHistory(entityId) {
      return (await this.getAll(STORES.taskHistory)).filter((item) => item.entityId === entityId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }

    async getTaskHistoryRecord(id) { return this.get(STORES.taskHistory, id); }

    async getHistory(noteId) {
      return (await this.getAll(STORES.history)).filter((item) => item.noteId === noteId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }

    async getHistorySnapshot(id) {
      const record = await this.get(STORES.history, id);
      if (!record) return null;
      return { ...record.snapshot, content: this.hydrateContent(record.snapshot.content || "") };
    }

    async recordRecovery(kind, label, payload) {
      const createdAt = isoNow();
      const record = { id: makeId("recovery"), kind, label, createdAt, expiresAt: new Date(Date.now() + HISTORY_AGE).toISOString(), payload: structuredClone(payload) };
      if (record.payload?.content) record.payload.content = this.dehydrateContent(record.payload.content);
      if (Array.isArray(record.payload?.notes)) record.payload.notes.forEach((note) => { note.content = this.dehydrateContent(note.content || ""); });
      await this.put(STORES.recovery, record);
      await this.pruneRecovery();
      return record;
    }

    async pruneRecovery() {
      const expired = (await this.getAll(STORES.recovery)).filter((item) => new Date(item.expiresAt).getTime() < Date.now());
      for (const item of expired) await this.remove(STORES.recovery, item.id);
    }

    async getRecoveryItems() { await this.pruneRecovery(); return (await this.getAll(STORES.recovery)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
    async getRecoveryPayload(id) {
      const record = await this.get(STORES.recovery, id);
      if (!record) return null;
      const payload = structuredClone(record.payload);
      if (payload?.content) payload.content = this.hydrateContent(payload.content);
      if (Array.isArray(payload?.notes)) payload.notes.forEach((note) => { note.content = this.hydrateContent(note.content || ""); });
      return { record, payload };
    }

    async storageInfo() {
      const result = { supported: Boolean(navigator.storage), persisted: false, usage: 0, quota: 0 };
      if (!navigator.storage) return result;
      try { result.persisted = await navigator.storage.persisted(); } catch { /* unsupported */ }
      try { Object.assign(result, await navigator.storage.estimate()); } catch { /* unsupported */ }
      return result;
    }

    async requestPersistence() {
      if (!navigator.storage?.persist) return false;
      const granted = await navigator.storage.persist();
      this.emitSafety({ persistenceChanged: true });
      return granted;
    }

    async getBackupPermission(request = false) {
      const handle = this.backupDirectoryHandle || (await this.get(STORES.settings, "backupDirectory"))?.value;
      if (!handle) return "unconfigured";
      this.backupDirectoryHandle = handle;
      const options = { mode: "readwrite" };
      let permission = await handle.queryPermission(options);
      if (permission !== "granted" && request) permission = await handle.requestPermission(options);
      return permission;
    }

    async chooseBackupDirectory({ backup = true } = {}) {
      if (!window.showDirectoryPicker) throw new Error("当前浏览器不支持自动目录备份，请使用最新版 Edge 或 Chrome");
      const handle = await window.showDirectoryPicker({ id: "easynote-backups", mode: "readwrite", startIn: "documents" });
      this.backupDirectoryHandle = handle;
      await this.put(STORES.settings, { key: "backupDirectory", value: handle, selectedAt: isoNow() });
      if (backup) await this.backupNow();
      return handle.name;
    }

    async writeDirectoryFile(directory, name, contents) {
      const handle = await directory.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      await writable.write(contents);
      await writable.close();
      return handle;
    }

    async buildBackupSnapshot() {
      const [notes, folders, files, tasks, taskFields, taskViews, scheduleEntries, scheduleSeries, scheduleOccurrenceStates, scheduleDailyNotes, whiteboards, focusSessions, reviews, goals, milestones, noteHistory, taskHistory, recovery, attachments, lastCommit] = await Promise.all([
        this.getAll(STORES.notes), this.getAll(STORES.folders), this.getAll(STORES.files),
        this.getAll(STORES.tasks), this.getAll(STORES.taskFields), this.getAll(STORES.taskViews),
        this.getAll(STORES.scheduleEntries), this.getAll(STORES.scheduleSeries), this.getAll(STORES.scheduleOccurrenceStates), this.getAll(STORES.scheduleDailyNotes), this.getAll(STORES.whiteboards), this.getAll(STORES.focusSessions), this.getAll(STORES.reviews), this.getAll(STORES.goals), this.getAll(STORES.milestones),
        this.getAll(STORES.history), this.getAll(STORES.taskHistory), this.getAll(STORES.recovery),
        this.getAll(STORES.attachments), this.get(STORES.meta, "lastCommit")
      ]);
      return {
        format: "easynote-directory-backup", version: 6, createdAt: isoNow(), commit: lastCommit || null,
        data: { notes, categories: folders, files, tasks, taskFields, taskViews, scheduleEntries, scheduleSeries, scheduleOccurrenceStates, scheduleDailyNotes, whiteboards, focusSessions, reviews, goals, milestones, noteHistory, taskHistory, recovery },
        attachments: attachments.map(({ blob, ...item }) => ({ ...item, file: `${item.sha256}.${mimeExtension(item.type)}` }))
      };
    }

    async backupNow() {
      const permission = await this.getBackupPermission(true);
      if (permission === "unconfigured") throw new Error("请先选择本地备份目录");
      if (permission !== "granted") throw new Error("没有备份目录写入权限");
      const selected = this.backupDirectoryHandle;
      const root = await selected.getDirectoryHandle("EasyNote-Backups", { create: true });
      const snapshotsDirectory = await root.getDirectoryHandle("snapshots", { create: true });
      const attachmentsDirectory = await root.getDirectoryHandle("attachments", { create: true });
      const snapshot = await this.buildBackupSnapshot();
      for (const descriptor of snapshot.attachments) {
        const record = this.attachmentRecords.get(descriptor.id) || await this.get(STORES.attachments, descriptor.id);
        if (!record?.blob) throw new Error(`附件 ${descriptor.name || descriptor.id} 无法读取`);
        let valid = false;
        try {
          const existing = await attachmentsDirectory.getFileHandle(descriptor.file);
          const file = await existing.getFile();
          valid = file.size === record.size && await sha256(file) === record.sha256;
        } catch { /* create below */ }
        if (!valid) {
          const tempName = `${descriptor.file}.pending`;
          const tempHandle = await this.writeDirectoryFile(attachmentsDirectory, tempName, record.blob);
          const tempFile = await tempHandle.getFile();
          if (tempFile.size !== record.size || await sha256(tempFile) !== record.sha256) throw new Error(`附件 ${descriptor.name || descriptor.id} 备份校验失败`);
          await this.writeDirectoryFile(attachmentsDirectory, descriptor.file, tempFile);
          await attachmentsDirectory.removeEntry(tempName);
        }
      }
      const stamp = snapshot.createdAt.replace(/[:.]/g, "-");
      const baseName = `easynote-${stamp}`;
      const json = JSON.stringify(snapshot, null, 2);
      const checksum = await sha256(json);
      const pendingName = `${baseName}.pending`;
      const pending = await this.writeDirectoryFile(snapshotsDirectory, pendingName, json);
      const pendingText = await (await pending.getFile()).text();
      if (await sha256(pendingText) !== checksum) throw new Error("快照写入后校验失败");
      await this.writeDirectoryFile(snapshotsDirectory, `${baseName}.json`, pendingText);
      await this.writeDirectoryFile(snapshotsDirectory, `${baseName}.ok`, JSON.stringify({ checksum, createdAt: snapshot.createdAt, commitId: snapshot.commit?.id || null }));
      await snapshotsDirectory.removeEntry(pendingName);
      await this.put(STORES.meta, { key: "lastBackup", createdAt: snapshot.createdAt, checksum, name: `${baseName}.json`, commitId: snapshot.commit?.id || null, directory: selected.name });
      await this.put(STORES.meta, { key: "backupDirty", value: false, commitId: snapshot.commit?.id || null, updatedAt: snapshot.createdAt });
      await this.rotateBackups(snapshotsDirectory);
      await this.pruneBackupAttachments(attachmentsDirectory, snapshotsDirectory);
      this.emitSafety({ backupCompleted: true, createdAt: snapshot.createdAt });
      return { createdAt: snapshot.createdAt, checksum, name: `${baseName}.json` };
    }

    async rotateBackups(directory) {
      const jsonNames = [];
      for await (const [name] of directory.entries()) if (/^easynote-.*\.json$/.test(name)) jsonNames.push(name);
      jsonNames.sort().reverse();
      const keep = new Set(jsonNames.slice(0, 24));
      const daily = new Set();
      const cutoff = Date.now() - 30 * DAY;
      for (const name of jsonNames) {
        const datePart = name.match(/easynote-(\d{4}-\d{2}-\d{2})/)?.[1];
        if (!datePart || new Date(`${datePart}T00:00:00`).getTime() < cutoff || daily.has(datePart)) continue;
        daily.add(datePart); keep.add(name);
      }
      for (const name of jsonNames) {
        if (keep.has(name)) continue;
        await directory.removeEntry(name);
        try { await directory.removeEntry(name.replace(/\.json$/, ".ok")); } catch { /* marker absent */ }
      }
    }

    async pruneBackupAttachments(attachmentsDirectory, snapshotsDirectory) {
      const referenced = new Set();
      for await (const [name, handle] of snapshotsDirectory.entries()) {
        if (!/^easynote-.*\.json$/.test(name) || handle.kind !== "file") continue;
        try {
          const snapshot = JSON.parse(await (await handle.getFile()).text());
          (snapshot.attachments || []).forEach((item) => { if (item.file) referenced.add(item.file); });
        } catch { /* invalid snapshots are ignored and never treated as valid references */ }
      }
      const cutoff = Date.now() - HISTORY_AGE;
      for await (const [name, handle] of attachmentsDirectory.entries()) {
        if (handle.kind !== "file" || name.endsWith(".pending") || referenced.has(name)) continue;
        const file = await handle.getFile();
        if (file.lastModified < cutoff) await attachmentsDirectory.removeEntry(name);
      }
    }

    async verifyLatestBackup() {
      const permission = await this.getBackupPermission(true);
      if (permission !== "granted") throw new Error("没有备份目录读取权限");
      const root = await this.backupDirectoryHandle.getDirectoryHandle("EasyNote-Backups");
      const directory = await root.getDirectoryHandle("snapshots");
      const markers = [];
      for await (const [name] of directory.entries()) if (/^easynote-.*\.ok$/.test(name)) markers.push(name);
      markers.sort().reverse();
      if (!markers.length) throw new Error("还没有完成的备份");
      const marker = JSON.parse(await (await (await directory.getFileHandle(markers[0])).getFile()).text());
      const jsonName = markers[0].replace(/\.ok$/, ".json");
      const text = await (await (await directory.getFileHandle(jsonName)).getFile()).text();
      if (await sha256(text) !== marker.checksum) throw new Error("最近备份校验失败");
      const parsed = JSON.parse(text);
      if (parsed.format !== "easynote-directory-backup" || !Array.isArray(parsed.data?.notes)) throw new Error("备份结构无效");
      const attachmentsDirectory = await root.getDirectoryHandle("attachments");
      for (const descriptor of parsed.attachments || []) {
        const file = await (await attachmentsDirectory.getFileHandle(descriptor.file)).getFile();
        if (file.size !== descriptor.size || await sha256(file) !== descriptor.sha256) throw new Error(`备份附件“${descriptor.name || descriptor.id}”校验失败`);
      }
      return { name: jsonName, createdAt: parsed.createdAt, notes: parsed.data.notes.length, tasks: parsed.data.tasks?.length || 0, schedules: parsed.data.scheduleEntries?.length || 0, whiteboards: parsed.data.whiteboards?.length || 0 };
    }

    async exportPortable(state, { allowMissingAttachments = false } = {}) {
      const snapshot = await this.prepareInlineAttachments(structuredClone(state));
      const dataUrlCache = new Map();
      const missingAttachments = new Set();
      const missingImageDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
      const getDataUrl = async (id) => {
        if (!dataUrlCache.has(id)) {
          const blob = this.getAttachmentBlob(id) || (await this.get(STORES.attachments, id))?.blob;
          if (!blob) {
            if (!allowMissingAttachments) throw new Error(`附件 ${id} 缺失`);
            missingAttachments.add(id || "unknown");
            dataUrlCache.set(id, missingImageDataUrl);
          } else dataUrlCache.set(id, await blobToDataUrl(blob));
        }
        return dataUrlCache.get(id);
      };
      for (const note of snapshot.notes || []) {
        const template = document.createElement("template");
        template.innerHTML = note.content || "";
        for (const image of template.content.querySelectorAll("img[data-attachment-id]")) {
          const id = image.dataset.attachmentId || "";
          image.src = await getDataUrl(id);
          if (missingAttachments.has(id)) { image.dataset.missingAttachmentId = id; delete image.dataset.attachmentId; }
        }
        note.content = template.innerHTML;
      }
      for (const file of snapshot.files || []) if (file.attachmentId) { file.dataUrl = await getDataUrl(file.attachmentId); if (missingAttachments.has(file.attachmentId)) { file.missingAttachmentId = file.attachmentId; delete file.attachmentId; } }
      for (const task of snapshot.tasks || []) {
        for (const value of Object.values(task.values || {})) {
          if (!Array.isArray(value)) continue;
           for (const descriptor of value) if (descriptor?.attachmentId) { descriptor.dataUrl = await getDataUrl(descriptor.attachmentId); if (missingAttachments.has(descriptor.attachmentId)) { descriptor.missingAttachmentId = descriptor.attachmentId; delete descriptor.attachmentId; } }
        }
      }
      for (const board of snapshot.whiteboards || []) {
        for (const node of board.nodes || []) if (node.type === "image" && node.attachmentId) { node.dataUrl = await getDataUrl(node.attachmentId); if (missingAttachments.has(node.attachmentId)) { node.missingAttachmentId = node.attachmentId; delete node.attachmentId; } }
      }
      const [noteHistory, taskHistory, recovery] = await Promise.all([this.getAll(STORES.history), this.getAll(STORES.taskHistory), this.getAll(STORES.recovery)]);
      return { ...snapshot, version: 8, format: "easynote-portable", exportedAt: isoNow(), missingAttachments: [...missingAttachments], safetyArchive: { noteHistory, taskHistory, recovery } };
    }

    async integrityCheck({ full = false } = {}) {
      const report = { checkedAt: isoNow(), full, ok: true, errors: [], warnings: [], counts: {} };
      try {
        const [notes, folders, files, tasks, taskFields, taskViews, scheduleEntries, scheduleSeries, scheduleOccurrenceStates, scheduleDailyNotes, whiteboards, focusSessions, reviews, goals, milestones, attachments, operations] = await Promise.all([
          this.getAll(STORES.notes), this.getAll(STORES.folders), this.getAll(STORES.files),
          this.getAll(STORES.tasks), this.getAll(STORES.taskFields), this.getAll(STORES.taskViews),
          this.getAll(STORES.scheduleEntries), this.getAll(STORES.scheduleSeries), this.getAll(STORES.scheduleOccurrenceStates), this.getAll(STORES.scheduleDailyNotes), this.getAll(STORES.whiteboards), this.getAll(STORES.focusSessions), this.getAll(STORES.reviews), this.getAll(STORES.goals), this.getAll(STORES.milestones), this.getAll(STORES.attachments), this.getAll(STORES.operations)
        ]);
        report.counts = { notes: notes.length, folders: folders.length, files: files.length, tasks: tasks.length, taskFields: taskFields.length, schedules: scheduleEntries.length, scheduleSeries: scheduleSeries.length, scheduleOccurrenceStates: scheduleOccurrenceStates.length, scheduleDailyNotes: scheduleDailyNotes.length, whiteboards: whiteboards.length, focusSessions: focusSessions.length, reviews: reviews.length, goals: goals.length, milestones: milestones.length, attachments: attachments.length };
        const folderIds = new Set(folders.map((item) => item.id));
        const attachmentIds = new Set(attachments.map((item) => item.id));
        const noteIds = new Set(notes.map((item) => item.id));
        const fieldIds = new Set(taskFields.map((item) => item.id));
        const taskIds = new Set(tasks.map((item) => item.id));
        const fieldsById = new Map(taskFields.map((item) => [item.id, item]));
        for (const note of notes) {
          const payload = this.notePayload(note);
          if (await sha256(stableStringify(payload)) !== note.checksum) report.errors.push(`笔记“${note.title || "无标题"}”校验值不一致`);
          if (note.categoryId && !folderIds.has(note.categoryId)) report.warnings.push(`笔记“${note.title || "无标题"}”引用了不存在的文件夹`);
          const template = document.createElement("template"); template.innerHTML = note.content || "";
          template.content.querySelectorAll("img[data-attachment-id]").forEach((image) => { if (!attachmentIds.has(image.dataset.attachmentId)) report.errors.push(`笔记“${note.title || "无标题"}”缺少图片附件`); });
        }
        for (const file of files) {
          if (file.folderId && !folderIds.has(file.folderId)) report.warnings.push(`文件“${file.name}”引用了不存在的文件夹`);
          if (!attachmentIds.has(file.attachmentId)) report.errors.push(`文件“${file.name}”缺少附件内容`);
        }
        const validValue = (field, value) => {
          if (value == null || value === "") return true;
          if (field.type === "multiSelect" || field.type === "attachment") return Array.isArray(value);
          if (field.type === "number") return typeof value === "number" && Number.isFinite(value);
          if (field.type === "checkbox") return typeof value === "boolean";
          return typeof value === "string";
        };
        for (const task of tasks) {
          const clean = { id: task.id, values: task.values || {}, sortOrder: Number(task.sortOrder) || 0, createdAt: task.createdAt, updatedAt: task.updatedAt, completedAt: task.completedAt || null, previousIncompleteProgress: Number.isFinite(task.previousIncompleteProgress) ? task.previousIncompleteProgress : null };
          if (await sha256(stableStringify(clean)) !== task.checksum) report.errors.push(`任务“${task.id}”校验值不一致`);
          for (const [fieldId, value] of Object.entries(task.values || {})) {
            if (!fieldIds.has(fieldId)) { report.warnings.push(`任务“${task.id}”含有已不存在字段的值`); continue; }
            const field = fieldsById.get(fieldId);
            if (!validValue(field, value)) report.errors.push(`任务“${task.id}”的“${field.name}”值类型不正确`);
            if (field.type === "noteLink" && value && !noteIds.has(value)) report.warnings.push(`任务“${task.id}”关联的笔记不存在`);
            if ((field.type === "singleSelect" || field.type === "multiSelect") && value) {
              const optionIds = new Set((field.options || []).map((option) => option.id)), values = Array.isArray(value) ? value : [value];
              if (values.some((id) => !optionIds.has(id))) report.warnings.push(`任务“${task.id}”引用了不存在的选项`);
            }
            if (field.type === "attachment") for (const item of value || []) if (!attachmentIds.has(item.attachmentId)) report.errors.push(`任务“${task.id}”缺少附件“${item.name || item.attachmentId}”`);
          }
        }
        for (const field of taskFields) {
          const clean = { id: field.id, name: field.name || "未命名字段", type: field.type || "text", description: field.description || "", systemRole: field.systemRole || "", required: Boolean(field.required), hidden: Boolean(field.hidden), width: Math.max(90, Number(field.width) || 160), options: Array.isArray(field.options) ? field.options : [], config: field.config && typeof field.config === "object" ? field.config : {}, order: Number(field.order) || 0, createdAt: field.createdAt || field.updatedAt, updatedAt: field.updatedAt || field.createdAt };
          if (await sha256(stableStringify(clean)) !== field.checksum) report.errors.push(`任务字段“${field.name || field.id}”校验值不一致`);
        }
        if (taskFields.length) {
          const titleFields = taskFields.filter((field) => field.systemRole === "title"), statusFields = taskFields.filter((field) => field.systemRole === "status"), progressFields = taskFields.filter((field) => field.systemRole === "progress");
          if (titleFields.length !== 1 || titleFields[0]?.type !== "text") report.errors.push("任务主标题字段结构无效");
          if (statusFields.length !== 1 || statusFields[0]?.type !== "singleSelect") report.errors.push("任务状态角色字段结构无效");
          if (progressFields.length !== 1 || progressFields[0]?.type !== "number" || progressFields[0]?.config?.format !== "percent") report.errors.push("任务进度角色字段结构无效");
          if (statusFields[0] && (!(statusFields[0].options || []).some((option) => option.isDone) || !(statusFields[0].options || []).some((option) => !option.isDone))) report.errors.push("任务状态字段缺少完成或未完成选项");
        }
        for (const view of taskViews) {
          const clean = { id: view.id || "main", tableGroupFieldId: view.tableGroupFieldId || "", boardGroupFieldId: view.boardGroupFieldId || "", filters: Array.isArray(view.filters) ? view.filters : [], sorts: Array.isArray(view.sorts) ? view.sorts : [], cardFieldIds: Array.isArray(view.cardFieldIds) ? view.cardFieldIds.slice(0, 5) : [], collapsedGroups: Array.isArray(view.collapsedGroups) ? view.collapsedGroups : [] };
          if (await sha256(stableStringify(clean)) !== view.checksum) report.errors.push(`任务视图“${view.id}”校验值不一致`);
        }
        const scheduleTemplateIds = new Set(scheduleEntries.filter((entry) => entry.isTemplate).map((entry) => entry.id));
        for (const entry of scheduleEntries) {
          const legacy = { id: entry.id, title: entry.title || "未命名日程", date: entry.date || "", allDay: entry.allDay !== false, startTime: entry.allDay === false ? entry.startTime || "" : "", endTime: entry.allDay === false ? entry.endTime || "" : "", notes: entry.notes || "", color: entry.color || "#4f7df3", completed: Boolean(entry.completed), taskId: entry.taskId || "", createdAt: entry.createdAt, updatedAt: entry.updatedAt };
          const slotsClean = { ...legacy, timeSlots: scheduleTimeSlots(entry) };
          const linkedClean = { ...legacy, noteId: entry.noteId || "", url: entry.url || "", urlLabel: entry.urlLabel || "" };
          const reminderClean = { ...linkedClean, reminderMode: ["auto", "none", "custom"].includes(entry.reminderMode) ? entry.reminderMode : "auto", customReminderAt: entry.reminderMode === "custom" ? entry.customReminderAt || "" : "" };
          const clean = { ...reminderClean, timeSlots: scheduleTimeSlots(entry), isTemplate: Boolean(entry.isTemplate), seriesId: entry.seriesId || "", recurrenceType: ["daily", "weekdays", "weekly", "monthly"].includes(entry.recurrenceType) ? entry.recurrenceType : "none", recurrenceInterval: Math.max(1, Number(entry.recurrenceInterval) || 1), repeatUntil: entry.repeatUntil || "", excludedDates: Array.isArray(entry.excludedDates) ? [...new Set(entry.excludedDates)].sort() : [] };
          const currentHash = await sha256(stableStringify(clean)), reminderHash = await sha256(stableStringify(reminderClean)), linkedHash = await sha256(stableStringify(linkedClean)), legacyHash = await sha256(stableStringify(legacy)), slotsHash = await sha256(stableStringify(slotsClean));
          if (currentHash !== entry.checksum && slotsHash !== entry.checksum && reminderHash !== entry.checksum && linkedHash !== entry.checksum && legacyHash !== entry.checksum) report.errors.push(`日程“${entry.title || entry.id}”校验值不一致`);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(clean.date) || Number.isNaN(new Date(`${clean.date}T12:00:00`).getTime())) report.errors.push(`日程“${entry.title || entry.id}”日期无效`);
          if (!clean.allDay && !/^\d{2}:\d{2}$/.test(clean.startTime)) report.errors.push(`日程“${entry.title || entry.id}”缺少有效开始时间`);
          if (!clean.allDay && clean.endTime && (!/^\d{2}:\d{2}$/.test(clean.endTime) || clean.endTime <= clean.startTime)) report.errors.push(`日程“${entry.title || entry.id}”结束时间无效`);
          if (clean.reminderMode === "custom" && (!clean.customReminderAt || Number.isNaN(new Date(clean.customReminderAt).getTime()))) report.errors.push(`日程“${entry.title || entry.id}”自定义提醒时间无效`);
          if (clean.repeatUntil && (!/^\d{4}-\d{2}-\d{2}$/.test(clean.repeatUntil) || clean.repeatUntil < clean.date)) report.errors.push(`固定日程“${entry.title || entry.id}”结束日期无效`);
          if (clean.seriesId && !scheduleTemplateIds.has(clean.seriesId)) report.warnings.push(`日程“${entry.title || entry.id}”关联的固定日程规则不存在`);
          if (clean.excludedDates.some((value) => !/^\d{4}-\d{2}-\d{2}$/.test(value))) report.errors.push(`固定日程“${entry.title || entry.id}”存在无效排除日期`);
          if (clean.taskId && !taskIds.has(clean.taskId)) report.warnings.push(`日程“${entry.title || entry.id}”关联的任务不存在`);
        }
        const seriesIds = new Set(scheduleSeries.map((series) => series.id));
        for (const series of scheduleSeries) {
          const legacySeries = { id: series.id, title: series.title || "未命名固定日程", startDate: series.startDate || "", allDay: series.allDay !== false, startTime: series.allDay === false ? series.startTime || "" : "", endTime: series.allDay === false ? series.endTime || "" : "", notes: series.notes || "", color: series.color || "#4f7df3", taskId: series.taskId || "", reminderMode: series.reminderMode === "none" ? "none" : "auto", recurrenceType: ["daily", "weekdays", "weekly", "monthly"].includes(series.recurrenceType) ? series.recurrenceType : "daily", recurrenceInterval: Math.max(1, Number(series.recurrenceInterval) || 1), weekdays: Array.isArray(series.weekdays) ? [...new Set(series.weekdays.map(Number).filter((day) => day >= 0 && day <= 6))].sort() : [], dayOfMonth: Math.min(31, Math.max(1, Number(series.dayOfMonth) || 1)), until: series.until || "", active: series.active !== false, createdAt: series.createdAt, updatedAt: series.updatedAt };
          const legacySeriesSlots = { ...legacySeries, timeSlots: scheduleTimeSlots(series) };
          const clean = { ...legacySeries, timeSlots: scheduleTimeSlots(series), noteId: series.noteId || "", url: series.url || "", urlLabel: series.urlLabel || "" };
          if (await sha256(stableStringify(clean)) !== series.checksum && await sha256(stableStringify(legacySeriesSlots)) !== series.checksum && await sha256(stableStringify(legacySeries)) !== series.checksum) report.errors.push(`固定日程“${clean.title}”校验值不一致`);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(clean.startDate)) report.errors.push(`固定日程“${clean.title}”开始日期无效`);
          if (clean.until && clean.until < clean.startDate) report.errors.push(`固定日程“${clean.title}”结束日期无效`);
          if (!clean.allDay && (!/^\d{2}:\d{2}$/.test(clean.startTime) || clean.endTime && clean.endTime <= clean.startTime)) report.errors.push(`固定日程“${clean.title}”时间范围无效`);
          if (clean.taskId && !taskIds.has(clean.taskId)) report.warnings.push(`固定日程“${clean.title}”关联任务不存在`);
        }
        for (const occurrence of scheduleOccurrenceStates) {
          const clean = { id: occurrence.id, seriesId: occurrence.seriesId || "", date: occurrence.date || "", completed: Boolean(occurrence.completed), deleted: Boolean(occurrence.deleted), override: occurrence.override && typeof occurrence.override === "object" ? occurrence.override : {}, updatedAt: occurrence.updatedAt };
          if (await sha256(stableStringify(clean)) !== occurrence.checksum) report.errors.push(`固定日程单次状态“${occurrence.id}”校验值不一致`);
          if (!seriesIds.has(clean.seriesId)) report.warnings.push(`固定日程单次状态“${occurrence.id}”关联规则不存在`);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(clean.date)) report.errors.push(`固定日程单次状态“${occurrence.id}”日期无效`);
        }
        for (const dailyNote of scheduleDailyNotes) {
          const clean = { id: dailyNote.id || dailyNote.date, date: dailyNote.date || dailyNote.id || "", content: String(dailyNote.content || ""), updatedAt: dailyNote.updatedAt };
          if (await sha256(stableStringify(clean)) !== dailyNote.checksum) report.errors.push(`日程便签“${clean.date}”校验值不一致`);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(clean.date)) report.errors.push(`日程便签“${clean.id}”日期无效`);
        }
        const verifyExtension = async (record, label) => {
          const { checksum, revision, ...clean } = record;
          if (await sha256(stableStringify(clean)) !== checksum) report.errors.push(`${label}“${record.title || record.label || record.id}”校验值不一致`);
        };
        for (const session of focusSessions) {
          await verifyExtension(session, "专注记录");
          if (session.taskId && !taskIds.has(session.taskId)) report.warnings.push(`专注记录“${session.label}”关联任务不存在`);
          if (!['active','paused','completed','abandoned'].includes(session.status)) report.errors.push(`专注记录“${session.label}”状态无效`);
        }
        for (const review of reviews) {
          await verifyExtension(review, "复盘");
          if (!['daily','weekly','monthly'].includes(review.periodType) || !/^\d{4}-\d{2}-\d{2}$/.test(review.periodStart)) report.errors.push(`复盘“${review.id}”周期无效`);
        }
        const goalIds = new Set(goals.filter((goal) => !goal.deletedAt).map((goal) => goal.id));
        for (const goal of goals) await verifyExtension(goal, "长期目标");
        for (const milestone of milestones) {
          await verifyExtension(milestone, "里程碑");
          if (!milestone.deletedAt && !goalIds.has(milestone.goalId)) report.warnings.push(`里程碑“${milestone.title}”关联目标不存在`);
          for (const taskId of milestone.taskIds || []) if (!taskIds.has(taskId)) report.warnings.push(`里程碑“${milestone.title}”关联任务不存在`);
        }
        for (const board of whiteboards) {
          const clean = this.whiteboardPayload(board);
          if (await sha256(stableStringify(clean)) !== board.checksum) report.errors.push(`白板“${board.title || board.id}”校验值不一致`);
          const boardNodeIds = new Set(), groups = new Set();
          for (const node of clean.nodes) {
            if (!node.id || boardNodeIds.has(node.id)) report.errors.push(`白板“${clean.title}”存在重复或无效卡片 ID`);
            boardNodeIds.add(node.id);
            if (node.type === "group") groups.add(node.id);
            if (node.type === "note" && node.noteId && !noteIds.has(node.noteId)) report.warnings.push(`白板“${clean.title}”引用的笔记已不存在`);
            if (node.type === "task" && node.taskId && !taskIds.has(node.taskId)) report.warnings.push(`白板“${clean.title}”引用的任务已不存在`);
            if (node.type === "image" && !attachmentIds.has(node.attachmentId)) report.errors.push(`白板“${clean.title}”缺少图片附件`);
          }
          for (const node of clean.nodes) if (node.groupId && !groups.has(node.groupId)) report.errors.push(`白板“${clean.title}”卡片引用了不存在的分组`);
          const edgeIds = new Set();
          for (const edge of clean.edges) {
            if (!edge.id || edgeIds.has(edge.id)) report.errors.push(`白板“${clean.title}”存在重复或无效连线 ID`);
            edgeIds.add(edge.id);
            if (edge.sourceId === edge.targetId || !boardNodeIds.has(edge.sourceId) || !boardNodeIds.has(edge.targetId)) report.errors.push(`白板“${clean.title}”存在无效连线`);
          }
        }
        for (const attachment of attachments) {
          if (!(attachment.blob instanceof Blob) || attachment.blob.size !== attachment.size) report.errors.push(`附件“${attachment.name || attachment.id}”大小不一致`);
          else if (full && await sha256(attachment.blob) !== attachment.sha256) report.errors.push(`附件“${attachment.name || attachment.id}”内容校验失败`);
        }
        const pending = operations.filter((item) => item.state === "pending");
        if (pending.length) report.warnings.push(`发现 ${pending.length} 条未完成写入，原子事务数据未被采用`);
      } catch (error) { report.errors.push(String(error?.message || error)); }
      report.ok = report.errors.length === 0;
      this.integrityReport = report;
      await this.put(STORES.meta, { key: "integrity", ...report });
      this.emitSafety({ integrity: report });
      return report;
    }

    async safetySummary() {
      const [storage, lastCommit, lastBackup, backupDirty, lastRescueSnapshot, lastLocalAutomaticBackup] = await Promise.all([
        this.storageInfo(), this.get(STORES.meta, "lastCommit"), this.get(STORES.meta, "lastBackup"), this.get(STORES.meta, "backupDirty"),
        this.get(STORES.meta, "lastRescueSnapshot"), this.get(STORES.meta, "lastLocalAutomaticBackup")
      ]);
      let backupPermission = "unconfigured";
      try { backupPermission = await this.getBackupPermission(false); } catch { backupPermission = "denied"; }
      return { storage, lastCommit, lastBackup, backupDirty, lastRescueSnapshot, lastLocalAutomaticBackup, backupPermission, integrity: this.integrityReport, pending: this.hasPendingWrites(), status: this.lastStatus, lastError: this.lastError?.message || null, protectionError: this.lastProtectionError?.message || null };
    }

    startAutomaticBackup() {
      clearInterval(this.autoBackupTimer);
      this.autoBackupTimer = setInterval(async () => {
        try {
          const dirty = await this.get(STORES.meta, "backupDirty");
          if (dirty?.value && await this.getBackupPermission(false) === "granted") await this.backupNow();
        } catch (error) { this.emitSafety({ backupError: String(error?.message || error) }); }
      }, BACKUP_INTERVAL);
      setTimeout(async () => {
        try {
          const dirty = await this.get(STORES.meta, "backupDirty");
          if (dirty?.value && await this.getBackupPermission(false) === "granted") await this.backupNow();
        } catch { /* the safety center will show permission or backup errors */ }
      }, 5000);
    }
  }

export { EasyNoteDataSafety, sha256, dataUrlToBlob, blobToDataUrl };
