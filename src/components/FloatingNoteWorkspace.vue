<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { easyNoteRuntime } from "../services/legacy-runtime";
import type { Folder, Note } from "../types/easynote";
import { codeSourceFromBlock, editMermaidDiagram, hydrateMermaidDiagrams, mermaidSourceFromElement, prepareMermaidForStorage, renderMermaidBlock, renderMermaidSourceBlock, replaceCompletedMermaidFences } from "../services/mermaid";

const emit = defineEmits<{ close: [] }>();
const revision = ref(0);
const selectedNoteId = ref("");
const selectedView = ref("all");
const search = ref("");
const sort = ref<"updated" | "created" | "title">("updated");
const editMode = ref<"rich" | "markdown">("rich");
const markdownText = ref("");
const saveStatus = ref<"saved" | "dirty" | "saving" | "failed">("saved");
const editor = ref<HTMLDivElement | null>(null);
const imageInput = ref<HTMLInputElement | null>(null);
const selectedImage = ref<HTMLImageElement | null>(null);
const selectedTextBlock = ref<HTMLElement | null>(null);
const editorContextMenu = ref<{ x: number; y: number; block: HTMLElement | null; diagram: HTMLElement | null; image: HTMLImageElement | null } | null>(null);
const compactPane = ref<"list" | "editor">("editor");
const folderPanelVisible = ref(localStorage.getItem("easynote-floating-folders-visible") !== "false");
const noteListVisible = ref(localStorage.getItem("easynote-floating-list-visible") !== "false");
const notePickerOpen = ref(false);
const recentPickerOpen = ref(false);
const folderPickerOpen = ref(false);
const expandedPickerFolders = ref<Set<string>>(new Set());
const contextMenu = ref<{ x: number; y: number; noteId: string } | null>(null);
const historyOpen = ref(false);
const historyItems = ref<Array<{ id: string; createdAt: string; reason: string; snapshot: Note }>>([]);
let savedRange: Range | null = null;
let statusToken = 0;
let uiRefreshTimer = 0;
let editorLoadToken = 0;
let autoSaveTimer = 0;
let richCommitTimer = 0;
let richDirtyNoteId = "";
let markdownCommitTimer = 0;
let markdownDirtyNoteId = "";
const plainTextCache = new Map<string, { source: string; value: string }>();

const runtime = computed(() => easyNoteRuntime.value);
const state = computed(() => { revision.value; return runtime.value?.state ?? null; });
const folders = computed(() => state.value?.categories ?? []);
const activeNote = computed(() => state.value?.notes.find((note) => note.id === selectedNoteId.value) ?? null);
const canChooseNoteFolder = computed(() => Boolean(activeNote.value && !activeNote.value.deletedAt));
const selectedFolderId = computed(() => selectedView.value.startsWith("folder:") ? selectedView.value.slice(7) : "");
const recentNotes = computed(() => (state.value?.notes ?? [])
  .filter((note) => !note.deletedAt)
  .slice()
  .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
  .slice(0, 10));
const folderPickerRows = computed(() => {
  const rows: Array<{ folder: Folder; level: number }> = [];
  const byParent = new Map<string, Folder[]>();
  const known = new Set(folders.value.map((folder) => folder.id));
  for (const folder of folders.value) {
    const parentId = folder.parentId && known.has(folder.parentId) ? folder.parentId : "";
    const siblings = byParent.get(parentId) ?? [];
    siblings.push(folder); byParent.set(parentId, siblings);
  }
  const append = (parentId: string, level: number, seen = new Set<string>()) => {
    for (const folder of (byParent.get(parentId) ?? []).slice().sort((left, right) => left.name.localeCompare(right.name, "zh-CN"))) {
      if (seen.has(folder.id)) continue;
      rows.push({ folder, level }); append(folder.id, level + 1, new Set(seen).add(folder.id));
    }
  };
  append("", 0);
  return rows;
});

function touch() { revision.value += 1; }
function scheduleUiRefresh(delay = 240) {
  window.clearTimeout(uiRefreshTimer);
  uiRefreshTimer = window.setTimeout(() => { uiRefreshTimer = 0; touch(); }, delay);
}
function now() { return new Date().toISOString(); }
function clamp(value: number, min: number, max: number) { return Math.min(Math.max(value, min), max); }
function makeId(prefix: string) { return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`; }
function windowForWorkspace(): Window { return editor.value?.ownerDocument.defaultView ?? window; }
function plainText(note: Note): string {
  const source = note.content || "";
  const cached = plainTextCache.get(note.id);
  if (cached?.source === source) return cached.value;
  const container = document.createElement("div"); container.innerHTML = source;
  const value = (container.textContent || "").replace(/\s+/g, " ").trim();
  if (plainTextCache.size > 300) plainTextCache.clear();
  plainTextCache.set(note.id, { source, value });
  return value;
}
function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function folderDepth(folder: Folder): number {
  let depth = 0, current = folder, guard = 0;
  while (current.parentId && guard++ < 8) { const parent = folders.value.find((item) => item.id === current.parentId); if (!parent) break; depth += 1; current = parent; }
  return depth;
}
function folderPath(id: string): string {
  const names: string[] = []; let current = folders.value.find((item) => item.id === id), guard = 0;
  while (current && guard++ < 10) { names.unshift(current.name); current = current.parentId ? folders.value.find((item) => item.id === current?.parentId) : undefined; }
  return names.join(" / ");
}

const visibleNotes = computed(() => {
  let notes = state.value?.notes.slice() ?? [];
  if (selectedView.value === "trash") notes = notes.filter((note) => note.deletedAt);
  else {
    notes = notes.filter((note) => !note.deletedAt);
    if (selectedView.value === "favorites") notes = notes.filter((note) => note.favorite);
    if (selectedFolderId.value) notes = notes.filter((note) => note.categoryId === selectedFolderId.value);
  }
  const query = search.value.trim().toLowerCase();
  if (query) notes = notes.filter((note) => `${note.title} ${(note.tags || []).join(" ")} ${plainText(note)}`.toLowerCase().includes(query));
  return notes.sort((left, right) => sort.value === "title"
    ? (left.title || "无标题笔记").localeCompare(right.title || "无标题笔记", "zh-CN")
    : String(sort.value === "created" ? right.createdAt : right.updatedAt).localeCompare(String(sort.value === "created" ? left.createdAt : left.updatedAt)));
});

type NotePickerRow =
  | { kind: "folder"; id: string; label: string; level: number; count: number; color: string; expanded: boolean }
  | { kind: "note"; id: string; label: string; level: number; updatedAt: string };

const notePickerRows = computed<NotePickerRow[]>(() => {
  const liveNotes = (state.value?.notes ?? []).filter((note) => !note.deletedAt);
  const folderMap = new Map(folders.value.map((folder) => [folder.id, folder]));
  const rows: NotePickerRow[] = [];
  const directNotes = (folderId: string) => liveNotes
    .filter((note) => (note.categoryId || "") === folderId)
    .slice()
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  const childFolders = (parentId: string) => folders.value
    .filter((folder) => (folder.parentId || "") === parentId)
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  const countNotes = (folderId: string, seen = new Set<string>()): number => {
    if (seen.has(folderId)) return 0;
    const nextSeen = new Set(seen).add(folderId);
    return directNotes(folderId).length + childFolders(folderId)
      .reduce((total, folder) => total + countNotes(folder.id, nextSeen), 0);
  };
  const appendFolder = (folder: Folder, level: number, seen = new Set<string>()) => {
    if (seen.has(folder.id)) return;
    const nextSeen = new Set(seen).add(folder.id);
    const expanded = expandedPickerFolders.value.has(folder.id);
    rows.push({ kind: "folder", id: folder.id, label: folder.name, level, count: countNotes(folder.id), color: folder.color || "#4f7df3", expanded });
    if (!expanded) return;
    for (const note of directNotes(folder.id)) rows.push({ kind: "note", id: note.id, label: note.title || "无标题笔记", level: level + 1, updatedAt: note.updatedAt });
    for (const child of childFolders(folder.id)) appendFolder(child, level + 1, nextSeen);
  };

  const unfiledNotes = directNotes("");
  if (unfiledNotes.length) {
    const expanded = expandedPickerFolders.value.has("__unfiled__");
    rows.push({ kind: "folder", id: "__unfiled__", label: "未归档", level: 0, count: unfiledNotes.length, color: "#94a3b8", expanded });
    if (expanded) for (const note of unfiledNotes) rows.push({ kind: "note", id: note.id, label: note.title || "无标题笔记", level: 1, updatedAt: note.updatedAt });
  }
  const roots = folders.value.filter((folder) => !folder.parentId || !folderMap.has(folder.parentId));
  for (const folder of roots.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"))) appendFolder(folder, 0);
  return rows;
});

function dispatchLock(noteId = "") {
  window.dispatchEvent(new CustomEvent("easynote:floating-note-lock", { detail: { noteId } }));
}

function toggleFolderPanel() {
  folderPanelVisible.value = !folderPanelVisible.value;
  localStorage.setItem("easynote-floating-folders-visible", String(folderPanelVisible.value));
}
function toggleNoteList(force?: boolean) {
  noteListVisible.value = typeof force === "boolean" ? force : !noteListVisible.value;
  compactPane.value = noteListVisible.value ? "list" : "editor";
  localStorage.setItem("easynote-floating-list-visible", String(noteListVisible.value));
}

async function persist(immediate = false, reason = "auto") {
  const current = runtime.value; if (!current) return false;
  if (immediate) { window.clearTimeout(autoSaveTimer); autoSaveTimer = 0; }
  const token = ++statusToken;
  saveStatus.value = immediate ? "saving" : "dirty";
  const saved = await current.persist(immediate, reason);
  if (token === statusToken) saveStatus.value = saved ? "saved" : "failed";
  if (saved && immediate) scheduleUiRefresh(0);
  return saved;
}

function scheduleAutoSave(delay = 750) {
  window.clearTimeout(autoSaveTimer);
  saveStatus.value = "dirty";
  autoSaveTimer = window.setTimeout(() => { autoSaveTimer = 0; void persist(true, "auto"); }, delay);
}

function commitRichContent(scheduleSave = true) {
  window.clearTimeout(richCommitTimer); richCommitTimer = 0;
  const note = activeNote.value, root = editor.value;
  if (!note || !root || note.deletedAt || editMode.value !== "rich" || richDirtyNoteId !== note.id) return false;
  ensureTrailingParagraph(root);
  if (replaceCompletedMermaidFences(root)) void hydrateMermaidDiagrams(root);
  note.content = floatingHtmlForStorage(root); note.updatedAt = now(); richDirtyNoteId = "";
  if (scheduleSave) scheduleAutoSave();
  return true;
}

function syncRichContent() {
  const note = activeNote.value, root = editor.value;
  if (!note || !root || note.deletedAt || editMode.value !== "rich") return;
  richDirtyNoteId = note.id; saveStatus.value = "dirty";
  window.clearTimeout(richCommitTimer);
  richCommitTimer = window.setTimeout(() => { richCommitTimer = 0; commitRichContent(true); }, 300);
}

function floatingHtmlForStorage(root = editor.value): string {
  if (!root) return "";
  const clone = root.cloneNode(true) as HTMLElement; prepareMermaidForStorage(clone); return clone.innerHTML;
}

function convertRichMarkdownShortcut() {
  const root = editor.value, selection = root?.ownerDocument.getSelection();
  if (!root || !selection?.isCollapsed || !selection.rangeCount || !root.contains(selection.anchorNode)) return;
  const anchor = selection.anchorNode;
  let element = anchor?.nodeType === 1 ? anchor as HTMLElement : anchor?.parentElement;
  if (anchor?.nodeType === 3 && anchor.parentElement === root) {
    const paragraph = root.ownerDocument.createElement("p"); root.insertBefore(paragraph, anchor); paragraph.append(anchor); element = paragraph;
  }
  const block = element?.closest("p,div");
  if (!block || block === root || !root.contains(block)) return;
  const text = (block.textContent || "").replace(/\u200b/g, "");
  const match = text.match(/^(###|##|#|>|-|\*|\d+\.|```)\s+([\s\S]*)$/);
  if (!match) return;
  const marker = match[1], value = match[2] || "";
  const rules: Record<string, { tag?: string; list?: "ul" | "ol" }> = { "#": { tag: "h1" }, "##": { tag: "h2" }, "###": { tag: "h3" }, ">": { tag: "blockquote" }, "-": { list: "ul" }, "*": { list: "ul" }, "```": { tag: "pre" } };
  const rule = rules[marker] || (/^\d+\.$/.test(marker) ? { list: "ol" as const } : undefined);
  if (!rule) return;
  const replacement = root.ownerDocument.createElement(rule.list || rule.tag!);
  const caretTarget = rule.list ? root.ownerDocument.createElement("li") : replacement;
  if (value) caretTarget.append(root.ownerDocument.createTextNode(value)); else caretTarget.append(root.ownerDocument.createElement("br"));
  if (marker === "```") (replacement as HTMLElement).dataset.codeLanguage = "";
  if (rule.list) replacement.append(caretTarget);
  block.replaceWith(replacement);
  const caret = root.ownerDocument.createRange(); caret.selectNodeContents(caretTarget); caret.collapse(false); selection.removeAllRanges(); selection.addRange(caret); savedRange = caret.cloneRange();
  syncRichContent();
}

