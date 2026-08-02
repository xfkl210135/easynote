// @ts-nocheck -- compatibility module; typed boundaries live in services/data-repository.ts.
"use strict";

  const DB_NAME = "easynote-db";
  const DB_VERSION = 7;
  const DAY = 86400000;
  const HISTORY_LIMIT = 50;
  const HISTORY_AGE = 30 * DAY;
  const BACKUP_INTERVAL = 10 * 60 * 1000;
  const STORES = {
    legacy: "app-state", notes: "notes", folders: "folders", files: "fileEntries",
    attachments: "attachments", history: "history", recovery: "recovery",
    operations: "operations", meta: "meta", settings: "settings",
    tasks: "tasks", taskFields: "taskFields", taskViews: "taskViews", taskHistory: "taskHistory",
    scheduleEntries: "scheduleEntries", scheduleSeries: "scheduleSeries", scheduleOccurrenceStates: "scheduleOccurrenceStates", scheduleDailyNotes: "scheduleDailyNotes", whiteboards: "whiteboards"
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
    if (value instanceof Blob) buffer = await value.arrayBuffer();
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
      this.integrityReport = null;
      this.backupDirectoryHandle = null;
      this.wasEmpty = false;
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
      return this.db;
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

    async load() {
      await this.open();
      this.backupDirectoryHandle = (await this.get(STORES.settings, "backupDirectory"))?.value || null;
      let notes = await this.getAll(STORES.notes);
      const legacy = await this.get(STORES.legacy, "main");
      if (!notes.length && legacy?.notes?.length) {
        await this.saveState(structuredClone(legacy), "migration");
        notes = await this.getAll(STORES.notes);
        await this.put(STORES.meta, { key: "migration", state: "verified", migratedAt: isoNow(), source: "app-state/main", legacyRetained: true });
      }
      const attachments = await this.getAll(STORES.attachments);
      attachments.forEach((record) => this.attachmentRecords.set(record.id, record));
      const [folders, files, tasks, taskFields, taskViews, scheduleEntries, scheduleSeries, scheduleOccurrenceStates, scheduleDailyNotes, whiteboards] = await Promise.all([
        this.getAll(STORES.folders), this.getAll(STORES.files), this.getAll(STORES.tasks),
        this.getAll(STORES.taskFields), this.getAll(STORES.taskViews), this.getAll(STORES.scheduleEntries), this.getAll(STORES.scheduleSeries), this.getAll(STORES.scheduleOccurrenceStates), this.getAll(STORES.scheduleDailyNotes), this.getAll(STORES.whiteboards)
      ]);
      if (!notes.length && !folders.length && !files.length && !tasks.length && !taskFields.length && !taskViews.length && !scheduleEntries.length && !scheduleSeries.length && !scheduleOccurrenceStates.length && !scheduleDailyNotes.length && !whiteboards.length) { this.wasEmpty = true; return null; }
      const state = {
        version: 8,
        categories: folders.map(({ checksum, ...folder }) => folder),
        files: files.map(({ checksum, ...file }) => file),
        notes: notes.map((note) => ({ ...note, content: this.hydrateContent(note.content || "") })),
        tasks: tasks.map(({ checksum, ...task }) => task),
        taskFields: taskFields.map(({ checksum, ...field }) => field),
        taskViews: taskViews.map(({ checksum, ...view }) => view),
        scheduleEntries: scheduleEntries.map(({ checksum, ...entry }) => entry),
        scheduleSeries: scheduleSeries.map(({ checksum, ...series }) => series),
        scheduleOccurrenceStates: scheduleOccurrenceStates.map(({ checksum, ...occurrence }) => occurrence),
        scheduleDailyNotes: scheduleDailyNotes.map(({ checksum, ...dailyNote }) => dailyNote),
        whiteboards: whiteboards.map(({ checksum, ...board }) => board)
      };
      const lastCommit = await this.get(STORES.meta, "lastCommit");
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

    async prepareInlineAttachments(snapshot) {
      for (const note of snapshot.notes || []) {
        const template = document.createElement("template");
        template.innerHTML = note.content || "";
        for (const image of template.content.querySelectorAll("img")) {
          const source = image.getAttribute("src") || "";
          if (!image.dataset.attachmentId && source.startsWith("data:image/")) {
            const attachment = await this.putAttachment(dataUrlToBlob(source), { name: image.alt || "笔记图片" });
            image.dataset.attachmentId = attachment.id;
            image.src = attachment.url;
          }
        }
        note.content = template.innerHTML;
      }
      for (const file of snapshot.files || []) {
        if (!file.attachmentId && file.dataUrl) {
          const attachment = await this.putAttachment(dataUrlToBlob(file.dataUrl), { name: file.name, type: file.type });
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
          if (node.type !== "image" || node.attachmentId || !node.dataUrl) continue;
          const attachment = await this.putAttachment(dataUrlToBlob(node.dataUrl), { name: node.title || "白板图片" });
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
      const [existingNotes, existingFolders, existingFiles, existingTasks, existingTaskFields, existingTaskViews, existingScheduleEntries, existingScheduleSeries, existingScheduleOccurrenceStates, existingScheduleDailyNotes, existingWhiteboards] = await Promise.all([
        this.getAll(STORES.notes), this.getAll(STORES.folders), this.getAll(STORES.files),
        this.getAll(STORES.tasks), this.getAll(STORES.taskFields), this.getAll(STORES.taskViews), this.getAll(STORES.scheduleEntries), this.getAll(STORES.scheduleSeries), this.getAll(STORES.scheduleOccurrenceStates), this.getAll(STORES.scheduleDailyNotes), this.getAll(STORES.whiteboards)
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
      const preparedNotes = [];
      const changedNotes = [];
      for (const note of snapshot.notes || []) {
        const payload = this.notePayload(note);
        const checksum = await sha256(stableStringify(payload));
        const previous = noteMap.get(note.id);
        const record = { ...payload, revision: previous?.checksum === checksum ? previous.revision || 1 : (previous?.revision || 0) + 1, checksum };
        preparedNotes.push(record);
        if (!previous || previous.checksum !== checksum) changedNotes.push(record);
      }
      const preparedFolders = await Promise.all((snapshot.categories || []).map(async (folder) => {
        const clean = { id: folder.id, name: folder.name || "未命名文件夹", color: folder.color || "", parentId: folder.parentId || null };
        return { ...clean, checksum: await sha256(stableStringify(clean)) };
      }));
      const preparedFiles = await Promise.all((snapshot.files || []).map(async (file) => {
        const clean = { id: file.id, name: file.name || "本地文件", type: file.type || "application/octet-stream", size: file.size || 0, folderId: file.folderId || "", attachmentId: file.attachmentId || "", createdAt: file.createdAt || isoNow() };
        return { ...clean, checksum: await sha256(stableStringify(clean)) };
      }));
      const prepareVersioned = async (items, previousMap, cleanItem) => {
        const prepared = [], changed = [];
        for (const item of items || []) {
          const clean = cleanItem(item), checksum = await sha256(stableStringify(clean)), previous = previousMap.get(item.id);
          const record = { ...clean, revision: previous?.checksum === checksum ? previous.revision || 1 : (previous?.revision || 0) + 1, checksum };
          prepared.push(record);
          if (!previous || previous.checksum !== checksum) changed.push(record);
        }
        return { prepared, changed };
      };
      const taskResult = await prepareVersioned(snapshot.tasks, taskMap, (task) => ({
        id: task.id, values: task.values && typeof task.values === "object" ? task.values : {}, sortOrder: Number(task.sortOrder) || 0,
        createdAt: task.createdAt || isoNow(), updatedAt: task.updatedAt || isoNow(), completedAt: task.completedAt || null,
        previousIncompleteProgress: Number.isFinite(task.previousIncompleteProgress) ? task.previousIncompleteProgress : null
      }));
      const fieldResult = await prepareVersioned(snapshot.taskFields, taskFieldMap, (field) => ({
        id: field.id, name: field.name || "未命名字段", type: field.type || "text", description: field.description || "",
        systemRole: field.systemRole || "", required: Boolean(field.required), hidden: Boolean(field.hidden), width: Math.max(90, Number(field.width) || 160),
        options: Array.isArray(field.options) ? field.options : [], config: field.config && typeof field.config === "object" ? field.config : {},
        order: Number(field.order) || 0, createdAt: field.createdAt || isoNow(), updatedAt: field.updatedAt || isoNow()
      }));
      const viewResult = await prepareVersioned(snapshot.taskViews, taskViewMap, (view) => ({
        id: view.id || "main", tableGroupFieldId: view.tableGroupFieldId || "", boardGroupFieldId: view.boardGroupFieldId || "",
        filters: Array.isArray(view.filters) ? view.filters : [], sorts: Array.isArray(view.sorts) ? view.sorts : [],
        cardFieldIds: Array.isArray(view.cardFieldIds) ? view.cardFieldIds.slice(0, 5) : [], collapsedGroups: Array.isArray(view.collapsedGroups) ? view.collapsedGroups : []
      }));
      const scheduleResult = await prepareVersioned(snapshot.scheduleEntries, scheduleMap, (entry) => ({
        id: entry.id, title: entry.title || "未命名日程", date: entry.date || "", allDay: entry.allDay !== false,
        startTime: entry.allDay === false ? entry.startTime || "" : "", endTime: entry.allDay === false ? entry.endTime || "" : "",
        notes: entry.notes || "", color: entry.color || "#4f7df3", completed: Boolean(entry.completed), taskId: entry.taskId || "",
        reminderMode: ["auto", "none", "custom"].includes(entry.reminderMode) ? entry.reminderMode : "auto",
        customReminderAt: entry.reminderMode === "custom" ? entry.customReminderAt || "" : "",
        isTemplate: Boolean(entry.isTemplate), seriesId: entry.seriesId || "",
        recurrenceType: ["daily", "weekdays", "weekly", "monthly"].includes(entry.recurrenceType) ? entry.recurrenceType : "none",
        recurrenceInterval: Math.max(1, Number(entry.recurrenceInterval) || 1), repeatUntil: entry.repeatUntil || "",
        excludedDates: Array.isArray(entry.excludedDates) ? [...new Set(entry.excludedDates)].sort() : [],
        createdAt: entry.createdAt || isoNow(), updatedAt: entry.updatedAt || isoNow()
      }));
      const scheduleSeriesResult = await prepareVersioned(snapshot.scheduleSeries, scheduleSeriesMap, (series) => ({
        id: series.id, title: series.title || "未命名固定日程", startDate: series.startDate || "", allDay: series.allDay !== false,
        startTime: series.allDay === false ? series.startTime || "" : "", endTime: series.allDay === false ? series.endTime || "" : "",
        notes: series.notes || "", color: series.color || "#4f7df3", taskId: series.taskId || "", reminderMode: series.reminderMode === "none" ? "none" : "auto",
        recurrenceType: ["daily", "weekdays", "weekly", "monthly"].includes(series.recurrenceType) ? series.recurrenceType : "daily",
        recurrenceInterval: Math.max(1, Number(series.recurrenceInterval) || 1), weekdays: Array.isArray(series.weekdays) ? [...new Set(series.weekdays.map(Number).filter((day) => day >= 0 && day <= 6))].sort() : [],
        dayOfMonth: Math.min(31, Math.max(1, Number(series.dayOfMonth) || 1)), until: series.until || "", active: series.active !== false,
        createdAt: series.createdAt || isoNow(), updatedAt: series.updatedAt || isoNow()
      }));
      const scheduleOccurrenceResult = await prepareVersioned(snapshot.scheduleOccurrenceStates, scheduleOccurrenceMap, (occurrence) => ({
        id: occurrence.id, seriesId: occurrence.seriesId || "", date: occurrence.date || "", completed: Boolean(occurrence.completed), deleted: Boolean(occurrence.deleted),
        override: occurrence.override && typeof occurrence.override === "object" ? occurrence.override : {}, updatedAt: occurrence.updatedAt || isoNow()
      }));
      const scheduleDailyNoteResult = await prepareVersioned(snapshot.scheduleDailyNotes, scheduleDailyNoteMap, (dailyNote) => ({ id: dailyNote.id || dailyNote.date, date: dailyNote.date || dailyNote.id || "", content: String(dailyNote.content || ""), updatedAt: dailyNote.updatedAt || isoNow() }));
      const whiteboardResult = await prepareVersioned(snapshot.whiteboards, whiteboardMap, (board) => this.whiteboardPayload(board));
      const changedScheduleCount = scheduleResult.changed.length + scheduleSeriesResult.changed.length + scheduleOccurrenceResult.changed.length + scheduleDailyNoteResult.changed.length;
      const operation = { id: makeId("op"), state: "pending", reason, createdAt: isoNow(), noteIds: changedNotes.map((item) => item.id), taskIds: taskResult.changed.map((item) => item.id), scheduleIds: scheduleResult.changed.map((item) => item.id), scheduleSeriesIds: scheduleSeriesResult.changed.map((item) => item.id), scheduleOccurrenceIds: scheduleOccurrenceResult.changed.map((item) => item.id), scheduleDailyNoteIds: scheduleDailyNoteResult.changed.map((item) => item.id), whiteboardIds: whiteboardResult.changed.map((item) => item.id) };
      await this.put(STORES.operations, operation);
      try {
        const transaction = this.db.transaction([STORES.notes, STORES.folders, STORES.files, STORES.tasks, STORES.taskFields, STORES.taskViews, STORES.scheduleEntries, STORES.scheduleSeries, STORES.scheduleOccurrenceStates, STORES.scheduleDailyNotes, STORES.whiteboards, STORES.operations, STORES.meta], "readwrite");
        const notesStore = transaction.objectStore(STORES.notes), foldersStore = transaction.objectStore(STORES.folders), filesStore = transaction.objectStore(STORES.files);
        const tasksStore = transaction.objectStore(STORES.tasks), taskFieldsStore = transaction.objectStore(STORES.taskFields), taskViewsStore = transaction.objectStore(STORES.taskViews), scheduleStore = transaction.objectStore(STORES.scheduleEntries), scheduleSeriesStore = transaction.objectStore(STORES.scheduleSeries), scheduleOccurrenceStore = transaction.objectStore(STORES.scheduleOccurrenceStates), scheduleDailyNoteStore = transaction.objectStore(STORES.scheduleDailyNotes), whiteboardStore = transaction.objectStore(STORES.whiteboards);
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
        existingNotes.forEach((item) => { if (!nextNoteIds.has(item.id)) notesStore.delete(item.id); });
        existingFolders.forEach((item) => { if (!nextFolderIds.has(item.id)) foldersStore.delete(item.id); });
        existingFiles.forEach((item) => { if (!nextFileIds.has(item.id)) filesStore.delete(item.id); });
        existingTasks.forEach((item) => { if (!nextTaskIds.has(item.id)) tasksStore.delete(item.id); });
        existingTaskFields.forEach((item) => { if (!nextTaskFieldIds.has(item.id)) taskFieldsStore.delete(item.id); });
        existingTaskViews.forEach((item) => { if (!nextTaskViewIds.has(item.id)) taskViewsStore.delete(item.id); });
        existingScheduleEntries.forEach((item) => { if (!nextScheduleIds.has(item.id)) scheduleStore.delete(item.id); });
        existingScheduleSeries.forEach((item) => { if (!nextScheduleSeriesIds.has(item.id)) scheduleSeriesStore.delete(item.id); });
        existingScheduleOccurrenceStates.forEach((item) => { if (!nextScheduleOccurrenceIds.has(item.id)) scheduleOccurrenceStore.delete(item.id); });
        existingScheduleDailyNotes.forEach((item) => { if (!nextScheduleDailyNoteIds.has(item.id)) scheduleDailyNoteStore.delete(item.id); });
        existingWhiteboards.forEach((item) => { if (!nextWhiteboardIds.has(item.id)) whiteboardStore.delete(item.id); });
        const committedAt = isoNow();
        transaction.objectStore(STORES.operations).put({ ...operation, state: "committed", committedAt });
        transaction.objectStore(STORES.meta).put({ key: "lastCommit", id: operation.id, committedAt, reason, changedNotes: changedNotes.length, changedTasks: taskResult.changed.length, changedTaskFields: fieldResult.changed.length, changedSchedules: changedScheduleCount, changedWhiteboards: whiteboardResult.changed.length });
        transaction.objectStore(STORES.meta).put({ key: "backupDirty", value: true, commitId: operation.id, updatedAt: committedAt });
        await transactionDone(transaction);
        for (const expected of changedNotes) {
          const actual = await this.get(STORES.notes, expected.id);
          if (!actual || actual.revision !== expected.revision || actual.checksum !== expected.checksum) throw new Error(`笔记“${expected.title || "无标题"}”回读校验失败`);
        }
        for (const expected of [...taskResult.changed, ...fieldResult.changed, ...viewResult.changed, ...scheduleResult.changed, ...scheduleSeriesResult.changed, ...scheduleOccurrenceResult.changed, ...scheduleDailyNoteResult.changed, ...whiteboardResult.changed]) {
          const store = taskResult.changed.includes(expected) ? STORES.tasks : fieldResult.changed.includes(expected) ? STORES.taskFields : viewResult.changed.includes(expected) ? STORES.taskViews : scheduleResult.changed.includes(expected) ? STORES.scheduleEntries : scheduleSeriesResult.changed.includes(expected) ? STORES.scheduleSeries : scheduleOccurrenceResult.changed.includes(expected) ? STORES.scheduleOccurrenceStates : scheduleDailyNoteResult.changed.includes(expected) ? STORES.scheduleDailyNotes : STORES.whiteboards;
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
        await this.maybeCreateHistory(changedNotes, reason);
        await this.maybeCreateTaskHistory(taskResult.changed, fieldResult.changed, reason);
        this.lastError = null;
        return { committedAt, operationId: operation.id, changedNotes: changedNotes.length, changedTasks: taskResult.changed.length, changedSchedules: changedScheduleCount, changedWhiteboards: whiteboardResult.changed.length };
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
          const result = await this.saveState(snapshot, reason);
          this.emitStatus(this.pendingSnapshot ? "dirty" : "saved", { verifiedAt: result.committedAt });
          waiters.forEach((resolve) => resolve(true));
        } catch (error) {
          console.error("EasyNote verified save failed", error);
          this.lastError = error;
          if (!this.pendingSnapshot) this.pendingSnapshot = snapshot;
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

    async chooseBackupDirectory() {
      if (!window.showDirectoryPicker) throw new Error("当前浏览器不支持自动目录备份，请使用最新版 Edge 或 Chrome");
      const handle = await window.showDirectoryPicker({ id: "easynote-backups", mode: "readwrite", startIn: "documents" });
      this.backupDirectoryHandle = handle;
      await this.put(STORES.settings, { key: "backupDirectory", value: handle, selectedAt: isoNow() });
      await this.backupNow();
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
      const [notes, folders, files, tasks, taskFields, taskViews, scheduleEntries, scheduleSeries, scheduleOccurrenceStates, scheduleDailyNotes, whiteboards, noteHistory, taskHistory, recovery, attachments, lastCommit] = await Promise.all([
        this.getAll(STORES.notes), this.getAll(STORES.folders), this.getAll(STORES.files),
        this.getAll(STORES.tasks), this.getAll(STORES.taskFields), this.getAll(STORES.taskViews),
        this.getAll(STORES.scheduleEntries), this.getAll(STORES.scheduleSeries), this.getAll(STORES.scheduleOccurrenceStates), this.getAll(STORES.scheduleDailyNotes), this.getAll(STORES.whiteboards),
        this.getAll(STORES.history), this.getAll(STORES.taskHistory), this.getAll(STORES.recovery),
        this.getAll(STORES.attachments), this.get(STORES.meta, "lastCommit")
      ]);
      return {
        format: "easynote-directory-backup", version: 6, createdAt: isoNow(), commit: lastCommit || null,
        data: { notes, categories: folders, files, tasks, taskFields, taskViews, scheduleEntries, scheduleSeries, scheduleOccurrenceStates, scheduleDailyNotes, whiteboards, noteHistory, taskHistory, recovery },
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

    async exportPortable(state) {
      const snapshot = await this.prepareInlineAttachments(structuredClone(state));
      const dataUrlCache = new Map();
      const getDataUrl = async (id) => {
        if (!dataUrlCache.has(id)) {
          const blob = this.getAttachmentBlob(id) || (await this.get(STORES.attachments, id))?.blob;
          if (!blob) throw new Error(`附件 ${id} 缺失`);
          dataUrlCache.set(id, await blobToDataUrl(blob));
        }
        return dataUrlCache.get(id);
      };
      for (const note of snapshot.notes || []) {
        const template = document.createElement("template");
        template.innerHTML = note.content || "";
        for (const image of template.content.querySelectorAll("img[data-attachment-id]")) image.src = await getDataUrl(image.dataset.attachmentId);
        note.content = template.innerHTML;
      }
      for (const file of snapshot.files || []) if (file.attachmentId) file.dataUrl = await getDataUrl(file.attachmentId);
      for (const task of snapshot.tasks || []) {
        for (const value of Object.values(task.values || {})) {
          if (!Array.isArray(value)) continue;
          for (const descriptor of value) if (descriptor?.attachmentId) descriptor.dataUrl = await getDataUrl(descriptor.attachmentId);
        }
      }
      for (const board of snapshot.whiteboards || []) {
        for (const node of board.nodes || []) if (node.type === "image" && node.attachmentId) node.dataUrl = await getDataUrl(node.attachmentId);
      }
      const [noteHistory, taskHistory, recovery] = await Promise.all([this.getAll(STORES.history), this.getAll(STORES.taskHistory), this.getAll(STORES.recovery)]);
      return { ...snapshot, version: 8, format: "easynote-portable", exportedAt: isoNow(), safetyArchive: { noteHistory, taskHistory, recovery } };
    }

    async integrityCheck({ full = false } = {}) {
      const report = { checkedAt: isoNow(), full, ok: true, errors: [], warnings: [], counts: {} };
      try {
        const [notes, folders, files, tasks, taskFields, taskViews, scheduleEntries, scheduleSeries, scheduleOccurrenceStates, scheduleDailyNotes, whiteboards, attachments, operations] = await Promise.all([
          this.getAll(STORES.notes), this.getAll(STORES.folders), this.getAll(STORES.files),
          this.getAll(STORES.tasks), this.getAll(STORES.taskFields), this.getAll(STORES.taskViews),
          this.getAll(STORES.scheduleEntries), this.getAll(STORES.scheduleSeries), this.getAll(STORES.scheduleOccurrenceStates), this.getAll(STORES.scheduleDailyNotes), this.getAll(STORES.whiteboards), this.getAll(STORES.attachments), this.getAll(STORES.operations)
        ]);
        report.counts = { notes: notes.length, folders: folders.length, files: files.length, tasks: tasks.length, taskFields: taskFields.length, schedules: scheduleEntries.length, scheduleSeries: scheduleSeries.length, scheduleOccurrenceStates: scheduleOccurrenceStates.length, scheduleDailyNotes: scheduleDailyNotes.length, whiteboards: whiteboards.length, attachments: attachments.length };
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
          const reminderClean = { ...legacy, reminderMode: ["auto", "none", "custom"].includes(entry.reminderMode) ? entry.reminderMode : "auto", customReminderAt: entry.reminderMode === "custom" ? entry.customReminderAt || "" : "" };
          const clean = { ...reminderClean, isTemplate: Boolean(entry.isTemplate), seriesId: entry.seriesId || "", recurrenceType: ["daily", "weekdays", "weekly", "monthly"].includes(entry.recurrenceType) ? entry.recurrenceType : "none", recurrenceInterval: Math.max(1, Number(entry.recurrenceInterval) || 1), repeatUntil: entry.repeatUntil || "", excludedDates: Array.isArray(entry.excludedDates) ? [...new Set(entry.excludedDates)].sort() : [] };
          const currentHash = await sha256(stableStringify(clean)), reminderHash = await sha256(stableStringify(reminderClean)), legacyHash = await sha256(stableStringify(legacy));
          if (currentHash !== entry.checksum && reminderHash !== entry.checksum && legacyHash !== entry.checksum) report.errors.push(`日程“${entry.title || entry.id}”校验值不一致`);
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
          const clean = { id: series.id, title: series.title || "未命名固定日程", startDate: series.startDate || "", allDay: series.allDay !== false, startTime: series.allDay === false ? series.startTime || "" : "", endTime: series.allDay === false ? series.endTime || "" : "", notes: series.notes || "", color: series.color || "#4f7df3", taskId: series.taskId || "", reminderMode: series.reminderMode === "none" ? "none" : "auto", recurrenceType: ["daily", "weekdays", "weekly", "monthly"].includes(series.recurrenceType) ? series.recurrenceType : "daily", recurrenceInterval: Math.max(1, Number(series.recurrenceInterval) || 1), weekdays: Array.isArray(series.weekdays) ? [...new Set(series.weekdays.map(Number).filter((day) => day >= 0 && day <= 6))].sort() : [], dayOfMonth: Math.min(31, Math.max(1, Number(series.dayOfMonth) || 1)), until: series.until || "", active: series.active !== false, createdAt: series.createdAt, updatedAt: series.updatedAt };
          if (await sha256(stableStringify(clean)) !== series.checksum) report.errors.push(`固定日程“${clean.title}”校验值不一致`);
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
      const [storage, lastCommit, lastBackup, backupDirty] = await Promise.all([
        this.storageInfo(), this.get(STORES.meta, "lastCommit"), this.get(STORES.meta, "lastBackup"), this.get(STORES.meta, "backupDirty")
      ]);
      let backupPermission = "unconfigured";
      try { backupPermission = await this.getBackupPermission(false); } catch { backupPermission = "denied"; }
      return { storage, lastCommit, lastBackup, backupDirty, backupPermission, integrity: this.integrityReport, pending: this.hasPendingWrites(), lastError: this.lastError?.message || null };
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
