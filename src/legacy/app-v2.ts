// @ts-nocheck -- compatibility controller; new shell, routing, stores and data contracts are strict TypeScript.
import { EasyNoteDataSafety } from "./data-safety";
import { TaskManager } from "./task-manager";
import { WhiteboardManager } from "./whiteboard-manager";
import { installEasyNoteRuntime, VueScheduleAdapter } from "../services/legacy-runtime";

"use strict";

  const LEGACY_STORAGE_KEY = "easynote-data-v1";
  const THEME_KEY = "easynote-theme";
  const LAYOUT_KEY = "easynote-layout-v1";
  const DB_NAME = "easynote-db";
  const DB_STORE = "app-state";
  const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
  const MAX_FILE_BYTES = 25 * 1024 * 1024;
  const CATEGORY_COLORS = ["#4f7df3", "#24a173", "#9b65d7", "#e38a36", "#e15d6f", "#32a3b7"];
  const DEFAULT_LAYOUT = { sidebarWidth: 230, listWidth: 354, sidebar: true, list: true, editor: true, focus: false, preFocus: null, split: false, splitRatio: 50, secondaryNoteId: null, outline: true, expandedFolders: null };

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const now = () => new Date().toISOString();
  const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

  const els = {
    topbar: $(".topbar"), workspace: $("#workspace"), sidebar: $("#sidebar"), notePanel: $("#notePanel"),
    editorPanel: $("#editorPanel"), sidebarResizer: $("#sidebarResizer"), listResizer: $("#listResizer"),
    sidebarScrim: $("#sidebarScrim"), sidebarToggle: $("#sidebarToggle"), searchInput: $("#searchInput"),
    themeToggle: $("#themeToggle"), saveIndicator: $("#saveIndicator"), newNoteTop: $("#newNoteTop"),
    newNoteEmpty: $("#newNoteEmpty"), allCount: $("#allCount"), favoriteCount: $("#favoriteCount"),
    trashCount: $("#trashCount"), categoryList: $("#categoryList"), addCategory: $("#addCategory"),
    viewTitle: $("#viewTitle"), viewCount: $("#viewCount"), sortSelect: $("#sortSelect"), noteList: $("#noteList"),
    emptyState: $("#emptyState"), editor: $("#editor"), editedTime: $("#editedTime"), titleInput: $("#titleInput"),
    categorySelect: $("#categorySelect"), tagInput: $("#tagInput"), editorScroll: $("#editorScroll"), contentEditor: $("#contentEditor"),
    markdownEditor: $("#markdownEditor"), formatToolbar: $("#formatToolbar"), modeToggle: $("#modeToggle"),
    favoriteButton: $("#favoriteButton"), deleteButton: $("#deleteButton"), downloadMarkdown: $("#downloadMarkdown"),
    trashActions: $("#trashActions"), restoreButton: $("#restoreButton"), permanentDeleteButton: $("#permanentDeleteButton"),
    importButton: $("#importButton"), exportButton: $("#exportButton"), importFile: $("#importFile"),
    imageFile: $("#imageFile"), insertImage: $("#insertImage"), insertLink: $("#insertLink"), clearFormat: $("#clearFormat"),
    backToList: $("#backToList"), editorMore: $("#editorMore"), imageDropHint: $("#imageDropHint"),
    imageResizeOverlay: $("#imageResizeOverlay"), imageResizeHandle: $("#imageResizeHandle"), imageWidthHandle: $("#imageWidthHandle"), imageHeightHandle: $("#imageHeightHandle"), imageSizeLabel: $("#imageSizeLabel"),
    splitViewButton: $("#splitViewButton"), outlineButton: $("#outlineButton"), editorSplitResizer: $("#editorSplitResizer"),
    secondaryEditor: $("#secondaryEditor"), secondaryNoteSelect: $("#secondaryNoteSelect"), secondaryClose: $("#secondaryClose"),
    secondaryScroll: $("#secondaryScroll"), secondaryTitle: $("#secondaryTitle"), secondaryContent: $("#secondaryContent"),
    outlinePanel: $("#outlinePanel"), outlineTitle: $("#outlineTitle"), outlineClose: $("#outlineClose"), outlineList: $("#outlineList"),
    layoutButton: $("#layoutButton"), layoutPopover: $("#layoutPopover"), panelSwitcher: $("#panelSwitcher"), focusExit: $("#focusExit"),
    imageMoveHandle: $("#imageMoveHandle"), imagePositionGuide: $("#imagePositionGuide"), imageDropMarker: $("#imageDropMarker"),
    imagePositionCursor: $("#imagePositionCursor"), imagePositionLabel: $("#imagePositionLabel"),
    uploadFileButton: $("#uploadFileButton"), localFileInput: $("#localFileInput"), fileViewer: $("#fileViewer"),
    fileViewerName: $("#fileViewerName"), fileViewerMeta: $("#fileViewerMeta"), fileViewerDownload: $("#fileViewerDownload"),
    fileViewerDelete: $("#fileViewerDelete"), fileViewerClose: $("#fileViewerClose"), filePdfViewer: $("#filePdfViewer"),
    fileImageViewer: $("#fileImageViewer"), fileTextViewer: $("#fileTextViewer"), fileUnsupported: $("#fileUnsupported"), fileUnsupportedDownload: $("#fileUnsupportedDownload"),
    linkViewer: $("#linkViewer"), linkViewerBack: $("#linkViewerBack"), linkViewerClose: $("#linkViewerClose"), linkViewerReload: $("#linkViewerReload"),
    linkViewerNewTab: $("#linkViewerNewTab"), linkViewerTabs: $("#linkViewerTabs"), linkViewerFrames: $("#linkViewerFrames"), linkViewerUrl: $("#linkViewerUrl"), linkViewerStatus: $("#linkViewerStatus"),
    contextMenu: $("#contextMenu"), dialogBackdrop: $("#dialogBackdrop"), appDialog: $("#appDialog"),
    dialogTitle: $("#dialogTitle"), dialogMessage: $("#dialogMessage"), dialogField: $("#dialogField"),
    dialogLabel: $("#dialogLabel"), dialogInput: $("#dialogInput"), dialogError: $("#dialogError"),
    dialogClose: $("#dialogClose"), dialogCancel: $("#dialogCancel"), dialogConfirm: $("#dialogConfirm"), toast: $("#toast"),
    safetyCenterButton: $("#safetyCenterButton"), safetyBackdrop: $("#safetyBackdrop"), safetyClose: $("#safetyClose"),
    storageSummary: $("#storageSummary"), protocolAlert: $("#protocolAlert"), databaseSafetyState: $("#databaseSafetyState"),
    databaseSafetyDetail: $("#databaseSafetyDetail"), persistentStorageState: $("#persistentStorageState"), storageQuotaDetail: $("#storageQuotaDetail"),
    directoryBackupState: $("#directoryBackupState"), directoryBackupDetail: $("#directoryBackupDetail"), lastVerifiedSave: $("#lastVerifiedSave"),
    pendingSaveDetail: $("#pendingSaveDetail"), requestPersistenceButton: $("#requestPersistenceButton"), runIntegrityButton: $("#runIntegrityButton"),
    retrySaveButton: $("#retrySaveButton"), chooseBackupDirectoryButton: $("#chooseBackupDirectoryButton"), backupNowButton: $("#backupNowButton"),
    verifyBackupButton: $("#verifyBackupButton"), historyList: $("#historyList"), recoveryList: $("#recoveryList"), portableExportButton: $("#portableExportButton"),
    safetyUpdatedAt: $("#safetyUpdatedAt"), migrationExportButton: $("#migrationExportButton"), migrationBanner: $("#migrationBanner"),
    migrationBannerExport: $("#migrationBannerExport"), migrationBannerDismiss: $("#migrationBannerDismiss")
  };

  let state = null;
  let db = null;
  let safety = null;
  let storageMode = "indexeddb";
  let externalSyncTimer = 0;
  let pendingExternalCommit = null;
  let applyingExternalCommit = false;
  let activeView = "all";
  let activeNoteId = null;
  let activeFileId = null;
  let activeLinkUrl = null;
  let activeLinkTabId = null;
  let linkTabs = [];
  let searchTerm = "";
  let editMode = "rich";
  let saveTimer = null;
  let toastTimer = null;
  let savedEditorRange = null;
  let contextPayload = null;
  let dragDepth = 0;
  let layout = loadLayout();
  let selectedImage = null;
  let outlinePane = "primary";
  let dialogState = null;
  let pendingUploadFolderId = "";
  let fileObjectUrl = null;
  let taskManager = null;
  let scheduleManager = null;
  let whiteboardManager = null;

  function seedData() {
    const stamp = Date.now();
    return {
      version: 8,
      categories: [
        { id: "work", name: "工作", color: CATEGORY_COLORS[0] },
        { id: "study", name: "学习", color: CATEGORY_COLORS[1] },
        { id: "life", name: "生活", color: CATEGORY_COLORS[3] },
        { id: "ideas", name: "灵感", color: CATEGORY_COLORS[2] }
      ],
      files: [], tasks: [], taskFields: [], taskViews: [], scheduleEntries: [], scheduleSeries: [], scheduleOccurrenceStates: [], scheduleDailyNotes: [], focusSessions: [], reviews: [], goals: [], milestones: [], whiteboards: [],
      notes: [
        {
          id: uid(), title: "欢迎使用 EasyNote", categoryId: "ideas", tags: ["开始", "指南"], favorite: true,
          createdAt: new Date(stamp - 3600000).toISOString(), updatedAt: new Date(stamp - 300000).toISOString(), deletedAt: null,
          content: `<p>这是一个专属于你的轻量笔记空间。所有内容都会<strong>自动保存在当前浏览器</strong>，无需登录也能使用。</p><h2>你可以从这里开始</h2><ul><li>使用左侧分类整理笔记</li><li>通过搜索快速找到内容</li><li>给重要笔记添加收藏和标签</li><li>在富文本与 Markdown 模式之间切换</li></ul><blockquote>小提示：按下 Ctrl + N 可以随时新建笔记。</blockquote>`
        },
        {
          id: uid(), title: "本周学习计划", categoryId: "study", tags: ["计划", "成长"], favorite: false,
          createdAt: new Date(stamp - 86400000 * 2).toISOString(), updatedAt: new Date(stamp - 86400000).toISOString(), deletedAt: null,
          content: `<h2>本周目标</h2><ol><li>完成一个小项目的核心功能</li><li>整理两篇技术学习笔记</li><li>每天留出 30 分钟阅读</li></ol><p>专注完成最重要的事情，不追求一次做到完美。</p>`
        },
        {
          id: uid(), title: "产品灵感收集", categoryId: "work", tags: ["产品", "待整理"], favorite: false,
          createdAt: new Date(stamp - 86400000 * 5).toISOString(), updatedAt: new Date(stamp - 86400000 * 3).toISOString(), deletedAt: null,
          content: `<p>把日常使用产品时遇到的不顺畅记录下来，它们可能就是下一次优化的起点。</p><h3>记录模板</h3><p><strong>场景：</strong>什么时候遇到？</p><p><strong>问题：</strong>哪里让人困惑？</p><p><strong>想法：</strong>可以怎样改善？</p>`
        }
      ]
    };
  }

  function normalizeData(data) {
    if (!data || !Array.isArray(data.notes) || !Array.isArray(data.categories)) throw new Error("数据格式无效");
    data.version = 8;
    data.files = Array.isArray(data.files) ? data.files : [];
    data.tasks = Array.isArray(data.tasks) ? data.tasks : [];
    data.taskFields = Array.isArray(data.taskFields) ? data.taskFields : [];
    data.taskViews = Array.isArray(data.taskViews) ? data.taskViews : [];
    data.scheduleEntries = Array.isArray(data.scheduleEntries) ? data.scheduleEntries : [];
    data.scheduleSeries = Array.isArray(data.scheduleSeries) ? data.scheduleSeries : [];
    data.scheduleOccurrenceStates = Array.isArray(data.scheduleOccurrenceStates) ? data.scheduleOccurrenceStates : [];
    data.scheduleDailyNotes = Array.isArray(data.scheduleDailyNotes) ? data.scheduleDailyNotes : [];
    data.focusSessions = Array.isArray(data.focusSessions) ? data.focusSessions : [];
    data.reviews = Array.isArray(data.reviews) ? data.reviews : [];
    data.goals = Array.isArray(data.goals) ? data.goals : [];
    data.milestones = Array.isArray(data.milestones) ? data.milestones : [];
    data.whiteboards = Array.isArray(data.whiteboards) ? data.whiteboards : [];
    const folderIds = new Set(data.categories.map((folder) => folder.id));
    data.categories.forEach((folder) => { folder.parentId = folder.parentId && folder.parentId !== folder.id && folderIds.has(folder.parentId) ? folder.parentId : null; });
    data.notes.forEach((note) => {
      note.tags = Array.isArray(note.tags) ? note.tags : [];
      note.favorite = Boolean(note.favorite);
      note.content = note.content || "";
      note.deletedAt = note.deletedAt || null;
    });
    data.files.forEach((file) => {
      file.folderId = folderIds.has(file.folderId) ? file.folderId : "";
      file.name = file.name || "本地文件";
      file.type = file.type || "application/octet-stream";
      file.attachmentId = file.attachmentId || "";
      file.dataUrl = file.dataUrl || "";
      file.createdAt = file.createdAt || now();
    });
    return data;
  }

  async function loadData() {
    try {
      safety = new EasyNoteDataSafety({ onStatus: setSaveStatus });
      const stored = await safety.load();
      storageMode = "indexeddb-verified";
      if (stored) return normalizeData(stored);
      let legacy = null;
      try {
        const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
        if (raw) legacy = normalizeData(JSON.parse(raw));
      } catch (error) { console.warn("旧版 LocalStorage 数据读取失败", error); }
      return legacy || seedData();
    } catch (error) {
      storageMode = "failed";
      throw new Error(`安全数据库无法启动：${error.message || error}`);
    }
  }

  function setSaveStatus(status, detail = {}) {
    const labels = { dirty: " 有未保存更改", saving: " 正在保存", saved: " 已验证保存", failed: " 保存失败，等待重试" };
    const normalized = typeof status === "boolean" ? (status ? "saving" : "saved") : status;
    els.saveIndicator.classList.remove("saving", "dirty", "failed", "verified");
    els.saveIndicator.classList.add(normalized === "saved" ? "verified" : normalized);
    els.saveIndicator.lastChild.textContent = labels[normalized] || labels.saved;
    els.saveIndicator.title = normalized === "failed" ? `${detail.error || "写入失败"}。点击打开数据安全中心。` : detail.verifiedAt ? `最近回读校验：${new Date(detail.verifiedAt).toLocaleString("zh-CN")}` : "";
    if (normalized === "failed") showToast("保存失败：修改仍保留在当前页面，请打开数据安全中心重试");
  }

  function persist(immediate = false, reason = "auto") {
    if (!safety) return Promise.resolve(false);
    return safety.queueSave(state, immediate, reason);
  }

  function mergeCommitDetails(current, next) {
    const merged = { ...(current || {}), ...(next || {}) };
    for (const key of ["changedNoteIds", "changedTaskIds", "changedScheduleIds", "changedWhiteboardIds"]) merged[key] = [...new Set([...(current?.[key] || []), ...(next?.[key] || [])])];
    return merged;
  }

  function queueExternalCommit(event) {
    pendingExternalCommit = mergeCommitDetails(pendingExternalCommit, event.detail || {});
    clearTimeout(externalSyncTimer);
    externalSyncTimer = setTimeout(applyExternalCommit, 220);
  }

  async function applyExternalCommit() {
    if (!safety || applyingExternalCommit || !pendingExternalCommit) return;
    if (document.hidden || safety.hasPendingWrites()) { clearTimeout(externalSyncTimer); externalSyncTimer = setTimeout(applyExternalCommit, 600); return; }
    applyingExternalCommit = true;
    const detail = pendingExternalCommit;
    try {
      const freshRaw = await safety.load(false);
      if (!freshRaw || safety.hasPendingWrites()) { clearTimeout(externalSyncTimer); externalSyncTimer = setTimeout(applyExternalCommit, 600); return; }
      pendingExternalCommit = null;
      const fresh = normalizeData(freshRaw);
      const previousActiveId = activeNoteId;
      const activeChanged = Boolean(previousActiveId && (detail.changedNoteIds || []).includes(previousActiveId));
      Object.assign(state, fresh);
      safety.captureStateBaselines(state);
      const activeMissing = Boolean(previousActiveId && !getNote(previousActiveId));
      if (activeMissing) activeNoteId = getVisibleNotes()[0]?.id || null;
      taskManager?.render(); scheduleManager?.render(); whiteboardManager?.render(); renderSidebar(); renderList();
      if (activeChanged || activeMissing || !getActiveNote()) renderEditor();
      if (activeChanged) showToast("当前笔记已从另一个页面同步到最新版本");
    } catch (error) {
      console.error("EasyNote cross-tab refresh failed", error);
      showToast("其他页面有新修改，自动同步失败，请刷新当前页面");
    } finally { applyingExternalCommit = false; }
  }

  function applySyncConflicts(event) {
    const conflicts = event.detail?.conflicts || [];
    for (const conflict of conflicts.filter((item) => item.kind === "note" && item.copy)) {
      const index = state.notes.findIndex((note) => note.id === conflict.originalId);
      if (index >= 0) conflict.remote ? state.notes.splice(index, 1, conflict.remote) : state.notes.splice(index, 1);
      if (!state.notes.some((note) => note.id === conflict.copy.id)) state.notes.unshift(conflict.copy);
      if (activeNoteId === conflict.originalId) activeNoteId = conflict.copy.id;
    }
    render();
    showToast(conflicts.some((item) => item.kind === "note") ? "检测到同一笔记被多个页面修改，本页内容已保存为冲突副本" : "检测到多页面修改冲突，本页版本已放入数据安全恢复记录");
  }

  window.addEventListener("easynote:external-commit", queueExternalCommit);
  window.addEventListener("easynote:sync-conflict", applySyncConflicts);

  async function ensureVueMigrationRecovery() {
    if (!document.querySelector("#vue-shell-root") || !safety) return;
    const marker = await safety.get("meta", "vueMigrationV1");
    if (marker?.state === "verified") return;
    if (!safety.wasEmpty) await safety.recordRecovery("vue-migration", "迁移到 Vue 前的完整数据", structuredClone(state));
    await safety.put("meta", { key: "vueMigrationV1", state: "verified", migratedAt: now(), dataVersion: state.version || 8 });
  }

  window.addEventListener("easynote:flush-request", async () => {
    let ok = true;
    try {
      flushActiveWorkspace("pwa-update");
      ok = safety ? await safety.flush() : true;
    } catch (error) {
      ok = false;
      console.error("EasyNote shell flush failed", error);
    }
    window.dispatchEvent(new CustomEvent("easynote:flush-complete", { detail: { ok } }));
  });

  function loadLayout() {
    try { return { ...DEFAULT_LAYOUT, ...JSON.parse(localStorage.getItem(LAYOUT_KEY) || "{}") }; }
    catch { return { ...DEFAULT_LAYOUT }; }
  }

  function saveLayout() { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); }

  function escapeHtml(value) {
    const div = document.createElement("div");
    div.textContent = value ?? "";
    return div.innerHTML;
  }

  function escapeAttr(value) { return escapeHtml(value).replace(/"/g, "&quot;"); }
  function stripHtml(html) { const div = document.createElement("div"); div.innerHTML = html || ""; return (div.textContent || "").replace(/\s+/g, " ").trim(); }
  function getActiveNote() { return state.notes.find((note) => note.id === activeNoteId) || null; }
  function getNote(id) { return state.notes.find((note) => note.id === id) || null; }
  function getActiveFile() { return state.files.find((file) => file.id === activeFileId) || null; }
  function getStoredFile(id) { return state.files.find((file) => file.id === id) || null; }
  function formatBytes(bytes = 0) { if (bytes < 1024) return `${bytes} B`; if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`; return `${(bytes / 1048576).toFixed(1)} MB`; }
  function getCategory(id) { return state.categories.find((category) => category.id === id); }
  function getChildFolders(parentId) { return state.categories.filter((folder) => (folder.parentId || null) === (parentId || null)); }
  function getFolderColor(folder) {
    const color = typeof folder?.color === "string" && /^#[0-9a-f]{6}$/i.test(folder.color) ? folder.color : "";
    return color || CATEGORY_COLORS[Math.max(0, state.categories.indexOf(folder)) % CATEGORY_COLORS.length];
  }
  function getDescendantFolderIds(id) {
    const result = [];
    const visit = (parentId) => getChildFolders(parentId).forEach((child) => { if (!result.includes(child.id)) { result.push(child.id); visit(child.id); } });
    visit(id); return result;
  }
  function getFolderPath(id) {
    const parts = []; const visited = new Set(); let folder = getCategory(id);
    while (folder && !visited.has(folder.id)) { visited.add(folder.id); parts.unshift(folder.name); folder = getCategory(folder.parentId); }
    return parts.join(" / ");
  }
  function expandFolderPath(id) {
    const expanded = new Set(layout.expandedFolders || []), visited = new Set(); let folder = getCategory(id);
    while (folder && !visited.has(folder.id)) { visited.add(folder.id); expanded.add(folder.id); folder = getCategory(folder.parentId); }
    layout.expandedFolders = [...expanded]; saveLayout();
  }

  function getVisibleNotes() {
    const folderFilter = activeView.startsWith("category:") ? new Set([activeView.slice(9), ...getDescendantFolderIds(activeView.slice(9))]) : null;
    let notes = state.notes.filter((note) => {
      if (activeView === "trash") return Boolean(note.deletedAt);
      if (note.deletedAt) return false;
      if (activeView === "favorites" && !note.favorite) return false;
      if (folderFilter) return folderFilter.has(note.categoryId);
      return true;
    });
    const keyword = searchTerm.trim().toLocaleLowerCase("zh-CN");
    if (keyword) notes = notes.filter((note) => [note.title, stripHtml(note.content), ...(note.tags || [])].join(" ").toLocaleLowerCase("zh-CN").includes(keyword));
    const sort = els.sortSelect.value;
    return notes.sort((a, b) => {
      if (sort === "title") return (a.title || "").localeCompare(b.title || "", "zh-CN");
      const field = sort === "created" ? "createdAt" : "updatedAt";
      return new Date(b[field]) - new Date(a[field]);
    });
  }

  function formatDate(value, detailed = false) {
    if (!value) return "";
    const date = new Date(value);
    const today = new Date();
    const sameYear = date.getFullYear() === today.getFullYear();
    if (detailed) return `编辑于 ${date.toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
    const diff = new Date(today).setHours(0, 0, 0, 0) - new Date(date).setHours(0, 0, 0, 0);
    if (diff === 0) return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    if (diff === 86400000) return "昨天";
    return date.toLocaleDateString("zh-CN", { year: sameYear ? undefined : "numeric", month: "short", day: "numeric" });
  }

  function viewLabel() {
    if (activeView === "favorites") return "我的收藏";
    if (activeView === "trash") return "回收站";
    if (activeView.startsWith("category:")) return getCategory(activeView.slice(9))?.name || "文件夹";
    return "全部笔记";
  }

  function renderSidebar() {
    const previousScrollTop = els.categoryList.scrollTop;
    const alive = state.notes.filter((note) => !note.deletedAt);
    const storedFiles = state.files;
    els.allCount.textContent = alive.length;
    els.favoriteCount.textContent = alive.filter((note) => note.favorite).length;
    els.trashCount.textContent = state.notes.filter((note) => note.deletedAt).length;
    const workspaceView = whiteboardManager?.active ? "whiteboard" : scheduleManager?.active ? "schedule" : taskManager?.active ? "tasks" : activeView;
    $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === workspaceView));
    const expanded = new Set(Array.isArray(layout.expandedFolders) ? layout.expandedFolders : []), rendered = new Set();
    const noteRow = (note, depth) => `<div class="tree-row tree-note ${note.id === activeNoteId ? "active" : ""}" style="--tree-depth:${depth}" data-context="tree-note" data-note-id="${note.id}" draggable="true">
      <button class="tree-toggle placeholder" tabindex="-1"></button><button class="tree-note-button" data-note-id="${note.id}">
        <svg class="tree-note-icon" viewBox="0 0 24 24"><path d="M6 3h9l3 3v15H6z"/><path d="M9 11h6M9 15h5"/></svg><span>${escapeHtml(note.title || "无标题笔记")}</span>
      </button><button class="item-more" data-more="note" data-note-id="${note.id}" aria-label="更多笔记操作">•••</button></div>`;
    const fileRow = (file, depth) => `<div class="tree-row tree-file ${file.id === activeFileId ? "active" : ""}" style="--tree-depth:${depth}" data-context="tree-file" data-file-id="${file.id}" draggable="true">
      <button class="tree-toggle placeholder" tabindex="-1"></button><button class="tree-file-button" data-file-id="${file.id}" title="${escapeAttr(file.name)}">
        <svg class="tree-file-icon" viewBox="0 0 24 24"><path d="M6 3h9l3 3v15H6z"/><path d="M9 12h6M9 16h5"/></svg><span>${escapeHtml(file.name)}</span><small>${formatBytes(file.size)}</small>
      </button><button class="item-more" data-more="file" data-file-id="${file.id}" aria-label="更多文件操作">•••</button></div>`;
    const renderFolder = (folder, depth = 0) => {
      if (!folder || rendered.has(folder.id)) return ""; rendered.add(folder.id);
      const children = getChildFolders(folder.id), notes = alive.filter((note) => note.categoryId === folder.id), files = storedFiles.filter((file) => file.folderId === folder.id), descendants = new Set([folder.id, ...getDescendantFolderIds(folder.id)]);
      const count = alive.filter((note) => descendants.has(note.categoryId)).length + storedFiles.filter((file) => descendants.has(file.folderId)).length, isExpanded = expanded.has(folder.id), hasChildren = children.length || notes.length || files.length;
      const childHtml = isExpanded ? `${children.map((child) => renderFolder(child, depth + 1)).join("")}${notes.map((note) => noteRow(note, depth + 1)).join("")}${files.map((file) => fileRow(file, depth + 1)).join("")}` : "";
      return `<div class="tree-node ${depth === 0 ? "root-node" : "nested-node"}" data-folder-node="${folder.id}" data-folder-depth="${depth}"><div class="tree-row folder-row ${depth === 0 ? "root-folder" : "nested-folder"} ${activeView === `category:${folder.id}` ? "active" : ""}" style="--tree-depth:${depth};--folder-color:${getFolderColor(folder)}" data-context="category" data-category-id="${folder.id}" draggable="true">
        <button class="tree-toggle ${isExpanded ? "expanded" : ""} ${hasChildren ? "" : "placeholder"}" data-folder-toggle="${folder.id}" aria-label="${isExpanded ? "折叠" : "展开"}${escapeAttr(folder.name)}"><svg viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg></button>
        <button class="tree-folder-button" data-category-id="${folder.id}"><svg class="tree-folder-icon" viewBox="0 0 24 24"><path d="M3 6h7l2 2h9v11H3z"/></svg><span>${escapeHtml(folder.name)}</span><em>${count}</em></button>
        <button class="item-more" data-more="category" data-category-id="${folder.id}" aria-label="${escapeAttr(folder.name)}更多操作">•••</button>
      </div>${childHtml ? `<div class="tree-children" style="--tree-depth:${depth}">${childHtml}</div>` : ""}</div>`;
    };
    const roots = getChildFolders(null), reachable = new Set();
    const markReachable = (folder) => {
      if (!folder || reachable.has(folder.id)) return;
      reachable.add(folder.id);
      getChildFolders(folder.id).forEach(markReachable);
    };
    roots.forEach(markReachable);
    let treeHtml = roots.map((folder) => renderFolder(folder)).join("");
    state.categories.filter((folder) => !reachable.has(folder.id)).forEach((folder) => { treeHtml += renderFolder(folder); });
    treeHtml += alive.filter((note) => !note.categoryId || !getCategory(note.categoryId)).map((note) => noteRow(note, 0)).join("");
    treeHtml += storedFiles.filter((file) => !file.folderId || !getCategory(file.folderId)).map((file) => fileRow(file, 0)).join("");
    els.categoryList.innerHTML = treeHtml || '<div class="tree-empty">还没有文件夹<br>点击上方“＋”创建</div>';
    els.categoryList.scrollTop = previousScrollTop;
    const selected = getActiveNote()?.categoryId || els.categorySelect.value;
    const flattened = [];
    const flatten = (parentId, depth) => getChildFolders(parentId).forEach((folder) => { flattened.push({ folder, depth }); flatten(folder.id, depth + 1); });
    flatten(null, 0); state.categories.filter((folder) => !flattened.some((entry) => entry.folder.id === folder.id)).forEach((folder) => flattened.push({ folder, depth: 0 }));
    const options = `<option value="">未归档</option>` + flattened.map(({ folder, depth }) => `<option value="${folder.id}">${"　".repeat(depth)}${depth ? "└ " : ""}${escapeHtml(folder.name)}</option>`).join("");
    if (els.categorySelect.innerHTML !== options) els.categorySelect.innerHTML = options;
    els.categorySelect.value = selected || "";
  }

  function renderList() {
    const notes = getVisibleNotes();
    els.viewTitle.textContent = searchTerm ? `搜索“${searchTerm}”` : viewLabel();
    els.viewCount.textContent = `${notes.length} 篇`;
    if (!notes.length) {
      els.noteList.innerHTML = `<div class="list-empty"><svg viewBox="0 0 24 24"><path d="M6 3h9l3 3v15H6z"/><path d="M9 11h6M9 15h4"/></svg>
        <h3>${searchTerm ? "没有找到相关笔记" : activeView === "trash" ? "回收站是空的" : "这里还没有笔记"}</h3>
        <p>${searchTerm ? "试试其他关键词" : activeView === "trash" ? "删除的笔记会暂存在这里" : "点击右上角按钮创建第一篇"}</p></div>`;
      return;
    }
    els.noteList.innerHTML = notes.map((note) => {
      const category = getCategory(note.categoryId);
      return `<article class="note-card ${note.id === activeNoteId ? "active" : ""}" data-context="note-card" data-note-id="${note.id}" tabindex="0">
        <div class="note-card-top"><h3>${escapeHtml(note.title || "无标题笔记")}</h3>${note.favorite ? `<svg class="mini-star" viewBox="0 0 24 24"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2L3 9.6l6.2-.9z"/></svg>` : ""}<button class="card-more" data-more="note" data-note-id="${note.id}" aria-label="更多笔记操作">•••</button></div>
        <p>${escapeHtml(stripHtml(note.content) || "暂无正文内容")}</p>
        <div class="note-card-meta"><time>${formatDate(note.updatedAt)}</time>${category ? `<span class="category-pill">${escapeHtml(category.name)}</span>` : ""}</div>
      </article>`;
    }).join("");
  }

  function dataUrlToBlob(dataUrl) {
    const [header, payload = ""] = dataUrl.split(",", 2), mime = header.match(/^data:([^;,]+)/)?.[1] || "application/octet-stream";
    const binary = header.includes(";base64") ? atob(payload) : decodeURIComponent(payload);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type: mime });
  }

  function renderFileViewer(file) {
    if (fileObjectUrl) URL.revokeObjectURL(fileObjectUrl);
    const storedBlob = safety?.getAttachmentBlob(file.attachmentId) || (file.dataUrl ? dataUrlToBlob(file.dataUrl) : null);
    fileObjectUrl = storedBlob ? URL.createObjectURL(storedBlob) : null;
    els.fileViewerName.textContent = file.name;
    els.fileViewerMeta.textContent = `${formatBytes(file.size)} · ${getFolderPath(file.folderId) || "未归档"}`;
    [els.filePdfViewer, els.fileImageViewer, els.fileTextViewer, els.fileUnsupported].forEach((element) => { element.hidden = true; });
    els.filePdfViewer.removeAttribute("src"); els.fileImageViewer.removeAttribute("src"); els.fileTextViewer.textContent = "";
    if (file.type === "application/pdf") { els.filePdfViewer.src = fileObjectUrl; els.filePdfViewer.hidden = false; }
    else if (file.type.startsWith("image/")) { els.fileImageViewer.src = fileObjectUrl; els.fileImageViewer.alt = file.name; els.fileImageViewer.hidden = false; }
    else if (file.type.startsWith("text/") || file.type === "application/json" || /\.(md|markdown|txt|json|csv|html?)$/i.test(file.name)) {
      (storedBlob ? storedBlob.text() : Promise.resolve("附件内容缺失")).then((text) => { if (activeFileId === file.id) els.fileTextViewer.textContent = text; });
      els.fileTextViewer.hidden = false;
    } else els.fileUnsupported.hidden = false;
  }

  function getActiveLinkTab() { return linkTabs.find((tab) => tab.id === activeLinkTabId) || null; }

  function linkTabLabel(url) {
    try {
      const parsed = new URL(url), tail = parsed.pathname.split("/").filter(Boolean).pop();
      return decodeURIComponent(tail || parsed.hostname).slice(0, 42) || parsed.hostname;
    } catch { return url; }
  }

  function preferredLinkTabLabel(label, url) {
    const cleaned = String(label || "").replace(/\s+/g, " ").trim();
    return cleaned && cleaned !== url ? cleaned.slice(0, 60) : linkTabLabel(url);
  }

  function renderLinkTabStrip() {
    els.linkViewerTabs.innerHTML = linkTabs.map((tab) => `<div class="link-viewer-tab ${tab.id === activeLinkTabId ? "active" : ""} ${tab.status === "loading" ? "loading" : ""}" data-link-tab-id="${tab.id}" title="${escapeAttr(tab.url)}"><i></i><span>${escapeHtml(tab.label)}</span><button data-close-link-tab="${tab.id}" title="关闭此网页" aria-label="关闭${escapeAttr(tab.label)}">×</button></div>`).join("");
    requestAnimationFrame(() => els.linkViewerTabs.querySelector(`[data-link-tab-id="${activeLinkTabId}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" }));
  }

  function renderLinkViewer() {
    if (!activeLinkUrl) return;
    let activeTab = getActiveLinkTab();
    if (!activeTab) {
      activeTab = linkTabs.find((tab) => tab.url === activeLinkUrl) || null;
      activeLinkTabId = activeTab?.id || null;
    }
    if (!activeTab) return;
    els.linkViewerUrl.textContent = activeTab.url; els.linkViewerUrl.title = activeTab.url;
    els.linkViewerStatus.textContent = activeTab.status === "loaded" ? "已加载" : "正在加载";
    renderLinkTabStrip();
    const validIds = new Set(linkTabs.map((tab) => tab.id));
    els.linkViewerFrames.querySelectorAll("iframe[data-link-tab-id]").forEach((frame) => { if (!validIds.has(frame.dataset.linkTabId)) frame.remove(); });
    linkTabs.forEach((tab) => {
      let frame = els.linkViewerFrames.querySelector(`iframe[data-link-tab-id="${tab.id}"]`);
      if (!frame) {
        frame = document.createElement("iframe"); frame.dataset.linkTabId = tab.id; frame.title = `笔记内网页：${tab.label}`; frame.referrerPolicy = "no-referrer";
        frame.addEventListener("load", () => { tab.status = "loaded"; if (tab.id === activeLinkTabId) els.linkViewerStatus.textContent = "已加载"; renderLinkTabStrip(); });
        els.linkViewerFrames.appendChild(frame); frame.src = tab.url;
      }
      frame.hidden = tab.id !== activeLinkTabId;
    });
  }

  function openLinkInEditor(url, label = "") {
    if (!/^https?:\/\//i.test(url || "")) return showToast("只支持打开 http 或 https 链接");
    const normalized = new URL(url).href;
    flushEditor(); activeFileId = null;
    let tab = linkTabs.find((item) => item.url === normalized);
    const preferredLabel = preferredLinkTabLabel(label, normalized);
    if (!tab) { tab = { id: uid(), url: normalized, label: preferredLabel, status: "loading", openedAt: Date.now() }; linkTabs.push(tab); }
    else if (label) tab.label = preferredLabel;
    activeLinkTabId = tab.id; activeLinkUrl = tab.url;
    renderEditor(); els.workspace.classList.add("editor-open");
  }

  function openLinkNewTab(url = activeLinkUrl) {
    if (!/^https?:\/\//i.test(url || "")) return;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  function hideLinkViewer() { activeLinkUrl = null; els.linkViewer.hidden = true; renderEditor(); }

  function switchLinkTab(id) {
    const tab = linkTabs.find((item) => item.id === id); if (!tab) return;
    activeLinkTabId = tab.id; activeLinkUrl = tab.url; activeFileId = null; renderEditor();
  }

  function closeLinkTab(id = activeLinkTabId) {
    const index = linkTabs.findIndex((tab) => tab.id === id); if (index < 0) return;
    const wasActive = linkTabs[index].id === activeLinkTabId;
    linkTabs.splice(index, 1); els.linkViewerFrames.querySelector(`iframe[data-link-tab-id="${id}"]`)?.remove();
    if (!wasActive) { renderLinkTabStrip(); return; }
    const next = linkTabs[index] || linkTabs[index - 1] || null;
    activeLinkTabId = next?.id || null; activeLinkUrl = next?.url || null;
    renderEditor();
  }

  function renderEditor() {
    const note = getActiveNote(), file = getActiveFile();
    deselectImage();
    if (activeLinkUrl) {
      els.emptyState.hidden = true; els.editor.hidden = true; els.fileViewer.hidden = true; els.linkViewer.hidden = false;
      if (fileObjectUrl) { URL.revokeObjectURL(fileObjectUrl); fileObjectUrl = null; }
      renderLinkViewer(); renderSecondaryEditor(); updateOutline(); applyEditorLayout(false); return;
    }
    els.linkViewer.hidden = true;
    if (file) {
      els.emptyState.hidden = true; els.editor.hidden = true; els.fileViewer.hidden = false;
      renderFileViewer(file); renderSecondaryEditor(); updateOutline(); applyEditorLayout(false); return;
    }
    els.fileViewer.hidden = true;
    if (fileObjectUrl) { URL.revokeObjectURL(fileObjectUrl); fileObjectUrl = null; }
    if (!note) { els.emptyState.hidden = false; els.editor.hidden = true; renderSecondaryEditor(); updateOutline(); applyEditorLayout(false); return; }
    els.emptyState.hidden = true;
    els.editor.hidden = false;
    els.titleInput.value = note.title || "";
    els.categorySelect.value = note.categoryId || "";
    els.tagInput.value = (note.tags || []).join(", ");
    els.contentEditor.innerHTML = note.content || "";
    normalizeRichImageStructure(els.contentEditor);
    els.contentEditor.querySelectorAll("a[href]").forEach((link) => { link.removeAttribute("target"); link.rel = "noopener noreferrer"; });
    els.markdownEditor.value = htmlToMarkdown(note.content || "");
    els.editedTime.textContent = formatDate(note.updatedAt, true);
    els.favoriteButton.classList.toggle("favorite-active", note.favorite);
    els.favoriteButton.title = note.favorite ? "取消收藏" : "收藏";
    const inTrash = Boolean(note.deletedAt);
    els.trashActions.hidden = !inTrash;
    els.titleInput.disabled = inTrash;
    els.categorySelect.disabled = inTrash;
    els.tagInput.disabled = inTrash;
    els.contentEditor.contentEditable = inTrash ? "false" : "true";
    els.markdownEditor.disabled = inTrash;
    els.formatToolbar.style.display = inTrash || editMode === "markdown" ? "none" : "flex";
    els.modeToggle.style.display = inTrash ? "none" : "inline-block";
    els.favoriteButton.style.display = inTrash ? "none" : "inline-grid";
    els.deleteButton.style.display = inTrash ? "none" : "inline-grid";
    renderSecondaryEditor();
    updateOutline();
    applyEditorLayout(false);
  }

  function render() { scheduleManager?.render(); whiteboardManager?.render(); renderSidebar(); renderList(); renderEditor(); applyLayout(false); }

  function leaveWorkspaceModes() { taskManager?.leave(); scheduleManager?.leave(); whiteboardManager?.leave(); }

  function flushActiveWorkspace(reason = "manual") {
    if (whiteboardManager?.active) return whiteboardManager.flush(reason);
    if (scheduleManager?.active) return scheduleManager.flush(reason);
    if (taskManager?.active) return taskManager.flush(reason);
    return flushEditor(reason);
  }

  function setActiveView(view) {
    if (view === "tasks") { flushActiveWorkspace("switch"); scheduleManager?.leave(); whiteboardManager?.leave(); activeView = "tasks"; taskManager?.enter(); renderSidebar(); return; }
    if (view === "schedule") { flushActiveWorkspace("switch"); taskManager?.leave(); whiteboardManager?.leave(); activeView = "schedule"; scheduleManager?.enter(); renderSidebar(); return; }
    if (view === "whiteboard") { flushActiveWorkspace("switch"); taskManager?.leave(); scheduleManager?.leave(); activeView = "whiteboard"; whiteboardManager?.enter(); renderSidebar(); return; }
    flushActiveWorkspace("switch");
    leaveWorkspaceModes();
    flushEditor(); closeContextMenu(); activeView = view; searchTerm = ""; els.searchInput.value = "";
    activeFileId = null; activeLinkUrl = null;
    if (view.startsWith("category:")) expandFolderPath(view.slice(9));
    const visible = getVisibleNotes();
    if (!visible.some((note) => note.id === activeNoteId)) activeNoteId = visible[0]?.id || null;
    render(); closeSidebar();
  }

  function selectNote(id) {
    leaveWorkspaceModes();
    flushEditor(); closeContextMenu();
    activeFileId = null; activeLinkUrl = null;
    if (layout.split && layout.secondaryNoteId === id) layout.secondaryNoteId = activeNoteId;
    activeNoteId = id; editMode = "rich"; outlinePane = "primary"; setEditorMode(false);
    renderList(); renderEditor(); els.workspace.classList.add("editor-open");
  }

  function selectFile(id) {
    leaveWorkspaceModes();
    flushEditor(); closeContextMenu();
    const file = getStoredFile(id); if (!file) return;
    activeFileId = id; activeLinkUrl = null; activeNoteId = null; if (file.folderId) { activeView = `category:${file.folderId}`; expandFolderPath(file.folderId); }
    renderSidebar(); renderList(); renderEditor(); els.workspace.classList.add("editor-open");
  }

  function createNote(categoryId) {
    leaveWorkspaceModes();
    flushEditor();
    const defaultCategory = typeof categoryId === "string" ? categoryId : activeView.startsWith("category:") ? activeView.slice(9) : state.categories[0]?.id || "";
    const note = { id: uid(), title: "", categoryId: defaultCategory, tags: [], favorite: false, createdAt: now(), updatedAt: now(), deletedAt: null, content: "" };
    state.notes.unshift(note); activeNoteId = note.id; activeFileId = null; activeLinkUrl = null; if (activeView === "trash") activeView = "all";
    searchTerm = ""; els.searchInput.value = ""; editMode = "rich"; setEditorMode(false); persist(true); render();
    els.workspace.classList.add("editor-open"); requestAnimationFrame(() => els.titleInput.focus());
  }

  function updateActiveNote(changes, rerenderList = true) {
    const note = getActiveNote();
    if (!note || note.deletedAt) return;
    Object.assign(note, changes, { updatedAt: now() });
    els.editedTime.textContent = formatDate(note.updatedAt, true); persist();
    if (rerenderList) { renderList(); renderSidebar(); }
  }

  function hasEditableBlockContent(element) {
    if (!element) return false;
    if (element.textContent.replace(/\u200b/g, "").trim()) return true;
    return Boolean(element.querySelector("img,hr,input,video,audio,iframe"));
  }

  function normalizeRichImageStructure(root) {
    if (!root?.querySelectorAll) return root;
    [...root.querySelectorAll(".note-image-row")].forEach((row) => row.replaceWith(...row.childNodes));
    [...root.querySelectorAll("img")].forEach((image) => {
      const block = image.closest("h1,h2,h3,p,blockquote,li,pre");
      if (!block || block === root || !root.contains(block)) return;
      if (image.parentElement === block) {
        const afterBlock = block.cloneNode(false);
        while (image.nextSibling) afterBlock.appendChild(image.nextSibling);
        block.after(image);
        if (hasEditableBlockContent(afterBlock)) image.after(afterBlock);
        if (!hasEditableBlockContent(block)) block.remove();
      } else block.after(image);
    });
    root.querySelectorAll("p,div").forEach((block) => {
      if (/^#{1,3}$/.test(block.textContent.trim()) && block.nextElementSibling?.matches("img")) block.remove();
    });
    const directImages = [...root.children].filter((element) => element.matches("img"));
    directImages.forEach((image) => { if (!['below', 'side'].includes(image.dataset.wrap)) image.dataset.wrap = "below"; });
    directImages.forEach((image) => {
      const previous = image.previousElementSibling;
      if (previous?.matches("img") && previous.dataset.wrap === "below") previous.dataset.wrap = "side";
      if (image.dataset.wrap !== "below" || image.nextElementSibling?.matches("img")) return;
      let next = image.nextElementSibling;
      if (!next) { next = createEmptyEditorParagraph(); image.after(next); }
      next.dataset.imageClear = "true";
    });
    return root;
  }

  function createEmptyEditorParagraph() {
    const paragraph = document.createElement("p"); paragraph.appendChild(document.createElement("br")); return paragraph;
  }

  function paragraphBelowImage(image) {
    let lastImage = image;
    while (lastImage?.nextElementSibling?.matches("img")) lastImage = lastImage.nextElementSibling;
    let next = lastImage?.nextElementSibling;
    if (!next || next.matches("img")) { next = createEmptyEditorParagraph(); lastImage.after(next); }
    next.dataset.imageClear = "true"; lastImage.dataset.wrap = "below"; return next;
  }

  function placeCaretAtBlockStart(block) {
    if (!block?.isConnected) return;
    els.contentEditor.focus();
    const range = document.createRange(); range.setStart(block, 0); range.collapse(true);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); saveCurrentRange(range);
  }

  function getCleanPrimaryHtml() {
    const clone = els.contentEditor.cloneNode(true);
    normalizeRichImageStructure(clone);
    clone.querySelectorAll(".image-selected,.context-target").forEach((element) => element.classList.remove("image-selected", "context-target"));
    return clone.innerHTML;
  }

  function flushEditor(reason = "switch") {
    clearTimeout(saveTimer);
    const note = getActiveNote();
    if (!note || note.deletedAt || els.editor.hidden) return;
    note.title = els.titleInput.value.trim(); note.categoryId = els.categorySelect.value;
    note.tags = els.tagInput.value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean);
    note.content = editMode === "markdown" ? markdownToHtml(els.markdownEditor.value) : getCleanPrimaryHtml();
    return persist(true, reason);
  }

  function setEditorMode(convert = true) {
    const markdown = editMode === "markdown";
    if (convert) {
      if (markdown) els.markdownEditor.value = htmlToMarkdown(els.contentEditor.innerHTML);
      else { els.contentEditor.innerHTML = markdownToHtml(els.markdownEditor.value); normalizeRichImageStructure(els.contentEditor); }
    }
    els.contentEditor.hidden = markdown; els.markdownEditor.hidden = !markdown;
    els.formatToolbar.style.display = markdown ? "none" : "flex";
    els.modeToggle.textContent = markdown ? "富文本" : "Markdown";
  }

  function getSecondaryNote() { return getNote(layout.secondaryNoteId); }

  function ensureSecondaryNote() {
    let note = getSecondaryNote();
    if (!note || note.deletedAt || note.id === activeNoteId) {
      note = state.notes.find((item) => !item.deletedAt && item.id !== activeNoteId) || null;
      layout.secondaryNoteId = note?.id || null;
    }
    return note;
  }

  function renderSecondaryEditor() {
    if (!layout.split || !getActiveNote()) { els.secondaryEditor.hidden = true; return; }
    const note = ensureSecondaryNote();
    if (!note) { layout.split = false; els.secondaryEditor.hidden = true; return; }
    const candidates = state.notes.filter((item) => !item.deletedAt && item.id !== activeNoteId);
    els.secondaryNoteSelect.innerHTML = candidates.map((item) => `<option value="${item.id}">${escapeHtml(item.title || "无标题笔记")}</option>`).join("");
    els.secondaryNoteSelect.value = note.id;
    els.secondaryTitle.value = note.title || "";
    els.secondaryContent.innerHTML = note.content || "";
    els.secondaryEditor.hidden = false;
    setOutlinePane(outlinePane === "secondary" ? "secondary" : "primary", false);
  }

  function updateSecondaryNote(changes, updateList = true) {
    const note = getSecondaryNote();
    if (!note || note.deletedAt) return;
    Object.assign(note, changes, { updatedAt: now() });
    persist();
    if (updateList) { renderList(); renderSidebar(); }
    if (outlinePane === "secondary") updateOutline();
  }

  function toggleSplitView(force) {
    if (window.innerWidth < 960) return showToast("分栏功能适用于桌面宽屏");
    const enable = typeof force === "boolean" ? force : !layout.split;
    if (enable && !state.notes.some((note) => !note.deletedAt && note.id !== activeNoteId)) return showToast("至少需要两篇笔记才能开启分栏");
    layout.split = enable;
    if (enable) ensureSecondaryNote();
    else outlinePane = "primary";
    saveLayout(); renderSecondaryEditor(); applyEditorLayout(); updateOutline();
  }

  function openInSecondary(id) {
    if (window.innerWidth < 960) return showToast("右侧分栏适用于桌面宽屏");
    if (id === activeNoteId) return showToast("这篇笔记已在主栏打开");
    const note = getNote(id); if (!note || note.deletedAt) return;
    layout.secondaryNoteId = id; layout.split = true; outlinePane = "secondary";
    saveLayout(); renderSecondaryEditor(); applyEditorLayout(); updateOutline(); showToast("已在右侧打开笔记");
  }

  function applyEditorLayout(shouldSave = false) {
    const desktop = window.innerWidth >= 960, hasNote = Boolean(getActiveNote());
    const viewingWeb = Boolean(activeLinkUrl), showSplit = desktop && hasNote && !viewingWeb && layout.split && Boolean(ensureSecondaryNote());
    const enoughForSplitOutline = !showSplit || els.editorPanel.clientWidth >= 850;
    const showOutline = desktop && hasNote && !viewingWeb && layout.outline && enoughForSplitOutline;
    els.editorPanel.classList.toggle("split-active", showSplit);
    els.editorSplitResizer.hidden = !showSplit; els.secondaryEditor.hidden = !showSplit; els.outlinePanel.hidden = !showOutline;
    els.splitViewButton.classList.toggle("active", showSplit);
    els.outlineButton.classList.toggle("active", showOutline);
    const outlineTrack = showOutline ? "220px" : "0px";
    if (showSplit) {
      const left = clamp(Number(layout.splitRatio) || 50, 30, 70), right = 100 - left;
      els.editorPanel.style.gridTemplateColumns = `minmax(260px, ${left}fr) 7px minmax(260px, ${right}fr) ${outlineTrack}`;
    } else els.editorPanel.style.gridTemplateColumns = `minmax(0, 1fr) 0 0 ${outlineTrack}`;
    if (shouldSave) saveLayout();
  }

  function startEditorSplitResize(event) {
    if (window.innerWidth < 960) return;
    event.preventDefault();
    const rect = els.editorPanel.getBoundingClientRect(), outlineWidth = els.outlinePanel.hidden ? 0 : 220;
    const available = Math.max(1, rect.width - outlineWidth - 7);
    document.body.classList.add("resizing"); els.editorSplitResizer.classList.add("dragging");
    const move = (moveEvent) => { layout.splitRatio = clamp(((moveEvent.clientX - rect.left) / available) * 100, 30, 70); applyEditorLayout(false); };
    const end = () => { document.body.classList.remove("resizing"); els.editorSplitResizer.classList.remove("dragging"); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); saveLayout(); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end, { once: true });
  }

  function getOutlineSource() {
    if (outlinePane === "secondary" && layout.split && !els.secondaryEditor.hidden) return { editor: els.secondaryContent, scroll: els.secondaryScroll, note: getSecondaryNote() };
    return { editor: els.contentEditor, scroll: els.editorScroll, note: getActiveNote() };
  }

  function setOutlinePane(pane, refresh = true) {
    outlinePane = pane === "secondary" && layout.split ? "secondary" : "primary";
    els.editor.classList.toggle("pane-active", outlinePane === "primary" && layout.split);
    els.secondaryEditor.classList.toggle("pane-active", outlinePane === "secondary" && layout.split);
    if (refresh) updateOutline();
  }

  function updateOutline() {
    const source = getOutlineSource(), headings = source.editor ? [...source.editor.querySelectorAll("h1,h2,h3")] : [];
    els.outlineTitle.textContent = source.note?.title ? `${source.note.title} · 大纲` : "笔记大纲";
    if (!headings.length) { els.outlineList.innerHTML = '<div class="outline-empty">使用 H1、H2 或 H3 标题后，<br>这里会自动生成大纲。</div>'; return; }
    els.outlineList.innerHTML = headings.map((heading, index) => `<button class="outline-item level-${heading.tagName.slice(1)}" data-outline-index="${index}" title="${escapeAttr(heading.textContent.trim())}">${escapeHtml(heading.textContent.trim() || "未命名标题")}</button>`).join("");
    updateOutlineActive();
  }

  function updateOutlineActive() {
    const source = getOutlineSource(); if (!source.editor || !source.scroll) return;
    const headings = [...source.editor.querySelectorAll("h1,h2,h3")], scrollTop = source.scroll.getBoundingClientRect().top + 90;
    let activeIndex = 0;
    headings.forEach((heading, index) => { if (heading.getBoundingClientRect().top <= scrollTop) activeIndex = index; });
    els.outlineList.querySelectorAll(".outline-item").forEach((item, index) => item.classList.toggle("active", index === activeIndex));
  }

  function deselectImage() {
    if (selectedImage) selectedImage.classList.remove("image-selected");
    selectedImage = null;
    if (els.imageResizeOverlay) els.imageResizeOverlay.hidden = true;
    if (els.imagePositionGuide) els.imagePositionGuide.hidden = true;
    if (els.imageDropMarker) els.imageDropMarker.hidden = true;
  }

  function positionImageResizeOverlay() {
    if (!selectedImage?.isConnected || els.contentEditor.hidden) return deselectImage();
    const imageRect = selectedImage.getBoundingClientRect(), scrollRect = els.editorScroll.getBoundingClientRect();
    els.imageResizeOverlay.style.left = `${imageRect.left - scrollRect.left + els.editorScroll.scrollLeft}px`;
    els.imageResizeOverlay.style.top = `${imageRect.top - scrollRect.top + els.editorScroll.scrollTop}px`;
    els.imageResizeOverlay.style.width = `${imageRect.width}px`; els.imageResizeOverlay.style.height = `${imageRect.height}px`;
    els.imageSizeLabel.textContent = `${Math.round(imageRect.width)} × ${Math.round(imageRect.height)} px`;
  }

  function selectImageForResize(image) {
    if (getActiveNote()?.deletedAt || editMode !== "rich") return;
    deselectImage(); selectedImage = image; image.classList.add("image-selected"); els.imageResizeOverlay.hidden = false;
    requestAnimationFrame(positionImageResizeOverlay);
  }

  function startImageResize(event, mode = "both") {
    if (!selectedImage) return;
    event.preventDefault(); event.stopPropagation();
    const startX = event.clientX, startY = event.clientY, startRect = selectedImage.getBoundingClientRect(), startWidth = startRect.width, startHeight = startRect.height, editorWidth = els.contentEditor.getBoundingClientRect().width;
    document.body.classList.add("resizing-image");
    const move = (moveEvent) => {
      const width = mode === "height" ? selectedImage.getBoundingClientRect().width : clamp(startWidth + moveEvent.clientX - startX, 80, editorWidth);
      const height = mode === "width" ? selectedImage.getBoundingClientRect().height : clamp(startHeight + moveEvent.clientY - startY, 60, 2400);
      if (mode !== "height") { selectedImage.style.width = `${(width / editorWidth) * 100}%`; selectedImage.dataset.size = "custom"; }
      if (mode !== "width") { selectedImage.style.height = `${height}px`; selectedImage.dataset.height = "custom"; }
      if (selectedImage.dataset.align === "free") {
        const maxLeft = Math.max(0, 100 - (width / editorWidth) * 100), currentLeft = parseFloat(selectedImage.style.marginLeft) || 0;
        selectedImage.style.marginLeft = `${Math.min(currentLeft, maxLeft)}%`;
      }
      positionImageResizeOverlay();
    };
    const end = () => { document.body.classList.remove("resizing-image"); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); commitEditor(); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end, { once: true });
  }

  function startImageMove(event) {
    if (!selectedImage?.isConnected) return;
    event.preventDefault(); event.stopPropagation();
    const image = selectedImage, imageRect = image.getBoundingClientRect(), editorRect = els.contentEditor.getBoundingClientRect(), scrollRect = els.editorScroll.getBoundingClientRect();
    const startX = event.clientX, startY = event.clientY;
    const pointerOffsetX = startX - imageRect.left;
    let xPercent = clamp(((imageRect.left - editorRect.left) / Math.max(1, editorRect.width)) * 100, 0, 100), destination = null, moved = false;
    els.imagePositionGuide.style.top = `${els.editorScroll.scrollTop + 12}px`;
    els.imagePositionGuide.hidden = false;
    els.imagePositionCursor.style.left = `${xPercent}%`; els.imagePositionLabel.textContent = `${Math.round(xPercent)}%`;
    document.body.classList.add("moving-image");

    const updatePosition = (moveEvent) => {
      if (!moved && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 4) return;
      moved = true;
      els.imagePositionGuide.style.top = `${els.editorScroll.scrollTop + 12}px`;
      const maxLeftPx = Math.max(0, editorRect.width - image.getBoundingClientRect().width), leftPx = clamp(moveEvent.clientX - editorRect.left - pointerOffsetX, 0, maxLeftPx);
      xPercent = (leftPx / Math.max(1, editorRect.width)) * 100;
      image.dataset.align = "free"; image.style.marginLeft = `${xPercent}%`; image.style.marginRight = "0";
      els.imagePositionCursor.style.left = `${maxLeftPx ? (leftPx / maxLeftPx) * 100 : 0}%`; els.imagePositionLabel.textContent = `${Math.round(xPercent)}%`;
      positionImageResizeOverlay();

      const rowTarget = [...els.contentEditor.querySelectorAll("img")]
        .filter((candidate) => candidate !== image)
        .map((candidate) => ({ candidate, rect: candidate.getBoundingClientRect() }))
        .filter(({ rect }) => moveEvent.clientY >= rect.top - 18 && moveEvent.clientY <= rect.bottom + 18)
        .sort((a, b) => Math.abs(moveEvent.clientX - (a.rect.left + a.rect.width / 2)) - Math.abs(moveEvent.clientX - (b.rect.left + b.rect.width / 2)))[0];
      if (rowTarget) {
        const after = moveEvent.clientX >= rowTarget.rect.left + rowTarget.rect.width / 2;
        destination = { image: rowTarget.candidate, after, sameRow: true, desiredLeftPx: leftPx };
        els.imageDropMarker.classList.add("vertical");
        els.imageDropMarker.style.left = `${(after ? rowTarget.rect.right : rowTarget.rect.left) - scrollRect.left + els.editorScroll.scrollLeft}px`;
        els.imageDropMarker.style.top = `${rowTarget.rect.top - scrollRect.top + els.editorScroll.scrollTop}px`;
        els.imageDropMarker.style.width = "3px"; els.imageDropMarker.style.height = `${rowTarget.rect.height}px`;
        els.imageDropMarker.hidden = false;
        return;
      }

      const blocks = [...els.contentEditor.children];
      if (!blocks.length || moveEvent.clientY < scrollRect.top || moveEvent.clientY > scrollRect.bottom) {
        destination = null; els.imageDropMarker.hidden = true; return;
      }
      els.imageDropMarker.classList.remove("vertical"); els.imageDropMarker.style.height = "3px";
      const before = blocks.find((block) => moveEvent.clientY < block.getBoundingClientRect().top + block.getBoundingClientRect().height / 2);
      const block = before || blocks.at(-1), after = !before;
      destination = { block, after };
      const blockRect = block.getBoundingClientRect(), markerTop = (after ? blockRect.bottom : blockRect.top) - scrollRect.top + els.editorScroll.scrollTop;
      els.imageDropMarker.style.left = `${editorRect.left - scrollRect.left + els.editorScroll.scrollLeft}px`;
      els.imageDropMarker.style.width = `${editorRect.width}px`;
      els.imageDropMarker.style.top = `${markerTop}px`;
      els.imageDropMarker.hidden = false;
      if (moveEvent.clientY < scrollRect.top + 42) els.editorScroll.scrollBy({ top: -18 });
      else if (moveEvent.clientY > scrollRect.bottom - 42) els.editorScroll.scrollBy({ top: 18 });
    };

    const end = () => {
      window.removeEventListener("pointermove", updatePosition);
      document.body.classList.remove("moving-image");
      els.imagePositionGuide.hidden = true; els.imageDropMarker.hidden = true;
      if (!moved) return;
      if (destination?.sameRow && destination.image?.isConnected) {
        const target = destination.image, targetRect = target.getBoundingClientRect(), imageWidth = image.getBoundingClientRect().width;
        const siblings = [...els.contentEditor.querySelectorAll("img")].filter((candidate) => candidate !== image && candidate !== target);
        if (destination.after) {
          target.after(image);
          const targetRight = targetRect.right - editorRect.left, targetMargin = parseFloat(getComputedStyle(target).marginRight) || 0;
          image.style.marginLeft = `${(Math.max(0, destination.desiredLeftPx - targetRight - targetMargin) / editorRect.width) * 100}%`;
        } else {
          const previous = siblings.map((candidate) => ({ candidate, rect: candidate.getBoundingClientRect() })).filter(({ rect }) => rect.right <= targetRect.left && Math.abs(rect.top - targetRect.top) < 18).sort((a, b) => b.rect.right - a.rect.right)[0];
          const baseRight = previous ? previous.rect.right - editorRect.left + (parseFloat(getComputedStyle(previous.candidate).marginRight) || 0) : 0;
          const desiredLeft = Math.max(baseRight, destination.desiredLeftPx);
          target.before(image);
          image.style.marginLeft = `${(Math.max(0, desiredLeft - baseRight) / editorRect.width) * 100}%`;
          target.style.marginLeft = `${(Math.max(0, targetRect.left - editorRect.left - desiredLeft - imageWidth) / editorRect.width) * 100}%`;
        }
        image.style.marginRight = ""; image.dataset.align = "free";
      } else if (destination?.block?.isConnected) destination.after ? destination.block.after(image) : destination.block.before(image);
      commitEditor(); requestAnimationFrame(positionImageResizeOverlay); showToast("图片位置已更新");
    };
    updatePosition(event);
    window.addEventListener("pointermove", updatePosition);
    window.addEventListener("pointerup", end, { once: true });
  }

  function safeImageLayoutValue(value, units = ["%", "px"]) {
    const match = String(value || "").trim().match(/^(\d+(?:\.\d+)?)(%|px)$/);
    if (!match || !units.includes(match[2])) return "";
    const number = Number(match[1]);
    if (!Number.isFinite(number) || number < 0 || (match[2] === "%" ? number > 100 : number > 5000)) return "";
    return `${number}${match[2]}`;
  }

  function markdownImageToHtml(alt, rawTarget, rawMeta = "") {
    const target = String(rawTarget || "").trim();
    let attachmentId = "", src = "";
    if (target.startsWith("easynote-attachment:")) {
      attachmentId = target.slice("easynote-attachment:".length);
      if (!/^[\w.-]+$/.test(attachmentId)) return "";
      src = safety?.getAttachmentUrl(attachmentId) || "";
    } else if (target.startsWith("blob:")) {
      attachmentId = safety?.getAttachmentIdByUrl?.(target) || "";
      src = attachmentId ? (safety?.getAttachmentUrl(attachmentId) || "") : "";
    } else if (/^data:image\/(?:jpeg|png|webp|gif);base64,/i.test(target)) src = target;
    if (!src) return "";

    const meta = {};
    String(rawMeta || "").split(/\s+/).forEach((part) => {
      const separator = part.indexOf("=");
      if (separator > 0) meta[part.slice(0, separator)] = part.slice(separator + 1);
    });
    const size = ["small", "medium", "large", "full", "custom"].includes(meta.size) ? meta.size : "large";
    const align = ["left", "center", "right", "free"].includes(meta.align) ? meta.align : "center";
    const wrap = meta.wrap === "side" ? "side" : "below";
    const width = safeImageLayoutValue(meta.width), height = safeImageLayoutValue(meta.height);
    const left = safeImageLayoutValue(meta.left), right = safeImageLayoutValue(meta.right);
    const styles = [];
    if (width) styles.push(`width:${width}`);
    if (height) styles.push(`height:${height}`);
    if (left) styles.push(`margin-left:${left}`);
    if (right) styles.push(`margin-right:${right}`);
    return `<img src="${escapeAttr(src)}"${attachmentId ? ` data-attachment-id="${escapeAttr(attachmentId)}"` : ""} alt="${escapeAttr(alt || "图片")}" data-size="${size}" data-align="${align}" data-wrap="${wrap}"${styles.length ? ` style="${styles.join(";")}"` : ""}>`;
  }

  function markdownToHtml(markdown) {
    const codeBlocks = [], imageBlocks = [];
    let prepared = String(markdown || "").replace(/\r\n/g, "\n")
      .replace(/```([\s\S]*?)```/g, (_, code) => { codeBlocks.push(`<pre>${escapeHtml(code.trim())}</pre>`); return `\n@@CODE${codeBlocks.length - 1}@@\n`; })
      .replace(/<!--\s*easynote:image-clear\s*-->/gi, "\n@@IMAGECLEAR@@\n")
      .replace(/!\[([^\]]*)\]\(([^)\s]+)\)(?:\{([^}\n]*)\})?/g, (match, alt, target, meta) => {
        const html = markdownImageToHtml(alt, target, meta);
        if (!html) return match;
        imageBlocks.push(html); return `\n@@IMAGE${imageBlocks.length - 1}@@\n`;
      });
    let text = escapeHtml(prepared);
    text = text
      .replace(/^### (.+)$/gm, "<h3>$1</h3>").replace(/^## (.+)$/gm, "<h2>$1</h2>").replace(/^# (.+)$/gm, "<h1>$1</h1>")
      .replace(/^&gt; (.+)$/gm, "<blockquote>$1</blockquote>")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\*(.+?)\*/g, "<em>$1</em>").replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" rel="noopener noreferrer">$1</a>');
    const lines = text.split("\n"), result = []; let listType = null;
    const closeList = () => { if (listType) { result.push(`</${listType}>`); listType = null; } };
    lines.forEach((line) => {
      const ul = line.match(/^[-*] (.+)$/), ol = line.match(/^\d+\. (.+)$/);
      if (ul || ol) { const type = ul ? "ul" : "ol"; if (listType !== type) { closeList(); result.push(`<${type}>`); listType = type; } result.push(`<li>${(ul || ol)[1]}</li>`); }
      else { closeList(); if (!line.trim()) result.push(""); else if (/^<(h[1-3]|blockquote|pre|img)/.test(line) || /^@@(?:CODE|IMAGE)/.test(line)) result.push(line); else result.push(`<p>${line}</p>`); }
    });
    closeList();
    const container = document.createElement("div");
    container.innerHTML = result.join("\n")
      .replace(/@@CODE(\d+)@@/g, (_, i) => codeBlocks[Number(i)])
      .replace(/@@IMAGE(\d+)@@/g, (_, i) => imageBlocks[Number(i)])
      .replace(/@@IMAGECLEAR@@/g, '<i data-image-clear-marker="true"></i>');
    container.querySelectorAll("[data-image-clear-marker]").forEach((marker) => { const next = marker.nextElementSibling; if (next) next.dataset.imageClear = "true"; marker.remove(); });
    normalizeRichImageStructure(container); return container.innerHTML;
  }

  function htmlToMarkdown(html) {
    const div = document.createElement("div"); div.innerHTML = html || "";
    normalizeRichImageStructure(div);
    const convert = (node, depth = 0) => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent;
      if (node.nodeType !== Node.ELEMENT_NODE) return "";
      const inner = [...node.childNodes].map((child) => convert(child, depth)).join("");
      const clearPrefix = node.dataset.imageClear === "true" ? "<!-- easynote:image-clear -->\n" : "";
      switch (node.tagName.toLowerCase()) {
        case "h1": return `${clearPrefix}# ${inner}\n\n`; case "h2": return `${clearPrefix}## ${inner}\n\n`; case "h3": return `${clearPrefix}### ${inner}\n\n`;
        case "p": case "div": return `${clearPrefix}${inner}\n\n`; case "br": return "\n";
        case "strong": case "b": return `**${inner}**`; case "em": case "i": return `*${inner}*`;
        case "blockquote": return clearPrefix + inner.split("\n").filter(Boolean).map((line) => `> ${line}`).join("\n") + "\n\n";
        case "pre": return `${clearPrefix}\`\`\`\n${node.textContent}\n\`\`\`\n\n`; case "code": return `\`${inner}\``;
        case "a": return `[${inner}](${node.getAttribute("href") || ""})`;
        case "img": {
          const src = node.getAttribute("src") || "";
          const attachmentId = node.dataset.attachmentId || safety?.getAttachmentIdByUrl?.(src) || "";
          const target = attachmentId ? `easynote-attachment:${attachmentId}` : src;
          const alt = (node.getAttribute("alt") || "图片").replace(/\]/g, "\\]").replace(/[\r\n]+/g, " ");
          const size = ["small", "medium", "large", "full", "custom"].includes(node.dataset.size) ? node.dataset.size : "large";
          const align = ["left", "center", "right", "free"].includes(node.dataset.align) ? node.dataset.align : "center";
          const wrap = node.dataset.wrap === "side" ? "side" : "below";
          const meta = [`size=${size}`, `align=${align}`, `wrap=${wrap}`];
          const width = safeImageLayoutValue(node.style.width), height = safeImageLayoutValue(node.style.height);
          const left = safeImageLayoutValue(node.style.marginLeft), right = safeImageLayoutValue(node.style.marginRight);
          if (width) meta.push(`width=${width}`);
          if (height) meta.push(`height=${height}`);
          if (left) meta.push(`left=${left}`);
          if (right) meta.push(`right=${right}`);
          return `![${alt}](${target}){${meta.join(" ")}}\n\n`;
        }
        case "hr": return "---\n\n";
        case "ul": case "ol": return clearPrefix + [...node.children].map((li, index) => `${"  ".repeat(depth)}${node.tagName === "OL" ? `${index + 1}.` : "-"} ${[...li.childNodes].map((child) => convert(child, depth + 1)).join("").trim()}\n`).join("") + "\n";
        case "li": return inner; default: return inner;
      }
    };
    return [...div.childNodes].map((node) => convert(node)).join("").replace(/\n{3,}/g, "\n\n").trim();
  }

  function finishDialog(value) {
    if (!dialogState) return;
    const resolve = dialogState.resolve; dialogState = null; els.dialogBackdrop.hidden = true; els.dialogError.hidden = true; resolve(value);
  }

  function openCenteredDialog(options) {
    if (dialogState) finishDialog(null);
    return new Promise((resolve) => {
      dialogState = { ...options, resolve };
      els.dialogTitle.textContent = options.title || "请输入";
      els.dialogMessage.textContent = options.message || ""; els.dialogMessage.hidden = !options.message;
      els.dialogField.hidden = options.mode === "confirm";
      els.dialogLabel.textContent = options.label || "名称";
      els.dialogInput.type = options.type || "text"; els.dialogInput.value = options.value || ""; els.dialogInput.placeholder = options.placeholder || "";
      els.dialogConfirm.textContent = options.confirmText || "确定";
      els.dialogConfirm.className = options.danger ? "danger-button" : "primary-button";
      els.dialogError.hidden = true; els.dialogBackdrop.hidden = false;
      requestAnimationFrame(() => { if (options.mode === "confirm") els.dialogConfirm.focus(); else { els.dialogInput.focus(); els.dialogInput.select(); } });
    });
  }

  function showInputDialog(options) { return openCenteredDialog({ mode: "input", required: true, ...options }); }
  function showConfirmDialog(options) { return openCenteredDialog({ mode: "confirm", ...options }); }

  function submitDialog() {
    if (!dialogState) return;
    if (dialogState.mode === "confirm") return finishDialog(true);
    const value = els.dialogInput.value.trim();
    if (dialogState.required && !value) { els.dialogError.textContent = "请输入内容"; els.dialogError.hidden = false; return; }
    const error = dialogState.validate?.(value);
    if (error) { els.dialogError.textContent = error; els.dialogError.hidden = false; els.dialogInput.focus(); return; }
    finishDialog(value);
  }

  async function addCategory(parentId = null) {
    const parent = getCategory(parentId);
    const name = await showInputDialog({
      title: parent ? `在“${parent.name}”中新建文件夹` : "新建文件夹", label: "文件夹名称", placeholder: "例如：面试资料",
      validate: (value) => state.categories.some((item) => (item.parentId || null) === (parentId || null) && item.name === value) ? "同一层级下已存在同名文件夹" : ""
    });
    if (!name) return null;
    const folder = { id: uid(), name, parentId: parentId || null, color: CATEGORY_COLORS[state.categories.length % CATEGORY_COLORS.length] };
    state.categories.push(folder);
    if (parentId) { layout.expandedFolders = [...new Set([...(layout.expandedFolders || []), parentId])]; }
    activeView = `category:${folder.id}`; persist(true); saveLayout(); render(); showToast("文件夹已创建"); return folder;
  }

  async function renameCategory(id) {
    const folder = getCategory(id); if (!folder) return;
    const name = await showInputDialog({ title: "重命名文件夹", label: "文件夹名称", value: folder.name,
      validate: (value) => state.categories.some((item) => item.id !== id && (item.parentId || null) === (folder.parentId || null) && item.name === value) ? "同一层级下已存在同名文件夹" : "" });
    if (!name || name === folder.name) return;
    folder.name = name; persist(true); render(); showToast("文件夹已重命名");
  }

  async function deleteCategory(id) {
    const folder = getCategory(id); if (!folder) return;
    const confirmed = await showConfirmDialog({ title: "删除文件夹", message: `确定删除“${folder.name}”吗？其中的笔记、本地文件和子文件夹会移动到上一级，不会被删除。`, confirmText: "删除文件夹", danger: true });
    if (!confirmed) return;
    state.notes.forEach((note) => { if (note.categoryId === id) note.categoryId = folder.parentId || ""; });
    state.files.forEach((file) => { if (file.folderId === id) file.folderId = folder.parentId || ""; });
    state.categories.forEach((item) => { if (item.parentId === id) item.parentId = folder.parentId || null; });
    state.categories = state.categories.filter((item) => item.id !== id);
    layout.expandedFolders = (layout.expandedFolders || []).filter((item) => item !== id);
    if (activeView === `category:${id}`) activeView = folder.parentId ? `category:${folder.parentId}` : "all";
    persist(true); saveLayout(); render(); showToast("文件夹已删除，内容已移动到上一级");
  }

  function moveFolder(id, parentId) {
    const folder = getCategory(id); if (!folder || id === parentId || getDescendantFolderIds(id).includes(parentId)) return showToast("不能移动到自身或其子文件夹中");
    folder.parentId = parentId || null;
    if (parentId) layout.expandedFolders = [...new Set([...(layout.expandedFolders || []), parentId])];
    persist(true); saveLayout(); render(); showToast("文件夹已移动");
  }

  function startFileUpload(folderId = "") {
    pendingUploadFolderId = getCategory(folderId) ? folderId : "";
    els.localFileInput.click();
  }

  async function uploadLocalFiles(fileList, folderId = "") {
    const files = [...fileList]; if (!files.length) return;
    const added = [];
    for (const file of files) {
      if (file.size > MAX_FILE_BYTES) { showToast(`${file.name} 超过 25MB，已跳过`); continue; }
      try {
        const attachment = await safety.putAttachment(file, { name: file.name, type: file.type });
        const stored = { id: uid(), name: file.name, type: attachment.type, size: attachment.size, folderId: getCategory(folderId) ? folderId : "", attachmentId: attachment.id, createdAt: now() };
        state.files.push(stored); added.push(stored);
      } catch { showToast(`${file.name} 读取失败`); }
    }
    if (!added.length) return;
    if (folderId) expandFolderPath(folderId);
    await persist(true); render(); selectFile(added[0].id); updateSafetyCenter().catch(console.error); showToast(`已上传 ${added.length} 个文件`);
  }

  function downloadStoredFile(id = activeFileId) {
    const file = getStoredFile(id); if (!file) return;
    const blob = safety?.getAttachmentBlob(file.attachmentId) || (file.dataUrl ? dataUrlToBlob(file.dataUrl) : null);
    if (!blob) return showToast("附件内容缺失，无法下载");
    const url = URL.createObjectURL(blob), anchor = document.createElement("a"); anchor.href = url; anchor.download = file.name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function moveStoredFile(id, folderId) {
    const file = getStoredFile(id); if (!file) return;
    file.folderId = getCategory(folderId) ? folderId : ""; if (file.folderId) expandFolderPath(file.folderId);
    persist(true); render(); showToast("文件已移动");
  }

  async function deleteStoredFile(id = activeFileId) {
    const file = getStoredFile(id); if (!file) return;
    const confirmed = await showConfirmDialog({ title: "删除本地文件", message: `确定永久删除“${file.name}”吗？此操作无法撤销。`, confirmText: "永久删除", danger: true });
    if (!confirmed) return;
    await safety.recordRecovery("file-delete", `已删除文件：${file.name}`, { file: structuredClone(file) });
    state.files = state.files.filter((item) => item.id !== id); if (activeFileId === id) activeFileId = null;
    persist(true, "danger"); render(); showToast("文件已删除，可在数据安全中心恢复 30 天");
  }

  function toggleFavorite(id) { const note = getNote(id); if (!note || note.deletedAt) return; note.favorite = !note.favorite; note.updatedAt = now(); persist(true); render(); }
  function duplicateNote(id) {
    const source = getNote(id); if (!source || source.deletedAt) return;
    const copy = { ...structuredClone(source), id: uid(), title: `${source.title || "无标题笔记"} - 副本`, favorite: false, createdAt: now(), updatedAt: now(), deletedAt: null };
    state.notes.unshift(copy); activeNoteId = copy.id; activeView = "all"; persist(true); render(); showToast("已创建笔记副本");
  }
  function moveNoteToCategory(id, categoryId) { const note = getNote(id); if (!note) return; note.categoryId = categoryId; note.updatedAt = now(); if (categoryId) expandFolderPath(categoryId); persist(true); render(); showToast("笔记文件夹已更新"); }
  function moveToTrash(id = activeNoteId) { const note = getNote(id); if (!note) return; note.deletedAt = now(); note.updatedAt = now(); persist(true); if (id === activeNoteId) activeNoteId = getVisibleNotes().find((item) => item.id !== id)?.id || null; render(); showToast("笔记已移到回收站"); }
  function restoreNote(id = activeNoteId) { const note = getNote(id); if (!note) return; note.deletedAt = null; note.updatedAt = now(); persist(true); if (activeView === "trash" && id === activeNoteId) activeNoteId = getVisibleNotes().find((item) => item.id !== id)?.id || null; render(); showToast("笔记已恢复"); }
  async function permanentlyDelete(id = activeNoteId) {
    const note = getNote(id); if (!note) return;
    const confirmed = await showConfirmDialog({ title: "永久删除笔记", message: `确定永久删除“${note.title || "无标题笔记"}”吗？此操作无法撤销。`, confirmText: "永久删除", danger: true });
    if (!confirmed) return;
    await safety.recordRecovery("note-delete", `已永久删除：${note.title || "无标题笔记"}`, structuredClone(note));
    state.notes = state.notes.filter((item) => item.id !== id); if (id === activeNoteId) activeNoteId = getVisibleNotes()[0]?.id || null; persist(true, "danger"); render(); showToast("笔记已永久删除，可在数据安全中心恢复 30 天");
  }
  async function emptyTrash() {
    const removed = state.notes.filter((note) => note.deletedAt), count = removed.length;
    if (!count) return showToast("回收站已经是空的");
    const confirmed = await showConfirmDialog({ title: "清空回收站", message: `确定永久删除回收站中的 ${count} 篇笔记吗？删除后仍可从数据安全中心紧急恢复 30 天。`, confirmText: "清空回收站", danger: true });
    if (!confirmed) return;
    await safety.recordRecovery("trash-empty", `已清空回收站：${count} 篇笔记`, { notes: structuredClone(removed) });
    state.notes = state.notes.filter((note) => !note.deletedAt); activeNoteId = null;
    persist(true, "danger"); render(); showToast("回收站已清空，可在数据安全中心恢复 30 天");
  }

  function downloadFile(name, content, type) { const blob = new Blob([content], { type }); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  async function shareOrDownloadFile(name, content, type) {
    const file = new File([content], name, { type });
    if (matchMedia("(max-width: 620px)").matches && navigator.share && navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ title: "EasyNote 完整备份", files: [file] }); return "shared"; }
      catch (error) { if (error?.name === "AbortError") return "cancelled"; }
    }
    downloadFile(name, content, type); return "downloaded";
  }
  async function exportData() {
    try {
      await flushActiveWorkspace("manual");
      const date = new Date().toISOString().slice(0, 10);
      const portable = await safety.exportPortable(state);
      const result = await shareOrDownloadFile(`easynote-backup-${date}.json`, JSON.stringify(portable, null, 2), "application/json;charset=utf-8");
      if (result !== "cancelled") showToast(result === "shared" ? "便携式完整备份已发送" : "便携式完整备份已导出并包含全部附件");
    } catch (error) { console.error(error); showToast(`备份导出失败：${error.message || error}`); }
  }
  function exportNoteMarkdown(id = activeNoteId) {
    flushEditor(); const note = getNote(id); if (!note) return;
    const category = getCategory(note.categoryId)?.name || "未分类";
    const frontmatter = `---\ntitle: ${note.title || "无标题笔记"}\ncategory: ${category}\ntags: ${(note.tags || []).join(", ")}\nupdated: ${note.updatedAt}\n---\n\n`;
    downloadFile(`${(note.title || "无标题笔记").replace(/[\\/:*?"<>|]/g, "-")}.md`, frontmatter + htmlToMarkdown(note.content), "text/markdown;charset=utf-8"); showToast("Markdown 已导出");
  }

  function importData(file) {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        if (/\.(md|markdown)$/i.test(file.name)) {
          const raw = String(reader.result), match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/), metadata = {};
          if (match) match[1].split("\n").forEach((line) => { const i = line.indexOf(":"); if (i > -1) metadata[line.slice(0, i).trim()] = line.slice(i + 1).trim(); });
          const body = match ? raw.slice(match[0].length) : raw, heading = body.match(/^#\s+(.+)$/m), categoryName = metadata.category && metadata.category !== "未分类" ? metadata.category : "";
          let categoryId = "";
          if (categoryName) { let category = state.categories.find((item) => item.name === categoryName); if (!category) { category = { id: uid(), name: categoryName, color: CATEGORY_COLORS[state.categories.length % CATEGORY_COLORS.length] }; state.categories.push(category); } categoryId = category.id; }
          const note = { id: uid(), title: metadata.title || heading?.[1] || file.name.replace(/\.(md|markdown)$/i, ""), categoryId, tags: (metadata.tags || "").split(/[,，]/).map((tag) => tag.trim()).filter(Boolean), favorite: false, createdAt: now(), updatedAt: now(), deletedAt: null, content: markdownToHtml(body) };
          state.notes.unshift(note); activeView = "all"; activeNoteId = note.id; persist(true); render(); showToast("Markdown 笔记已导入"); return;
        }
        const imported = normalizeData(JSON.parse(reader.result));
        const confirmed = await showConfirmDialog({ title: "导入备份", message: `将导入 ${imported.notes.length} 篇笔记、${imported.tasks.length} 条任务、${imported.scheduleEntries.length} 条普通日程、${imported.scheduleSeries.length} 个固定日程和 ${imported.whiteboards.length} 张白板并替换当前数据，是否继续？`, confirmText: "导入并替换", danger: true });
        if (!confirmed) return;
        await safety.recordRecovery("import", "导入前完整数据", structuredClone(state));
        state = imported; taskManager?.setState(state); scheduleManager?.setState(state); whiteboardManager?.setState(state); activeView = "all"; activeNoteId = state.notes.find((note) => !note.deletedAt)?.id || null;
        const saved = await persist(true, "import");
        if (!saved) throw new Error("导入内容未能通过保存校验，旧数据已保存在紧急恢复区");
        render(); showToast("数据导入成功并已通过回读校验");
      } catch (error) { console.error(error); showToast("无法导入：文件格式不正确"); }
    };
    reader.readAsText(file);
  }

  function saveCurrentRange(range) { if (range && els.contentEditor.contains(range.commonAncestorContainer)) savedEditorRange = range.cloneRange(); }
  function captureEditorRange() { const selection = window.getSelection(); if (selection?.rangeCount) saveCurrentRange(selection.getRangeAt(0)); }
  function restoreEditorRange() {
    els.contentEditor.focus(); const selection = window.getSelection(); selection.removeAllRanges();
    if (savedEditorRange && savedEditorRange.commonAncestorContainer.isConnected) selection.addRange(savedEditorRange);
    else { const range = document.createRange(); range.selectNodeContents(els.contentEditor); range.collapse(false); selection.addRange(range); savedEditorRange = range.cloneRange(); }
  }
  function commitEditor() { normalizeRichImageStructure(els.contentEditor); captureEditorRange(); updateActiveNote({ content: getCleanPrimaryHtml() }); if (outlinePane === "primary") updateOutline(); }
  function runEditorCommand(command, value = null) { restoreEditorRange(); document.execCommand(command, false, value); commitEditor(); }
  function insertEditorHtml(html) { restoreEditorRange(); document.execCommand("insertHTML", false, html); commitEditor(); }
  async function insertLinkAtSelection() {
    const url = await showInputDialog({ title: "插入链接", label: "链接地址", type: "url", placeholder: "https://example.com", validate: (value) => /^https?:\/\//i.test(value) ? "" : "请输入以 http:// 或 https:// 开头的地址" });
    if (!url) return;
    runEditorCommand("createLink", url);
    els.contentEditor.querySelectorAll("a[href]").forEach((link) => { if (link.href === url || link.getAttribute("href") === url) { link.removeAttribute("target"); link.rel = "noopener noreferrer"; } });
    commitEditor();
  }

  function fileToDataUrl(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); }); }
  function loadImage(url) { return new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = url; }); }
  async function processImage(file) {
    if (!/^image\/(jpeg|png|webp|gif)$/.test(file.type)) throw new Error("仅支持 JPEG、PNG、WebP 和 GIF 图片");
    if (file.size > MAX_IMAGE_BYTES) throw new Error("单张图片不能超过 12MB");
    if (file.type === "image/gif") return file;
    const objectUrl = URL.createObjectURL(file);
    try {
      const image = await loadImage(objectUrl), ratio = Math.min(1, 2000 / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio)); canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
      canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", .84));
      if (!blob) throw new Error("图片压缩失败");
      return blob;
    } finally { URL.revokeObjectURL(objectUrl); }
  }

  function insertStoredImageAtSelection(attachment, alt) {
    normalizeRichImageStructure(els.contentEditor); restoreEditorRange();
    const selection = window.getSelection(), range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    let block = range?.startContainer || null;
    if (block === els.contentEditor) block = els.contentEditor.childNodes[Math.min(range.startOffset, els.contentEditor.childNodes.length - 1)] || null;
    if (block?.nodeType === Node.TEXT_NODE) block = block.parentElement;
    while (block?.parentElement && block.parentElement !== els.contentEditor) block = block.parentElement;

    const image = document.createElement("img");
    image.src = attachment.url; image.dataset.attachmentId = attachment.id; image.alt = alt || "图片";
    image.dataset.size = "large"; image.dataset.align = "free"; image.dataset.wrap = "below"; image.style.marginLeft = "0%";
    const below = createEmptyEditorParagraph(); below.dataset.imageClear = "true";
    if (block?.dataset?.imageSide === "true" || (block?.previousElementSibling?.matches("img[data-wrap='side']") && block.dataset.imageClear !== "true")) {
      image.dataset.wrap = "side"; block.before(image);
      let clearBlock = block.nextElementSibling;
      if (!clearBlock || clearBlock.dataset.imageClear !== "true") { clearBlock = below; block.after(clearBlock); }
      placeCaretAtBlockStart(clearBlock); commitEditor(); placeCaretAtBlockStart(clearBlock); return image;
    }
    if (block && block.matches("p,div") && !hasEditableBlockContent(block)) block.replaceWith(image, below);
    else if (block?.isConnected) block.after(image, below);
    else els.contentEditor.append(image, below);
    commitEditor(); placeCaretAtBlockStart(below); return image;
  }

  function focusBesideImageAtPoint(event) {
    if (event.button !== 0 || event.target !== els.contentEditor) return false;
    const candidates = [...els.contentEditor.querySelectorAll(":scope > img")].map((image) => ({ image, rect: image.getBoundingClientRect() }))
      .filter(({ rect }) => event.clientY >= rect.top && event.clientY <= rect.bottom && (event.clientX < rect.left || event.clientX > rect.right))
      .sort((a, b) => Math.min(Math.abs(event.clientX - a.rect.left), Math.abs(event.clientX - a.rect.right)) - Math.min(Math.abs(event.clientX - b.rect.left), Math.abs(event.clientX - b.rect.right)));
    const image = candidates[0]?.image; if (!image) return false;
    event.preventDefault(); image.dataset.wrap = "side";
    let side = image.nextElementSibling;
    if (!side || side.matches("img") || side.dataset.imageClear === "true") {
      side = createEmptyEditorParagraph(); side.dataset.imageSide = "true"; image.after(side);
    } else side.dataset.imageSide = "true";
    let clearBlock = side.nextElementSibling;
    if (!clearBlock || clearBlock.dataset.imageClear !== "true") { clearBlock = createEmptyEditorParagraph(); clearBlock.dataset.imageClear = "true"; side.after(clearBlock); }
    commitEditor(); placeCaretAtBlockStart(side); return true;
  }

  async function insertImageFiles(files, range = savedEditorRange) {
    if (!safety) return showToast("安全存储尚未就绪");
    if (!getActiveNote() || getActiveNote().deletedAt || editMode !== "rich") return showToast("请先打开可编辑的富文本笔记");
    if (range) savedEditorRange = range.cloneRange();
    const valid = [...files].filter((file) => file.type.startsWith("image/")); if (!valid.length) return;
    showToast(`正在处理 ${valid.length} 张图片…`);
    for (const file of valid) {
      try {
        const blob = await processImage(file);
        const attachment = await safety.putAttachment(blob, { name: file.name, type: blob.type });
        insertStoredImageAtSelection(attachment, file.name.replace(/\.[^.]+$/, ""));
      }
      catch (error) { showToast(error.message || "图片插入失败"); }
    }
    showToast("图片已插入");
  }

  async function changeImage(action, value) {
    const image = contextPayload?.image; if (!image?.isConnected) return;
    if (action === "image-size") { image.dataset.size = value; delete image.dataset.height; image.style.width = ""; image.style.height = ""; }
    if (action === "image-align") { image.dataset.align = value; image.style.marginLeft = ""; image.style.marginRight = ""; }
    if (action === "image-alt") { const alt = await showInputDialog({ title: "图片说明", label: "替代文字", value: image.alt || "", required: false, placeholder: "描述图片内容" }); if (alt !== null) image.alt = alt; }
    if (action === "image-delete") { if (selectedImage === image) deselectImage(); image.remove(); }
    if (action === "image-download") { const anchor = document.createElement("a"); anchor.href = image.src; anchor.download = `${image.alt || "图片"}.${image.src.startsWith("data:image/gif") ? "gif" : "webp"}`; anchor.click(); return; }
    commitEditor(); if (selectedImage === image) requestAnimationFrame(positionImageResizeOverlay);
  }

  function safetyCardLevel(element, level) {
    const card = element?.closest(".safety-card");
    if (card) card.dataset.level = level;
  }

  function formatSafetyTime(value) {
    if (!value) return "暂无";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "暂无" : date.toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  async function updateSafetyCenter() {
    if (!safety) return;
    const summary = await safety.safetySummary();
    const report = summary.integrity;
    els.databaseSafetyState.textContent = report ? (report.ok ? "完整性正常" : `发现 ${report.errors.length} 个问题`) : "等待检查";
    els.databaseSafetyDetail.textContent = report ? `${report.counts.notes || 0} 篇笔记 · ${report.counts.tasks || 0} 条任务 · ${report.counts.schedules || 0} 条日程 · ${report.counts.whiteboards || 0} 张白板${report.warnings.length ? ` · ${report.warnings.length} 个提醒` : ""}` : "数据库已按记录独立存储";
    safetyCardLevel(els.databaseSafetyState, report?.ok ? (report.warnings.length ? "warn" : "good") : report ? "bad" : "warn");

    const quota = summary.storage.quota || 0, usage = summary.storage.usage || 0, ratio = quota ? usage / quota : 0;
    els.persistentStorageState.textContent = summary.storage.persisted ? "已持久化" : "尚未持久化";
    els.storageQuotaDetail.textContent = quota ? `${formatBytes(usage)} / ${formatBytes(quota)}（${Math.round(ratio * 100)}%）` : "浏览器未提供容量估算";
    safetyCardLevel(els.persistentStorageState, ratio >= .95 ? "bad" : summary.storage.persisted ? (ratio >= .7 ? "warn" : "good") : "warn");

    const backupLabels = { granted: "自动备份可用", prompt: "需要重新授权", denied: "目录权限已拒绝", unconfigured: "未配置目录" };
    els.directoryBackupState.textContent = backupLabels[summary.backupPermission] || "状态未知";
    els.directoryBackupDetail.textContent = summary.lastBackup ? `最近：${formatSafetyTime(summary.lastBackup.createdAt)} · ${summary.lastBackup.directory || "本地目录"}` : "尚未生成验证备份";
    safetyCardLevel(els.directoryBackupState, summary.backupPermission === "granted" && summary.lastBackup ? "good" : summary.backupPermission === "denied" ? "bad" : "warn");

    els.lastVerifiedSave.textContent = formatSafetyTime(summary.lastCommit?.committedAt);
    els.pendingSaveDetail.textContent = summary.lastError ? `失败：${summary.lastError}` : summary.pending ? "仍有写入正在等待" : "没有待处理写入";
    safetyCardLevel(els.lastVerifiedSave, summary.lastError ? "bad" : summary.pending ? "warn" : "good");
    els.retrySaveButton.disabled = !summary.pending && !summary.lastError;
    els.requestPersistenceButton.disabled = summary.storage.persisted;

    const backupText = summary.backupPermission === "granted" ? (summary.backupDirty?.value ? "数据库安全，目录备份待更新" : "数据库与目录备份正常") : "数据库已验证，建议配置自动备份";
    els.storageSummary.textContent = backupText;
    els.protocolAlert.hidden = location.protocol !== "file:";
    els.safetyUpdatedAt.textContent = `更新于 ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;

    const note = getActiveNote();
    if (note) {
      const histories = await safety.getHistory(note.id);
      els.historyList.innerHTML = histories.length ? histories.map((item) => `<div class="history-item"><div><strong>${escapeHtml(item.snapshot.title || "无标题笔记")}</strong><span>${formatSafetyTime(item.createdAt)} · ${escapeHtml(({ manual: "手动保存", switch: "切换笔记", danger: "危险操作前", migration: "数据迁移", import: "数据导入" })[item.reason] || "自动版本")}</span></div><button data-safety-action="restore-history" data-id="${item.id}">恢复</button></div>`).join("") : '<p class="safety-empty">当前笔记还没有历史版本。</p>';
    } else els.historyList.innerHTML = '<p class="safety-empty">打开一篇笔记后可查看历史版本。</p>';

    const recoveryItems = await safety.getRecoveryItems();
    els.recoveryList.innerHTML = recoveryItems.length ? recoveryItems.map((item) => `<div class="history-item"><div><strong>${escapeHtml(item.label)}</strong><span>${formatSafetyTime(item.createdAt)} · 保留至 ${formatSafetyTime(item.expiresAt)}</span></div><button data-safety-action="restore-recovery" data-id="${item.id}">恢复</button></div>`).join("") : '<p class="safety-empty">暂无可恢复内容。</p>';
  }

  async function openSafetyCenter() {
    els.safetyBackdrop.hidden = false;
    await updateSafetyCenter();
  }

  function closeSafetyCenter() { els.safetyBackdrop.hidden = true; }

  async function runSafetyTask(button, work, successMessage) {
    const oldText = button.textContent;
    button.disabled = true; button.textContent = "处理中…";
    try {
      const result = await work();
      if (successMessage) showToast(typeof successMessage === "function" ? successMessage(result) : successMessage);
      await updateSafetyCenter();
      return result;
    } catch (error) {
      console.error(error); showToast(error.message || "操作失败");
      await updateSafetyCenter();
      return null;
    } finally { button.disabled = false; button.textContent = oldText; }
  }

  async function restoreHistoryVersion(id) {
    const note = getActiveNote(), snapshot = await safety.getHistorySnapshot(id);
    if (!note || !snapshot) return showToast("历史版本已不存在");
    const confirmed = await showConfirmDialog({ title: "恢复历史版本", message: `恢复 ${formatSafetyTime(snapshot.updatedAt)} 的版本吗？当前内容会先保存为恢复记录。`, confirmText: "恢复版本" });
    if (!confirmed) return;
    await safety.recordRecovery("history-restore", `恢复历史前：${note.title || "无标题笔记"}`, structuredClone(note));
    Object.assign(note, snapshot, { id: note.id, updatedAt: now(), deletedAt: null });
    await persist(true, "manual"); render(); await updateSafetyCenter(); showToast("历史版本已恢复并通过保存校验");
  }

  async function restoreRecoveryItem(id) {
    const result = await safety.getRecoveryPayload(id);
    if (!result) return showToast("恢复记录已不存在");
    const confirmed = await showConfirmDialog({ title: "恢复数据", message: `确定恢复“${result.record.label}”吗？恢复操作不会删除这条恢复记录。`, confirmText: "恢复" });
    if (!confirmed) return;
    const payload = result.payload;
    if (Array.isArray(payload?.categories) && Array.isArray(payload?.notes)) {
      await safety.recordRecovery("restore-replace", "恢复整库前的数据", structuredClone(state));
      state = normalizeData(payload); taskManager?.setState(state); scheduleManager?.setState(state); whiteboardManager?.setState(state);
    } else if (Array.isArray(payload?.notes)) {
      payload.notes.forEach((note) => { const restored = { ...note, deletedAt: null, updatedAt: now() }; const index = state.notes.findIndex((item) => item.id === restored.id); if (index >= 0) state.notes[index] = restored; else state.notes.unshift(restored); });
    } else if (payload?.file) {
      const index = state.files.findIndex((item) => item.id === payload.file.id); if (index >= 0) state.files[index] = payload.file; else state.files.push(payload.file);
    } else if (payload?.task) {
      const index = state.tasks.findIndex((item) => item.id === payload.task.id); if (index >= 0) state.tasks[index] = payload.task; else state.tasks.push(payload.task);
    } else if (payload?.scheduleSeries) {
      const series = { ...payload.scheduleSeries, updatedAt: now() }, index = state.scheduleSeries.findIndex((item) => item.id === series.id);
      if (index >= 0) state.scheduleSeries[index] = series; else state.scheduleSeries.push(series);
      (payload.scheduleOccurrenceStates || []).forEach((occurrence) => { const stateIndex = state.scheduleOccurrenceStates.findIndex((item) => item.id === occurrence.id); if (stateIndex >= 0) state.scheduleOccurrenceStates[stateIndex] = occurrence; else state.scheduleOccurrenceStates.push(occurrence); });
    } else if (payload?.scheduleOccurrenceState) {
      const occurrence = { ...payload.scheduleOccurrenceState, deleted: false, updatedAt: now() }, index = state.scheduleOccurrenceStates.findIndex((item) => item.id === occurrence.id);
      if (index >= 0) state.scheduleOccurrenceStates[index] = occurrence; else state.scheduleOccurrenceStates.push(occurrence);
    } else if (payload?.scheduleEntry) {
      const restored = { ...payload.scheduleEntry, updatedAt: now() }, index = state.scheduleEntries.findIndex((item) => item.id === restored.id);
      if (index >= 0) state.scheduleEntries[index] = restored; else state.scheduleEntries.push(restored);
    } else if (payload?.whiteboard) {
      const restored = { ...payload.whiteboard, updatedAt: now() }, index = state.whiteboards.findIndex((item) => item.id === restored.id);
      if (index >= 0) state.whiteboards[index] = restored; else state.whiteboards.push(restored);
    } else if (payload?.field && Array.isArray(payload?.values)) {
      const index = state.taskFields.findIndex((item) => item.id === payload.field.id); if (index >= 0) state.taskFields[index] = payload.field; else state.taskFields.push(payload.field);
      payload.values.forEach((entry) => { const task = state.tasks.find((item) => item.id === entry.taskId); if (task) task.values[payload.field.id] = entry.value; });
    } else if (payload?.id) {
      const restored = { ...payload, deletedAt: null, updatedAt: now() }; const index = state.notes.findIndex((item) => item.id === restored.id); if (index >= 0) state.notes[index] = restored; else state.notes.unshift(restored);
    }
    activeView = "all"; activeNoteId = state.notes.find((item) => !item.deletedAt)?.id || null;
    await persist(true, "manual"); taskManager?.render(); scheduleManager?.render(); whiteboardManager?.setState(state); render(); await updateSafetyCenter(); showToast("数据已恢复并通过保存校验");
  }

  function showToast(message) { clearTimeout(toastTimer); els.toast.textContent = message; els.toast.classList.add("show"); toastTimer = setTimeout(() => els.toast.classList.remove("show"), 2400); }
  function closeSidebar() { els.sidebar.classList.remove("open"); els.sidebarScrim.classList.remove("open"); }

  function applyLayout(shouldSave = true) {
    const desktop = window.innerWidth >= 960;
    const visibility = layout.focus ? { sidebar: false, list: false, editor: true } : { sidebar: layout.sidebar, list: layout.list, editor: layout.editor };
    els.topbar.classList.toggle("focus-mode", desktop && layout.focus); els.focusExit.hidden = !(desktop && layout.focus);
    if (!desktop) {
      [els.sidebar, els.notePanel, els.editorPanel].forEach((panel) => panel.classList.remove("panel-hidden"));
      [els.sidebarResizer, els.listResizer].forEach((resizer) => resizer.classList.remove("panel-hidden"));
      els.workspace.style.gridTemplateColumns = ""; els.topbar.style.gridTemplateColumns = ""; applyEditorLayout(false); return;
    }
    const maxSideAndList = window.innerWidth - 434;
    if (visibility.sidebar && visibility.list && visibility.editor && layout.sidebarWidth + layout.listWidth > maxSideAndList) {
      layout.listWidth = Math.max(260, maxSideAndList - layout.sidebarWidth);
      if (layout.sidebarWidth + layout.listWidth > maxSideAndList) layout.sidebarWidth = Math.max(180, maxSideAndList - layout.listWidth);
    }
    els.sidebar.classList.toggle("panel-hidden", !visibility.sidebar); els.notePanel.classList.toggle("panel-hidden", !visibility.list); els.editorPanel.classList.toggle("panel-hidden", !visibility.editor);
    const sideSplit = visibility.sidebar && (visibility.list || visibility.editor), listSplit = visibility.list && visibility.editor;
    els.sidebarResizer.classList.toggle("panel-hidden", !sideSplit); els.listResizer.classList.toggle("panel-hidden", !listSplit);
    let sideTrack = visibility.sidebar ? `${layout.sidebarWidth}px` : "0px";
    let listTrack = visibility.list ? `${layout.listWidth}px` : "0px";
    let editorTrack = visibility.editor ? "minmax(420px, 1fr)" : "0px";
    if (!visibility.editor && visibility.list) listTrack = "minmax(260px, 1fr)";
    if (!visibility.editor && !visibility.list && visibility.sidebar) sideTrack = "1fr";
    els.workspace.style.gridTemplateColumns = `${sideTrack} ${sideSplit ? "7px" : "0px"} ${listTrack} ${listSplit ? "7px" : "0px"} ${editorTrack}`;
    els.topbar.style.gridTemplateColumns = `${visibility.sidebar ? `${layout.sidebarWidth}px` : "0px"} ${visibility.list ? `${layout.listWidth}px` : "0px"} minmax(0, 1fr)`;
    els.layoutPopover.querySelectorAll("[data-layout-panel]").forEach((button) => button.classList.toggle("off", !layout[button.dataset.layoutPanel]));
    els.panelSwitcher?.querySelectorAll("[data-panel-switch]").forEach((button) => {
      const visible = visibility[button.dataset.panelSwitch];
      button.classList.toggle("active", visible); button.setAttribute("aria-pressed", String(visible));
    });
    applyEditorLayout(false);
    if (shouldSave) saveLayout();
  }

  function togglePanel(panel) {
    if (layout.focus) exitFocusMode();
    const visibleCount = ["sidebar", "list", "editor"].filter((key) => layout[key]).length;
    if (layout[panel] && visibleCount === 1) return showToast("至少需要保留一个区域");
    layout[panel] = !layout[panel]; applyLayout();
  }
  function enterFocusMode() { if (window.innerWidth < 960) return showToast("专注模式适用于桌面宽屏"); if (!layout.focus) layout.preFocus = { sidebar: layout.sidebar, list: layout.list, editor: layout.editor }; layout.focus = true; layout.editor = true; els.layoutPopover.hidden = true; applyLayout(); }
  function exitFocusMode() { if (layout.preFocus) Object.assign(layout, layout.preFocus); layout.focus = false; layout.preFocus = null; applyLayout(); }
  function resetLayout() { layout = { ...DEFAULT_LAYOUT }; applyLayout(); els.layoutPopover.hidden = true; showToast("已恢复默认布局"); }

  function startResize(event, type) {
    if (event.target.closest("button") || window.innerWidth < 960) return;
    event.preventDefault(); const startX = event.clientX, startSide = layout.sidebarWidth, startList = layout.listWidth, resizer = type === "sidebar" ? els.sidebarResizer : els.listResizer;
    document.body.classList.add("resizing"); resizer.classList.add("dragging");
    try { resizer.setPointerCapture?.(event.pointerId); } catch { /* Synthetic pointer events may not own capture. */ }
    const move = (moveEvent) => {
      const dx = moveEvent.clientX - startX;
      if (type === "sidebar") layout.sidebarWidth = clamp(startSide + dx, 180, Math.max(180, Math.min(360, window.innerWidth - layout.listWidth - 434)));
      else layout.listWidth = clamp(startList + dx, 260, Math.max(260, Math.min(560, window.innerWidth - layout.sidebarWidth - 434)));
      applyLayout(false);
    };
    const end = () => { document.body.classList.remove("resizing"); resizer.classList.remove("dragging"); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); saveLayout(); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end, { once: true });
  }

  const sep = () => ({ separator: true });
  const menu = (label, action, options = {}) => ({ label, action, ...options });
  function sortItems() { return [menu("最近编辑", "sort", { value: "updated" }), menu("最近创建", "sort", { value: "created" }), menu("标题排序", "sort", { value: "title" })]; }
  function categoryMoveItems(noteId) { return [menu("未归档", "move-category", { value: `${noteId}|` }), ...state.categories.map((folder) => menu(getFolderPath(folder.id), "move-category", { value: `${noteId}|${folder.id}` }))]; }
  function folderMoveItems(folderId) {
    const excluded = new Set([folderId, ...getDescendantFolderIds(folderId)]);
    return [menu("移动到顶层", "move-folder", { value: `${folderId}|` }), ...state.categories.filter((folder) => !excluded.has(folder.id)).map((folder) => menu(getFolderPath(folder.id), "move-folder", { value: `${folderId}|${folder.id}` }))];
  }
  function fileMoveItems(fileId) { return [menu("未归档", "move-file", { value: `${fileId}|` }), ...state.categories.map((folder) => menu(getFolderPath(folder.id), "move-file", { value: `${fileId}|${folder.id}` }))]; }
  function folderMenu(folder) { return [menu("新建笔记", "new-note", { value: folder.id }), menu("上传本地文件", "upload-file", { value: folder.id }), menu("新建子文件夹", "new-subfolder", { value: folder.id }), sep(), menu("重命名文件夹", "rename-category", { value: folder.id }), menu("移动文件夹", null, { submenu: folderMoveItems(folder.id) }), menu("删除文件夹", "delete-category", { value: folder.id, danger: true })]; }
  function fileMenu(file) { return [menu("打开查看", "open-file", { value: file.id }), menu("下载文件", "download-file", { value: file.id }), menu("移动到文件夹", null, { submenu: fileMoveItems(file.id) }), sep(), menu("永久删除", "delete-file", { value: file.id, danger: true })]; }
  function linkMenu(link) { const url = link.href; return [menu("在正文中打开", "open-link-editor", { value: url }), menu("在新标签页打开", "open-link-tab", { value: url }), sep(), menu("复制链接地址", "copy-link", { value: url })]; }
  function noteMenu(note) {
    if (note.deletedAt) return [menu("打开查看", "open-note", { value: note.id }), sep(), menu("恢复笔记", "restore-note", { value: note.id }), menu("永久删除", "permanent-delete", { value: note.id, danger: true })];
    return [menu("打开笔记", "open-note", { value: note.id }), menu("在右侧分栏打开", "open-secondary", { value: note.id, disabled: note.id === activeNoteId }), menu(note.favorite ? "取消收藏" : "收藏笔记", "toggle-favorite", { value: note.id }), menu("复制笔记", "duplicate-note", { value: note.id }), menu("移动到文件夹", null, { submenu: categoryMoveItems(note.id) }), sep(), menu("导出 Markdown", "export-note", { value: note.id }), menu("移入回收站", "trash-note", { value: note.id, danger: true })];
  }
  function imageMenu() { return [menu("图片尺寸", null, { submenu: [menu("小尺寸", "image-size", { value: "small" }), menu("中等尺寸", "image-size", { value: "medium" }), menu("大尺寸", "image-size", { value: "large" }), menu("占满正文", "image-size", { value: "full" })] }), menu("图片对齐", null, { submenu: [menu("左对齐", "image-align", { value: "left" }), menu("居中", "image-align", { value: "center" }), menu("右对齐", "image-align", { value: "right" })] }), menu("修改图片说明", "image-alt"), menu("下载图片", "image-download"), sep(), menu("删除图片", "image-delete", { danger: true })]; }
  function selectionMenu() { return [menu("剪切", "cut", { shortcut: "Ctrl X" }), menu("复制", "copy", { shortcut: "Ctrl C" }), sep(), menu("加粗", "editor-command", { value: "bold", shortcut: "Ctrl B" }), menu("斜体", "editor-command", { value: "italic", shortcut: "Ctrl I" }), menu("设置标题", null, { submenu: [menu("正文", "format-block", { value: "p" }), menu("二级标题", "format-block", { value: "h2" }), menu("三级标题", "format-block", { value: "h3" })] }), menu("引用", "format-block", { value: "blockquote" }), menu("代码块", "format-block", { value: "pre" }), menu("添加链接", "insert-link"), menu("清除格式", "editor-command", { value: "removeFormat" })]; }
  function caretMenu() { return [menu("粘贴", "paste", { shortcut: "Ctrl V" }), sep(), menu("插入图片", "choose-image"), menu("插入链接", "insert-link"), menu("待办事项", "insert-html", { value: '<div class="check-item"><input type="checkbox" contenteditable="false"><span>待办事项</span></div><p><br></p>' }), menu("无序列表", "editor-command", { value: "insertUnorderedList" }), menu("有序列表", "editor-command", { value: "insertOrderedList" }), menu("引用", "format-block", { value: "blockquote" }), menu("代码块", "format-block", { value: "pre" }), menu("分割线", "insert-html", { value: "<hr><p><br></p>" })]; }

  function buildContextMenu(items) {
    return items.map((item) => {
      if (item.separator) return '<div class="context-separator"></div>';
      const submenu = item.submenu ? `<span class="context-arrow">›</span><div class="context-submenu">${buildContextMenu(item.submenu)}</div>` : "";
      return `<div class="context-item ${item.danger ? "danger" : ""} ${item.disabled ? "disabled" : ""}" role="menuitem" tabindex="${item.disabled ? "-1" : "0"}" ${item.disabled ? 'aria-disabled="true"' : ""} ${item.action ? `data-action="${item.action}"` : ""} ${item.value !== undefined ? `data-value="${escapeAttr(item.value)}"` : ""}>
        <span class="context-icon">${item.icon || ""}</span><span class="context-label">${escapeHtml(item.label)}</span>${item.shortcut ? `<span class="context-shortcut">${item.shortcut}</span>` : ""}${submenu}</div>`;
    }).join("");
  }
  function openContextMenu(x, y, items, payload = {}) {
    closeContextMenu(); contextPayload = payload; if (payload.image) payload.image.classList.add("context-target"); els.contextMenu.innerHTML = buildContextMenu(items); els.contextMenu.hidden = false;
    const rect = els.contextMenu.getBoundingClientRect(); els.contextMenu.classList.toggle("flip-submenus", x + rect.width * 2 > innerWidth);
    els.contextMenu.style.left = `${clamp(x, 8, innerWidth - rect.width - 8)}px`; els.contextMenu.style.top = `${clamp(y, 8, innerHeight - rect.height - 8)}px`;
  }
  function closeContextMenu() { els.contextMenu.hidden = true; els.contextMenu.innerHTML = ""; els.contentEditor.querySelectorAll("img.context-target").forEach((image) => image.classList.remove("context-target")); }

  async function pasteText() {
    try {
      const text = await navigator.clipboard.readText();
      if (contextPayload?.input) { const input = contextPayload.input; input.focus(); input.setRangeText(text, input.selectionStart, input.selectionEnd, "end"); input.dispatchEvent(new Event("input", { bubbles: true })); }
      else { restoreEditorRange(); document.execCommand("insertText", false, text); commitEditor(); }
    } catch { showToast("浏览器未授权读取剪贴板，请使用 Ctrl + V"); }
  }
  function runContextAction(action, value) {
    if (action?.startsWith("task-")) return taskManager?.runContextAction(action, value);
    if (action?.startsWith("schedule-")) return scheduleManager?.runContextAction(action, value);
    if (action === "open-note") selectNote(value);
    else if (action === "open-secondary") openInSecondary(value);
    else if (action === "open-view") setActiveView(value);
    else if (action === "toggle-favorite") toggleFavorite(value);
    else if (action === "duplicate-note") duplicateNote(value);
    else if (action === "move-category") { const [noteId, categoryId] = value.split("|"); moveNoteToCategory(noteId, categoryId); }
    else if (action === "move-folder") { const [folderId, parentId] = value.split("|"); moveFolder(folderId, parentId); }
    else if (action === "open-file") selectFile(value);
    else if (action === "download-file") downloadStoredFile(value);
    else if (action === "move-file") { const [fileId, folderId] = value.split("|"); moveStoredFile(fileId, folderId); }
    else if (action === "delete-file") deleteStoredFile(value);
    else if (action === "upload-file") startFileUpload(value);
    else if (action === "open-link-editor") openLinkInEditor(value, contextPayload?.link?.textContent || "");
    else if (action === "open-link-tab") openLinkNewTab(value);
    else if (action === "copy-link") navigator.clipboard?.writeText(value).then(() => showToast("链接已复制")).catch(() => showToast("复制失败，请手动复制"));
    else if (action === "export-note") exportNoteMarkdown(value);
    else if (action === "trash-note") moveToTrash(value);
    else if (action === "restore-note") restoreNote(value);
    else if (action === "permanent-delete") permanentlyDelete(value);
    else if (action === "new-note") createNote(value || undefined);
    else if (action === "add-category") addCategory();
    else if (action === "new-subfolder") addCategory(value);
    else if (action === "rename-category") renameCategory(value);
    else if (action === "delete-category") deleteCategory(value);
    else if (action === "empty-trash") emptyTrash();
    else if (action === "sort") { els.sortSelect.value = value; renderList(); }
    else if (action === "import") els.importFile.click();
    else if (action === "export") exportData();
    else if (action === "refresh") { render(); showToast("列表已刷新"); }
    else if (action === "cut" || action === "copy") { if (contextPayload?.input) contextPayload.input.focus(); else restoreEditorRange(); document.execCommand(action); if (action === "cut" && !contextPayload?.input) commitEditor(); }
    else if (action === "select-all") { const input = contextPayload?.input; if (input) { input.focus(); input.select(); } }
    else if (action === "paste") pasteText();
    else if (action === "editor-command") runEditorCommand(value);
    else if (action === "format-block") runEditorCommand("formatBlock", value);
    else if (action === "insert-link") insertLinkAtSelection();
    else if (action === "insert-html") insertEditorHtml(value);
    else if (action === "choose-image") els.imageFile.click();
    else if (action?.startsWith("image-")) changeImage(action, value);
    else if (action === "toggle-panel") togglePanel(value);
    else if (action === "focus") enterFocusMode();
    else if (action === "reset-layout") resetLayout();
  }

  function contextForTarget(target) {
    const taskContext = taskManager?.contextForTarget(target); if (taskContext) return taskContext;
    const scheduleContext = scheduleManager?.contextForTarget?.(target); if (scheduleContext) return scheduleContext;
    if (target.closest("#secondaryContent")) return null;
    const link = target.closest("#contentEditor a[href]");
    if (link) return { items: linkMenu(link), payload: { link } };
    const image = target.closest("#contentEditor img");
    if (image) return { items: imageMenu(), payload: { image } };
    if (target.closest("#contentEditor")) {
      const note = getActiveNote();
      if (note?.deletedAt) return { items: noteMenu(note), payload: { noteId: note.id } };
      captureEditorRange(); const selection = window.getSelection(), hasSelection = selection && !selection.isCollapsed && els.contentEditor.contains(selection.anchorNode);
      return { items: hasSelection ? selectionMenu() : caretMenu(), payload: { editor: true } };
    }
    const noteCard = target.closest("[data-context='note-card']"); if (noteCard) { const note = getNote(noteCard.dataset.noteId); return note ? { items: noteMenu(note), payload: { noteId: note.id } } : null; }
    const treeNote = target.closest("[data-context='tree-note']"); if (treeNote) { const note = getNote(treeNote.dataset.noteId); return note ? { items: noteMenu(note), payload: { noteId: note.id } } : null; }
    const treeFile = target.closest("[data-context='tree-file']"); if (treeFile) { const file = getStoredFile(treeFile.dataset.fileId); return file ? { items: fileMenu(file), payload: { fileId: file.id } } : null; }
    const category = target.closest("[data-context='category']"); if (category) { const folder = getCategory(category.dataset.categoryId); return folder ? { items: folderMenu(folder), payload: { categoryId: folder.id } } : null; }
    const smart = target.closest("[data-context='smart-view']");
    if (smart) {
      const view = smart.dataset.view;
      if (view === "trash") return { items: [menu("打开回收站", "open-view", { value: "trash" }), menu("清空回收站", "empty-trash", { danger: true })], payload: { view } };
      return { items: [menu("新建笔记", "new-note"), menu("排序方式", null, { submenu: sortItems() }), ...(view === "all" ? [menu("导入笔记", "import")] : [])], payload: { view } };
    }
    const input = target.closest("[data-context='meta-input']"); if (input) return { items: [menu("剪切", "cut"), menu("复制", "copy"), menu("粘贴", "paste"), sep(), menu("全选", "select-all")], payload: { input } };
    if (target.closest("#noteList")) return { items: [menu("新建笔记", "new-note"), menu("排序方式", null, { submenu: sortItems() }), menu("刷新列表", "refresh")], payload: {} };
    if (target.closest("#categoryList") || (target.closest("#sidebar") && !target.closest("button,input"))) return { items: [menu("新建文件夹", "add-category"), menu("新建笔记", "new-note"), sep(), menu("导入数据", "import"), menu("备份数据", "export")], payload: {} };
    if (target.closest("button")) return null;
    if (target.closest(".topbar") && !target.closest("button,input,label,select")) return { items: [menu("显示或隐藏区域", null, { submenu: [menu("侧边栏", "toggle-panel", { value: "sidebar" }), menu("笔记列表", "toggle-panel", { value: "list" }), menu("正文", "toggle-panel", { value: "editor" })] }), menu("进入专注模式", "focus"), menu("恢复默认布局", "reset-layout")], payload: {} };
    if (target.closest("#editorPanel")) return { items: [menu("新建笔记", "new-note"), menu("显示或隐藏区域", null, { submenu: [menu("侧边栏", "toggle-panel", { value: "sidebar" }), menu("笔记列表", "toggle-panel", { value: "list" }), menu("正文", "toggle-panel", { value: "editor" })] }), menu("进入专注模式", "focus")], payload: {} };
    return null;
  }

  function applyRichMarkdownShortcut(event) {
    if (editMode !== "rich" || event.key !== " " || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return false;
    const selection = window.getSelection();
    if (!selection?.isCollapsed || !selection.rangeCount || !els.contentEditor.contains(selection.anchorNode)) return false;

    let anchor = selection.anchorNode, block = null;
    if (anchor === els.contentEditor) {
      anchor = els.contentEditor.childNodes[Math.max(0, selection.anchorOffset - 1)] || null;
    }
    if (anchor?.nodeType === Node.TEXT_NODE && anchor.parentElement === els.contentEditor) {
      const paragraph = document.createElement("p");
      els.contentEditor.insertBefore(paragraph, anchor); paragraph.appendChild(anchor); block = paragraph;
    } else {
      const element = anchor?.nodeType === Node.ELEMENT_NODE ? anchor : anchor?.parentElement;
      block = element?.closest("p, div, h1, h2, h3, blockquote, pre") || null;
    }
    if (!block || block === els.contentEditor || !els.contentEditor.contains(block)) return false;

    const prefixRange = document.createRange();
    prefixRange.selectNodeContents(block);
    try { prefixRange.setEnd(selection.anchorNode, selection.anchorOffset); } catch { return false; }
    const marker = prefixRange.toString().replace(/\u200b/g, "");
    if (block.textContent.replace(/\u200b/g, "") !== marker) return false;
    const rules = {
      "#": { tag: "h1" }, "##": { tag: "h2" }, "###": { tag: "h3" },
      ">": { tag: "blockquote" }, "-": { list: "ul" }, "*": { list: "ul" },
      "1.": { list: "ol" }, "```": { tag: "pre" }
    };
    const rule = rules[marker]; if (!rule) return false;

    event.preventDefault();
    let replacement, caretTarget;
    if (rule.list) {
      replacement = document.createElement(rule.list); caretTarget = document.createElement("li");
      caretTarget.appendChild(document.createElement("br")); replacement.appendChild(caretTarget);
    } else {
      replacement = document.createElement(rule.tag); caretTarget = replacement;
      caretTarget.appendChild(document.createElement("br"));
    }
    block.replaceWith(replacement);
    const caret = document.createRange(); caret.setStart(caretTarget, 0); caret.collapse(true);
    selection.removeAllRanges(); selection.addRange(caret); saveCurrentRange(caret); commitEditor();
    return true;
  }

  function bindEvents() {
    document.addEventListener("click", (event) => { if (event.target.closest?.(".nav-item")) flushActiveWorkspace("switch"); }, { capture: true });
    $$(".nav-item").forEach((item) => item.addEventListener("click", () => setActiveView(item.dataset.view)));
    els.categoryList.addEventListener("click", (event) => {
      const toggle = event.target.closest("[data-folder-toggle]");
      if (toggle) { const expanded = new Set(layout.expandedFolders || []), id = toggle.dataset.folderToggle; expanded.has(id) ? expanded.delete(id) : expanded.add(id); layout.expandedFolders = [...expanded]; saveLayout(); renderSidebar(); return; }
      const noteButton = event.target.closest(".tree-note-button");
      if (noteButton) { const note = getNote(noteButton.dataset.noteId); if (note) { activeView = note.categoryId ? `category:${note.categoryId}` : "all"; if (note.categoryId) expandFolderPath(note.categoryId); selectNote(note.id); renderSidebar(); } return; }
      const fileButton = event.target.closest(".tree-file-button");
      if (fileButton) { selectFile(fileButton.dataset.fileId); return; }
      const folderButton = event.target.closest(".tree-folder-button"); if (folderButton) setActiveView(`category:${folderButton.dataset.categoryId}`);
    });
    els.categoryList.addEventListener("dragstart", (event) => {
      const noteRow = event.target.closest("[data-context='tree-note']"), fileRow = event.target.closest("[data-context='tree-file']"), folderRow = event.target.closest("[data-context='category']");
      const payload = noteRow ? { type: "note", id: noteRow.dataset.noteId } : fileRow ? { type: "file", id: fileRow.dataset.fileId } : folderRow ? { type: "folder", id: folderRow.dataset.categoryId } : null;
      if (payload) { event.dataTransfer.setData("application/x-easynote-tree", JSON.stringify(payload)); event.dataTransfer.effectAllowed = "move"; }
    });
    els.categoryList.addEventListener("dragover", (event) => { if (!event.dataTransfer.types.includes("application/x-easynote-tree")) return; event.preventDefault(); els.categoryList.querySelectorAll(".drop-target").forEach((row) => row.classList.remove("drop-target")); event.target.closest("[data-context='category']")?.classList.add("drop-target"); });
    els.categoryList.addEventListener("dragleave", (event) => { if (!els.categoryList.contains(event.relatedTarget)) els.categoryList.querySelectorAll(".drop-target").forEach((row) => row.classList.remove("drop-target")); });
    els.categoryList.addEventListener("drop", (event) => {
      event.preventDefault(); const raw = event.dataTransfer.getData("application/x-easynote-tree"); if (!raw) return;
      let payload; try { payload = JSON.parse(raw); } catch { return; }
      const targetFolder = event.target.closest("[data-context='category']")?.dataset.categoryId || "";
      els.categoryList.querySelectorAll(".drop-target").forEach((row) => row.classList.remove("drop-target"));
      if (payload.type === "note") moveNoteToCategory(payload.id, targetFolder); else if (payload.type === "file") moveStoredFile(payload.id, targetFolder); else if (payload.type === "folder") moveFolder(payload.id, targetFolder);
    });
    els.categoryList.addEventListener("dragend", () => els.categoryList.querySelectorAll(".drop-target").forEach((row) => row.classList.remove("drop-target")));
    els.noteList.addEventListener("click", (event) => { if (event.target.closest("[data-more]")) return; const card = event.target.closest(".note-card"); if (card) selectNote(card.dataset.noteId); });
    els.noteList.addEventListener("keydown", (event) => { if ((event.key === "Enter" || event.key === " ") && event.target.matches(".note-card")) selectNote(event.target.dataset.noteId); });
    els.searchInput.addEventListener("input", (event) => { if (whiteboardManager?.active) whiteboardManager.setSearch(event.target.value); else if (scheduleManager?.active) scheduleManager.setSearch(event.target.value); else if (taskManager?.active) taskManager.setSearch(event.target.value); else { searchTerm = event.target.value; renderList(); } });
    els.sortSelect.addEventListener("change", renderList);
    [els.newNoteTop, els.newNoteEmpty].forEach((button) => button.addEventListener("click", () => whiteboardManager?.active ? whiteboardManager.createNode("text") : scheduleManager?.active ? scheduleManager.createSchedule() : taskManager?.active ? taskManager.createTask() : createNote()));
    els.addCategory.addEventListener("click", () => addCategory());
    els.titleInput.addEventListener("input", () => { updateActiveNote({ title: els.titleInput.value }, true); if (outlinePane === "primary") updateOutline(); });
    els.categorySelect.addEventListener("change", () => updateActiveNote({ categoryId: els.categorySelect.value }, true));
    els.tagInput.addEventListener("input", () => updateActiveNote({ tags: els.tagInput.value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean) }, false));
    els.contentEditor.addEventListener("keydown", applyRichMarkdownShortcut);
    els.contentEditor.addEventListener("input", () => { updateActiveNote({ content: getCleanPrimaryHtml() }, true); if (outlinePane === "primary") updateOutline(); });
    els.contentEditor.addEventListener("click", (event) => {
      const link = event.target.closest("a[href]");
      if (link) { event.preventDefault(); link.removeAttribute("target"); link.rel = "noopener noreferrer"; if (event.ctrlKey || event.metaKey || event.shiftKey) openLinkNewTab(link.href); else openLinkInEditor(link.href, link.textContent); return; }
      if (event.target.matches("img")) selectImageForResize(event.target); else if (!event.target.closest("#imageResizeOverlay")) deselectImage();
      if (event.target.matches("input[type='checkbox']")) updateActiveNote({ content: els.contentEditor.innerHTML });
      setOutlinePane("primary");
    });
    els.contentEditor.addEventListener("auxclick", (event) => { const link = event.target.closest("a[href]"); if (link && event.button === 1) { event.preventDefault(); openLinkNewTab(link.href); } });
    els.contentEditor.addEventListener("pointerdown", (event) => {
      if (focusBesideImageAtPoint(event)) return;
      if (event.button !== 0 || !event.target.matches("img")) return;
      selectImageForResize(event.target); startImageMove(event);
    });
    els.markdownEditor.addEventListener("input", () => updateActiveNote({ content: markdownToHtml(els.markdownEditor.value) }, true));
    document.addEventListener("selectionchange", () => { const selection = window.getSelection(); if (selection?.rangeCount && els.contentEditor.contains(selection.anchorNode)) saveCurrentRange(selection.getRangeAt(0)); });

    els.modeToggle.addEventListener("click", () => { deselectImage(); editMode = editMode === "rich" ? "markdown" : "rich"; setEditorMode(true); updateActiveNote({ content: editMode === "markdown" ? markdownToHtml(els.markdownEditor.value) : getCleanPrimaryHtml() }); updateOutline(); });
    els.favoriteButton.addEventListener("click", () => toggleFavorite(activeNoteId));
    els.deleteButton.addEventListener("click", () => moveToTrash()); els.restoreButton.addEventListener("click", () => restoreNote()); els.permanentDeleteButton.addEventListener("click", () => permanentlyDelete());
    els.downloadMarkdown.addEventListener("click", () => exportNoteMarkdown());
    els.formatToolbar.addEventListener("mousedown", (event) => event.preventDefault());
    els.formatToolbar.addEventListener("click", (event) => { const button = event.target.closest("button[data-command]"); if (button) runEditorCommand(button.dataset.command, button.dataset.value || null); });
    els.insertLink.addEventListener("click", insertLinkAtSelection); els.clearFormat.addEventListener("click", () => runEditorCommand("removeFormat")); els.insertImage.addEventListener("click", () => { captureEditorRange(); els.imageFile.click(); });

    els.imageFile.addEventListener("change", () => { if (els.imageFile.files.length) insertImageFiles(els.imageFile.files); els.imageFile.value = ""; });
    els.uploadFileButton.addEventListener("click", () => startFileUpload(activeView.startsWith("category:") ? activeView.slice(9) : getActiveNote()?.categoryId || ""));
    els.localFileInput.addEventListener("change", () => { if (els.localFileInput.files.length) uploadLocalFiles(els.localFileInput.files, pendingUploadFolderId); els.localFileInput.value = ""; });
    [els.fileViewerDownload, els.fileUnsupportedDownload].forEach((button) => button.addEventListener("click", () => downloadStoredFile()));
    els.fileViewerDelete.addEventListener("click", () => deleteStoredFile());
    els.fileViewerClose.addEventListener("click", () => { activeFileId = null; renderEditor(); renderSidebar(); });
    els.linkViewerBack.addEventListener("click", hideLinkViewer);
    els.linkViewerClose.addEventListener("click", () => closeLinkTab());
    els.linkViewerNewTab.addEventListener("click", () => openLinkNewTab());
    els.linkViewerReload.addEventListener("click", () => {
      const tab = getActiveLinkTab(), frame = tab && els.linkViewerFrames.querySelector(`iframe[data-link-tab-id="${tab.id}"]`); if (!tab || !frame) return;
      tab.status = "loading"; els.linkViewerStatus.textContent = "正在加载"; renderLinkTabStrip(); frame.src = tab.url;
    });
    els.linkViewerTabs.addEventListener("click", (event) => {
      const close = event.target.closest("[data-close-link-tab]"); if (close) { event.stopPropagation(); closeLinkTab(close.dataset.closeLinkTab); return; }
      const tab = event.target.closest("[data-link-tab-id]"); if (tab) switchLinkTab(tab.dataset.linkTabId);
    });
    els.contentEditor.addEventListener("paste", (event) => { const images = [...event.clipboardData.items].filter((item) => item.type.startsWith("image/")).map((item) => item.getAsFile()).filter(Boolean); if (images.length) { event.preventDefault(); captureEditorRange(); insertImageFiles(images); } });
    els.contentEditor.addEventListener("dragenter", (event) => { if ([...event.dataTransfer.items].some((item) => item.type.startsWith("image/"))) { event.preventDefault(); dragDepth++; els.imageDropHint.classList.add("show"); } });
    els.contentEditor.addEventListener("dragover", (event) => { if ([...event.dataTransfer.items].some((item) => item.type.startsWith("image/"))) event.preventDefault(); });
    els.contentEditor.addEventListener("dragleave", () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) els.imageDropHint.classList.remove("show"); });
    els.contentEditor.addEventListener("drop", (event) => { event.preventDefault(); dragDepth = 0; els.imageDropHint.classList.remove("show"); const range = document.caretRangeFromPoint?.(event.clientX, event.clientY); if (range) saveCurrentRange(range); insertImageFiles(event.dataTransfer.files, range); });
    els.editorScroll.addEventListener("scroll", () => { if (selectedImage) positionImageResizeOverlay(); if (outlinePane === "primary") updateOutlineActive(); });
    els.imageWidthHandle.addEventListener("pointerdown", (event) => startImageResize(event, "width"));
    els.imageHeightHandle.addEventListener("pointerdown", (event) => startImageResize(event, "height"));
    els.imageResizeHandle.addEventListener("pointerdown", (event) => startImageResize(event, "both"));
    els.imageMoveHandle.addEventListener("pointerdown", startImageMove);

    els.splitViewButton.addEventListener("click", () => toggleSplitView());
    els.secondaryClose.addEventListener("click", () => toggleSplitView(false));
    els.secondaryNoteSelect.addEventListener("change", () => { layout.secondaryNoteId = els.secondaryNoteSelect.value; saveLayout(); renderSecondaryEditor(); setOutlinePane("secondary"); });
    els.secondaryTitle.addEventListener("input", () => updateSecondaryNote({ title: els.secondaryTitle.value }));
    els.secondaryContent.addEventListener("input", () => updateSecondaryNote({ content: els.secondaryContent.innerHTML }));
    els.secondaryEditor.addEventListener("click", () => setOutlinePane("secondary"));
    els.secondaryTitle.addEventListener("focus", () => setOutlinePane("secondary"));
    els.secondaryContent.addEventListener("focus", () => setOutlinePane("secondary"));
    els.secondaryScroll.addEventListener("scroll", () => { if (outlinePane === "secondary") updateOutlineActive(); });
    els.editorSplitResizer.addEventListener("pointerdown", startEditorSplitResize);
    els.editorSplitResizer.addEventListener("dblclick", () => { layout.splitRatio = 50; applyEditorLayout(true); });
    els.outlineButton.addEventListener("click", () => { layout.outline = !layout.outline; applyEditorLayout(true); updateOutline(); });
    els.outlineClose.addEventListener("click", () => { layout.outline = false; applyEditorLayout(true); });
    els.outlineList.addEventListener("click", (event) => {
      const item = event.target.closest("[data-outline-index]"); if (!item) return;
      const source = getOutlineSource(), heading = source.editor.querySelectorAll("h1,h2,h3")[Number(item.dataset.outlineIndex)];
      if (heading) { heading.scrollIntoView({ behavior: "smooth", block: "start" }); setTimeout(updateOutlineActive, 350); }
    });

    els.exportButton.addEventListener("click", exportData); els.importButton.addEventListener("click", () => els.importFile.click());
    els.importFile.addEventListener("change", () => { if (els.importFile.files[0]) importData(els.importFile.files[0]); els.importFile.value = ""; });
    els.themeToggle.addEventListener("click", () => { const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark"; document.documentElement.dataset.theme = next; localStorage.setItem(THEME_KEY, next); });
    els.sidebarToggle.addEventListener("click", () => { els.sidebar.classList.add("open"); els.sidebarScrim.classList.add("open"); }); els.sidebarScrim.addEventListener("click", closeSidebar); els.backToList.addEventListener("click", () => els.workspace.classList.remove("editor-open"));

    els.layoutButton.addEventListener("click", (event) => { event.stopPropagation(); els.layoutPopover.hidden = !els.layoutPopover.hidden; });
    els.panelSwitcher.addEventListener("click", (event) => { const button = event.target.closest("[data-panel-switch]"); if (button) togglePanel(button.dataset.panelSwitch); });
    els.layoutPopover.addEventListener("click", (event) => { const panel = event.target.closest("[data-layout-panel]"); const action = event.target.closest("[data-layout-action]"); if (panel) togglePanel(panel.dataset.layoutPanel); if (action?.dataset.layoutAction === "focus") enterFocusMode(); if (action?.dataset.layoutAction === "reset") resetLayout(); });
    els.focusExit.addEventListener("click", exitFocusMode);
    [els.sidebarResizer, els.listResizer].forEach((resizer) => { resizer.addEventListener("pointerdown", (event) => startResize(event, resizer.dataset.resizer)); resizer.addEventListener("dblclick", () => { if (resizer.dataset.resizer === "sidebar") layout.sidebarWidth = DEFAULT_LAYOUT.sidebarWidth; else layout.listWidth = DEFAULT_LAYOUT.listWidth; applyLayout(); }); });
    $$('[data-collapse-panel]').forEach((button) => button.addEventListener("click", () => togglePanel(button.dataset.collapsePanel)));

    els.appDialog.addEventListener("submit", (event) => { event.preventDefault(); submitDialog(); });
    [els.dialogClose, els.dialogCancel].forEach((button) => button.addEventListener("click", () => finishDialog(dialogState?.mode === "confirm" ? false : null)));
    els.dialogBackdrop.addEventListener("mousedown", (event) => { if (event.target === els.dialogBackdrop) finishDialog(dialogState?.mode === "confirm" ? false : null); });
    els.dialogInput.addEventListener("input", () => { els.dialogError.hidden = true; });

    els.safetyCenterButton.addEventListener("click", openSafetyCenter);
    els.saveIndicator.addEventListener("click", () => { if (safety?.lastStatus === "failed") openSafetyCenter(); });
    els.safetyClose.addEventListener("click", closeSafetyCenter);
    els.safetyBackdrop.addEventListener("mousedown", (event) => { if (event.target === els.safetyBackdrop) closeSafetyCenter(); });
    els.requestPersistenceButton.addEventListener("click", () => runSafetyTask(els.requestPersistenceButton, () => safety.requestPersistence(), (granted) => granted ? "浏览器持久存储已启用" : "浏览器未授予持久存储，数据库仍可正常使用"));
    els.runIntegrityButton.addEventListener("click", () => runSafetyTask(els.runIntegrityButton, () => safety.integrityCheck({ full: true }), (report) => report?.ok ? "完整性检查通过" : "检查发现问题，请查看数据安全中心"));
    els.retrySaveButton.addEventListener("click", () => runSafetyTask(els.retrySaveButton, () => safety.retry(), (ok) => ok ? "失败写入已重试并通过校验" : "仍无法保存，请立即导出便携式备份"));
    els.chooseBackupDirectoryButton.addEventListener("click", () => runSafetyTask(els.chooseBackupDirectoryButton, async () => { await flushActiveWorkspace("manual"); await safety.flush(); return safety.chooseBackupDirectory(); }, (name) => `已选择“${name}”并完成首份备份`));
    els.backupNowButton.addEventListener("click", () => runSafetyTask(els.backupNowButton, async () => { await flushActiveWorkspace("manual"); await safety.flush(); return safety.backupNow(); }, "目录备份已写入并验证"));
    els.verifyBackupButton.addEventListener("click", () => runSafetyTask(els.verifyBackupButton, () => safety.verifyLatestBackup(), (result) => `备份验证通过：${result.notes} 篇笔记、${result.tasks} 条任务、${result.schedules} 条日程、${result.whiteboards} 张白板`));
    els.portableExportButton.addEventListener("click", exportData);
    els.migrationExportButton.addEventListener("click", exportData);
    els.migrationBannerExport.addEventListener("click", exportData);
    els.migrationBannerDismiss.addEventListener("click", () => { els.migrationBanner.hidden = true; sessionStorage.setItem("easynote-migration-dismissed", "1"); });
    els.safetyBackdrop.addEventListener("click", (event) => {
      const action = event.target.closest("[data-safety-action]"); if (!action) return;
      if (action.dataset.safetyAction === "restore-history") restoreHistoryVersion(action.dataset.id);
      if (action.dataset.safetyAction === "restore-recovery") restoreRecoveryItem(action.dataset.id);
    });
    window.addEventListener("easynote:safety", () => { if (!els.safetyBackdrop.hidden) updateSafetyCenter(); });

    document.addEventListener("contextmenu", (event) => { const taskRange = event.target.matches?.("[data-progress-task]"); if (event.shiftKey || (!taskRange && (event.target.closest("select") || (event.target.closest("input,textarea") && !event.target.matches("[data-context='meta-input']"))))) return; const result = contextForTarget(event.target); if (!result) return; event.preventDefault(); openContextMenu(event.clientX, event.clientY, result.items, result.payload); });
    document.addEventListener("click", (event) => {
      if (!event.target.closest("#layoutPopover,#layoutButton")) els.layoutPopover.hidden = true;
      const more = event.target.closest("[data-more]");
      if (more) {
        event.preventDefault(); event.stopPropagation(); const rect = more.getBoundingClientRect();
        if (more.dataset.more === "note") { const note = getNote(more.dataset.noteId); if (note) openContextMenu(rect.left, rect.bottom + 4, noteMenu(note), { noteId: note.id }); }
        else if (more.dataset.more === "file") { const file = getStoredFile(more.dataset.fileId); if (file) openContextMenu(rect.left, rect.bottom + 4, fileMenu(file), { fileId: file.id }); }
        else { const folder = getCategory(more.dataset.categoryId); if (folder) openContextMenu(rect.left, rect.bottom + 4, folderMenu(folder), { categoryId: folder.id }); }
        return;
      }
      if (!event.target.closest("#contextMenu")) closeContextMenu();
    });
    els.editorMore.addEventListener("click", (event) => { event.stopPropagation(); const note = getActiveNote(); if (!note) return; const rect = event.currentTarget.getBoundingClientRect(); openContextMenu(rect.right - 226, rect.bottom + 4, noteMenu(note), { noteId: note.id }); });
    els.contextMenu.addEventListener("pointerdown", (event) => event.preventDefault());
    els.contextMenu.addEventListener("click", (event) => { const item = event.target.closest(".context-item[data-action]"); if (!item || item.classList.contains("disabled")) return; const action = item.dataset.action, value = item.dataset.value || ""; closeContextMenu(); runContextAction(action, value); });
    document.addEventListener("scroll", closeContextMenu, true);
    document.addEventListener("keydown", async (event) => {
      if (event.key === "Escape" && dialogState) { event.preventDefault(); finishDialog(dialogState.mode === "confirm" ? false : null); return; }
      if (event.key === "Escape") { if (activeLinkUrl) { event.preventDefault(); hideLinkViewer(); return; } closeContextMenu(); els.layoutPopover.hidden = true; if (layout.focus) exitFocusMode(); }
      if (!(event.ctrlKey || event.metaKey)) return;
      if (whiteboardManager?.active && event.key.toLowerCase() === "z") { event.preventDefault(); event.shiftKey ? whiteboardManager.redo() : whiteboardManager.undo(); return; }
      if (whiteboardManager?.active && event.key.toLowerCase() === "y") { event.preventDefault(); whiteboardManager.redo(); return; }
      if (event.key.toLowerCase() === "n") { event.preventDefault(); whiteboardManager?.active ? whiteboardManager.createNode("text") : scheduleManager?.active ? scheduleManager.createSchedule() : taskManager?.active ? taskManager.createTask() : createNote(); }
      if (event.key.toLowerCase() === "k") { event.preventDefault(); els.searchInput.focus(); els.searchInput.select(); }
      if (event.key.toLowerCase() === "s") { event.preventDefault(); const saved = await flushActiveWorkspace("manual"), label = whiteboardManager?.active ? "白板" : scheduleManager?.active ? "日程" : taskManager?.active ? "任务" : "笔记"; showToast(saved ? `${label}已回读校验并保存` : "保存失败，修改仍保留在当前页面"); }
      if (event.shiftKey && event.key.toLowerCase() === "f") { event.preventDefault(); layout.focus ? exitFocusMode() : enterFocusMode(); }
    });
    window.addEventListener("resize", () => applyLayout(false));
    document.addEventListener("visibilitychange", () => { if (document.hidden) flushActiveWorkspace("switch"); });
    window.addEventListener("pagehide", () => flushActiveWorkspace("switch"));
    window.addEventListener("beforeunload", (event) => { if (safety?.hasPendingWrites()) { event.preventDefault(); event.returnValue = ""; } });
  }

  async function init() {
    const preferredTheme = localStorage.getItem(THEME_KEY) || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    document.documentElement.dataset.theme = preferredTheme;
    state = await loadData();
    await ensureVueMigrationRecovery();
    if (!Array.isArray(layout.expandedFolders)) layout.expandedFolders = getChildFolders(null).map((folder) => folder.id);
    activeNoteId = state.notes.find((note) => !note.deletedAt)?.id || null;
    taskManager = new TaskManager({
      state, safety, persist, toast: showToast,
      notes: () => state.notes,
      onEnter: () => { flushActiveWorkspace("switch"); scheduleManager?.leave(); whiteboardManager?.leave(); },
      scheduleTask: (id) => { setActiveView("schedule"); scheduleManager?.scheduleTask(id); },
      openNote: (id) => { taskManager.leave(); searchTerm = ""; els.searchInput.value = ""; const note = getNote(id); if (note?.categoryId) activeView = `category:${note.categoryId}`; selectNote(id); renderSidebar(); },
      openLink: (url) => { if (!url) return; taskManager.leave(); openLinkInEditor(url, url); }
    });
    scheduleManager = new VueScheduleAdapter(persist);
    whiteboardManager = new WhiteboardManager({
      state, safety, persist, toast: showToast,
      notes: () => state.notes,
      tasks: () => state.tasks,
      fields: () => state.taskFields,
      openNote: (id) => { const note = getNote(id); if (!note) return; if (note.categoryId) activeView = `category:${note.categoryId}`; selectNote(id); renderSidebar(); },
      openTask: (id) => { setActiveView("tasks"); taskManager?.openTask(id); renderSidebar(); }
    });
    installEasyNoteRuntime({
      state,
      safety,
      persist,
      toast: showToast,
      openTask: (id) => { setActiveView("tasks"); taskManager?.openTask(id); renderSidebar(); },
      openNote: (id) => { const note = getNote(id); if (!note) return; scheduleManager?.leave(); if (note.categoryId) activeView = `category:${note.categoryId}`; selectNote(id); renderSidebar(); }
    });
    setEditorMode(false); render(); bindEvents();
    let quickReport;
    if (safety.wasEmpty) {
      const initialSaved = await persist(true, "migration");
      if (!initialSaved) showToast("初始数据未能安全保存，请打开数据安全中心");
      quickReport = await safety.integrityCheck({ full: false });
    } else {
      quickReport = await safety.integrityCheck({ full: false });
      if (quickReport.ok) await persist(true, "auto");
      else { setSaveStatus("failed", { error: "启动完整性检查未通过，已停止自动覆盖" }); setTimeout(openSafetyCenter, 350); }
    }
    safety.startAutomaticBackup();
    updateSafetyCenter().catch(console.error);
    if (location.protocol === "file:" && !sessionStorage.getItem("easynote-migration-dismissed")) els.migrationBanner.hidden = false;
    if (location.protocol === "http:" && safety.wasEmpty) {
      const desktopDirectoryBackup = "showDirectoryPicker" in window && matchMedia("(min-width: 621px)").matches;
      if (desktopDirectoryBackup) { setTimeout(openSafetyCenter, 350); showToast("首次安全启动：请导入旧备份并选择自动备份目录"); }
      else showToast("数据已安全保存在当前浏览器，可从侧栏导入或导出完整 JSON");
    }
    setInterval(() => { if (!document.hidden) updateSafetyCenter().catch(console.error); }, 5 * 60 * 1000);
    const runFullCheck = () => safety.integrityCheck({ full: true }).catch((error) => console.error("后台完整性检查失败", error));
    if ("requestIdleCallback" in window) requestIdleCallback(runFullCheck, { timeout: 8000 }); else setTimeout(runFullCheck, 2500);
  }

init().catch((error) => { console.error(error); document.body.innerHTML = `<div style="padding:40px;font-family:sans-serif"><h2>EasyNote 无法启动</h2><p>${escapeHtml(error.message)}</p></div>`; });