function applyRichMarkdownShortcut(event: KeyboardEvent): boolean {
  if (editMode.value !== "rich" || event.key !== " " || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return false;
  const root = editor.value;
  if (!root) return false;
  // Let the browser insert the space first. Preventing it makes the floating
  // window appear to “eat” the space, especially in its separate document.
  root.ownerDocument.defaultView?.setTimeout(convertRichMarkdownShortcut, 0);
  return false;
}

function isFramedBlock(element: Element | null): element is HTMLElement {
  return Boolean(element && (element.tagName === "PRE" || element.tagName === "BLOCKQUOTE"));
}

function ensureTrailingParagraph(root = editor.value) {
  if (!root) return;
  const last = root.lastElementChild;
  const isEmptyParagraph = last?.tagName === "P"
    && !(last.textContent || "").trim()
    && [...last.children].every((child) => child.tagName === "BR");
  if (isEmptyParagraph) return;
  const paragraph = root.ownerDocument.createElement("p");
  paragraph.append(root.ownerDocument.createElement("br"));
  root.append(paragraph);
}

function placeCaretAtEnd(element: HTMLElement) {
  const selection = element.ownerDocument.getSelection();
  const range = element.ownerDocument.createRange();
  range.selectNodeContents(element); range.collapse(false);
  selection?.removeAllRanges(); selection?.addRange(range); savedRange = range.cloneRange();
}

function selectWholeTextBlock(block: HTMLElement) {
  const selection = block.ownerDocument.getSelection();
  const range = block.ownerDocument.createRange();
  range.selectNode(block); selection?.removeAllRanges(); selection?.addRange(range);
  selectedTextBlock.value = block; savedRange = range.cloneRange(); editor.value?.focus();
}

function unwrapTextBlock(block = selectedTextBlock.value) {
  const root = editor.value;
  if (!root || !block || !root.contains(block)) return;
  const doc = root.ownerDocument;
  let caretTarget: HTMLElement | null = null;
  if (block.tagName === "PRE") {
    const paragraph = doc.createElement("p");
    const lines = (block.textContent || "").split("\n");
    lines.forEach((line, index) => { if (index) paragraph.append(doc.createElement("br")); paragraph.append(doc.createTextNode(line)); });
    if (!paragraph.childNodes.length) paragraph.append(doc.createElement("br"));
    block.replaceWith(paragraph); caretTarget = paragraph;
  } else {
    const fragment = doc.createDocumentFragment();
    const children = [...block.childNodes];
    if (children.some((child) => child.nodeType === 1 && /^(P|DIV|H[1-6]|UL|OL)$/.test((child as HTMLElement).tagName))) {
      for (const child of children) fragment.append(child);
    } else {
      const paragraph = doc.createElement("p"); for (const child of children) paragraph.append(child);
      if (!paragraph.childNodes.length) paragraph.append(doc.createElement("br")); fragment.append(paragraph); caretTarget = paragraph;
    }
    const previous = block.previousElementSibling as HTMLElement | null;
    block.replaceWith(fragment); caretTarget ||= (previous?.nextElementSibling as HTMLElement | null) || previous;
  }
  selectedTextBlock.value = null; ensureTrailingParagraph(root);
  if (caretTarget) placeCaretAtEnd(caretTarget);
  syncRichContent();
}

function deleteTextBlock(block: HTMLElement | null) {
  const root = editor.value; if (!root || !block || !root.contains(block)) return;
  const previous = block.previousElementSibling as HTMLElement | null;
  block.remove(); selectedTextBlock.value = null; ensureTrailingParagraph(root);
  placeCaretAtEnd(previous || root.lastElementChild as HTMLElement || root); syncRichContent();
}
function updateTitle(value: string) { const note = activeNote.value; if (!note || note.deletedAt) return; note.title = value; note.updatedAt = now(); scheduleAutoSave(); }
function updateCategory(value: string) { const note = activeNote.value; if (!note || note.deletedAt || !canChooseNoteFolder.value) return; note.categoryId = value; note.updatedAt = now(); touch(); void persist(true, "manual"); }
function updateTags(value: string) { const note = activeNote.value; if (!note || note.deletedAt) return; note.tags = value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean); note.updatedAt = now(); scheduleAutoSave(); }

function commitPendingEditorContent() {
  const note = activeNote.value;
  if (!note || note.deletedAt) return;
  if (editMode.value === "rich") commitRichContent(false);
  else commitMarkdownContent(false);
}

async function flushCurrent(reason = "switch") {
  commitPendingEditorContent();
  return persist(true, reason);
}

async function selectNote(id: string) {
  if (id === selectedNoteId.value) { compactPane.value = "editor"; return; }
  if (selectedNoteId.value) void flushCurrent("switch");
  selectedNoteId.value = id; selectedImage.value = null; editMode.value = "rich"; compactPane.value = "editor";
  dispatchLock(id);
  loadEditorContent();
}

function loadEditorContent() {
  const token = ++editorLoadToken;
  void nextTick().then(() => {
    if (token !== editorLoadToken || !editor.value) return;
    editor.value.innerHTML = activeNote.value?.content || "";
    ensureTrailingParagraph(editor.value);
    window.setTimeout(() => { if (token === editorLoadToken && editor.value) void hydrateMermaidDiagrams(editor.value); }, 0);
  });
}

async function selectNoteFromPicker(id: string) {
  notePickerOpen.value = false;
  if (!id || id === selectedNoteId.value) return;
  selectedView.value = "all";
  await selectNote(id);
}

function toggleNotePicker() {
  notePickerOpen.value = !notePickerOpen.value;
  recentPickerOpen.value = false; folderPickerOpen.value = false;
  if (!notePickerOpen.value) return;
  const next = new Set(expandedPickerFolders.value);
  let folderId = activeNote.value?.categoryId || "__unfiled__";
  let guard = 0;
  while (folderId && guard++ < 10) {
    next.add(folderId);
    if (folderId === "__unfiled__") break;
    const folder = folders.value.find((item) => item.id === folderId);
    folderId = folder?.parentId || "";
  }
  expandedPickerFolders.value = next;
}

function toggleRecentPicker() {
  recentPickerOpen.value = !recentPickerOpen.value;
  notePickerOpen.value = false; folderPickerOpen.value = false;
}

function toggleFolderPicker() {
  folderPickerOpen.value = !folderPickerOpen.value;
  notePickerOpen.value = false; recentPickerOpen.value = false;
}

async function selectRecentNote(id: string) {
  recentPickerOpen.value = false;
  await selectNote(id);
}

async function selectFolder(folderId: string) {
  const note = activeNote.value;
  folderPickerOpen.value = false;
  if (!note || note.deletedAt || note.categoryId === folderId) return;
  commitPendingEditorContent();
  note.categoryId = folderId; note.updatedAt = now(); touch();
  await persist(true, "manual");
}

function togglePickerFolder(id: string) {
  const next = new Set(expandedPickerFolders.value);
  if (next.has(id)) next.delete(id); else next.add(id);
  expandedPickerFolders.value = next;
}

function ensureSelection() {
  const root = editor.value; if (!root) return null;
  const selection = root.ownerDocument.getSelection();
  if (savedRange && savedRange.commonAncestorContainer.isConnected) { selection?.removeAllRanges(); selection?.addRange(savedRange); }
  else { const range = root.ownerDocument.createRange(); range.selectNodeContents(root); range.collapse(false); selection?.removeAllRanges(); selection?.addRange(range); savedRange = range; }
  root.focus(); return selection;
}
function captureSelection() {
  const root = editor.value; if (!root) return;
  const selection = root.ownerDocument.getSelection();
  if (selection?.rangeCount && root.contains(selection.anchorNode)) savedRange = selection.getRangeAt(0).cloneRange();
}
function runCommand(command: string, value?: string) {
  const root = editor.value; if (!root) return;
  ensureSelection(); root.ownerDocument.execCommand(command, false, value); ensureTrailingParagraph(root); syncRichContent(); captureSelection();
}
function insertLink() {
  captureSelection(); const address = windowForWorkspace().prompt("输入链接地址（http:// 或 https://）", "https://");
  if (!address) return;
  try { const url = new URL(address); if (!/^https?:$/.test(url.protocol)) throw new Error(); runCommand("createLink", url.href); }
  catch { runtime.value?.toast("请输入有效的 HTTP 或 HTTPS 链接"); }
}

