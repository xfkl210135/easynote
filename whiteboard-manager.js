(function () {
  "use strict";

  const COLORS = ["#4f7df3", "#22a06b", "#f59e0b", "#8b5cf6", "#e5484d", "#64748b"];
  const NODE_TYPES = new Set(["text", "note", "task", "image", "link", "group"]);
  const SIDES = new Set(["top", "right", "bottom", "left"]);
  const GRID = 20;
  const now = () => new Date().toISOString();
  const id = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const clone = (value) => structuredClone(value);
  const esc = (value) => { const node = document.createElement("div"); node.textContent = value ?? ""; return node.innerHTML; };
  const attr = (value) => esc(value).replace(/"/g, "&quot;");
  const strip = (html) => { const node = document.createElement("div"); node.innerHTML = html || ""; return (node.textContent || "").replace(/\s+/g, " ").trim(); };
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const validColor = (value) => /^#[0-9a-f]{6}$/i.test(String(value || "")) ? String(value) : COLORS[0];
  const safeNotePreview = (html) => {
    const template = document.createElement("template"); template.innerHTML = html || "";
    template.content.querySelectorAll("script,style,iframe,object,embed,form,button,input,textarea,select,svg,canvas,video,audio,source,track,link,meta").forEach((element) => element.remove());
    template.content.querySelectorAll("*").forEach((element) => {
      [...element.attributes].forEach((attribute) => { if (/^on/i.test(attribute.name) || ["style", "id", "class", "contenteditable", "tabindex", "srcset"].includes(attribute.name)) element.removeAttribute(attribute.name); });
      if (element.tagName === "A") { const href = element.getAttribute("href") || ""; element.removeAttribute("href"); element.removeAttribute("target"); if (/^https?:\/\//i.test(href)) element.dataset.whiteboardPreviewLink = href; }
      if (element.tagName === "IMG" && !/^(blob:|data:image\/)/i.test(element.getAttribute("src") || "")) element.removeAttribute("src");
    });
    return template.innerHTML;
  };

  class WhiteboardManager {
    constructor(options) {
      this.options = options;
      this.state = options.state;
      this.active = false;
      this.activeBoardId = "";
      this.selected = new Set();
      this.selectedEdgeId = "";
      this.search = "";
      this.histories = new Map();
      this.futures = new Map();
      this.drag = null;
      this.pan = null;
      this.connection = null;
      this.inlineEditingNodeId = "";
      this.replacingImageNodeId = "";
      this.ensureState();
      this.cacheElements();
      this.installDialog();
      this.installContextMenu();
      this.bind();
      this.render();
    }

    defaultBoard(title = "我的白板") {
      const stamp = now();
      return { id: id("board"), title, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 }, gridEnabled: true, createdAt: stamp, updatedAt: stamp };
    }

    ensureState() {
      this.state.whiteboards = Array.isArray(this.state.whiteboards) ? this.state.whiteboards : [];
      if (!this.state.whiteboards.length) this.state.whiteboards.push(this.defaultBoard());
      this.state.whiteboards.forEach((board) => {
        board.title = String(board.title || "未命名白板");
        board.nodes = Array.isArray(board.nodes) ? board.nodes : [];
        board.edges = Array.isArray(board.edges) ? board.edges : [];
        board.viewport = board.viewport && typeof board.viewport === "object" ? board.viewport : { x: 0, y: 0, zoom: 1 };
        board.viewport.x = Number(board.viewport.x) || 0; board.viewport.y = Number(board.viewport.y) || 0; board.viewport.zoom = clamp(Number(board.viewport.zoom) || 1, .25, 2.5);
        board.gridEnabled = board.gridEnabled !== false;
        board.createdAt ||= now(); board.updatedAt ||= board.createdAt;
        board.nodes.forEach((node, index) => {
          node.type = NODE_TYPES.has(node.type) ? node.type : "text";
          node.x = Number(node.x) || 0; node.y = Number(node.y) || 0; node.width = clamp(Number(node.width) || (node.type === "group" ? 420 : 260), 140, 1000); node.height = clamp(Number(node.height) || (node.type === "group" ? 280 : 160), 80, 800);
          node.zIndex = Number.isFinite(node.zIndex) ? node.zIndex : index + 1; node.color = validColor(node.color || COLORS[index % COLORS.length]); node.groupId ||= "";
        });
        const nodeIds = new Set(board.nodes.map((node) => node.id));
        board.edges = board.edges.filter((edge) => nodeIds.has(edge.sourceId) && nodeIds.has(edge.targetId) && edge.sourceId !== edge.targetId).map((edge) => ({ ...edge, sourceSide: SIDES.has(edge.sourceSide) ? edge.sourceSide : "right", targetSide: SIDES.has(edge.targetSide) ? edge.targetSide : "left", color: validColor(edge.color) }));
      });
      if (!this.state.whiteboards.some((board) => board.id === this.activeBoardId)) this.activeBoardId = this.state.whiteboards[0].id;
    }

    cacheElements() {
      const q = (selector) => document.querySelector(selector);
      this.el = {
        nav: q("#whiteboardNavButton"), count: q("#whiteboardCount"), workspace: q("#whiteboardWorkspace"), select: q("#whiteboardSelect"),
        canvas: q("#whiteboardCanvas"), stage: q("#whiteboardStage"), edges: q("#whiteboardEdges"), nodes: q("#whiteboardNodes"),
        selection: q("#whiteboardSelectionToolbar"), addMenu: q("#whiteboardAddMenu"), imageInput: q("#whiteboardImageInput"),
        newBoard: q("#whiteboardNew"), rename: q("#whiteboardRename"), remove: q("#whiteboardDelete"), undo: q("#whiteboardUndo"), redo: q("#whiteboardRedo"), grid: q("#whiteboardGrid"),
        zoomIn: q("#whiteboardZoomIn"), zoomOut: q("#whiteboardZoomOut"), fit: q("#whiteboardFit"), reset: q("#whiteboardReset"), zoomLabel: q("#whiteboardZoomLabel"),
        newTop: q("#newNoteTop"), searchInput: q("#searchInput"), panelSwitcher: q("#panelSwitcher"), layoutButton: q("#layoutButton")
      };
    }

    installDialog() {
      const root = document.createElement("div");
      root.innerHTML = `<div class="whiteboard-dialog-backdrop" id="whiteboardDialogBackdrop" hidden><form class="whiteboard-dialog" id="whiteboardDialog" role="dialog" aria-modal="true"><header><div><span>白板卡片</span><h2 id="whiteboardDialogTitle">添加内容</h2></div><button type="button" data-whiteboard-dialog-close>×</button></header><div id="whiteboardDialogBody"></div><p id="whiteboardDialogError" hidden></p><footer><button type="button" class="secondary-button" data-whiteboard-dialog-close>取消</button><button type="submit" class="primary-button">确定</button></footer></form></div>`;
      document.body.append(root.firstElementChild);
      this.dialogBackdrop = document.querySelector("#whiteboardDialogBackdrop"); this.dialog = document.querySelector("#whiteboardDialog"); this.dialogBody = document.querySelector("#whiteboardDialogBody"); this.dialogTitle = document.querySelector("#whiteboardDialogTitle"); this.dialogError = document.querySelector("#whiteboardDialogError"); this.dialogMode = ""; this.editingNodeId = ""; this.pendingPoint = null;
    }

    installContextMenu() {
      const menu = document.createElement("div"); menu.id = "whiteboardContextMenu"; menu.className = "whiteboard-context-menu"; menu.setAttribute("role", "menu"); menu.hidden = true; document.body.append(menu);
      this.contextMenu = menu; this.contextPoint = null;
    }

    get boards() { return this.state.whiteboards; }
    get board() { return this.boards.find((board) => board.id === this.activeBoardId) || this.boards[0]; }
    notes() { return this.options.notes?.() || []; }
    tasks() { return this.options.tasks?.() || []; }
    fields() { return this.options.fields?.() || []; }
    node(nodeId) { return this.board?.nodes.find((node) => node.id === nodeId); }
    role(name) { return this.fields().find((field) => field.systemRole === name); }
    taskTitle(task) { return String(task?.values?.[this.role("title")?.id] || "未命名任务"); }
    taskStatus(task) { const field = this.role("status"), option = field?.options?.find((item) => item.id === task?.values?.[field.id]); return option?.label || "未设置"; }
    taskProgress(task) { const field = this.role("progress"); return clamp(Number(task?.values?.[field?.id]) || 0, 0, 100); }
    taskDue(task) { const field = this.fields().find((item) => item.id === "task-due" || (item.type === "date" && /截止|到期|due/i.test(item.name || ""))); return String(task?.values?.[field?.id] || ""); }

    enter() {
      if (this.active) return;
      this.active = true; document.body.classList.add("whiteboard-mode"); this.el.workspace.hidden = false; this.el.nav.classList.add("active");
      this.el.newTop.innerHTML = "<span>＋</span> 新建卡片"; this.el.searchInput.placeholder = "搜索当前白板中的卡片…"; this.search = ""; this.el.searchInput.value = "";
      this.el.panelSwitcher.hidden = true; this.el.layoutButton.hidden = true; this.render(); this.closeSidebar();
    }

    leave() {
      if (!this.active) return;
      this.active = false; document.body.classList.remove("whiteboard-mode"); this.el.workspace.hidden = true; this.el.nav.classList.remove("active");
      this.el.newTop.innerHTML = "<span>＋</span> 新建笔记"; this.el.searchInput.placeholder = "搜索标题、正文或标签…"; this.el.panelSwitcher.hidden = false; this.el.layoutButton.hidden = false;
      this.closeDialog(); this.closeContextMenu(); this.el.addMenu.hidden = true; this.selected.clear(); this.selectedEdgeId = ""; this.inlineEditingNodeId = "";
    }

    closeSidebar() { document.querySelector("#sidebar")?.classList.remove("open"); document.querySelector("#sidebarScrim")?.classList.remove("open"); }
    setState(nextState) { this.state = nextState; this.ensureState(); this.selected.clear(); this.selectedEdgeId = ""; this.closeContextMenu(); this.render(); }
    setSearch(value) { this.search = String(value || "").trim().toLowerCase(); if (this.active) { this.renderNodes(); this.focusSearchResult(); } }

    createBoard(title = "新建白板") {
      const board = this.defaultBoard(title); this.boards.push(board); this.activeBoardId = board.id; this.selected.clear(); this.save(true, "manual"); this.render(); return board;
    }

    openBoard(boardId) { if (!this.boards.some((board) => board.id === boardId)) return; this.activeBoardId = boardId; this.selected.clear(); this.selectedEdgeId = ""; this.inlineEditingNodeId = ""; this.closeContextMenu(); this.render(); }

    async deleteBoard() {
      const board = this.board; if (!board || !confirm(`确定删除白板“${board.title}”吗？删除后可在数据安全中心恢复 30 天。`)) return;
      await this.options.safety.recordRecovery("whiteboard-delete", `删除白板“${board.title}”`, { whiteboard: clone(board) });
      this.state.whiteboards = this.boards.filter((item) => item.id !== board.id); if (!this.state.whiteboards.length) this.state.whiteboards.push(this.defaultBoard()); this.activeBoardId = this.state.whiteboards[0].id;
      await this.save(true, "danger"); this.render(); this.options.toast("白板已删除，可在 30 天内恢复");
    }

    snapshot() { return { nodes: clone(this.board.nodes), edges: clone(this.board.edges) }; }
    pushHistory() { const list = this.histories.get(this.board.id) || []; list.push(this.snapshot()); if (list.length > 50) list.shift(); this.histories.set(this.board.id, list); this.futures.set(this.board.id, []); }
    restoreSnapshot(value) { this.board.nodes = clone(value.nodes); this.board.edges = clone(value.edges); this.board.updatedAt = now(); this.selected.clear(); this.selectedEdgeId = ""; this.save(); this.renderCanvas(); }
    undo() { const list = this.histories.get(this.board.id) || []; if (!list.length) return; const future = this.futures.get(this.board.id) || []; future.push(this.snapshot()); this.futures.set(this.board.id, future); this.restoreSnapshot(list.pop()); this.histories.set(this.board.id, list); }
    redo() { const list = this.futures.get(this.board.id) || []; if (!list.length) return; const history = this.histories.get(this.board.id) || []; history.push(this.snapshot()); this.histories.set(this.board.id, history); this.restoreSnapshot(list.pop()); this.futures.set(this.board.id, list); }

    centerPoint() { const rect = this.el.canvas.getBoundingClientRect(), view = this.board.viewport; return { x: (rect.width / 2 - view.x) / view.zoom, y: (rect.height / 2 - view.y) / view.zoom }; }
    nextPoint(type = "text") {
      if (this.pendingPoint) { const point = this.pendingPoint; this.pendingPoint = null; return point; }
      const center = this.centerPoint(), rect = this.el.canvas.getBoundingClientRect(), columns = rect.width < 700 ? 1 : rect.width < 1100 ? 2 : 3;
      const regularCount = this.board.nodes.filter((node) => node.type !== "group").length;
      if (type === "group") return { x: center.x - 230, y: center.y + 120 + Math.floor(regularCount / columns) * 40 };
      const column = regularCount % columns, row = Math.floor(regularCount / columns), spread = (columns - 1) * 320;
      return { x: center.x - spread / 2 - 140 + column * 320, y: center.y - 170 + row * 220 };
    }

    createNode(type, data = {}) {
      this.pushHistory(); const point = data.point || this.nextPoint(type), zIndex = type === "group" ? Math.min(0, ...this.board.nodes.map((node) => node.zIndex || 0)) - 1 : Math.max(0, ...this.board.nodes.map((node) => node.zIndex || 0)) + 1;
      const sizes = { text: [280, 190], note: [340, 280], task: [290, 170], image: [320, 240], link: [300, 150], group: [460, 300] }, size = sizes[type] || sizes.text;
      const node = { id: id("node"), type: NODE_TYPES.has(type) ? type : "text", x: point.x, y: point.y, width: size[0], height: size[1], zIndex, color: validColor(data.color), groupId: "", text: data.text || "", title: data.title || "", noteId: data.noteId || "", taskId: data.taskId || "", attachmentId: data.attachmentId || "", url: data.url || "" };
      this.board.nodes.push(node); this.board.updatedAt = now(); this.selected = new Set([node.id]); this.save(); this.renderCanvas();
      if (node.type === "text") requestAnimationFrame(() => this.focusInlineText(node.id, data.title ? "body" : "title"));
      return node;
    }

    deleteSelection() {
      if (!this.selected.size && !this.selectedEdgeId) return;
      this.pushHistory(); const ids = new Set(this.selected); this.board.nodes = this.board.nodes.filter((node) => !ids.has(node.id)); this.board.nodes.forEach((node) => { if (ids.has(node.groupId)) node.groupId = ""; }); this.board.edges = this.board.edges.filter((edge) => !ids.has(edge.sourceId) && !ids.has(edge.targetId) && edge.id !== this.selectedEdgeId); this.selected.clear(); this.selectedEdgeId = ""; this.board.updatedAt = now(); this.save(); this.renderCanvas();
    }

    duplicateSelection() {
      if (!this.selected.size) return; this.pushHistory(); const ids = [...this.selected], copies = [], map = new Map(), maxZ = Math.max(0, ...this.board.nodes.map((node) => node.zIndex || 0));
      ids.forEach((nodeId, index) => { const source = this.node(nodeId); if (!source) return; const copy = { ...clone(source), id: id("node"), x: source.x + 28, y: source.y + 28, zIndex: maxZ + index + 1, groupId: "" }; map.set(source.id, copy.id); copies.push(copy); });
      const edges = this.board.edges.filter((edge) => map.has(edge.sourceId) && map.has(edge.targetId)).map((edge) => ({ ...clone(edge), id: id("edge"), sourceId: map.get(edge.sourceId), targetId: map.get(edge.targetId) }));
      this.board.nodes.push(...copies); this.board.edges.push(...edges); this.selected = new Set(copies.map((node) => node.id)); this.save(); this.renderCanvas();
    }

    cycleColor() { if (!this.selected.size && !this.selectedEdgeId) return; this.pushHistory(); if (this.selectedEdgeId) { const edge = this.board.edges.find((item) => item.id === this.selectedEdgeId); if (edge) edge.color = COLORS[(COLORS.indexOf(edge.color) + 1) % COLORS.length]; } this.selected.forEach((nodeId) => { const node = this.node(nodeId); if (node) node.color = COLORS[(COLORS.indexOf(node.color) + 1) % COLORS.length]; }); this.save(); this.renderCanvas(); }
    setSelectionColor(color) { color = validColor(color); if (!this.selected.size && !this.selectedEdgeId) return; this.pushHistory(); if (this.selectedEdgeId) { const edge = this.board.edges.find((item) => item.id === this.selectedEdgeId); if (edge) edge.color = color; } this.selected.forEach((nodeId) => { const node = this.node(nodeId); if (node) node.color = color; }); this.save(); this.renderCanvas(); }
    changeLayer(direction) { if (!this.selected.size) return; this.pushHistory(); const target = direction > 0 ? Math.max(0, ...this.board.nodes.map((node) => node.zIndex)) + 1 : Math.min(0, ...this.board.nodes.map((node) => node.zIndex)) - 1; this.selected.forEach((nodeId, index) => { const node = this.node(nodeId); if (node) node.zIndex = target + index * direction; }); this.save(); this.renderNodes(); }

    nodeLabel(node) {
      if (node.type === "text" || node.type === "group") return node.title || node.text || "未命名";
      if (node.type === "note") return this.notes().find((item) => item.id === node.noteId)?.title || "笔记已不存在";
      if (node.type === "task") return this.taskTitle(this.tasks().find((item) => item.id === node.taskId)) || "任务已不存在";
      if (node.type === "link") return node.title || node.url;
      return node.title || "图片";
    }

    renderNodeContent(node) {
      if (node.type === "group") return `<div class="whiteboard-group-title">${esc(node.title || "分组")}</div>`;
      if (node.type === "text") return `<div class="whiteboard-card-kicker whiteboard-drag-strip">文本 · 直接编辑</div><div class="whiteboard-inline-title" contenteditable="true" spellcheck="true" data-whiteboard-inline="title" data-placeholder="标题（可选）">${esc(node.title)}</div><div class="whiteboard-inline-body whiteboard-scrollable" contenteditable="true" spellcheck="true" data-whiteboard-inline="text" data-placeholder="输入内容…">${esc(node.text)}</div>`;
      if (node.type === "note") { const note = this.notes().find((item) => item.id === node.noteId); if (!note) return `<div class="whiteboard-card-missing"><strong>笔记已不存在</strong><span>右键可重新关联或删除</span></div>`; const preview = safeNotePreview(note.content); return `<div class="whiteboard-note-header whiteboard-drag-strip"><div class="whiteboard-card-kicker">笔记 · 双击打开</div><strong>${esc(note.title || "无标题笔记")}</strong></div><div class="whiteboard-note-preview whiteboard-scrollable" data-whiteboard-preview-scroll>${preview || '<span class="whiteboard-preview-empty">暂无正文</span>'}</div><button data-whiteboard-open-note="${attr(note.id)}">打开原笔记 ›</button>`; }
      if (node.type === "task") { const task = this.tasks().find((item) => item.id === node.taskId); if (!task) return `<div class="whiteboard-card-missing"><strong>任务已不存在</strong><span>可以重新关联或删除此卡片</span></div>`; const progress = this.taskProgress(task), due = this.taskDue(task); return `<div class="whiteboard-card-kicker">任务 · ${esc(this.taskStatus(task))}</div><strong>${esc(this.taskTitle(task))}</strong>${due ? `<div class="whiteboard-task-due">截止 ${esc(due.replace("T", " "))}</div>` : ""}<div class="whiteboard-task-progress"><i style="width:${progress}%"></i><span>${progress}%</span></div><button data-whiteboard-open-task="${attr(task.id)}">查看任务 ›</button>`; }
      if (node.type === "image") { const url = this.options.safety.getAttachmentUrl(node.attachmentId); return url ? `<img src="${attr(url)}" alt="${attr(node.title || "白板图片")}"><span>${esc(node.title || "图片")}</span>` : `<div class="whiteboard-card-missing"><strong>图片内容缺失</strong></div>`; }
      if (node.type === "link") { const safe = /^https?:\/\//i.test(node.url || ""); return `<div class="whiteboard-card-kicker">网页链接</div><strong>${esc(node.title || node.url)}</strong><p>${esc(node.url)}</p>${safe ? `<button data-whiteboard-open-link="${attr(node.url)}">新标签页打开 ›</button>` : ""}`; }
      return "";
    }

    nodeMatches(node) { if (!this.search) return false; const note = node.type === "note" ? this.notes().find((item) => item.id === node.noteId) : null, task = node.type === "task" ? this.tasks().find((item) => item.id === node.taskId) : null; const source = note ? `${note.title || ""} ${strip(note.content || "")}` : task ? `${this.taskTitle(task)} ${this.taskStatus(task)} ${this.taskDue(task)}` : `${node.title || ""} ${node.text || ""} ${node.url || ""}`; return String(source || "").toLowerCase().includes(this.search); }

    renderNodes() {
      if (!this.board) return;
      const ordered = this.board.nodes.slice().sort((a, b) => (a.type === "group" ? -1 : 1) - (b.type === "group" ? -1 : 1) || a.zIndex - b.zIndex);
      this.el.nodes.innerHTML = ordered.map((node) => `<article class="whiteboard-node type-${node.type} ${node.type === "group" ? "group" : "card"} ${this.selected.has(node.id) ? "selected" : ""} ${this.nodeMatches(node) ? "search-match" : ""}" data-whiteboard-node="${attr(node.id)}" style="--node-x:${node.x}px;--node-y:${node.y}px;--node-width:${node.width}px;--node-height:${node.height}px;--node-z:${node.zIndex};--node-color:${node.color}">
        <div class="whiteboard-node-content">${this.renderNodeContent(node)}</div>${node.type !== "group" ? `<i class="whiteboard-connect-handle top" data-connect-side="top"></i><i class="whiteboard-connect-handle right" data-connect-side="right"></i><i class="whiteboard-connect-handle bottom" data-connect-side="bottom"></i><i class="whiteboard-connect-handle left" data-connect-side="left"></i>` : ""}<i class="whiteboard-resize-handle" data-whiteboard-resize></i>
      </article>`).join("");
      this.renderSelectionToolbar();
    }

    syncNodeSelectionClasses() { this.el.nodes.querySelectorAll("[data-whiteboard-node]").forEach((element) => element.classList.toggle("selected", this.selected.has(element.dataset.whiteboardNode))); this.renderSelectionToolbar(); }

    anchor(node, side) { if (side === "left") return { x: node.x, y: node.y + node.height / 2 }; if (side === "right") return { x: node.x + node.width, y: node.y + node.height / 2 }; if (side === "top") return { x: node.x + node.width / 2, y: node.y }; return { x: node.x + node.width / 2, y: node.y + node.height }; }
    autoSide(source, target) { const sx = source.x + source.width / 2, sy = source.y + source.height / 2, tx = target.x + target.width / 2, ty = target.y + target.height / 2; return Math.abs(tx - sx) > Math.abs(ty - sy) ? (tx > sx ? "right" : "left") : (ty > sy ? "bottom" : "top"); }
    pathFor(edge) { const source = this.node(edge.sourceId), target = this.node(edge.targetId); if (!source || !target) return ""; const a = this.anchor(source, edge.sourceSide || this.autoSide(source, target)), b = this.anchor(target, edge.targetSide || this.autoSide(target, source)); const curve = Math.max(55, Math.hypot(b.x - a.x, b.y - a.y) * .32); const control = (point, side, amount) => side === "left" ? { x: point.x - amount, y: point.y } : side === "right" ? { x: point.x + amount, y: point.y } : side === "top" ? { x: point.x, y: point.y - amount } : { x: point.x, y: point.y + amount }; const c1 = control(a, edge.sourceSide || this.autoSide(source, target), curve), c2 = control(b, edge.targetSide || this.autoSide(target, source), curve); return `M ${a.x} ${a.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${b.x} ${b.y}`; }

    renderEdges() {
      const markers = this.board.edges.map((edge, index) => `<marker id="whiteboardArrow${index}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${attr(edge.color || COLORS[0])}"></path></marker>`).join("");
      const paths = this.board.edges.map((edge, index) => `<path class="whiteboard-edge-hit" data-whiteboard-edge="${attr(edge.id)}" d="${this.pathFor(edge)}"></path><path class="whiteboard-edge ${edge.id === this.selectedEdgeId ? "selected" : ""}" d="${this.pathFor(edge)}" style="--edge-color:${validColor(edge.color)}" marker-end="url(#whiteboardArrow${index})"></path>`).join("");
      const temp = this.connection ? `<path class="whiteboard-edge temporary" d="${this.connection.path || ""}"></path>` : "";
      this.el.edges.innerHTML = `<defs>${markers}</defs>${paths}${temp}`;
    }

    applyViewport() { const view = this.board.viewport; this.el.stage.style.transform = `translate(${view.x}px,${view.y}px) scale(${view.zoom})`; this.el.canvas.style.setProperty("--board-grid-size", `${GRID * view.zoom}px`); this.el.canvas.style.setProperty("--board-grid-x", `${view.x}px`); this.el.canvas.style.setProperty("--board-grid-y", `${view.y}px`); this.el.canvas.classList.toggle("grid-off", !this.board.gridEnabled); this.el.zoomLabel.textContent = `${Math.round(view.zoom * 100)}%`; if (this.selected.size || this.selectedEdgeId) this.renderSelectionToolbar(); }
    renderBoardSelect() { this.el.select.innerHTML = this.boards.map((board) => `<option value="${attr(board.id)}" ${board.id === this.board.id ? "selected" : ""}>${esc(board.title)}</option>`).join(""); this.el.count.textContent = this.boards.length; }
    renderSelectionToolbar() {
      const visible = this.selected.size || this.selectedEdgeId; this.el.selection.hidden = !visible; if (!visible) return;
      const one = this.selected.size === 1 ? this.node([...this.selected][0]) : null, edit = this.el.selection.querySelector("[data-whiteboard-edit]");
      edit.hidden = !one || one.type === "image"; edit.textContent = one?.type === "text" ? "编辑文字" : ["note", "task"].includes(one?.type) ? "重新关联" : "编辑";
      this.el.selection.querySelector("[data-whiteboard-duplicate]").hidden = !this.selected.size; this.el.selection.querySelectorAll("[data-whiteboard-front],[data-whiteboard-back]").forEach((button) => button.hidden = !this.selected.size);
      if (!this.selected.size) { this.el.selection.style.left = "50%"; this.el.selection.style.top = "14px"; return; }
      const nodes = [...this.selected].map((nodeId) => this.node(nodeId)).filter(Boolean), view = this.board.viewport;
      if (!nodes.length) { this.selected.clear(); this.el.selection.hidden = true; return; }
      const minX = Math.min(...nodes.map((node) => node.x)), minY = Math.min(...nodes.map((node) => node.y)), maxX = Math.max(...nodes.map((node) => node.x + node.width)), maxY = Math.max(...nodes.map((node) => node.y + node.height));
      const width = this.el.selection.offsetWidth || 420, canvasWidth = this.el.canvas.clientWidth, canvasHeight = this.el.canvas.clientHeight;
      const x = clamp((minX + maxX) / 2 * view.zoom + view.x, width / 2 + 8, Math.max(width / 2 + 8, canvasWidth - width / 2 - 8));
      let y = minY * view.zoom + view.y - this.el.selection.offsetHeight - 12; if (y < 8) y = maxY * view.zoom + view.y + 12;
      this.el.selection.style.left = `${x}px`; this.el.selection.style.top = `${clamp(y, 8, Math.max(8, canvasHeight - 54))}px`;
    }
    renderCanvas() { this.renderEdges(); this.renderNodes(); this.applyViewport(); this.el.grid.classList.toggle("active", this.board.gridEnabled); this.el.undo.disabled = !(this.histories.get(this.board.id) || []).length; this.el.redo.disabled = !(this.futures.get(this.board.id) || []).length; }
    render() { if (!this.el.workspace || !this.board) return; this.renderBoardSelect(); this.renderCanvas(); }

    screenPoint(event) { const rect = this.el.canvas.getBoundingClientRect(), view = this.board.viewport; return { x: (event.clientX - rect.left - view.x) / view.zoom, y: (event.clientY - rect.top - view.y) / view.zoom }; }
    snap(value, bypass) { return this.board.gridEnabled && !bypass ? Math.round(value / GRID) * GRID : value; }

    startNodeDrag(event, element) {
      if (event.button !== 0 || event.target.closest("button,input,textarea,select,[contenteditable],[data-whiteboard-preview-scroll],[data-whiteboard-resize],[data-connect-side]")) return;
      const nodeId = element.dataset.whiteboardNode; if (!event.shiftKey && !this.selected.has(nodeId)) this.selected = new Set([nodeId]); else if (event.shiftKey) this.selected.has(nodeId) ? this.selected.delete(nodeId) : this.selected.add(nodeId); this.selectedEdgeId = ""; this.syncNodeSelectionClasses();
      if (!this.selected.has(nodeId)) return;
      const start = this.screenPoint(event), originals = new Map(); this.selected.forEach((idValue) => { const node = this.node(idValue); if (node) originals.set(idValue, { x: node.x, y: node.y }); });
      const dragged = this.node(nodeId); if (dragged?.type === "group") this.board.nodes.filter((node) => node.groupId === dragged.id).forEach((node) => { if (!originals.has(node.id)) originals.set(node.id, { x: node.x, y: node.y }); });
      this.drag = { type: "move", start, originals, bypass: event.altKey, moved: false };
    }

    startResize(event, element) { const node = this.node(element.closest("[data-whiteboard-node]").dataset.whiteboardNode); if (!node) return; this.pushHistory(); this.drag = { type: "resize", nodeId: node.id, start: this.screenPoint(event), width: node.width, height: node.height, bypass: event.altKey }; event.stopPropagation(); event.preventDefault(); }
    startPan(event) { if (event.button !== 0 || event.target !== this.el.canvas) return; this.closeContextMenu(); this.selected.clear(); this.selectedEdgeId = ""; this.renderCanvas(); this.pan = { x: event.clientX, y: event.clientY, vx: this.board.viewport.x, vy: this.board.viewport.y }; event.preventDefault(); }

    movePointer(event) {
      if (this.pan) { this.board.viewport.x = this.pan.vx + event.clientX - this.pan.x; this.board.viewport.y = this.pan.vy + event.clientY - this.pan.y; this.applyViewport(); return; }
      if (this.drag?.type === "move") { const point = this.screenPoint(event), dx = point.x - this.drag.start.x, dy = point.y - this.drag.start.y; if (!this.drag.moved && Math.hypot(dx, dy) < 2) return; if (!this.drag.moved) { this.pushHistory(); this.drag.moved = true; } this.drag.originals.forEach((origin, nodeId) => { const node = this.node(nodeId); if (node) { node.x = this.snap(origin.x + dx, event.altKey); node.y = this.snap(origin.y + dy, event.altKey); } }); this.renderEdges(); this.renderNodes(); event.preventDefault(); return; }
      if (this.drag?.type === "resize") { const point = this.screenPoint(event), node = this.node(this.drag.nodeId); if (node) { node.width = clamp(this.snap(this.drag.width + point.x - this.drag.start.x, event.altKey), 140, 1000); node.height = clamp(this.snap(this.drag.height + point.y - this.drag.start.y, event.altKey), 80, 800); this.renderEdges(); this.renderNodes(); } return; }
      if (this.connection) { const point = this.screenPoint(event), source = this.node(this.connection.sourceId), a = this.anchor(source, this.connection.sourceSide); this.connection.path = `M ${a.x} ${a.y} L ${point.x} ${point.y}`; this.renderEdges(); }
    }

    endPointer(event) {
      if (this.pan) { this.pan = null; this.save(); }
      if (this.drag) { const changed = this.drag.type !== "move" || this.drag.moved; if (this.drag.type === "move" && this.drag.moved) this.updateGroups(); this.drag = null; if (changed) { this.board.updatedAt = now(); this.save(); this.renderCanvas(); } }
      if (this.connection) { const targetElement = document.elementFromPoint(event.clientX, event.clientY)?.closest?.("[data-whiteboard-node]"), target = targetElement && this.node(targetElement.dataset.whiteboardNode), source = this.node(this.connection.sourceId); if (target && source && target.id !== source.id && target.type !== "group" && !this.board.edges.some((edge) => edge.sourceId === source.id && edge.targetId === target.id)) { this.pushHistory(); this.board.edges.push({ id: id("edge"), sourceId: source.id, targetId: target.id, sourceSide: this.connection.sourceSide, targetSide: this.autoSide(target, source), color: source.color || COLORS[0] }); this.save(); } this.connection = null; this.renderCanvas(); }
    }

    updateGroups() { const groups = this.board.nodes.filter((node) => node.type === "group").sort((a, b) => b.zIndex - a.zIndex); this.board.nodes.filter((node) => node.type !== "group").forEach((node) => { const cx = node.x + node.width / 2, cy = node.y + node.height / 2, group = groups.find((item) => cx >= item.x && cx <= item.x + item.width && cy >= item.y && cy <= item.y + item.height); node.groupId = group?.id || ""; }); }

    startConnection(event, handle) { const node = this.node(handle.closest("[data-whiteboard-node]").dataset.whiteboardNode); if (!node) return; this.connection = { sourceId: node.id, sourceSide: handle.dataset.connectSide, path: "" }; this.movePointer(event); event.stopPropagation(); event.preventDefault(); }
    zoomAt(nextZoom, clientX, clientY) { const view = this.board.viewport, rect = this.el.canvas.getBoundingClientRect(), old = view.zoom, zoom = clamp(nextZoom, .25, 2.5), px = clientX - rect.left, py = clientY - rect.top, wx = (px - view.x) / old, wy = (py - view.y) / old; view.zoom = zoom; view.x = px - wx * zoom; view.y = py - wy * zoom; this.applyViewport(); this.save(); }
    fitContent() { if (!this.board.nodes.length) return this.resetViewport(); const rect = this.el.canvas.getBoundingClientRect(), minX = Math.min(...this.board.nodes.map((node) => node.x)), minY = Math.min(...this.board.nodes.map((node) => node.y)), maxX = Math.max(...this.board.nodes.map((node) => node.x + node.width)), maxY = Math.max(...this.board.nodes.map((node) => node.y + node.height)), zoom = clamp(Math.min((rect.width - 100) / (maxX - minX), (rect.height - 100) / (maxY - minY)), .25, 1.5); this.board.viewport = { zoom, x: (rect.width - (maxX - minX) * zoom) / 2 - minX * zoom, y: (rect.height - (maxY - minY) * zoom) / 2 - minY * zoom }; this.applyViewport(); this.save(); }
    resetViewport() { this.board.viewport = { x: 0, y: 0, zoom: 1 }; this.applyViewport(); this.save(); }
    focusNode(node) { if (!node) return; const rect = this.el.canvas.getBoundingClientRect(), view = this.board.viewport; view.x = rect.width / 2 - (node.x + node.width / 2) * view.zoom; view.y = rect.height / 2 - (node.y + node.height / 2) * view.zoom; this.selected = new Set([node.id]); this.applyViewport(); this.renderNodes(); }
    focusSearchResult() { if (!this.search) return; const match = this.board.nodes.find((node) => this.nodeMatches(node)); if (match) this.focusNode(match); }

    focusInlineText(nodeId, field = "text") {
      const node = this.node(nodeId); if (!node || node.type !== "text") return;
      this.selected = new Set([nodeId]); this.selectedEdgeId = "";
      const card = [...this.el.nodes.querySelectorAll("[data-whiteboard-node]")].find((element) => element.dataset.whiteboardNode === nodeId), editor = card?.querySelector(`[data-whiteboard-inline="${field}"]`) || card?.querySelector('[data-whiteboard-inline="text"]');
      if (!editor) return; this.syncNodeSelectionClasses(); card.classList.add("inline-editing"); editor.focus();
      const selection = window.getSelection(), range = document.createRange(); range.selectNodeContents(editor); range.collapse(false); selection.removeAllRanges(); selection.addRange(range);
    }

    beginInlineEdit(editor) {
      const card = editor.closest("[data-whiteboard-node]"), node = card && this.node(card.dataset.whiteboardNode); if (!node || node.type !== "text") return;
      if (this.inlineEditingNodeId !== node.id) { this.inlineEditingNodeId = node.id; this.pushHistory(); }
      this.selected = new Set([node.id]); this.selectedEdgeId = ""; this.syncNodeSelectionClasses(); card.classList.add("inline-editing");
    }

    updateInlineEdit(editor) {
      const node = this.node(editor.closest("[data-whiteboard-node]")?.dataset.whiteboardNode); if (!node) return;
      const value = (editor.innerText || "").replace(/\r/g, ""); if (editor.dataset.whiteboardInline === "title") node.title = value.slice(0, 120); else node.text = value;
      this.board.updatedAt = now(); this.save();
    }

    finishInlineEdit(editor) {
      const card = editor.closest("[data-whiteboard-node]"), node = card && this.node(card.dataset.whiteboardNode); if (!node) return;
      requestAnimationFrame(() => {
        if (card.contains(document.activeElement)) return;
        node.title = String(node.title || "").trim().slice(0, 120); node.text = String(node.text || "").replace(/\n{3,}/g, "\n\n").trim();
        const titleEditor = card.querySelector('[data-whiteboard-inline="title"]'), textEditor = card.querySelector('[data-whiteboard-inline="text"]'); if (titleEditor && !node.title) titleEditor.textContent = ""; if (textEditor && !node.text) textEditor.textContent = "";
        this.inlineEditingNodeId = ""; card.classList.remove("inline-editing"); this.save();
      });
    }

    openNodeSource(node) {
      if (!node) return;
      if (node.type === "note" && this.notes().some((item) => item.id === node.noteId)) this.options.openNote(node.noteId);
      else if (node.type === "task" && this.tasks().some((item) => item.id === node.taskId)) this.options.openTask(node.taskId);
      else if (node.type === "link" && /^https?:\/\//i.test(node.url || "")) window.open(node.url, "_blank", "noopener,noreferrer");
    }

    contextButton(action, label, options = {}) { return `<button type="button" role="menuitem" data-whiteboard-context="${action}" ${options.disabled ? "disabled" : ""} class="${options.danger ? "danger" : ""}">${options.icon ? `<span>${options.icon}</span>` : ""}${label}${options.hint ? `<kbd>${options.hint}</kbd>` : ""}</button>`; }
    closeContextMenu() { if (this.contextMenu) this.contextMenu.hidden = true; this.contextPoint = null; }

    showContextMenu(event) {
      if (!this.active || event.target.closest("[contenteditable]")) return;
      event.preventDefault(); event.stopImmediatePropagation(); this.closeContextMenu(); this.contextPoint = this.screenPoint(event);
      const nodeElement = event.target.closest("[data-whiteboard-node]"), edgeElement = event.target.closest("[data-whiteboard-edge]"); let html = "";
      if (nodeElement) {
        const nodeId = nodeElement.dataset.whiteboardNode; if (!this.selected.has(nodeId)) this.selected = new Set([nodeId]); this.selectedEdgeId = ""; this.renderNodes();
        const node = this.node(nodeId), multiple = this.selected.size > 1;
        html += `<div class="whiteboard-context-title">${multiple ? `已选 ${this.selected.size} 张卡片` : esc(this.nodeLabel(node))}</div>`;
        if (!multiple && node?.type === "text") html += this.contextButton("edit", "直接编辑文字", { icon: "✎" });
        if (!multiple && node?.type === "note") html += this.contextButton("open", "查看原笔记", { icon: "↗", disabled: !this.notes().some((item) => item.id === node.noteId) }) + this.contextButton("edit", "重新关联笔记", { icon: "↻" });
        if (!multiple && node?.type === "task") html += this.contextButton("open", "查看任务详情", { icon: "↗", disabled: !this.tasks().some((item) => item.id === node.taskId) }) + this.contextButton("edit", "重新关联任务", { icon: "↻" });
        if (!multiple && node?.type === "link") html += this.contextButton("open", "打开网页", { icon: "↗" }) + this.contextButton("edit", "编辑链接", { icon: "✎" });
        if (!multiple && node?.type === "group") html += this.contextButton("edit", "重命名分组", { icon: "✎" });
        if (!multiple && node?.type === "image") html += this.contextButton("replace-image", "替换图片", { icon: "图" });
        html += `<hr>${this.contextButton("duplicate", multiple ? "复制所选卡片" : "复制卡片", { icon: "⧉", hint: "Ctrl+D" })}<div class="whiteboard-context-colors"><span>颜色</span>${COLORS.map((color) => `<button type="button" data-whiteboard-context="set-color" data-color="${color}" style="--swatch:${color}" aria-label="设置颜色"></button>`).join("")}</div>${this.contextButton("front", "置于顶层", { icon: "↑" })}${this.contextButton("back", "置于底层", { icon: "↓" })}<hr>${this.contextButton("delete", multiple ? "删除所选卡片" : "删除卡片", { icon: "×", danger: true, hint: "Delete" })}`;
      } else if (edgeElement) {
        this.selected.clear(); this.selectedEdgeId = edgeElement.dataset.whiteboardEdge; this.renderCanvas();
        html = `<div class="whiteboard-context-title">连线</div><div class="whiteboard-context-colors"><span>颜色</span>${COLORS.map((color) => `<button type="button" data-whiteboard-context="set-color" data-color="${color}" style="--swatch:${color}" aria-label="设置颜色"></button>`).join("")}</div><hr>${this.contextButton("delete", "删除连线", { icon: "×", danger: true, hint: "Delete" })}`;
      } else {
        this.selected.clear(); this.selectedEdgeId = ""; this.renderCanvas();
        html = `<div class="whiteboard-context-title">在这里添加</div>${this.contextButton("add-text", "文本卡片", { icon: "文", hint: "Ctrl+N" })}${this.contextButton("add-note", "现有笔记", { icon: "记" })}${this.contextButton("add-task", "现有任务", { icon: "任" })}${this.contextButton("add-image", "图片", { icon: "图" })}${this.contextButton("add-link", "网页链接", { icon: "链" })}${this.contextButton("add-group", "分组", { icon: "组" })}<hr>${this.contextButton("fit", "适应全部内容", { icon: "⊙" })}${this.contextButton("reset", "重置视图", { icon: "⌂" })}`;
      }
      this.contextMenu.innerHTML = html; this.contextMenu.hidden = false;
      const width = this.contextMenu.offsetWidth, height = this.contextMenu.offsetHeight; this.contextMenu.style.left = `${clamp(event.clientX, 8, Math.max(8, innerWidth - width - 8))}px`; this.contextMenu.style.top = `${clamp(event.clientY, 8, Math.max(8, innerHeight - height - 8))}px`;
    }

    runContextAction(action, button) {
      const point = this.contextPoint; this.closeContextMenu();
      if (action.startsWith("add-")) return this.handleAddAction(action.slice(4), point);
      if (action === "edit") return this.editSelected(); if (action === "open") return this.openNodeSource(this.node([...this.selected][0]));
      if (action === "replace-image") { this.replacingImageNodeId = [...this.selected][0] || ""; this.el.imageInput.click(); return; }
      if (action === "duplicate") return this.duplicateSelection(); if (action === "set-color") return this.setSelectionColor(button.dataset.color);
      if (action === "front") return this.changeLayer(1); if (action === "back") return this.changeLayer(-1); if (action === "delete") return this.deleteSelection();
      if (action === "fit") return this.fitContent(); if (action === "reset") return this.resetViewport();
    }

    openDialog(mode, node = null, point = null) {
      this.dialogMode = mode; this.editingNodeId = node?.id || ""; this.pendingPoint = point; this.dialogError.hidden = true; this.dialogTitle.textContent = `${node ? "编辑" : "添加"}${({ text: "文本", note: "笔记", task: "任务", link: "网页链接", group: "分组" })[mode] || "卡片"}`;
      if (mode === "text") this.dialogBody.innerHTML = `<label><span>标题</span><input name="title" maxlength="120" value="${attr(node?.title || "")}" placeholder="可选标题"></label><label><span>内容</span><textarea name="text" rows="7" required>${esc(node?.text || "")}</textarea></label>`;
      if (mode === "group") this.dialogBody.innerHTML = `<label><span>分组名称</span><input name="title" maxlength="120" required value="${attr(node?.title || "新分组")}"></label>`;
      if (mode === "link") this.dialogBody.innerHTML = `<label><span>标题</span><input name="title" maxlength="120" value="${attr(node?.title || "")}" placeholder="可选，默认使用网址"></label><label><span>网址</span><input name="url" type="url" required value="${attr(node?.url || "https://")}"></label>`;
      if (mode === "note") this.dialogBody.innerHTML = `<label><span>选择笔记</span><select name="refId" required><option value="">请选择</option>${this.notes().filter((note) => !note.deletedAt).map((note) => `<option value="${note.id}" ${node?.noteId === note.id ? "selected" : ""}>${esc(note.title || "无标题笔记")}</option>`).join("")}</select></label>`;
      if (mode === "task") this.dialogBody.innerHTML = `<label><span>选择任务</span><select name="refId" required><option value="">请选择</option>${this.tasks().map((task) => `<option value="${task.id}" ${node?.taskId === task.id ? "selected" : ""}>${esc(this.taskTitle(task))}</option>`).join("")}</select></label>`;
      this.dialogBackdrop.hidden = false; requestAnimationFrame(() => this.dialog.querySelector("input,textarea,select")?.focus());
    }

    submitDialog() {
      const data = new FormData(this.dialog), node = this.node(this.editingNodeId), mode = this.dialogMode;
      if (mode === "link" && !/^https?:\/\//i.test(String(data.get("url") || ""))) { this.dialogError.textContent = "网址必须以 http:// 或 https:// 开头"; this.dialogError.hidden = false; return; }
      if (node) { this.pushHistory(); node.title = String(data.get("title") || "").trim(); node.text = String(data.get("text") || "").trim(); if (mode === "link") node.url = String(data.get("url") || "").trim(); if (mode === "note") node.noteId = String(data.get("refId") || ""); if (mode === "task") node.taskId = String(data.get("refId") || ""); this.save(); this.renderCanvas(); }
      else if (mode === "text") this.createNode("text", { title: String(data.get("title") || "").trim(), text: String(data.get("text") || "").trim() });
      else if (mode === "group") this.createNode("group", { title: String(data.get("title") || "新分组").trim() });
      else if (mode === "link") this.createNode("link", { title: String(data.get("title") || "").trim(), url: String(data.get("url") || "").trim() });
      else if (mode === "note") this.createNode("note", { noteId: String(data.get("refId") || "") });
      else if (mode === "task") this.createNode("task", { taskId: String(data.get("refId") || "") });
      this.closeDialog();
    }

    editSelected() { if (this.selected.size !== 1) return; const node = this.node([...this.selected][0]); if (!node) return; if (node.type === "text") return this.focusInlineText(node.id, node.title ? "text" : "title"); if (["note", "task", "link", "group"].includes(node.type)) this.openDialog(node.type, node); }
    closeDialog() { if (this.dialogBackdrop) this.dialogBackdrop.hidden = true; this.dialogMode = ""; this.editingNodeId = ""; this.pendingPoint = null; }

    async addImages(files, point = null) { const images = [...files].filter((file) => file.type.startsWith("image/")); if (!images.length) return this.options.toast("白板目前只支持图片文件"); for (const file of images) { if (file.size > 12 * 1024 * 1024) { this.options.toast(`图片“${file.name}”超过 12MB`); continue; } const attachment = await this.options.safety.putAttachment(file, { name: file.name, type: file.type }); this.createNode("image", { attachmentId: attachment.id, title: file.name, point: point || this.nextPoint() }); point = point ? { x: point.x + 30, y: point.y + 30 } : null; } await this.save(true, "manual"); }
    async replaceImage(file) { const node = this.node(this.replacingImageNodeId); this.replacingImageNodeId = ""; if (!node || node.type !== "image" || !file?.type?.startsWith("image/")) return; if (file.size > 12 * 1024 * 1024) return this.options.toast(`图片“${file.name}”超过 12MB`); const attachment = await this.options.safety.putAttachment(file, { name: file.name, type: file.type }); this.pushHistory(); node.attachmentId = attachment.id; node.title = file.name; await this.save(true, "manual"); this.renderCanvas(); this.options.toast("图片已替换"); }

    save(immediate = false, reason = "auto") { this.board.updatedAt = now(); return this.options.persist(immediate, reason); }
    flush(reason = "manual") { return this.options.persist(true, reason); }

    handleAddAction(action, point = null) { this.el.addMenu.hidden = true; if (action === "text") return this.createNode("text", { point }); if (action === "image") { this.replacingImageNodeId = ""; this.pendingPoint = point; return this.el.imageInput.click(); } if (["note", "task", "link", "group"].includes(action)) this.openDialog(action, null, point); }

    bind() {
      this.el.select.addEventListener("change", () => this.openBoard(this.el.select.value));
      this.el.newBoard.addEventListener("click", () => this.createBoard(`白板 ${this.boards.length + 1}`));
      this.el.rename.addEventListener("click", () => { const title = prompt("白板名称", this.board.title); if (title?.trim()) { this.board.title = title.trim(); this.save(true, "manual"); this.renderBoardSelect(); } });
      this.el.remove.addEventListener("click", () => this.deleteBoard()); this.el.undo.addEventListener("click", () => this.undo()); this.el.redo.addEventListener("click", () => this.redo());
      this.el.grid.addEventListener("click", () => { this.board.gridEnabled = !this.board.gridEnabled; this.save(); this.renderCanvas(); });
      this.el.zoomIn.addEventListener("click", () => { const rect = this.el.canvas.getBoundingClientRect(); this.zoomAt(this.board.viewport.zoom * 1.2, rect.left + rect.width / 2, rect.top + rect.height / 2); });
      this.el.zoomOut.addEventListener("click", () => { const rect = this.el.canvas.getBoundingClientRect(); this.zoomAt(this.board.viewport.zoom / 1.2, rect.left + rect.width / 2, rect.top + rect.height / 2); }); this.el.fit.addEventListener("click", () => this.fitContent()); this.el.reset.addEventListener("click", () => this.resetViewport());
      this.el.canvas.addEventListener("wheel", (event) => { if (event.target.closest(".whiteboard-scrollable")) return; event.preventDefault(); this.zoomAt(this.board.viewport.zoom * (event.deltaY > 0 ? .9 : 1.1), event.clientX, event.clientY); }, { passive: false });
      this.el.canvas.addEventListener("pointerdown", (event) => { this.closeContextMenu(); const handle = event.target.closest("[data-connect-side]"); if (handle) return this.startConnection(event, handle); const resize = event.target.closest("[data-whiteboard-resize]"); if (resize) return this.startResize(event, resize); const node = event.target.closest("[data-whiteboard-node]"); if (node) return this.startNodeDrag(event, node); const edge = event.target.closest("[data-whiteboard-edge]"); if (edge) { this.selected.clear(); this.selectedEdgeId = edge.dataset.whiteboardEdge; this.renderCanvas(); return; } this.startPan(event); });
      window.addEventListener("pointermove", (event) => this.movePointer(event)); window.addEventListener("pointerup", (event) => this.endPointer(event));
      this.el.canvas.addEventListener("dblclick", (event) => { const element = event.target.closest("[data-whiteboard-node]"), node = element && this.node(element.dataset.whiteboardNode); if (node) { this.selected = new Set([node.id]); if (node.type === "text") return this.focusInlineText(node.id, event.target.dataset.whiteboardInline || "text"); if (["note", "task", "link"].includes(node.type)) return this.openNodeSource(node); return this.editSelected(); } if (event.target === this.el.canvas) this.createNode("text", { point: this.screenPoint(event) }); });
      this.el.nodes.addEventListener("click", (event) => { const note = event.target.closest("[data-whiteboard-open-note]"); if (note) return this.options.openNote(note.dataset.whiteboardOpenNote); const task = event.target.closest("[data-whiteboard-open-task]"); if (task) return this.options.openTask(task.dataset.whiteboardOpenTask); const previewLink = event.target.closest("[data-whiteboard-preview-link]"), link = event.target.closest("[data-whiteboard-open-link]"), url = previewLink?.dataset.whiteboardPreviewLink || link?.dataset.whiteboardOpenLink; if (url && /^https?:\/\//i.test(url)) return window.open(url, "_blank", "noopener,noreferrer"); });
      this.el.nodes.addEventListener("focusin", (event) => { const editor = event.target.closest("[data-whiteboard-inline]"); if (editor) this.beginInlineEdit(editor); });
      this.el.nodes.addEventListener("input", (event) => { const editor = event.target.closest("[data-whiteboard-inline]"); if (editor) this.updateInlineEdit(editor); });
      this.el.nodes.addEventListener("focusout", (event) => { const editor = event.target.closest("[data-whiteboard-inline]"); if (editor) this.finishInlineEdit(editor); });
      this.el.nodes.addEventListener("keydown", (event) => { const editor = event.target.closest("[data-whiteboard-inline]"); if (!editor) return; if (event.key === "Escape") { event.preventDefault(); editor.blur(); } else if (editor.dataset.whiteboardInline === "title" && event.key === "Enter") { event.preventDefault(); editor.closest("[data-whiteboard-node]").querySelector('[data-whiteboard-inline="text"]').focus(); } else if (editor.dataset.whiteboardInline === "text" && (event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); editor.blur(); } });
      this.el.selection.addEventListener("click", (event) => { if (event.target.closest("[data-whiteboard-edit]")) this.editSelected(); else if (event.target.closest("[data-whiteboard-duplicate]")) this.duplicateSelection(); else if (event.target.closest("[data-whiteboard-color]")) this.cycleColor(); else if (event.target.closest("[data-whiteboard-front]")) this.changeLayer(1); else if (event.target.closest("[data-whiteboard-back]")) this.changeLayer(-1); else if (event.target.closest("[data-whiteboard-remove]")) this.deleteSelection(); });
      document.querySelector("#whiteboardAddToolbar").addEventListener("click", (event) => { const action = event.target.closest("[data-whiteboard-add]"); if (action) this.handleAddAction(action.dataset.whiteboardAdd); });
      this.el.canvas.addEventListener("contextmenu", (event) => this.showContextMenu(event));
      this.contextMenu.addEventListener("click", (event) => { const button = event.target.closest("[data-whiteboard-context]"); if (button && !button.disabled) this.runContextAction(button.dataset.whiteboardContext, button); });
      this.el.imageInput.addEventListener("change", () => { if (this.el.imageInput.files.length) this.replacingImageNodeId ? this.replaceImage(this.el.imageInput.files[0]) : this.addImages(this.el.imageInput.files, this.pendingPoint); this.el.imageInput.value = ""; this.pendingPoint = null; });
      this.el.canvas.addEventListener("dragover", (event) => { if ([...event.dataTransfer.items].some((item) => item.type.startsWith("image/"))) event.preventDefault(); }); this.el.canvas.addEventListener("drop", (event) => { const images = [...event.dataTransfer.files].filter((file) => file.type.startsWith("image/")); if (images.length) { event.preventDefault(); this.addImages(images, this.screenPoint(event)); } });
      document.addEventListener("paste", (event) => { if (!this.active || !this.dialogBackdrop.hidden || event.target.isContentEditable) return; const images = [...event.clipboardData.items].filter((item) => item.type.startsWith("image/")) .map((item) => item.getAsFile()).filter(Boolean); if (images.length) { event.preventDefault(); this.addImages(images); } });
      this.dialog.addEventListener("submit", (event) => { event.preventDefault(); this.submitDialog(); }); this.dialog.querySelectorAll("[data-whiteboard-dialog-close]").forEach((button) => button.addEventListener("click", () => this.closeDialog())); this.dialogBackdrop.addEventListener("mousedown", (event) => { if (event.target === this.dialogBackdrop) this.closeDialog(); });
      document.addEventListener("pointerdown", (event) => { if (!event.target.closest("#whiteboardContextMenu")) this.closeContextMenu(); });
      document.addEventListener("keydown", (event) => { if (!this.active || !this.dialogBackdrop.hidden || /input|textarea|select/i.test(event.target.tagName) || event.target.isContentEditable) return; if (event.key === "Escape") this.closeContextMenu(); if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "d" && this.selected.size) { event.preventDefault(); this.duplicateSelection(); } if ((event.key === "Delete" || event.key === "Backspace") && (this.selected.size || this.selectedEdgeId)) { event.preventDefault(); this.deleteSelection(); } });
    }
  }

  window.EasyNoteWhiteboardManager = WhiteboardManager;
})();