function escapeHtml(value: string) { return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] || char); }
function htmlToMarkdown(html: string): string {
  const root = document.createElement("div"); root.innerHTML = html || "";
  const convert = (node: Node, depth = 0): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || "";
    if (node.nodeType !== 1) return "";
    const element = node as HTMLElement;
    const inner = [...element.childNodes].map((child) => convert(child, depth)).join("");
    switch (element.tagName.toLowerCase()) {
      case "h1": return `# ${inner}\n\n`; case "h2": return `## ${inner}\n\n`; case "h3": return `### ${inner}\n\n`;
      case "p": return `${inner}\n\n`;
      case "div": return element.classList.contains("mermaid-diagram") ? `\`\`\`mermaid\n${mermaidSourceFromElement(element)}\n\`\`\`\n\n` : `${inner}\n\n`;
      case "strong": case "b": return `**${inner}**`; case "em": case "i": return `*${inner}*`; case "code": return `\`${inner}\``;
      case "pre": return `\`\`\`${element.dataset.codeLanguage === "mermaid" ? "mermaid" : ""}\n${codeSourceFromBlock(element)}\n\`\`\`\n\n`; case "blockquote": return `${inner.split("\n").filter(Boolean).map((line) => `> ${line}`).join("\n")}\n\n`;
      case "a": return `[${inner}](${element.getAttribute("href") || ""})`;
      case "img": { const id = element.dataset.attachmentId || ""; return id ? `![${element.getAttribute("alt") || "图片"}](easynote-attachment:${id})\n\n` : ""; }
      case "ul": case "ol": return [...element.children].map((child, index) => `${"  ".repeat(depth)}${element.tagName === "OL" ? `${index + 1}.` : "-"} ${[...child.childNodes].map((item) => convert(item, depth + 1)).join("").trim()}\n`).join("") + "\n";
      default: return inner;
    }
  };
  return [...root.childNodes].map((node) => convert(node)).join("").replace(/\n{3,}/g, "\n\n").trim();
}
function markdownToHtml(markdown: string): string {
  const images: string[] = [];
  let source = String(markdown || "").replace(/!\[([^\]]*)\]\(easynote-attachment:([^)]+)\)/g, (_match, alt, id) => {
    const url = runtime.value?.safety.getAttachmentUrl(id) || "";
    images.push(`<img src="${escapeHtml(url)}" data-attachment-id="${escapeHtml(id)}" alt="${escapeHtml(alt || "图片")}" data-size="large" data-align="center">`);
    return `\n@@IMAGE${images.length - 1}@@\n`;
  });
  const code: string[] = [];
  source = source.replace(/```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g, (_match, language, value) => {
    const fallback = language ? `${language}\n${value}` : value;
    code.push(renderMermaidBlock(value, language || "") || `<pre>${escapeHtml(fallback.trim())}</pre>`);
    return `\n@@CODE${code.length - 1}@@\n`;
  });
  let text = escapeHtml(source).replace(/^### (.+)$/gm, "<h3>$1</h3>").replace(/^## (.+)$/gm, "<h2>$1</h2>").replace(/^# (.+)$/gm, "<h1>$1</h1>")
    .replace(/^&gt; (.+)$/gm, "<blockquote>$1</blockquote>").replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\*(.+?)\*/g, "<em>$1</em>").replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" rel="noopener noreferrer">$1</a>');
  const result: string[] = []; let list: "ul" | "ol" | "" = "";
  const closeList = () => { if (list) result.push(`</${list}>`); list = ""; };
  for (const line of text.split("\n")) {
    const unordered = line.match(/^[-*] (.+)$/), ordered = line.match(/^\d+\. (.+)$/);
    if (unordered || ordered) { const type = unordered ? "ul" : "ol"; if (list !== type) { closeList(); result.push(`<${type}>`); list = type; } result.push(`<li>${(unordered || ordered)?.[1] || ""}</li>`); }
    else { closeList(); if (line.trim()) result.push(/^<(h[1-3]|blockquote|pre|img|div)|^@@/.test(line) ? line : `<p>${line}</p>`); }
  }
  closeList();
  return result.join("\n").replace(/@@IMAGE(\d+)@@/g, (_m, index) => images[Number(index)]).replace(/@@CODE(\d+)@@/g, (_m, index) => code[Number(index)]);
}
function commitMarkdownContent(scheduleSave = true) {
  window.clearTimeout(markdownCommitTimer); markdownCommitTimer = 0;
  const note = activeNote.value;
  if (!note || note.deletedAt || editMode.value !== "markdown" || markdownDirtyNoteId !== note.id) return false;
  note.content = markdownToHtml(markdownText.value); note.updatedAt = now(); markdownDirtyNoteId = "";
  if (scheduleSave) scheduleAutoSave();
  return true;
}

async function toggleMode() {
  const note = activeNote.value; if (!note) return;
  if (editMode.value === "rich") {
    commitRichContent(false);
    markdownText.value = htmlToMarkdown(editor.value?.innerHTML || note.content); editMode.value = "markdown";
  } else {
    commitMarkdownContent(false);
    note.content = markdownToHtml(markdownText.value); editMode.value = "rich";
    await nextTick(); if (editor.value) { editor.value.innerHTML = note.content; void hydrateMermaidDiagrams(editor.value); }
  }
  note.updatedAt = now(); touch(); void persist(true, "manual");
}
function onMarkdownInput() {
  const note = activeNote.value; if (!note || note.deletedAt) return;
  markdownDirtyNoteId = note.id; saveStatus.value = "dirty";
  window.clearTimeout(markdownCommitTimer);
  markdownCommitTimer = window.setTimeout(() => { markdownCommitTimer = 0; commitMarkdownContent(true); }, 300);
}

async function processImage(file: File): Promise<Blob> {
  if (!/^image\/(jpeg|png|webp|gif)$/.test(file.type)) throw new Error("仅支持 JPEG、PNG、WebP 和 GIF 图片");
  if (file.size > 12 * 1024 * 1024) throw new Error("单张图片不能超过 12MB");
  if (file.type === "image/gif") return file;
  const bitmap = await createImageBitmap(file); const ratio = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
  const canvas = editor.value?.ownerDocument.createElement("canvas") ?? document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * ratio)); canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", .84));
  if (!blob) throw new Error("图片压缩失败"); return blob;
}
async function insertImage(file: File) {
  const current = runtime.value, root = editor.value; if (!current || !root) return;
  captureSelection();
  try {
    const blob = await processImage(file), attachment = await current.safety.putAttachment(blob, { name: file.name, type: blob.type });
    const doc = root.ownerDocument, image = doc.createElement("img"); image.src = attachment.url; image.dataset.attachmentId = attachment.id; image.alt = file.name.replace(/\.[^.]+$/, "") || "图片"; image.dataset.size = "large"; image.dataset.align = "center";
    const paragraph = doc.createElement("p"); paragraph.append(doc.createElement("br"));
    const selection = ensureSelection(), range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    if (range) { range.deleteContents(); range.insertNode(paragraph); range.insertNode(image); range.setStart(paragraph, 0); range.collapse(true); selection?.removeAllRanges(); selection?.addRange(range); }
    else root.append(image, paragraph);
    selectedImage.value = image;
    const note = activeNote.value;
    if (note) { note.content = floatingHtmlForStorage(root); note.updatedAt = now(); touch(); await persist(true, "manual"); }
  } catch (cause) { current.toast(cause instanceof Error ? cause.message : "图片插入失败"); }
}
async function onImageFiles(files: FileList | File[]) { for (const file of Array.from(files)) if (file.type.startsWith("image/")) await insertImage(file); }
function onPaste(event: ClipboardEvent) { const files = [...(event.clipboardData?.items || [])].filter((item) => item.type.startsWith("image/")).map((item) => item.getAsFile()).filter((file): file is File => Boolean(file)); if (files.length) { event.preventDefault(); void onImageFiles(files); } }
function onDrop(event: DragEvent) { const files = [...(event.dataTransfer?.files || [])].filter((file) => file.type.startsWith("image/")); if (files.length) { event.preventDefault(); void onImageFiles(files); } }
function selectEditorImage(event: MouseEvent) {
  const target = event.target as HTMLElement, link = target.closest<HTMLAnchorElement>("a[href]");
  if (link && (event.ctrlKey || event.metaKey || event.shiftKey)) { event.preventDefault(); window.open(link.href, "_blank", "noopener,noreferrer"); return; }
  const block = target.closest("pre,blockquote");
  if (isFramedBlock(block) && event.clientX >= block.getBoundingClientRect().right) { selectedImage.value = null; return; }
  selectedTextBlock.value = null;
  selectedImage.value = target.tagName === "IMG" ? target as HTMLImageElement : null;
}

function startImageMove(event: PointerEvent) {
  const root = editor.value, image = selectedImage.value;
  if (!root || !image?.isConnected || editMode.value !== "rich") return;
  event.preventDefault(); event.stopPropagation();
  const startY = event.clientY, startX = event.clientX, editorRect = root.getBoundingClientRect(), imageRect = image.getBoundingClientRect();
  const pointerOffsetX = startX - imageRect.left;
  let moved = false, horizontalMoved = false, destination: { block: Element; after: boolean } | null = null;
  image.classList.add("floating-image-moving");
  const update = (moveEvent: PointerEvent) => {
    if (!moved && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 5) return;
    moved = true;
    if (!horizontalMoved && Math.abs(moveEvent.clientX - startX) > 8) horizontalMoved = true;
    if (horizontalMoved) {
      const maxLeft = Math.max(0, editorRect.width - image.getBoundingClientRect().width);
      const left = clamp(moveEvent.clientX - editorRect.left - pointerOffsetX, 0, maxLeft);
      image.dataset.align = "free"; image.style.marginLeft = `${(left / Math.max(1, editorRect.width)) * 100}%`; image.style.marginRight = "0";
    }
    const blocks = [...root.children].filter((block) => block !== image);
    const target = blocks.find((block) => moveEvent.clientY < block.getBoundingClientRect().top + block.getBoundingClientRect().height / 2);
    destination = target ? { block: target, after: false } : blocks.length ? { block: blocks[blocks.length - 1], after: true } : null;
    root.classList.add("floating-image-dragging");
  };
  const finish = () => {
    window.removeEventListener("pointermove", update); window.removeEventListener("pointerup", finish);
    image.classList.remove("floating-image-moving"); root.classList.remove("floating-image-dragging");
    if (!moved || !destination) return;
    if (destination.after) destination.block.after(image); else destination.block.before(image);
    if (!horizontalMoved) { image.dataset.align = image.dataset.align || "center"; }
    syncRichContent();
  };
  update(event); window.addEventListener("pointermove", update); window.addEventListener("pointerup", finish, { once: true });
}

function onEditorPointerDown(event: PointerEvent) {
  const root = editor.value, target = event.target as HTMLElement; if (!root) return;
  if (target.tagName === "IMG") {
    selectedImage.value = target as HTMLImageElement;
    root.focus({ preventScroll: true });
    startImageMove(event);
    return;
  }
  if (target === root) {
    event.preventDefault(); selectedTextBlock.value = null; selectedImage.value = null;
    ensureTrailingParagraph(root);
    const trailingParagraph = root.lastElementChild as HTMLElement | null;
    if (trailingParagraph) placeCaretAtEnd(trailingParagraph);
    return;
  }
  const block = target.closest("pre,blockquote"); if (!isFramedBlock(block)) { selectedTextBlock.value = null; return; }
  const rect = block.getBoundingClientRect();
  if (event.clientX < rect.right) { selectedTextBlock.value = null; return; }
  event.preventDefault(); selectWholeTextBlock(block);
}

function onEditorKeydown(event: KeyboardEvent) {
  const shortcut = event.ctrlKey || event.metaKey ? event.key.toLowerCase() : "";
  const selection = editor.value?.ownerDocument.getSelection();
  if (selectedImage.value && (shortcut === "c" || shortcut === "x") && (!selection || selection.isCollapsed)) {
    event.preventDefault();
    void copyImageToClipboard(selectedImage.value, shortcut === "x");
    return;
  }
  if (applyRichMarkdownShortcut(event)) return;
  if (!selectedTextBlock.value || !["Backspace", "Delete"].includes(event.key)) return;
  event.preventDefault(); unwrapTextBlock();
}

function openEditorContext(event: MouseEvent) {
  const root = editor.value; if (!root) return;
  event.preventDefault(); event.stopPropagation();
  const target = event.target as HTMLElement, block = target.closest("pre,blockquote"), diagram = target.closest<HTMLElement>(".mermaid-diagram"), image = target.closest<HTMLImageElement>("img");
  editorContextMenu.value = { x: Math.min(event.clientX, windowForWorkspace().innerWidth - 210), y: Math.min(event.clientY, Math.max(8, windowForWorkspace().innerHeight - 520)), block: isFramedBlock(block) ? block : null, diagram, image };
  if (image) selectedImage.value = image;
  else if (isFramedBlock(block)) selectWholeTextBlock(block); else captureSelection();
}

async function copyImageToClipboard(image: HTMLImageElement | null, cut = false) {
  if (!image) return false;
  try {
    const doc = image.ownerDocument, view = doc.defaultView ?? window;
    const response = await view.fetch(image.currentSrc || image.src), blob = await response.blob();
    const fallbackCopy = () => {
      const selection = doc.getSelection(), range = doc.createRange();
      range.selectNode(image); selection?.removeAllRanges(); selection?.addRange(range);
      const copied = doc.execCommand("copy"); selection?.removeAllRanges();
      if (!copied) throw new Error("clipboard copy failed");
    };
    const ClipboardItemCtor = (view as Window & { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
    if (view.navigator.clipboard?.write && ClipboardItemCtor) {
      try { await view.navigator.clipboard.write([new ClipboardItemCtor({ [blob.type || "image/png"]: blob })]); }
      catch { fallbackCopy(); }
    } else fallbackCopy();
    if (cut) {
      const root = editor.value, next = image.nextSibling;
      image.remove();
      if (selectedImage.value === image) selectedImage.value = null;
      if (root) {
        const range = root.ownerDocument.createRange();
        if (next?.parentNode) range.setStartBefore(next); else { range.selectNodeContents(root); range.collapse(false); }
        range.collapse(true);
        const docSelection = root.ownerDocument.getSelection();
        docSelection?.removeAllRanges(); docSelection?.addRange(range); savedRange = range.cloneRange();
      }
      syncRichContent();
    }
    runtime.value?.toast(cut ? "图片已剪切" : "图片已复制");
    return true;
  } catch {
    runtime.value?.toast(cut ? "剪切图片失败，请稍后重试" : "复制图片失败，请尝试右键另存后复制");
    return false;
  }
}

async function editorContextAction(action: "undo" | "redo" | "copy" | "cut" | "paste" | "select-all" | "bold" | "unordered" | "ordered" | "paragraph" | "quote" | "code" | "mermaid" | "render-mermaid" | "edit-mermaid" | "delete-diagram" | "delete-block" | "copy-image" | "cut-image") {
  const menu = editorContextMenu.value; editorContextMenu.value = null;
  if (action === "copy-image") return copyImageToClipboard(menu?.image || selectedImage.value);
  if (action === "cut-image") return copyImageToClipboard(menu?.image || selectedImage.value, true);
  if (["undo", "redo", "copy", "cut", "bold"].includes(action)) return runCommand(action);
  if (action === "select-all") return runCommand("selectAll");
  if (action === "unordered") return runCommand("insertUnorderedList");
  if (action === "ordered") return runCommand("insertOrderedList");
  if (action === "paragraph" && menu?.block) return unwrapTextBlock(menu.block);
  if (action === "delete-block" && menu?.block) return deleteTextBlock(menu.block);
  if (action === "quote") return runCommand("formatBlock", "blockquote");
  if (action === "code") return runCommand("formatBlock", "pre");
  if (action === "render-mermaid" && menu?.block) {
    const root = editor.value; if (!root || !renderMermaidSourceBlock(menu.block)) return;
    void hydrateMermaidDiagrams(root); syncRichContent(); return;
  }
  if (action === "edit-mermaid" && menu?.diagram) {
    const block = editMermaidDiagram(menu.diagram); if (!block) return;
    placeCaretAtEnd(block); syncRichContent(); return;
  }
  if (action === "delete-diagram" && menu?.diagram) { menu.diagram.remove(); syncRichContent(); return; }
  if (action === "mermaid") {
    const root = editor.value; if (!root) return;
    ensureSelection();
    const source = "flowchart TD\nA[开始] --> B[结束]";
    root.ownerDocument.execCommand("insertHTML", false, `<pre data-code-language="mermaid">${escapeHtml(source)}</pre><p><br></p>`);
    syncRichContent(); captureSelection();
  }
  if (action === "paste") {
    try { const text = await navigator.clipboard.readText(); if (text) runCommand("insertText", text); }
    catch { runtime.value?.toast("浏览器未允许读取剪贴板，请使用 Ctrl+V"); }
  }
}
function imageAction(action: "small" | "medium" | "large" | "full" | "left" | "center" | "right" | "delete") {
  const image = selectedImage.value; if (!image) return;
  if (action === "delete") { image.remove(); selectedImage.value = null; }
  else if (["small", "medium", "large", "full"].includes(action)) { image.dataset.size = action; image.style.width = ({ small: "30%", medium: "55%", large: "78%", full: "100%" } as Record<string, string>)[action]; }
  else { image.dataset.align = action; image.style.display = "block"; image.style.marginLeft = action === "left" ? "0" : action === "center" ? "auto" : "auto"; image.style.marginRight = action === "right" ? "0" : action === "center" ? "auto" : "auto"; }
  syncRichContent();
}

async function createNote() {
  const current = state.value; if (!current) return;
  const targetFolderId = selectedFolderId.value || activeNote.value?.categoryId || "";
  if (selectedNoteId.value) void flushCurrent("switch");
  const stamp = now(), note: Note = { id: makeId("note"), title: "", categoryId: targetFolderId, tags: [], favorite: false, content: "", createdAt: stamp, updatedAt: stamp, deletedAt: null };
  current.notes.unshift(note); selectedView.value = "all"; selectedNoteId.value = note.id; selectedImage.value = null; editMode.value = "rich"; compactPane.value = "editor"; touch(); dispatchLock(note.id);
  await nextTick(); if (editor.value) editor.value.innerHTML = "";
  void persist(true, "manual");
}
async function createFolder() {
  const current = state.value; if (!current) return;
  const name = windowForWorkspace().prompt("文件夹名称", "新建文件夹")?.trim(); if (!name) return;
  current.categories.push({ id: makeId("folder"), name, color: "#4f7df3", parentId: selectedFolderId.value || null }); touch(); await persist(true, "manual");
}
async function toggleFavorite(note = activeNote.value) { if (!note || note.deletedAt) return; if (note.id === activeNote.value?.id) commitPendingEditorContent(); note.favorite = !note.favorite; note.updatedAt = now(); touch(); await persist(true, "manual"); }
async function duplicateNote(note = activeNote.value) {
  if (!note) return; if (note.id === activeNote.value?.id) commitPendingEditorContent(); const stamp = now(), copy: Note = { ...structuredClone(note), id: makeId("note"), title: `${note.title || "无标题笔记"}（副本）`, createdAt: stamp, updatedAt: stamp, deletedAt: null };
  state.value?.notes.unshift(copy); touch(); await persist(true, "manual"); await selectNote(copy.id);
}
async function trashNote(note = activeNote.value) {
  if (!note || note.deletedAt) return; if (note.id === activeNote.value?.id) commitPendingEditorContent(); await runtime.value?.safety.recordRecovery("note-delete", `删除笔记“${note.title || "无标题笔记"}”`, { note: structuredClone(note) }); note.deletedAt = now(); note.updatedAt = now(); touch(); await persist(true, "danger"); const next = visibleNotes.value.find((item) => item.id !== note.id); selectedNoteId.value = ""; dispatchLock(""); if (next) await selectNote(next.id);
}
async function restoreNote(note = activeNote.value) { if (!note?.deletedAt) return; note.deletedAt = null; note.updatedAt = now(); touch(); await persist(true, "manual"); selectedView.value = "all"; }
async function moveToFolder(noteId: string, folderId: string) { const note = state.value?.notes.find((item) => item.id === noteId); if (!note) return; if (note.id === activeNote.value?.id) commitPendingEditorContent(); note.categoryId = folderId; note.updatedAt = now(); touch(); await persist(true, "manual"); }
function showContext(event: MouseEvent, noteId: string) { event.preventDefault(); contextMenu.value = { x: Math.min(event.clientX, windowForWorkspace().innerWidth - 190), y: Math.min(event.clientY, windowForWorkspace().innerHeight - 190), noteId }; }
async function contextAction(action: "open" | "favorite" | "duplicate" | "trash") { const note = state.value?.notes.find((item) => item.id === contextMenu.value?.noteId); contextMenu.value = null; if (!note) return; if (action === "open") await selectNote(note.id); if (action === "favorite") await toggleFavorite(note); if (action === "duplicate") await duplicateNote(note); if (action === "trash") await trashNote(note); }
async function openInMain() { const note = activeNote.value; if (!note) return; await flushCurrent("manual"); dispatchLock(""); runtime.value?.openNote(note.id); window.focus(); }
async function openHistory() { const note = activeNote.value, current = runtime.value; if (!note || !current) return; await flushCurrent("manual"); historyItems.value = await current.safety.getHistory(note.id); historyOpen.value = true; }
async function restoreHistory(id: string) { const note = activeNote.value, current = runtime.value; if (!note || !current) return; const snapshot = await current.safety.getHistorySnapshot(id); if (!snapshot) return; await current.safety.recordRecovery("history-restore", `恢复笔记历史“${note.title || "无标题笔记"}”前`, { note: structuredClone(note) }); Object.assign(note, snapshot, { id: note.id, updatedAt: now(), deletedAt: null }); touch(); historyOpen.value = false; await persist(true, "manual"); await nextTick(); if (editor.value) { editor.value.innerHTML = note.content; void hydrateMermaidDiagrams(editor.value); } }
function downloadMarkdown() { const note = activeNote.value; if (!note) return; const content = editMode.value === "markdown" ? markdownText.value : htmlToMarkdown(editor.value?.innerHTML || note.content); const blob = new Blob([content], { type: "text/markdown;charset=utf-8" }); const url = URL.createObjectURL(blob), anchor = editor.value?.ownerDocument.createElement("a") ?? document.createElement("a"); anchor.href = url; anchor.download = `${(note.title || "无标题笔记").replace(/[\\/:*?"<>|]/g, "-")}.md`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }

function onSaveStatus(event: Event) {
  const status = (event as CustomEvent<{ status?: "saved" | "dirty" | "saving" | "failed" }>).detail?.status;
  if (status) saveStatus.value = status;
}
function onDocumentClick() { contextMenu.value = null; editorContextMenu.value = null; notePickerOpen.value = false; recentPickerOpen.value = false; folderPickerOpen.value = false; }
function onKeydown(event: KeyboardEvent) {
  if (!(event.ctrlKey || event.metaKey)) return;
  if (event.key.toLowerCase() === "s") { event.preventDefault(); void flushCurrent("manual"); }
  if (event.key.toLowerCase() === "n") { event.preventDefault(); void createNote(); }
  if (event.key.toLowerCase() === "k") { event.preventDefault(); (editor.value?.ownerDocument.querySelector(".floating-note-search") as HTMLInputElement | null)?.focus(); }
}

watch(() => activeNote.value?.id, () => { if (editMode.value === "rich") loadEditorContent(); });
watch(easyNoteRuntime, async (current) => { if (current && !selectedNoteId.value) { const initial = current.getActiveNoteId() || current.state.notes.find((note) => !note.deletedAt)?.id || ""; if (initial) await selectNote(initial); } });
onMounted(async () => {
  window.addEventListener("easynote:save-status", onSaveStatus);
  const initial = runtime.value?.getActiveNoteId() || state.value?.notes.find((note) => !note.deletedAt)?.id || "";
  if (initial) await selectNote(initial);
  const doc = editor.value?.ownerDocument; doc?.addEventListener("selectionchange", captureSelection); doc?.addEventListener("keydown", onKeydown); doc?.addEventListener("click", onDocumentClick);
});
onBeforeUnmount(() => {
  window.clearTimeout(uiRefreshTimer);
  window.clearTimeout(autoSaveTimer);
  window.clearTimeout(richCommitTimer);
  window.clearTimeout(markdownCommitTimer);
  plainTextCache.clear();
  window.removeEventListener("easynote:save-status", onSaveStatus);
  const doc = editor.value?.ownerDocument; doc?.removeEventListener("selectionchange", captureSelection); doc?.removeEventListener("keydown", onKeydown); doc?.removeEventListener("click", onDocumentClick);
  dispatchLock(""); void flushCurrent("switch");
});
</script>

<template>
  <section class="floating-note-workspace" :class="[`compact-${compactPane}`, { 'folders-hidden': !folderPanelVisible, 'list-hidden': !noteListVisible }]">
    <header class="floating-note-header">
      <div class="floating-note-brand"><strong>EasyNote</strong><span>悬浮笔记工作区</span></div>
      <label class="floating-note-search"><span>⌕</span><input v-model="search" type="search" placeholder="搜索标题、正文或标签…"><kbd>Ctrl K</kbd></label>
      <div class="floating-note-header-actions">
        <span class="floating-save-status" :class="saveStatus">{{ { saved: '已验证保存', dirty: '等待保存', saving: '正在保存', failed: '保存失败' }[saveStatus] }}</span>
        <button class="floating-layout-toggle" type="button" :class="{ active: folderPanelVisible }" @click="toggleFolderPanel">文件夹</button>
        <button class="floating-layout-toggle" type="button" :class="{ active: noteListVisible }" @click="toggleNoteList()">列表</button>
        <button type="button" @click="openInMain">主窗口</button><button type="button" title="关闭悬浮窗口" @click="emit('close')">×</button>
      </div>
    </header>

    <div class="floating-note-layout">
      <aside v-if="folderPanelVisible" class="floating-folder-panel">
        <div class="floating-panel-title"><strong>笔记</strong><button type="button" title="新建文件夹" @click="createFolder">＋</button></div>
        <nav>
          <button :class="{ active: selectedView === 'all' }" type="button" @click="selectedView = 'all'">全部笔记 <em>{{ state?.notes.filter(note => !note.deletedAt).length || 0 }}</em></button>
          <button :class="{ active: selectedView === 'favorites' }" type="button" @click="selectedView = 'favorites'">我的收藏</button>
          <button :class="{ active: selectedView === 'trash' }" type="button" @click="selectedView = 'trash'">回收站</button>
        </nav>
        <div class="floating-folder-heading">文件夹</div>
        <nav class="floating-folder-list">
          <button v-for="folder in folders" :key="folder.id" :class="{ active: selectedView === `folder:${folder.id}` }" :style="{ paddingLeft: `${13 + folderDepth(folder) * 15}px` }" type="button" :title="folderPath(folder.id)" @click="selectedView = `folder:${folder.id}`"><i :style="{ background: folder.color || '#4f7df3' }"></i><span>{{ folder.name }}</span></button>
        </nav>
      </aside>

      <aside v-if="noteListVisible" class="floating-note-list-panel">
        <div class="floating-note-list-heading">
          <div><strong>{{ selectedView === 'all' ? '全部笔记' : selectedView === 'favorites' ? '我的收藏' : selectedView === 'trash' ? '回收站' : folderPath(selectedFolderId) }}</strong><span>{{ visibleNotes.length }} 篇</span></div>
          <select v-model="sort" aria-label="排序方式"><option value="updated">最近编辑</option><option value="created">最近创建</option><option value="title">标题排序</option></select>
          <button class="floating-new-note" type="button" @click="createNote">＋ 新建</button>
        </div>
        <div class="floating-note-cards">
          <article v-for="note in visibleNotes" :key="note.id" :class="{ active: note.id === selectedNoteId }" tabindex="0" @click="selectNote(note.id)" @keydown.enter="selectNote(note.id)" @contextmenu="showContext($event, note.id)">
            <div><strong>{{ note.title || '无标题笔记' }}</strong><span v-if="note.favorite">★</span></div>
            <p>{{ plainText(note) || '暂无正文' }}</p>
            <footer><span>{{ folderPath(note.categoryId) || '未归档' }}</span><time>{{ formatDate(note.updatedAt) }}</time></footer>
          </article>
          <div v-if="!visibleNotes.length" class="floating-note-empty"><strong>没有符合条件的笔记</strong><button type="button" @click="createNote">新建一篇笔记</button></div>
        </div>
      </aside>

      <main class="floating-editor-panel">
        <div v-if="!activeNote" class="floating-editor-empty"><strong>选择一篇笔记开始编辑</strong><button type="button" @click="compactPane = 'list'">打开笔记列表</button></div>
        <template v-else>
          <div class="floating-editor-topline">
            <div class="floating-editor-leading-actions">
              <button class="floating-list-toggle" type="button" @click="toggleNoteList(true)">☰ {{ noteListVisible ? '笔记列表' : '显示列表' }}</button>
              <button class="floating-editor-new-note" type="button" @click="createNote">＋ 新建笔记</button>
            </div>
            <span>编辑于 {{ formatDate(activeNote.updatedAt) }}</span>
            <div>
              <button type="button" :title="activeNote.favorite ? '取消收藏' : '收藏'" @click="toggleFavorite()">{{ activeNote.favorite ? '★' : '☆' }}</button>
              <button type="button" @click="openHistory">历史</button><button type="button" @click="downloadMarkdown">导出</button>
              <button v-if="!activeNote.deletedAt" type="button" class="danger" @click="trashNote()">删除</button>
              <button v-else type="button" @click="restoreNote()">恢复</button>
            </div>
          </div>
          <div class="floating-editor-scroll">
            <input class="floating-title-input" :value="activeNote.title" :disabled="Boolean(activeNote.deletedAt)" placeholder="无标题笔记" @input="updateTitle(($event.target as HTMLInputElement).value)">
            <div class="floating-meta-row">
              <div class="floating-recent-picker">
                <button class="floating-recent-trigger" type="button" aria-label="最近编辑的笔记" :aria-expanded="recentPickerOpen" @click.stop="toggleRecentPicker"><span>最近</span><strong>快速切换</strong><b>⌄</b></button>
                <div v-if="recentPickerOpen" class="floating-recent-popover" @click.stop>
                  <div class="floating-recent-heading"><strong>最近编辑</strong><span>最多显示 10 篇</span></div>
                  <button v-for="note in recentNotes" :key="note.id" type="button" :class="{ active: note.id === selectedNoteId }" @click="selectRecentNote(note.id)"><span>{{ note.title || '无标题笔记' }}</span><time>{{ formatDate(note.updatedAt) }}</time></button>
                  <p v-if="!recentNotes.length">暂无最近笔记</p>
                </div>
              </div>
              <div class="floating-note-picker">
                <span>切换笔记</span>
                <button class="floating-note-picker-trigger" type="button" aria-label="切换具体笔记" :aria-expanded="notePickerOpen" @click.stop="toggleNotePicker"><span>{{ folderPath(activeNote.categoryId) || '未归档' }}</span><strong>{{ activeNote.title || '无标题笔记' }}</strong><b>⌄</b></button>
                <div v-if="notePickerOpen" class="floating-note-picker-popover" @click.stop>
                  <div class="floating-note-picker-heading"><strong>选择笔记</strong><span>按最近编辑排序</span></div>
                  <div class="floating-note-tree">
                    <template v-for="row in notePickerRows" :key="`${row.kind}:${row.id}`">
                      <button v-if="row.kind === 'folder'" class="floating-note-tree-folder" type="button" :style="{ paddingLeft: `${10 + row.level * 20}px` }" @click="togglePickerFolder(row.id)"><b>{{ row.expanded ? '⌄' : '›' }}</b><i :style="{ borderColor: row.color, background: `${row.color}18` }"></i><strong>{{ row.label }}</strong><span>{{ row.count }}</span></button>
                      <button v-else class="floating-note-tree-note" type="button" :class="{ active: row.id === selectedNoteId }" :style="{ paddingLeft: `${31 + row.level * 20}px` }" :title="`${row.label} · ${formatDate(row.updatedAt)}`" @click="selectNoteFromPicker(row.id)"><i>▤</i><span>{{ row.label }}</span><time>{{ formatDate(row.updatedAt) }}</time></button>
                    </template>
                  </div>
                </div>
              </div>
              <div class="floating-folder-picker">
                <span>所在文件夹</span>
                <button class="floating-folder-picker-trigger" type="button" :disabled="Boolean(activeNote.deletedAt)" :aria-expanded="folderPickerOpen" @click.stop="toggleFolderPicker"><strong>{{ folderPath(activeNote.categoryId) || '未归档' }}</strong><b>⌄</b></button>
                <div v-if="folderPickerOpen" class="floating-folder-picker-popover" @click.stop>
                  <div class="floating-recent-heading"><strong>移动到文件夹</strong><span>可随时更改</span></div>
                  <button type="button" :class="{ active: !activeNote.categoryId }" @click="selectFolder('')"><span>未归档</span></button>
                  <button v-for="row in folderPickerRows" :key="row.folder.id" type="button" :class="{ active: activeNote.categoryId === row.folder.id }" :style="{ paddingLeft: `${12 + row.level * 18}px` }" @click="selectFolder(row.folder.id)"><i :style="{ background: row.folder.color || '#4f7df3' }"></i><span>{{ row.folder.name }}</span></button>
                </div>
              </div>
              <label class="floating-tags-field" title="标签用于跨文件夹分类和搜索，例如：面试、Redis、待整理"><span>标签 <small>用于搜索</small></span><input :value="(activeNote.tags || []).join(', ')" :disabled="Boolean(activeNote.deletedAt)" placeholder="如：面试, Redis" @input="updateTags(($event.target as HTMLInputElement).value)"></label>
              <button type="button" @click="toggleMode">{{ editMode === 'rich' ? 'Markdown' : '富文本' }}</button>
            </div>
            <div v-if="editMode === 'rich' && !activeNote.deletedAt" class="floating-format-toolbar" @mousedown.prevent>
              <button type="button" title="撤销" @click="runCommand('undo')">↶</button><button type="button" title="重做" @click="runCommand('redo')">↷</button><i></i>
              <button type="button" title="加粗" @click="runCommand('bold')"><b>B</b></button><button type="button" title="斜体" @click="runCommand('italic')"><em>I</em></button>
              <button type="button" @click="runCommand('formatBlock', 'h2')">H2</button><button type="button" @click="runCommand('formatBlock', 'h3')">H3</button><i></i>
              <button type="button" @click="runCommand('insertUnorderedList')">• 列表</button><button type="button" @click="runCommand('insertOrderedList')">1. 列表</button>
              <button type="button" @click="runCommand('formatBlock', 'blockquote')">引用</button><button type="button" @click="runCommand('formatBlock', 'pre')">代码</button>
              <button type="button" @click="insertLink">链接</button><button type="button" @click="captureSelection(); imageInput?.click()">图片</button><button type="button" @click="runCommand('removeFormat')">清除格式</button>
              <input ref="imageInput" type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple hidden @change="onImageFiles(($event.target as HTMLInputElement).files || [])">
            </div>
            <div v-if="selectedImage && editMode === 'rich'" class="floating-image-controls"><span>图片（可直接拖动调整位置）</span><button type="button" @click="copyImageToClipboard(selectedImage)">复制</button><button type="button" @click="copyImageToClipboard(selectedImage, true)">剪切</button><button v-for="item in ['small','medium','large','full'] as const" :key="item" type="button" @click="imageAction(item)">{{ { small:'小',medium:'中',large:'大',full:'铺满' }[item] }}</button><i></i><button v-for="item in ['left','center','right'] as const" :key="item" type="button" @click="imageAction(item)">{{ { left:'左',center:'中',right:'右' }[item] }}</button><button class="danger" type="button" @click="imageAction('delete')">删除</button></div>
            <div v-show="editMode === 'rich'" ref="editor" class="floating-content-editor" :contenteditable="!activeNote.deletedAt" data-placeholder="开始写下你的想法…" spellcheck="true" @input="syncRichContent" @click="selectEditorImage" @pointerdown="onEditorPointerDown" @keydown="onEditorKeydown" @contextmenu="openEditorContext" @paste="onPaste" @dragover.prevent @drop="onDrop"></div>
            <textarea v-if="editMode === 'markdown'" v-model="markdownText" class="floating-markdown-editor" :disabled="Boolean(activeNote.deletedAt)" placeholder="# 开始写作…&#10;&#10;```mermaid&#10;flowchart TD&#10;A[开始] --> B[结束]&#10;```" @input="onMarkdownInput"></textarea>
          </div>
        </template>
      </main>
    </div>

    <div v-if="contextMenu" class="floating-context-menu" :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }" @click.stop>
      <button type="button" @click="contextAction('open')">打开笔记</button><button type="button" @click="contextAction('favorite')">收藏或取消收藏</button><button type="button" @click="contextAction('duplicate')">复制笔记</button><hr><button class="danger" type="button" @click="contextAction('trash')">移入回收站</button>
    </div>
    <div v-if="editorContextMenu" class="floating-context-menu floating-editor-context-menu" :style="{ left: `${editorContextMenu.x}px`, top: `${editorContextMenu.y}px` }" @pointerdown.prevent.stop @click.stop>
      <template v-if="editorContextMenu.image"><button type="button" @click="editorContextAction('copy-image')">复制图片 <span>Ctrl C</span></button><button type="button" @click="editorContextAction('cut-image')">剪切图片 <span>Ctrl X</span></button><hr></template>
      <template v-if="editorContextMenu.diagram"><button type="button" @click="editorContextAction('edit-mermaid')">编辑 Mermaid 源码</button><button class="danger" type="button" @click="editorContextAction('delete-diagram')">删除 Mermaid 图表</button><hr></template>
      <template v-if="editorContextMenu.block"><button v-if="editorContextMenu.block.dataset.codeLanguage === 'mermaid'" type="button" @click="editorContextAction('render-mermaid')">渲染 Mermaid 图表</button><button type="button" @click="editorContextAction('paragraph')">去掉框，保留文字</button><button class="danger" type="button" @click="editorContextAction('delete-block')">删除整个块</button><hr></template>
      <button type="button" @click="editorContextAction('copy')">复制 <span>Ctrl C</span></button><button type="button" @click="editorContextAction('cut')">剪切 <span>Ctrl X</span></button><button type="button" @click="editorContextAction('paste')">粘贴纯文本 <span>Ctrl V</span></button><button type="button" @click="editorContextAction('select-all')">全选 <span>Ctrl A</span></button><hr><button type="button" @click="editorContextAction('bold')">加粗</button><button type="button" @click="editorContextAction('unordered')">无序列表</button><button type="button" @click="editorContextAction('ordered')">有序列表</button><button type="button" @click="editorContextAction('quote')">设为引用框</button><button type="button" @click="editorContextAction('code')">设为代码框</button><button type="button" @click="editorContextAction('mermaid')">插入 Mermaid 流程图</button><hr><button type="button" @click="editorContextAction('undo')">撤销 <span>Ctrl Z</span></button><button type="button" @click="editorContextAction('redo')">重做 <span>Ctrl Y</span></button>
    </div>
    <div v-if="historyOpen" class="floating-history-backdrop" @click.self="historyOpen = false"><section class="floating-history-dialog"><header><div><span>当前笔记</span><strong>历史版本</strong></div><button type="button" @click="historyOpen = false">×</button></header><div><article v-for="item in historyItems" :key="item.id"><div><strong>{{ item.snapshot.title || '无标题笔记' }}</strong><span>{{ formatDate(item.createdAt) }}</span></div><button type="button" @click="restoreHistory(item.id)">恢复此版本</button></article><p v-if="!historyItems.length">暂无历史版本</p></div></section></div>
  </section>
</template>

<style>
.floating-note-workspace { --fn-border:var(--border,#dfe5ef); --fn-surface:var(--surface,#fff); --fn-soft:var(--surface-soft,#f6f8fc); --fn-text:var(--text,#192235); --fn-muted:var(--muted,#758096); --fn-primary:var(--primary,#4f7df3); --fn-primary-soft:var(--primary-soft,#edf3ff); width:100%; height:100%; min-width:420px; min-height:300px; display:flex; flex-direction:column; overflow:hidden; color:var(--fn-text); background:var(--fn-surface); font-family:Inter,"Microsoft YaHei","Segoe UI",sans-serif; }
:root[data-theme="dark"] .floating-note-workspace { --fn-border:#313b4e; --fn-surface:#171e2b; --fn-soft:#111722; --fn-text:#e9edf5; --fn-muted:#9ba6ba; }
.floating-note-workspace * { box-sizing:border-box; }
.floating-note-workspace button,.floating-note-workspace input,.floating-note-workspace select,.floating-note-workspace textarea { font:inherit; }
.floating-note-header { height:58px; flex:0 0 auto; display:flex; align-items:center; gap:18px; padding:0 14px 0 18px; border-bottom:1px solid var(--fn-border); background:var(--fn-surface); }
.floating-note-brand { display:grid; line-height:1.15; white-space:nowrap; }.floating-note-brand strong{font-size:16px}.floating-note-brand span{color:#4f7df3;font-size:10px;font-weight:650}
.floating-note-search { width:min(430px,42vw); height:36px; display:flex; align-items:center; gap:8px; margin:auto; padding:0 10px; border:1px solid var(--fn-border); border-radius:10px; background:var(--fn-soft); }.floating-note-search input{min-width:0;flex:1;border:0;outline:0;color:var(--fn-text);background:transparent}.floating-note-search kbd{font-size:9px;color:var(--fn-muted)}
.floating-note-header-actions{display:flex;align-items:center;gap:7px}.floating-note-header-actions button,.floating-editor-topline button,.floating-meta-row>button{height:32px;padding:0 10px;border:1px solid var(--fn-border);border-radius:8px;color:var(--fn-text);background:var(--fn-surface);cursor:pointer}.floating-save-status{font-size:10px;color:#23865a;white-space:nowrap}.floating-save-status.dirty,.floating-save-status.saving{color:#b9770e}.floating-save-status.failed{color:#d84c5a}
.floating-note-header-actions button.floating-layout-toggle.active{border-color:color-mix(in srgb,#4f7df3 42%,var(--fn-border));color:#386fd8;background:color-mix(in srgb,#4f7df3 9%,var(--fn-surface))}
.floating-note-layout{min-height:0;flex:1;display:grid;grid-template-columns:210px 280px minmax(0,1fr)}
.floating-note-workspace.folders-hidden .floating-note-layout{grid-template-columns:280px minmax(0,1fr)}
.floating-note-workspace.folders-hidden .floating-folder-panel{display:none}
.floating-note-workspace.list-hidden .floating-note-layout{grid-template-columns:210px minmax(0,1fr)}
.floating-note-workspace.list-hidden .floating-note-list-panel{display:none}
.floating-note-workspace.folders-hidden.list-hidden .floating-note-layout{grid-template-columns:minmax(0,1fr)}
.floating-folder-panel,.floating-note-list-panel{min-width:0;min-height:0;display:flex;flex-direction:column;border-right:1px solid var(--fn-border);background:var(--fn-soft)}
.floating-panel-title{height:52px;display:flex;align-items:center;justify-content:space-between;padding:0 13px 0 16px}.floating-panel-title button{width:29px;height:29px;border:1px solid var(--fn-border);border-radius:8px;color:#4f7df3;background:var(--fn-surface)}
.floating-folder-panel nav{display:grid;gap:3px;padding:0 8px}.floating-folder-panel nav button{min-width:0;height:35px;display:flex;align-items:center;gap:8px;padding:0 11px;border:0;border-radius:8px;color:var(--fn-muted);background:transparent;text-align:left;cursor:pointer}.floating-folder-panel nav button:hover,.floating-folder-panel nav button.active{color:#386fd8;background:color-mix(in srgb,#4f7df3 10%,var(--fn-surface))}.floating-folder-panel nav button em{margin-left:auto;font-style:normal;font-size:10px}.floating-folder-heading{padding:18px 15px 7px;color:var(--fn-muted);font-size:10px;font-weight:700}.floating-folder-list{overflow:auto}.floating-folder-list button i{width:8px;height:8px;flex:0 0 auto;border-radius:3px}.floating-folder-list button span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.floating-note-list-heading{min-height:72px;display:grid;grid-template-columns:1fr auto;gap:6px;padding:10px 10px;border-bottom:1px solid var(--fn-border);background:var(--fn-surface)}.floating-note-list-heading>div{min-width:0;display:grid}.floating-note-list-heading strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.floating-note-list-heading span{color:var(--fn-muted);font-size:10px}.floating-note-list-heading select{max-width:102px;border:1px solid var(--fn-border);border-radius:7px;color:var(--fn-muted);background:var(--fn-surface);font-size:10px}.floating-new-note{grid-column:1/-1;height:30px;border:0;border-radius:7px;color:#fff;background:#4f7df3;font-weight:650}
.floating-note-cards{min-height:0;flex:1;overflow:auto;padding:8px}.floating-note-cards article{display:grid;gap:7px;margin-bottom:6px;padding:11px;border:1px solid transparent;border-radius:10px;background:var(--fn-surface);cursor:pointer;content-visibility:auto;contain:layout style paint;contain-intrinsic-size:0 92px}.floating-note-cards article:hover,.floating-note-cards article.active{border-color:color-mix(in srgb,#4f7df3 42%,var(--fn-border));box-shadow:0 5px 16px rgba(15,23,42,.06)}.floating-note-cards article>div{display:flex;gap:6px}.floating-note-cards article strong{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}.floating-note-cards article>div span{color:#e3a008}.floating-note-cards article p{height:34px;margin:0;overflow:hidden;color:var(--fn-muted);font-size:10px;line-height:17px}.floating-note-cards article footer{display:flex;justify-content:space-between;gap:7px;color:var(--fn-muted);font-size:9px}.floating-note-cards article footer span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.floating-note-empty,.floating-editor-empty{height:100%;display:grid;place-content:center;justify-items:center;gap:12px;color:var(--fn-muted);text-align:center}.floating-note-empty button,.floating-editor-empty button{padding:8px 12px;border:0;border-radius:8px;color:#fff;background:#4f7df3}
.floating-editor-panel{min-width:0;min-height:0;display:flex;flex-direction:column;background:var(--fn-surface)}.floating-editor-topline{height:48px;flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;padding:0 13px;border-bottom:1px solid var(--fn-border);color:var(--fn-muted);font-size:10px}.floating-editor-topline>div{display:flex;gap:5px}.floating-editor-topline button.danger,.floating-image-controls button.danger,.floating-context-menu button.danger{color:#d84c5a}.floating-list-toggle{display:inline-flex;align-items:center}.floating-editor-leading-actions{display:flex;align-items:center;gap:5px}.floating-editor-new-note{border-color:#4f7df3!important;color:#fff!important;background:#4f7df3!important;font-weight:700}.floating-editor-scroll{min-height:0;flex:1;overflow:auto;padding:25px clamp(22px,5vw,70px) 80px}.floating-title-input{width:100%;border:0;outline:0;color:var(--fn-text);background:transparent;font-size:clamp(25px,3vw,36px);font-weight:750}.floating-meta-row{position:relative;display:grid;grid-template-columns:minmax(230px,1.2fr) minmax(150px,.8fr) minmax(180px,1fr) auto;gap:10px;margin:15px 0}.floating-meta-row label{min-width:0;display:flex;align-items:center;gap:7px}.floating-meta-row label span{color:var(--fn-muted);font-size:10px;white-space:nowrap}.floating-meta-row input,.floating-meta-row select{min-width:0;height:33px;flex:1;padding:0 9px;border:1px solid var(--fn-border);border-radius:8px;color:var(--fn-text);background:var(--fn-soft)}.floating-note-picker{position:relative;min-width:0;display:flex;align-items:center;gap:7px}.floating-note-picker>span{color:var(--fn-muted);font-size:10px;white-space:nowrap}.floating-note-picker-trigger{min-width:0;height:40px;flex:1;display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-rows:1fr 1fr;column-gap:8px;padding:4px 8px!important;border:1px solid var(--fn-border)!important;border-radius:8px!important;color:var(--fn-text)!important;background:var(--fn-soft)!important;text-align:left}.floating-note-picker-trigger>span,.floating-note-picker-trigger>strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.floating-note-picker-trigger>span{color:var(--fn-muted);font-size:9px}.floating-note-picker-trigger>strong{font-size:11px}.floating-note-picker-trigger>b{grid-column:2;grid-row:1/3;align-self:center;color:var(--fn-muted);font-size:15px}.floating-note-picker-popover{position:absolute;z-index:90;top:calc(100% + 7px);left:0;width:min(420px,80vw);max-height:min(520px,65vh);display:flex;flex-direction:column;border:1px solid var(--fn-border);border-radius:12px;background:var(--fn-surface);box-shadow:0 18px 48px rgba(15,23,42,.22);overflow:hidden}.floating-note-picker-heading{height:50px;flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;padding:0 13px;border-bottom:1px solid var(--fn-border)}.floating-note-picker-heading span{color:var(--fn-muted);font-size:9px}.floating-note-tree{min-height:0;overflow:auto;padding:7px}.floating-note-tree button{width:100%;border:0;color:var(--fn-text);background:transparent;cursor:pointer;text-align:left}.floating-note-tree-folder{height:38px;display:flex;align-items:center;gap:8px;border-radius:8px!important}.floating-note-tree-folder:hover{background:var(--fn-soft)}.floating-note-tree-folder>b{width:12px;color:var(--fn-muted);font-size:17px;font-weight:400}.floating-note-tree-folder>i{width:18px;height:13px;flex:0 0 auto;border:1.5px solid;border-radius:3px}.floating-note-tree-folder>strong{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.floating-note-tree-folder>span{color:var(--fn-muted);font-size:10px}.floating-note-tree-note{height:36px;display:flex;align-items:center;gap:8px;border-radius:7px!important;color:var(--fn-muted)!important}.floating-note-tree-note:hover,.floating-note-tree-note.active{color:#386fd8!important;background:color-mix(in srgb,#4f7df3 10%,var(--fn-soft))}.floating-note-tree-note>i{font-style:normal}.floating-note-tree-note>span{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.floating-note-tree-note>time{display:none;color:var(--fn-muted);font-size:8px}
.floating-recent-picker,.floating-folder-picker{position:relative;min-width:0;display:flex;align-items:center;gap:7px}.floating-recent-trigger,.floating-folder-picker-trigger{min-width:0;flex:1;height:40px;display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-rows:1fr 1fr;padding:4px 8px;border:1px solid var(--fn-border);border-radius:8px;color:var(--fn-text);background:var(--fn-soft);text-align:left;cursor:pointer}.floating-recent-trigger span,.floating-folder-picker>span{color:var(--fn-muted);font-size:9px}.floating-recent-trigger strong,.floating-folder-picker-trigger strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}.floating-recent-trigger b,.floating-folder-picker-trigger b{grid-column:2;grid-row:1/3;align-self:center;color:var(--fn-muted);font-size:15px}.floating-recent-popover,.floating-folder-picker-popover{position:absolute;z-index:95;top:calc(100% + 7px);left:0;width:min(360px,76vw);max-height:min(420px,60vh);display:flex;flex-direction:column;padding:7px;border:1px solid var(--fn-border);border-radius:12px;background:var(--fn-surface);box-shadow:0 18px 48px rgba(15,23,42,.22);overflow:auto}.floating-recent-heading{height:34px;display:flex;align-items:center;justify-content:space-between;padding:0 6px;color:var(--fn-text)}.floating-recent-heading span{color:var(--fn-muted);font-size:9px}.floating-recent-popover button,.floating-folder-picker-popover button{min-height:34px;display:flex;align-items:center;gap:7px;border:0;border-radius:7px;padding:0 7px;color:var(--fn-text);background:transparent;text-align:left;cursor:pointer}.floating-recent-popover button:hover,.floating-recent-popover button.active,.floating-folder-picker-popover button:hover,.floating-folder-picker-popover button.active{color:var(--fn-primary);background:color-mix(in srgb,var(--fn-primary) 10%,var(--fn-soft))}.floating-recent-popover button span,.floating-folder-picker-popover button span{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.floating-recent-popover time{color:var(--fn-muted);font-size:9px}.floating-folder-picker-popover button i{width:8px;height:8px;flex:0 0 auto;border-radius:3px}.floating-recent-popover p{padding:14px;color:var(--fn-muted);font-size:10px;text-align:center}.floating-tags-field{display:flex!important;flex-direction:column;align-items:stretch!important;gap:3px!important}.floating-tags-field small{color:var(--fn-muted);font-size:8px;font-weight:400}.floating-folder-location>i{flex:0 0 auto;color:var(--fn-muted);font-size:11px;font-style:normal}.floating-folder-location select:disabled{cursor:not-allowed;opacity:.72}
.floating-format-toolbar{position:sticky;z-index:4;top:-25px;display:flex;align-items:center;gap:3px;margin:8px 0 14px;padding:6px;border:1px solid var(--fn-border);border-radius:10px;background:var(--fn-surface);overflow-x:auto}.floating-format-toolbar button,.floating-image-controls button{height:30px;flex:0 0 auto;padding:0 8px;border:0;border-radius:6px;color:var(--fn-muted);background:transparent;cursor:pointer}.floating-format-toolbar button:hover,.floating-image-controls button:hover{color:#386fd8;background:color-mix(in srgb,#4f7df3 10%,var(--fn-soft))}.floating-format-toolbar i,.floating-image-controls i{width:1px;height:20px;flex:0 0 auto;background:var(--fn-border)}
.floating-content-editor{min-height:calc(100vh - 260px);outline:0;color:var(--fn-text);font-size:15px;line-height:1.78}.floating-content-editor:empty::before{color:var(--fn-muted);content:attr(data-placeholder)}.floating-content-editor h1,.floating-content-editor h2,.floating-content-editor h3{line-height:1.35}.floating-content-editor blockquote{margin:12px 0;padding:8px 34px 8px 14px;border-left:3px solid #4f7df3;color:var(--fn-muted);background:var(--fn-soft)}.floating-content-editor pre{padding:13px 36px 13px 13px;border-radius:9px;background:#121827;color:#e8edf7;white-space:pre-wrap}.floating-content-editor blockquote,.floating-content-editor pre{position:relative;min-height:42px}.floating-content-editor blockquote::after,.floating-content-editor pre::after{content:"⋮";position:absolute;top:0;right:0;bottom:0;width:25px;display:grid;place-items:center;border-left:1px solid rgba(148,163,184,.22);color:#94a3b8;font:18px/1 sans-serif;cursor:pointer;opacity:.62}.floating-content-editor blockquote:hover::after,.floating-content-editor pre:hover::after{opacity:1;background:rgba(79,125,243,.08)}.floating-content-editor blockquote:has(::selection),.floating-content-editor pre:has(::selection){outline:2px solid color-mix(in srgb,#4f7df3 55%,transparent)}.floating-content-editor>p:last-child:empty,.floating-content-editor>p:last-child:has(>br:only-child){min-height:30px;margin:8px 0;cursor:text}.floating-content-editor a{color:#386fd8}.floating-content-editor img{max-width:100%;height:auto;display:block;margin:14px auto;border-radius:8px;cursor:grab;user-select:none}.floating-content-editor img.floating-image-moving{cursor:grabbing;opacity:.72}.floating-content-editor.floating-image-dragging{cursor:grabbing}.floating-content-editor img[data-size="small"]{width:30%}.floating-content-editor img[data-size="medium"]{width:55%}.floating-content-editor img[data-size="large"]{width:78%}.floating-content-editor img[data-size="full"]{width:100%}.floating-content-editor img:hover{outline:2px solid color-mix(in srgb,#4f7df3 55%,transparent)}.floating-image-controls{display:flex;align-items:center;gap:3px;margin:-6px 0 10px;padding:5px 7px;border:1px solid color-mix(in srgb,#4f7df3 34%,var(--fn-border));border-radius:8px;background:var(--fn-soft)}.floating-image-controls span{margin-right:5px;color:#386fd8;font-size:10px;font-weight:700}.floating-markdown-editor{width:100%;min-height:calc(100vh - 250px);resize:none;padding:14px;border:1px solid var(--fn-border);border-radius:10px;outline:0;color:var(--fn-text);background:var(--fn-soft);font:14px/1.7 Consolas,"Microsoft YaHei",monospace}
.floating-content-editor blockquote{margin-right:28px;padding-right:14px}.floating-content-editor pre{margin-right:28px;padding-right:13px}.floating-content-editor blockquote::after,.floating-content-editor pre::after{right:-28px;border:1px solid var(--fn-border);border-radius:0 7px 7px 0;background:var(--fn-soft)}.floating-content-editor>p:last-child:empty,.floating-content-editor>p:last-child:has(>br:only-child){min-height:34px}
.floating-context-menu{position:fixed;z-index:999;width:180px;display:grid;padding:6px;border:1px solid var(--fn-border);border-radius:10px;background:var(--fn-surface);box-shadow:0 16px 42px rgba(15,23,42,.24)}.floating-context-menu button{height:34px;border:0;border-radius:6px;color:var(--fn-text);background:transparent;text-align:left}.floating-context-menu button:hover{background:var(--fn-soft)}.floating-context-menu hr{width:100%;border:0;border-top:1px solid var(--fn-border)}
.floating-editor-context-menu{width:205px;max-height:calc(100vh - 16px);overflow-y:auto}.floating-editor-context-menu button{display:flex;align-items:center;justify-content:space-between;gap:12px}.floating-editor-context-menu button span{color:var(--fn-muted);font-size:9px}
.floating-history-backdrop{position:fixed;z-index:1200;inset:0;display:grid;place-items:center;padding:24px;background:rgba(15,23,42,.38)}.floating-history-dialog{width:min(560px,100%);max-height:min(650px,90vh);display:flex;flex-direction:column;border:1px solid var(--fn-border);border-radius:14px;background:var(--fn-surface);box-shadow:0 24px 72px rgba(15,23,42,.3);overflow:hidden}.floating-history-dialog>header{height:60px;display:flex;align-items:center;justify-content:space-between;padding:0 16px;border-bottom:1px solid var(--fn-border)}.floating-history-dialog>header div{display:grid}.floating-history-dialog>header span{color:#4f7df3;font-size:9px;font-weight:700}.floating-history-dialog>header button{width:32px;height:32px;border:0;border-radius:8px;color:var(--fn-muted);background:var(--fn-soft)}.floating-history-dialog>div{overflow:auto;padding:10px}.floating-history-dialog article{display:flex;align-items:center;gap:12px;padding:11px;border-bottom:1px solid var(--fn-border)}.floating-history-dialog article>div{min-width:0;flex:1;display:grid}.floating-history-dialog article span{color:var(--fn-muted);font-size:10px}.floating-history-dialog article button{padding:7px 10px;border:1px solid var(--fn-border);border-radius:8px;color:#4f7df3;background:var(--fn-surface)}.floating-history-dialog p{padding:30px;color:var(--fn-muted);text-align:center}
@media(max-width:820px){.floating-note-layout,.floating-note-workspace.folders-hidden .floating-note-layout{grid-template-columns:260px minmax(0,1fr)}.floating-folder-panel{display:none}.floating-note-workspace.list-hidden .floating-note-layout,.floating-note-workspace.folders-hidden.list-hidden .floating-note-layout{grid-template-columns:minmax(0,1fr)}.floating-note-search{width:min(360px,40vw)}.floating-editor-scroll{padding-inline:28px}}
@media(max-width:620px){.floating-note-workspace{min-width:360px}.floating-note-header{gap:8px}.floating-note-brand span,.floating-save-status,.floating-note-search kbd{display:none}.floating-note-search{width:auto;min-width:0;flex:1}.floating-note-layout{display:block;position:relative}.floating-note-list-panel,.floating-editor-panel{position:absolute;inset:0}.compact-editor .floating-note-list-panel{display:none}.compact-list .floating-editor-panel{display:none}.floating-list-toggle{display:inline-flex}.floating-editor-scroll{padding:20px}.floating-meta-row{grid-template-columns:1fr}.floating-content-editor{min-height:calc(100vh - 330px)}}
.floating-content-editor .mermaid-diagram{margin:18px 0;padding:12px;overflow:auto;border:1px solid color-mix(in srgb,#4f7df3 24%,var(--fn-border));border-radius:10px;background:color-mix(in srgb,#4f7df3 5%,var(--fn-surface))}.floating-content-editor .mermaid-svg,.floating-content-editor .mermaid-diagram>svg{display:block;width:100%!important;max-width:100%!important;height:auto!important;max-height:70vh;min-height:130px}.floating-content-editor .mermaid-fallback{white-space:pre-wrap}.floating-content-editor .mermaid-diagram.mermaid-error{color:#d84c5a}
.floating-note-brand span,.floating-panel-title button,.floating-history-dialog>header span,.floating-history-dialog article button,.floating-image-controls span,.floating-content-editor a{color:var(--fn-primary)}
.floating-new-note,.floating-editor-empty button,.floating-note-empty button,.floating-editor-new-note{border-color:var(--fn-primary)!important;background:var(--fn-primary)!important}
.floating-note-header-actions button.floating-layout-toggle.active,.floating-note-cards article:hover,.floating-note-cards article.active{border-color:color-mix(in srgb,var(--fn-primary) 42%,var(--fn-border));color:var(--fn-primary);background:color-mix(in srgb,var(--fn-primary) 9%,var(--fn-surface))}
.floating-folder-panel nav button:hover,.floating-folder-panel nav button.active,.floating-note-tree-note:hover,.floating-note-tree-note.active,.floating-format-toolbar button:hover,.floating-image-controls button:hover{color:var(--fn-primary)!important;background:color-mix(in srgb,var(--fn-primary) 10%,var(--fn-soft))}
.floating-content-editor blockquote{border-left-color:var(--fn-primary)}.floating-content-editor img:hover{outline-color:color-mix(in srgb,var(--fn-primary) 55%,transparent)}
.floating-content-editor .mermaid-diagram{border-color:color-mix(in srgb,var(--fn-primary) 24%,var(--fn-border));background:color-mix(in srgb,var(--fn-primary) 5%,var(--fn-surface))}
</style>
