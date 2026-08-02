// @ts-nocheck -- preserved behavior while this workspace is progressively componentized.
"use strict";

  const TYPE_LABELS = {
    text: "文本", singleSelect: "单选", multiSelect: "多选", number: "数字", date: "日期",
    checkbox: "复选框", link: "链接", attachment: "附件", noteLink: "关联笔记"
  };
  const COLORS = ["#5b8def", "#22a06b", "#f59e0b", "#e5484d", "#8b5cf6", "#0ea5a4", "#64748b"];
  const DEFAULT_PROGRESS_COLORS = ["#94a3b8", "#4f7df3", "#f59e0b", "#22a06b"];
  const DEFAULT_PROGRESS_THRESHOLDS = [25, 60, 100];
  const now = () => new Date().toISOString();
  const id = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const esc = (value) => { const node = document.createElement("div"); node.textContent = value ?? ""; return node.innerHTML; };
  const attr = (value) => esc(value).replace(/"/g, "&quot;");
  const clone = (value) => structuredClone(value);

  function defaultTaskData() {
    const stamp = now();
    const option = (key, label, color, extra = {}) => ({ id: key, label, color, order: 0, ...extra });
    return {
      fields: [
        { id: "task-title", name: "任务名称", type: "text", systemRole: "title", required: true, width: 260, config: { multiline: false }, options: [], order: 0 },
        { id: "task-status", name: "状态", type: "singleSelect", systemRole: "status", required: true, width: 130, config: { defaultDoneOptionId: "status-done" }, options: [option("status-todo", "待开始", "#64748b"), option("status-doing", "进行中", "#3976f6"), option("status-done", "已完成", "#22a06b", { isDone: true })], order: 1 },
        { id: "task-progress", name: "进度", type: "number", systemRole: "progress", required: false, width: 170, config: { format: "percent", min: 0, max: 100, step: 5, progressColors: DEFAULT_PROGRESS_COLORS, progressThresholds: DEFAULT_PROGRESS_THRESHOLDS }, options: [], order: 2 },
        { id: "task-priority", name: "优先级", type: "singleSelect", systemRole: "", required: false, width: 120, config: {}, options: [option("priority-low", "低", "#64748b"), option("priority-normal", "普通", "#3976f6"), option("priority-high", "重要", "#f59e0b"), option("priority-urgent", "紧急", "#e5484d")], order: 3 },
        { id: "task-category", name: "分类", type: "singleSelect", systemRole: "", required: false, width: 140, config: {}, options: [], order: 4 },
        { id: "task-start", name: "开始日期", type: "date", systemRole: "", required: false, width: 145, config: { includeTime: false }, options: [], order: 5 },
        { id: "task-due", name: "截止日期", type: "date", systemRole: "", required: false, width: 145, config: { includeTime: false }, options: [], order: 6 },
        { id: "task-description", name: "任务描述", type: "text", systemRole: "", required: false, width: 260, config: { multiline: true }, options: [], order: 7 },
        { id: "task-note", name: "关联笔记", type: "noteLink", systemRole: "", required: false, width: 180, config: {}, options: [], order: 8 }
      ].map((field) => ({ ...field, hidden: false, description: "", createdAt: stamp, updatedAt: stamp })),
      view: { id: "main", tableGroupFieldId: "task-category", boardGroupFieldId: "task-status", filters: [], sorts: [], cardFieldIds: ["task-progress", "task-priority", "task-due"], collapsedGroups: [] }
    };
  }

  class TaskManager {
    constructor(options) {
      this.options = options;
      this.state = options.state;
      this.safety = options.safety;
      this.active = false;
      this.viewMode = "table";
      this.search = "";
      this.openTaskId = null;
      this.uploadTarget = null;
      this.dragTaskId = null;
      this.tableDrop = null;
      this.draft = null;
      this.progressSaveTimer = null;
      this.columnResize = null;
      this.ensureState();
      this.cacheElements();
      this.installDialogs();
      this.bind();
      this.render();
    }

    ensureState() {
      const defaults = defaultTaskData();
      this.state.tasks = Array.isArray(this.state.tasks) ? this.state.tasks : [];
      this.state.taskFields = Array.isArray(this.state.taskFields) && this.state.taskFields.length ? this.state.taskFields : defaults.fields;
      this.state.taskViews = Array.isArray(this.state.taskViews) && this.state.taskViews.length ? this.state.taskViews : [defaults.view];
      this.state.tasks.forEach((task, index) => {
        task.values = task.values && typeof task.values === "object" ? task.values : {};
        task.sortOrder = Number.isFinite(task.sortOrder) ? task.sortOrder : index;
        task.createdAt ||= now(); task.updatedAt ||= task.createdAt; task.completedAt ||= null;
      });
      this.state.taskFields.forEach((field) => {
        field.config = field.config && typeof field.config === "object" ? field.config : {};
        if (field.type === "number" && field.config.format === "percent") {
          field.config.min = Number.isFinite(Number(field.config.min)) ? Number(field.config.min) : 0;
          field.config.max = Number.isFinite(Number(field.config.max)) ? Number(field.config.max) : 100;
          field.config.step = Number(field.config.step) > 0 ? Number(field.config.step) : 1;
          const rawColors = Array.isArray(field.config.progressColors) && field.config.progressColors.length === 4 ? field.config.progressColors : DEFAULT_PROGRESS_COLORS;
          field.config.progressColors = rawColors.map((color, index) => /^#[0-9a-f]{6}$/i.test(color) ? color : DEFAULT_PROGRESS_COLORS[index]);
          const rawThresholds = Array.isArray(field.config.progressThresholds) && field.config.progressThresholds.length === 3 ? field.config.progressThresholds.map(Number) : [...DEFAULT_PROGRESS_THRESHOLDS];
          const low = Math.min(98, Math.max(1, rawThresholds[0] || 25)), middle = Math.min(99, Math.max(low + 1, rawThresholds[1] || 60)), done = Math.min(100, Math.max(middle + 1, rawThresholds[2] || 100));
          field.config.progressThresholds = [low, middle, done];
        }
      });
    }

    cacheElements() {
      const q = (selector) => document.querySelector(selector);
      this.el = {
        nav: q("#taskNavButton"), count: q("#taskCount"), workspace: q("#taskWorkspace"), table: q("#taskTable"), tableWrap: q("#taskTableWrap"),
        board: q("#taskBoard"), empty: q("#taskEmpty"), add: q("#taskAddButton"), fields: q("#taskFieldsButton"),
        filter: q("#taskFilterButton"), sort: q("#taskSortButton"), cards: q("#taskCardSettingsButton"), group: q("#taskGroupSelect"),
        rules: q("#taskActiveRules"), result: q("#taskResultCount"), attachment: q("#taskAttachmentInput"), newTop: q("#newNoteTop"),
        search: q("#searchInput"), panelSwitcher: q("#panelSwitcher"), layoutButton: q("#layoutButton")
      };
    }

    installDialogs() {
      const root = document.createElement("div");
      root.innerHTML = `<div class="task-modal-backdrop" id="taskModalBackdrop" hidden><section class="task-modal" id="taskModal" role="dialog" aria-modal="true"></section></div>
        <aside class="task-detail-drawer" id="taskDetailDrawer" hidden><header><div><span>任务详情</span><strong id="taskDetailTitle">任务</strong></div><button data-task-drawer-close aria-label="关闭">×</button></header><div class="task-detail-scroll" id="taskDetailBody"></div><footer><button class="danger-button" data-task-delete>删除任务</button><div><button class="secondary-button" data-task-schedule>安排到日程</button><button class="secondary-button" data-task-drawer-close>关闭</button></div></footer></aside>`;
      document.body.append(...root.children);
      this.modalBackdrop = document.querySelector("#taskModalBackdrop");
      this.modal = document.querySelector("#taskModal");
      this.drawer = document.querySelector("#taskDetailDrawer");
      this.drawerBody = document.querySelector("#taskDetailBody");
    }

    get fields() { return this.state.taskFields.sort((a, b) => (a.order || 0) - (b.order || 0)); }
    get view() { return this.state.taskViews[0]; }
    field(idValue) { return this.state.taskFields.find((field) => field.id === idValue); }
    task(idValue) { return this.state.tasks.find((task) => task.id === idValue) || (this.draft?.id === idValue ? this.draft : null); }
    role(name) { return this.state.taskFields.find((field) => field.systemRole === name); }
    titleOf(task) { return String(task?.values?.[this.role("title")?.id] || "未命名任务"); }
    option(field, optionId) { return field?.options?.find((option) => option.id === optionId); }

    enter() {
      if (this.active) return;
      this.options.onEnter?.();
      this.active = true;
      document.body.classList.add("task-mode");
      this.el.workspace.hidden = false;
      this.el.nav.classList.add("active");
      this.el.newTop.innerHTML = "<span>＋</span> 新建任务";
      this.el.search.placeholder = "搜索任务名称、选项或链接…";
      this.search = ""; this.el.search.value = "";
      this.el.panelSwitcher.hidden = true; this.el.layoutButton.hidden = true;
      this.render();
      document.querySelector("#sidebar")?.classList.remove("open");
      document.querySelector("#sidebarScrim")?.classList.remove("open");
    }

    leave() {
      if (!this.active) return;
      this.active = false;
      document.body.classList.remove("task-mode");
      this.el.workspace.hidden = true;
      this.el.nav.classList.remove("active");
      this.el.newTop.innerHTML = "<span>＋</span> 新建笔记";
      this.el.search.placeholder = "搜索标题、正文或标签…";
      this.el.panelSwitcher.hidden = false; this.el.layoutButton.hidden = false;
      this.cancelDraft(false);
      this.closeDrawer();
    }

    setSearch(value) { this.search = String(value || "").trim().toLowerCase(); if (this.active) this.render(); }
    setState(nextState) { this.state = nextState; this.ensureState(); this.render(); }
    async flush(reason = "manual") {
      if (!this.active) return true;
      const focused = document.activeElement;
      if (focused?.matches?.("[data-draft-title]")) focused.value.trim() ? this.finishDraftInput(focused) : this.cancelDraft();
      else if (this.draft) this.cancelDraft();
      if (focused?.matches?.("[data-progress-task]")) this.handleProgressInput(focused, true);
      else if (focused?.closest?.("#taskDetailDrawer") && focused.matches("[data-detail-input]")) this.commitDrawerInput(focused);
      else if (focused?.closest?.("#taskWorkspace") && focused.matches(".task-cell-editor input,.task-cell-editor textarea,.task-cell-editor select")) focused.blur();
      return this.options.persist(true, reason);
    }
    save(immediate = false, reason = "auto") { this.options.persist(immediate, reason); }
    toast(message) { this.options.toast(message); }

    nextSortOrder() {
      return this.state.tasks.reduce((maximum, task) => Math.max(maximum, Number.isFinite(task.sortOrder) ? task.sortOrder : -1), -1) + 1;
    }

    createTask(initial = {}) {
      this.cancelDraft(false);
      const values = { ...initial }, groupFieldId = this.viewMode === "board" ? this.view.boardGroupFieldId : this.view.tableGroupFieldId;
      if (this.viewMode === "board" && groupFieldId && values[groupFieldId] == null) {
        const groupField = this.field(groupFieldId);
        values[groupFieldId] = groupField?.systemRole === "status" ? groupField.options?.find((option) => !option.isDone)?.id || "" : "";
      }
      if (this.viewMode === "table") { const groupId = groupFieldId && values[groupFieldId] ? values[groupFieldId] : groupFieldId ? "unset" : "all"; this.view.collapsedGroups = (this.view.collapsedGroups || []).filter((entry) => entry !== groupId); }
      this.draft = { id: id("task"), values, sortOrder: this.nextSortOrder(), createdAt: now(), updatedAt: now(), completedAt: null, previousIncompleteProgress: 0, _draft: true };
      this.render();
      requestAnimationFrame(() => document.querySelector(`[data-draft-title="${this.draft?.id || ""}"]`)?.focus());
      return this.draft;
    }

    materializeDraft(render = false) {
      const task = this.draft; if (!task) return null;
      const statusField = this.role("status"), progressField = this.role("progress"), titleField = this.role("title");
      if (titleField && task.values[titleField.id] == null) task.values[titleField.id] = "";
      if (statusField && task.values[statusField.id] == null) task.values[statusField.id] = statusField.options?.find((option) => !option.isDone)?.id || "";
      if (progressField && task.values[progressField.id] == null) task.values[progressField.id] = 0;
      delete task._draft; task._quickNew = true; this.draft = null; this.state.tasks.push(task); this.save(false, "manual");
      if (render) this.render();
      return task;
    }

    cancelDraft(render = true) {
      if (!this.draft) return;
      this.draft = null;
      if (render && this.active) this.render();
    }

    updateValue(taskId, fieldId, value, immediate = false) {
      const task = this.task(taskId), field = this.field(fieldId); if (!task || !field) return;
      const empty = value == null || value === "" || (Array.isArray(value) && !value.length);
      if (field.required && empty && !task._draft) { this.toast(`“${field.name}”是必填字段`); this.render(); return; }
      if (field.type === "link" && value) { try { const parsed = new URL(value); if (!["http:", "https:"].includes(parsed.protocol)) throw new Error(); } catch { this.toast("请输入以 http:// 或 https:// 开头的有效网址"); this.render(); return; } }
      if (task._draft && !empty) this.materializeDraft(false);
      task.values[fieldId] = value; task.updatedAt = now();
      if (!empty) delete task._quickNew;
      if (task._draft) { this.render(); return; }
      this.applyProgressLink(task, field, value);
      this.save(immediate); this.render();
      if (this.openTaskId === taskId && this.drawer.contains(document.activeElement) === false) this.renderDrawer();
    }

    applyProgressLink(task, changedField, value) {
      const statusField = this.role("status"), progressField = this.role("progress");
      if (!statusField || !progressField) return;
      if (changedField.id === statusField.id) {
        const selected = this.option(statusField, value);
        if (selected?.isDone) {
          const old = Number(task.values[progressField.id]);
          if (old < 100) task.previousIncompleteProgress = old;
          task.values[progressField.id] = 100; task.completedAt ||= now();
        } else {
          if (Number(task.values[progressField.id]) >= 100) task.values[progressField.id] = Number.isFinite(task.previousIncompleteProgress) ? task.previousIncompleteProgress : 0;
          task.completedAt = null;
        }
      }
      if (changedField.id === progressField.id) {
        const numeric = Number(value), done = statusField.options?.find((option) => option.isDone && option.id === statusField.config?.defaultDoneOptionId) || statusField.options?.find((option) => option.isDone);
        if (numeric >= 100 && done) { task.values[statusField.id] = done.id; task.completedAt ||= now(); }
        else {
          const current = this.option(statusField, task.values[statusField.id]);
          if (current?.isDone) task.values[statusField.id] = statusField.options?.find((option) => !option.isDone)?.id || "";
          task.previousIncompleteProgress = numeric; task.completedAt = null;
        }
      }
    }

    filteredTasks() {
      let tasks = this.state.tasks.slice();
      if (this.search) tasks = tasks.filter((task) => this.fields.some((field) => this.searchable(field, task.values[field.id]).includes(this.search)));
      for (const rule of this.view.filters || []) tasks = tasks.filter((task) => this.matchFilter(task, rule));
      const sorts = this.view.sorts || [];
      if (sorts.length) tasks.sort((a, b) => {
        for (const sort of sorts) {
          const cmp = this.compare(a.values[sort.fieldId], b.values[sort.fieldId]);
          if (cmp) return sort.direction === "desc" ? -cmp : cmp;
        }
        return a.sortOrder - b.sortOrder;
      }); else tasks.sort((a, b) => a.sortOrder - b.sortOrder);
      return tasks;
    }

    searchable(field, value) {
      if (value == null) return "";
      if (field.type === "singleSelect") return this.option(field, value)?.label?.toLowerCase() || "";
      if (field.type === "multiSelect") return (value || []).map((entry) => this.option(field, entry)?.label || "").join(" ").toLowerCase();
      if (field.type === "attachment") return (value || []).map((entry) => entry.name).join(" ").toLowerCase();
      if (field.type === "noteLink") return (this.options.notes().find((note) => note.id === value)?.title || "").toLowerCase();
      return String(value).toLowerCase();
    }

    compare(a, b) { if (a == null || a === "") return 1; if (b == null || b === "") return -1; return typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b), "zh-CN"); }

    matchFilter(task, rule) {
      const field = this.field(rule.fieldId), value = task.values[rule.fieldId]; if (!field) return true;
      if (rule.operator === "empty") return value == null || value === "" || (Array.isArray(value) && !value.length);
      if (rule.operator === "notEmpty") return !(value == null || value === "" || (Array.isArray(value) && !value.length));
      if (rule.operator === "contains") return this.searchable(field, value).includes(String(rule.value || "").toLowerCase());
      if (rule.operator === "equals") { const optionValue = ["singleSelect", "multiSelect"].includes(field.type) ? (field.options?.find((option) => option.id === rule.value || option.label === rule.value)?.id || rule.value) : rule.value; return Array.isArray(value) ? value.includes(optionValue) : String(value) === String(optionValue); }
      if (rule.operator === "gte") return field.type === "date" ? new Date(value).getTime() >= new Date(rule.value).getTime() : Number(value) >= Number(rule.value);
      if (rule.operator === "lte") return field.type === "date" ? new Date(value).getTime() <= new Date(rule.value).getTime() : Number(value) <= Number(rule.value);
      if (rule.operator === "overdue") return Boolean(value) && new Date(value).getTime() < Date.now() && !this.option(this.role("status"), task.values[this.role("status")?.id])?.isDone;
      return true;
    }

    render() {
      this.el.count.textContent = this.state.tasks.length;
      if (!this.active) return;
      document.querySelectorAll(".nav-item:not(#taskNavButton)").forEach((item) => item.classList.remove("active"));
      const groupFields = this.fields.filter((field) => field.type === "singleSelect");
      const currentGroup = this.viewMode === "board" ? this.view.boardGroupFieldId : this.view.tableGroupFieldId;
      this.el.group.innerHTML = `<option value="">不分组</option>${groupFields.map((field) => `<option value="${field.id}" ${field.id === currentGroup ? "selected" : ""}>${esc(field.name)}</option>`).join("")}`;
      document.querySelectorAll("[data-task-view]").forEach((button) => button.classList.toggle("active", button.dataset.taskView === this.viewMode));
      this.el.tableWrap.hidden = this.viewMode !== "table"; this.el.board.hidden = this.viewMode !== "board"; this.el.cards.hidden = this.viewMode !== "board";
      const tasks = this.filteredTasks(); this.el.result.textContent = `${tasks.length} / ${this.state.tasks.length} 条任务`;
      this.renderRules();
      if (this.viewMode === "table") this.renderTable(tasks); else this.renderBoard(tasks);
      this.el.empty.hidden = tasks.length > 0 || Boolean(this.draft);
      if (this.openTaskId) this.renderDrawer();
    }

    groups(tasks, fieldId) {
      if (!fieldId) return [{ id: "all", label: "全部任务", color: "#64748b", tasks }];
      const field = this.field(fieldId), result = [];
      for (const option of field?.options || []) result.push({ id: option.id, label: option.label, color: option.color, tasks: tasks.filter((task) => task.values[fieldId] === option.id) });
      result.push({ id: "unset", label: "未设置", color: "#94a3b8", tasks: tasks.filter((task) => !task.values[fieldId]) });
      return result;
    }

    renderTable(tasks) {
      const visible = this.fields.filter((field) => !field.hidden), rows = this.draft ? [...tasks, this.draft] : tasks, groups = this.groups(rows, this.view.tableGroupFieldId), collapsed = new Set(this.view.collapsedGroups || []);
      this.el.table.innerHTML = groups.map((group) => `<section class="task-table-group" data-task-group="${group.id}">
        <button class="task-group-heading" data-toggle-task-group="${group.id}"><i style="background:${attr(group.color)}"></i><span>${collapsed.has(group.id) ? "▸" : "▾"} ${esc(group.label)}</span><em>${group.tasks.filter((task) => !task._draft).length}</em><b data-group-add="${group.id}" title="在本组新建">＋</b></button>
        <div class="task-table-scroller" ${collapsed.has(group.id) ? "hidden" : ""}><table><thead><tr>${visible.map((field) => `<th style="width:${field.width || 160}px;min-width:${field.width || 160}px" data-field-head="${field.id}"><span>${esc(field.name)}${field.required ? " *" : ""}</span><button data-field-edit="${field.id}">•••</button><i class="task-column-resizer" data-column-resizer="${field.id}" title="拖动调整列宽，双击自动适配"></i></th>`).join("")}<th class="task-add-field"><button data-add-field>＋</button></th></tr></thead>
        <tbody>${group.tasks.map((task) => `<tr class="${task._draft ? "task-draft-row" : "task-order-row"}" draggable="${task._draft ? "false" : "true"}" data-task-row="${task.id}">${visible.map((field) => `<td data-task-cell="${task.id}" data-field-id="${field.id}">${this.cell(task, field)}</td>`).join("")}<td class="task-row-more">${task._draft ? '<span class="task-draft-label">待输入</span>' : `<button data-open-task="${task.id}">•••</button>`}</td></tr>`).join("")}
        <tr class="task-quick-row"><td colspan="${visible.length + 1}"><button data-group-add="${group.id}">＋ 添加任务</button></td></tr></tbody></table></div></section>`).join("");
    }

    clearTableDropIndicators() {
      this.el.table.querySelectorAll(".task-drop-before,.task-drop-after,.task-drop-end,.task-row-dragging").forEach((element) => element.classList.remove("task-drop-before", "task-drop-after", "task-drop-end", "task-row-dragging"));
      this.tableDrop = null;
    }

    tableGroupMatches(task, groupId, fieldId = this.view.tableGroupFieldId) {
      if (!fieldId || groupId === "all") return true;
      const value = task.values?.[fieldId];
      return groupId === "unset" ? !value : value === groupId;
    }

    reorderTableTask(taskId, drop) {
      const task = this.task(taskId); if (!task || task._draft || !drop) return;
      if ((this.view.sorts || []).length) return this.toast("当前已启用字段排序，清除排序后可手动拖动");
      const groupField = this.field(this.view.tableGroupFieldId), groupId = drop.groupId || "all";
      if (groupField) {
        if (groupField.required && groupId === "unset") return this.toast(`“${groupField.name}”是必填字段`);
        const nextValue = groupId === "unset" ? "" : groupId;
        if (groupId !== "all" && task.values[groupField.id] !== nextValue) {
          task.values[groupField.id] = nextValue;
          this.applyProgressLink(task, groupField, nextValue);
        }
      }

      const ordered = this.state.tasks.slice().sort((a, b) => (a.sortOrder - b.sortOrder) || a.createdAt.localeCompare(b.createdAt));
      const sourceIndex = ordered.findIndex((entry) => entry.id === task.id); if (sourceIndex < 0) return;
      ordered.splice(sourceIndex, 1);
      let insertIndex;
      if (drop.targetId) {
        const targetIndex = ordered.findIndex((entry) => entry.id === drop.targetId);
        insertIndex = targetIndex < 0 ? ordered.length : targetIndex + (drop.after ? 1 : 0);
      } else {
        const lastGroupIndex = ordered.reduce((last, entry, index) => this.tableGroupMatches(entry, groupId) ? index : last, -1);
        insertIndex = lastGroupIndex + 1;
      }
      ordered.splice(Math.max(0, Math.min(ordered.length, insertIndex)), 0, task);
      ordered.forEach((entry, index) => { entry.sortOrder = index; });
      task.updatedAt = now(); this.save(true, "manual"); this.render(); this.toast("任务顺序已更新");
    }

    cell(task, field) {
      const value = task.values[field.id];
      if (task._draft && field.systemRole === "title") return `<input class="task-draft-title" data-draft-title="${task.id}" value="${attr(value || "")}" placeholder="输入任务名称…" autocomplete="off">`;
      if (field.type === "text") return `<span class="task-cell-text ${field.systemRole === "title" ? "task-primary-value" : ""}">${esc(value || "")}</span>`;
      if (field.type === "singleSelect") { const option = this.option(field, value); return option ? `<span class="task-chip" style="--chip:${attr(option.color || COLORS[0])}">${esc(option.label)}</span>` : `<span class="task-cell-placeholder">选择…</span>`; }
      if (field.type === "multiSelect") return `<span class="task-chip-list">${(value || []).map((entry) => { const option = this.option(field, entry); return option ? `<span class="task-chip" style="--chip:${attr(option.color || COLORS[0])}">${esc(option.label)}</span>` : ""; }).join("")}</span>`;
      if (field.type === "number") { const number = Number(value); if (!Number.isFinite(number)) return `<span class="task-cell-placeholder">输入数字…</span>`; return field.config?.format === "percent" ? this.progressControl(task, field, number) : `<span>${number}</span>`; }
      if (field.type === "date") return value ? `<time class="${this.dateClass(value)}">${esc(this.formatDate(value, field.config?.includeTime))}</time>` : `<span class="task-cell-placeholder">选择日期…</span>`;
      if (field.type === "checkbox") return `<button class="task-checkbox ${value ? "checked" : ""}" data-checkbox-task="${task.id}" data-checkbox-field="${field.id}">${value ? "✓" : ""}</button>`;
      if (field.type === "link") return value ? `<span class="task-link-cell"><a href="${attr(value)}" data-task-link="${attr(value)}">${esc(value)}</a><button data-task-link-browser="${attr(value)}">↗</button></span>` : `<span class="task-cell-placeholder">粘贴链接…</span>`;
      if (field.type === "attachment") return `<span class="task-attachment-cell">${(value || []).slice(0, 2).map((item) => `<button data-preview-attachment="${item.attachmentId}">${esc(item.name)}</button>`).join("")}${(value || []).length > 2 ? `<em>+${value.length - 2}</em>` : ""}<button data-upload-task="${task.id}" data-upload-field="${field.id}">＋</button></span>`;
      if (field.type === "noteLink") { const note = this.options.notes().find((entry) => entry.id === value); return note ? `<button class="task-note-link" data-open-note="${note.id}">📄 ${esc(note.title || "无标题笔记")}</button>` : `<span class="task-cell-placeholder">关联笔记…</span>`; }
      return "";
    }

    dateClass(value) { const time = new Date(value).getTime(), diff = time - Date.now(); return diff < 0 ? "task-overdue" : diff < 86400000 * 2 ? "task-due-soon" : ""; }
    formatDate(value, includeTime) { const date = new Date(value); return includeTime ? date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : date.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }); }

    progressStyle(field, value) {
      const config = field.config || {}, colors = config.progressColors || DEFAULT_PROGRESS_COLORS, thresholds = config.progressThresholds || DEFAULT_PROGRESS_THRESHOLDS;
      const number = Math.max(Number(config.min ?? 0), Math.min(Number(config.max ?? 100), Number(value) || 0));
      const color = number < Number(thresholds[0]) ? colors[0] : number < Number(thresholds[1]) ? colors[1] : number < Number(thresholds[2]) ? colors[2] : colors[3];
      const min = Number(config.min ?? 0), max = Number(config.max ?? 100), percent = max > min ? ((number - min) / (max - min)) * 100 : 0;
      return { number, color, percent: Math.max(0, Math.min(100, percent)) };
    }

    progressControl(task, field, value, detail = false) {
      const visual = this.progressStyle(field, value), config = field.config || {};
      return `<span class="task-progress task-progress-control ${detail ? "task-progress-detail" : ""}" style="--progress-color:${attr(visual.color)};--progress-value:${visual.percent}%"><i></i><input type="range" min="${config.min ?? 0}" max="${config.max ?? 100}" step="${config.step ?? 1}" value="${visual.number}" data-progress-task="${task.id}" data-progress-field="${field.id}" aria-label="${attr(field.name)}"><em>${visual.number}%</em></span>`;
    }

    renderBoard(tasks) {
      const fieldId = this.view.boardGroupFieldId, rows = this.draft ? [...tasks, this.draft] : tasks, groups = this.groups(rows, fieldId), titleField = this.role("title"), cardFields = (this.view.cardFieldIds || []).map((entry) => this.field(entry)).filter(Boolean).slice(0, 5);
      this.el.board.innerHTML = groups.map((group) => `<section class="task-board-column" data-board-group="${group.id}"><header><div><i style="background:${attr(group.color)}"></i><strong>${esc(group.label)}</strong><span>${group.tasks.filter((task) => !task._draft).length}</span></div><button data-group-add="${group.id}">＋</button></header><div class="task-board-list" data-board-drop="${group.id}">${group.tasks.map((task) => `<article class="task-card ${task._draft ? "task-draft-card" : ""}" draggable="${task._draft ? "false" : "true"}" data-task-card="${task.id}"><div class="task-card-title">${task._draft ? `<input class="task-draft-title" data-draft-title="${task.id}" value="${attr(task.values[titleField?.id] || "")}" placeholder="输入任务名称…" autocomplete="off">` : `<span>${esc(task.values[titleField?.id] || "未命名任务")}</span><button data-open-task="${task.id}">•••</button>`}</div>${task._draft ? "" : cardFields.map((field) => `<div class="task-card-field"><label>${esc(field.name)}</label>${this.cell(task, field)}</div>`).join("")}</article>`).join("")}<button class="task-board-add" data-group-add="${group.id}">＋ 添加任务</button></div></section>`).join("");
    }

    renderRules() {
      const chips = [];
      for (const rule of this.view.filters || []) chips.push(`<button data-remove-filter="${rule.id}">筛选：${esc(this.field(rule.fieldId)?.name || "字段")} ×</button>`);
      for (const sort of this.view.sorts || []) chips.push(`<button data-remove-sort="${sort.id}">排序：${esc(this.field(sort.fieldId)?.name || "字段")} ${sort.direction === "desc" ? "↓" : "↑"} ×</button>`);
      this.el.rules.innerHTML = chips.join("");
    }

    startCellEdit(cell) {
      const task = this.task(cell.dataset.taskCell), field = this.field(cell.dataset.fieldId); if (!task || !field || cell.querySelector(".task-cell-editor")) return;
      const value = task.values[field.id], finish = (next, direction = 0) => { this.updateValue(task.id, field.id, next, true); if (direction) requestAnimationFrame(() => this.focusAdjacentCell(task.id, field.id, direction)); };
      let editor;
      if (field.type === "text") editor = field.config?.multiline ? `<textarea>${esc(value || "")}</textarea>` : `<input type="text" value="${attr(value || "")}">`;
      if (field.type === "number") editor = `<input type="number" value="${Number.isFinite(value) ? value : ""}" min="${field.config?.min ?? ""}" max="${field.config?.max ?? ""}" step="${field.config?.step ?? 1}">`;
      if (field.type === "date") editor = `<input type="${field.config?.includeTime ? "datetime-local" : "date"}" value="${attr(value || "")}">`;
      if (field.type === "link") editor = `<input type="url" value="${attr(value || "")}" placeholder="https://">`;
      if (field.type === "singleSelect") editor = `<select><option value="">未设置</option>${(field.options || []).map((option) => `<option value="${option.id}" ${option.id === value ? "selected" : ""}>${esc(option.label)}</option>`).join("")}</select>`;
      if (field.type === "multiSelect") editor = `<select multiple size="${Math.min(6, Math.max(3, field.options?.length || 3))}">${(field.options || []).map((option) => `<option value="${option.id}" ${(value || []).includes(option.id) ? "selected" : ""}>${esc(option.label)}</option>`).join("")}</select>`;
      if (field.type === "noteLink") editor = `<select><option value="">不关联</option>${this.options.notes().filter((note) => !note.deletedAt).map((note) => `<option value="${note.id}" ${note.id === value ? "selected" : ""}>${esc(note.title || "无标题笔记")}</option>`).join("")}</select>`;
      if (!editor) return;
      cell.innerHTML = `<div class="task-cell-editor">${editor}</div>`;
      const input = cell.querySelector("input,textarea,select"); input.focus(); if (input.select && field.type !== "multiSelect") input.select();
      let done = false;
      const commit = (direction = 0) => { if (done) return; done = true; let next = input.value; if (field.type === "number") next = input.value === "" ? null : Number(input.value); if (field.type === "multiSelect") next = [...input.selectedOptions].map((option) => option.value); finish(next, direction); };
      input.addEventListener("change", () => { if (["singleSelect", "multiSelect", "date", "noteLink"].includes(field.type)) commit(); });
      input.addEventListener("blur", commit);
      input.addEventListener("keydown", (event) => { if (event.key === "Tab") { event.preventDefault(); commit(event.shiftKey ? -1 : 1); } else if (event.key === "Enter" && !field.config?.multiline && field.type !== "multiSelect") { event.preventDefault(); commit(); } else if (event.key === "Escape") { done = true; task._draft ? this.cancelDraft() : this.render(); } });
    }

    focusAdjacentCell(taskId, fieldId, direction) {
      const visible = this.fields.filter((field) => !field.hidden), index = visible.findIndex((field) => field.id === fieldId), next = visible[index + direction];
      if (!next) return;
      const cell = document.querySelector(`[data-task-cell="${taskId}"][data-field-id="${next.id}"]`);
      if (cell) this.startCellEdit(cell);
    }

    handleDraftInput(input) {
      const task = this.task(input.dataset.draftTitle), titleField = this.role("title"); if (!task || !titleField) return;
      task.values[titleField.id] = input.value; task.updatedAt = now();
      if (task._draft && input.value.trim()) this.materializeDraft(false);
      if (!task._draft) this.save(false, "auto");
    }

    finishDraftInput(input, direction = 0) {
      const task = this.task(input.dataset.draftTitle), titleField = this.role("title"); if (!task || !titleField) return;
      task.values[titleField.id] = input.value.trim();
      if (task._draft && !task.values[titleField.id]) return this.cancelDraft();
      if (task._draft) this.materializeDraft(false);
      if (!task.values[titleField.id] && task._quickNew) { this.state.tasks = this.state.tasks.filter((entry) => entry.id !== task.id); this.save(true, "manual"); this.render(); return; }
      delete task._quickNew;
      this.save(true, "manual"); this.render();
      if (direction) requestAnimationFrame(() => this.focusAdjacentCell(task.id, titleField.id, direction));
    }

    handleProgressInput(input, final = false) {
      const task = this.task(input.dataset.progressTask), field = this.field(input.dataset.progressField); if (!task || !field) return;
      const raw = Number(input.value), min = Number(field.config?.min ?? 0), max = Number(field.config?.max ?? 100), step = Number(field.config?.step ?? 1);
      const value = Math.max(min, Math.min(max, min + Math.round((raw - min) / step) * step)), empty = !Number.isFinite(value);
      if (empty) return;
      if (task._draft) this.materializeDraft(false);
      task.values[field.id] = value; task.updatedAt = now(); this.applyProgressLink(task, field, value);
      const control = input.closest(".task-progress-control"), visual = this.progressStyle(field, value);
      if (control) { control.style.setProperty("--progress-color", visual.color); control.style.setProperty("--progress-value", `${visual.percent}%`); control.querySelector("em").textContent = `${value}%`; }
      clearTimeout(this.progressSaveTimer);
      if (final) { this.save(true, "manual"); this.render(); }
      else this.progressSaveTimer = setTimeout(() => this.save(false, "auto"), 300);
    }

    defaultFieldWidth(field) { if (field.systemRole === "title") return 260; if (field.type === "text" && field.config?.multiline) return 260; if (field.type === "date") return 145; if (field.type === "number" && field.config?.format === "percent") return 170; return 160; }

    setFieldWidth(fieldId, width, persist = false) {
      const field = this.field(fieldId); if (!field) return;
      field.width = Math.max(90, Math.min(520, Math.round(width)));
      document.querySelectorAll(`[data-field-head="${fieldId}"]`).forEach((head) => { head.style.width = `${field.width}px`; head.style.minWidth = `${field.width}px`; });
      if (persist) this.save(true, "layout");
    }

    startColumnResize(event) {
      if (event.button !== 0 || window.innerWidth < 960) return;
      const handle = event.target.closest("[data-column-resizer]"), field = handle && this.field(handle.dataset.columnResizer); if (!field) return;
      event.preventDefault(); event.stopPropagation(); const startX = event.clientX, startWidth = field.width || this.defaultFieldWidth(field);
      document.body.classList.add("task-column-resizing"); handle.classList.add("dragging");
      const move = (moveEvent) => this.setFieldWidth(field.id, startWidth + moveEvent.clientX - startX, false);
      const end = () => { document.body.classList.remove("task-column-resizing"); handle.classList.remove("dragging"); window.removeEventListener("pointermove", move); this.setFieldWidth(field.id, field.width, true); };
      window.addEventListener("pointermove", move); window.addEventListener("pointerup", end, { once: true });
    }

    autoFitField(fieldId) {
      const field = this.field(fieldId); if (!field) return;
      let width = Math.max(90, (field.name || "").length * 16 + 62);
      document.querySelectorAll(`[data-field-id="${fieldId}"]`).forEach((cell) => { width = Math.max(width, Math.min(520, cell.scrollWidth + 28)); });
      this.setFieldWidth(fieldId, width, true); this.render();
    }

    resetFieldWidth(fieldId) { const field = this.field(fieldId); if (field) { this.setFieldWidth(fieldId, this.defaultFieldWidth(field), true); this.render(); } }

    openDrawer(taskId, focusTitle = false) { this.openTaskId = taskId; this.drawer.hidden = false; this.renderDrawer(); if (focusTitle) setTimeout(() => this.drawer.querySelector(`[data-detail-field="${this.role("title")?.id}"] input`)?.focus(), 0); }
    openTask(taskId) { if (!this.task(taskId)) return false; this.enter(); this.openDrawer(taskId); return true; }
    closeDrawer() { this.openTaskId = null; this.drawer.hidden = true; }

    renderDrawer() {
      const task = this.task(this.openTaskId); if (!task) return this.closeDrawer();
      document.querySelector("#taskDetailTitle").textContent = this.titleOf(task);
      this.drawerBody.innerHTML = `<section class="task-detail-fields">${this.fields.map((field) => `<label class="task-detail-field" data-detail-field="${field.id}"><span>${esc(field.name)}${field.required ? " *" : ""}</span>${this.detailEditor(task, field)}${field.description ? `<small>${esc(field.description)}</small>` : ""}</label>`).join("")}</section><section class="task-detail-history"><h3>字段历史</h3><div id="taskHistoryItems"><span>正在读取历史…</span></div></section>`;
      this.safety.getTaskHistory(task.id).then((items) => { const target = document.querySelector("#taskHistoryItems"); if (!target || this.openTaskId !== task.id) return; target.innerHTML = items.length ? items.slice(0, 20).map((item) => `<div><span>${new Date(item.createdAt).toLocaleString("zh-CN")}</span><em>${esc(item.reason || "自动保存")}</em><button data-restore-task-history="${item.id}">恢复</button></div>`).join("") : "<span>暂无历史版本</span>"; }).catch(() => {});
    }

    detailEditor(task, field) {
      const value = task.values[field.id];
      if (field.type === "text") return field.config?.multiline ? `<textarea data-detail-input="${field.id}">${esc(value || "")}</textarea>` : `<input data-detail-input="${field.id}" value="${attr(value || "")}">`;
      if (field.type === "number") return field.config?.format === "percent" ? this.progressControl(task, field, Number.isFinite(value) ? value : 0, true) : `<input data-detail-input="${field.id}" type="number" value="${Number.isFinite(value) ? value : ""}" min="${field.config?.min ?? ""}" max="${field.config?.max ?? ""}" step="${field.config?.step ?? 1}">`;
      if (field.type === "date") return `<input data-detail-input="${field.id}" type="${field.config?.includeTime ? "datetime-local" : "date"}" value="${attr(value || "")}">`;
      if (field.type === "checkbox") return `<input data-detail-input="${field.id}" type="checkbox" ${value ? "checked" : ""}>`;
      if (field.type === "link") return `<div class="task-detail-inline"><input data-detail-input="${field.id}" type="url" value="${attr(value || "")}" placeholder="https://"><button data-task-link="${attr(value || "")}">正文打开</button><button data-task-link-browser="${attr(value || "")}">新页</button></div>`;
      if (field.type === "singleSelect") return `<select data-detail-input="${field.id}"><option value="">未设置</option>${(field.options || []).map((option) => `<option value="${option.id}" ${option.id === value ? "selected" : ""}>${esc(option.label)}</option>`).join("")}</select>`;
      if (field.type === "multiSelect") return `<select data-detail-input="${field.id}" multiple>${(field.options || []).map((option) => `<option value="${option.id}" ${(value || []).includes(option.id) ? "selected" : ""}>${esc(option.label)}</option>`).join("")}</select>`;
      if (field.type === "noteLink") return `<div class="task-detail-inline"><select data-detail-input="${field.id}"><option value="">不关联</option>${this.options.notes().filter((note) => !note.deletedAt).map((note) => `<option value="${note.id}" ${note.id === value ? "selected" : ""}>${esc(note.title || "无标题笔记")}</option>`).join("")}</select>${value ? `<button data-open-note="${value}">打开笔记</button>` : ""}</div>`;
      if (field.type === "attachment") return `<div class="task-detail-attachments">${(value || []).map((item, index) => `<div><button data-preview-attachment="${item.attachmentId}">${esc(item.name)}</button><button data-download-attachment="${item.attachmentId}" data-download-name="${attr(item.name)}">下载</button><button data-remove-task-attachment="${task.id}" data-remove-field="${field.id}" data-remove-index="${index}">×</button></div>`).join("")}<button data-upload-task="${task.id}" data-upload-field="${field.id}">＋ 上传附件</button></div>`;
      return "";
    }

    openFieldManager(editId = "") {
      this.modal.className = "task-modal task-fields-modal";
      this.modal.innerHTML = `<header><div><span>任务管理</span><h2>自定义字段</h2></div><button data-task-modal-close>×</button></header><div class="task-fields-layout"><nav class="task-field-list">${this.fields.map((field, index) => `<button class="${field.id === editId ? "active" : ""}" data-field-select="${field.id}"><i>${esc(TYPE_LABELS[field.type])}</i><span>${esc(field.name)}</span>${field.hidden ? "<em>已隐藏</em>" : ""}<b><span data-field-up="${field.id}" ${index === 0 ? "hidden" : ""}>↑</span><span data-field-down="${field.id}" ${index === this.fields.length - 1 ? "hidden" : ""}>↓</span></b></button>`).join("")}<button class="task-new-field" data-field-new>＋ 新增字段</button></nav><div class="task-field-form" id="taskFieldForm">${editId ? this.fieldForm(this.field(editId)) : `<div class="task-field-welcome"><strong>管理任务字段</strong><p>选择左侧字段修改名称、类型与显示方式，或新增一个字段。</p></div>`}</div></div><footer><button class="secondary-button" data-task-modal-close>完成</button></footer>`;
      this.modalBackdrop.hidden = false;
    }

    fieldForm(field, isNew = false) {
      const current = field || { id: id("field"), name: "新字段", type: "text", description: "", required: false, hidden: false, width: 160, options: [], config: {} };
      const optionsText = (current.options || []).map((option) => `${option.label}|${option.color || COLORS[0]}${current.systemRole === "status" ? `|${option.isDone ? "完成" : "未完成"}` : ""}`).join("\n");
      return `<form data-field-form data-field-id="${current.id}" data-field-new-state="${isNew ? "1" : "0"}">
        <div class="task-form-grid"><label><span>字段名称</span><input name="name" required value="${attr(current.name)}"></label><label><span>字段类型</span><select name="type" ${current.systemRole === "title" ? "disabled" : ""}>${Object.entries(TYPE_LABELS).map(([key, label]) => `<option value="${key}" ${key === current.type ? "selected" : ""}>${label}</option>`).join("")}</select></label></div>
        <label><span>字段说明</span><input name="description" value="${attr(current.description || "")}" placeholder="可选，说明该字段的用途"></label>
        <div class="task-form-grid"><label><span>列宽（像素）</span><input type="number" name="width" min="90" max="520" value="${current.width || 160}"></label><label><span>系统角色</span><select name="systemRole" ${current.systemRole === "title" ? "disabled" : ""}><option value="">普通字段</option><option value="status" ${current.systemRole === "status" ? "selected" : ""}>状态联动</option><option value="progress" ${current.systemRole === "progress" ? "selected" : ""}>进度联动</option></select></label></div>
        <div class="task-field-checks"><label><input type="checkbox" name="required" ${current.required ? "checked" : ""}> 必填</label><label><input type="checkbox" name="hidden" ${current.hidden ? "checked" : ""}> 在表格中隐藏</label><label><input type="checkbox" name="multiline" ${current.config?.multiline ? "checked" : ""}> 多行文本</label><label><input type="checkbox" name="includeTime" ${current.config?.includeTime ? "checked" : ""}> 包含时间</label><label><input type="checkbox" name="percent" ${current.config?.format === "percent" ? "checked" : ""}> 百分比进度条</label></div>
        <div class="task-form-grid task-number-config ${current.type === "number" ? "" : "task-config-hidden"}"><label><span>最小值</span><input type="number" name="min" value="${current.config?.min ?? 0}"></label><label><span>最大值</span><input type="number" name="max" value="${current.config?.max ?? 100}"></label><label><span>步长</span><input type="number" name="step" min="0.01" value="${current.config?.step ?? 1}"></label></div>
        <section class="task-progress-config ${current.type === "number" && current.config?.format === "percent" ? "" : "task-config-hidden"}"><strong>进度分段颜色</strong><div class="task-progress-color-grid">${(current.config?.progressColors || DEFAULT_PROGRESS_COLORS).map((color, index) => `<label><span>${["低进度", "进行中", "接近完成", "已完成"][index]}</span><input type="color" name="progressColor${index}" value="${attr(color)}"></label>`).join("")}</div><div class="task-form-grid task-progress-thresholds"><label><span>第二段起点</span><input type="number" name="progressThreshold0" min="1" max="98" value="${current.config?.progressThresholds?.[0] ?? 25}"></label><label><span>第三段起点</span><input type="number" name="progressThreshold1" min="2" max="99" value="${current.config?.progressThresholds?.[1] ?? 60}"></label><label><span>完成色起点</span><input type="number" name="progressThreshold2" min="3" max="100" value="${current.config?.progressThresholds?.[2] ?? 100}"></label></div></section>
        <label class="task-option-config"><span>选项（每行：名称 | 颜色${current.systemRole === "status" ? " | 完成/未完成" : ""}）</span><textarea name="options" rows="7" placeholder="待开始 | #64748b">${esc(optionsText)}</textarea><small>颜色可填写 #3976f6；状态字段至少需要一个完成和一个未完成选项。</small></label>
        <div class="task-field-form-actions">${!isNew && current.systemRole !== "title" ? `<button type="button" class="danger-button" data-delete-field="${current.id}">删除字段</button>` : ""}<button type="submit" class="primary-button">保存字段</button></div>
      </form>`;
    }

    parseFieldForm(form) {
      const old = this.field(form.dataset.fieldId), type = form.elements.type.value;
      const optionLines = String(form.elements.options.value || "").split(/\r?\n/).filter((line) => line.trim());
      const claimedOptionIds = new Set();
      const options = optionLines.map((line, index) => {
        const [label, color, done] = line.split("|").map((part) => part.trim());
        if (!label) return null;
        let previous = old?.options?.find((option) => option.label === label && !claimedOptionIds.has(option.id));
        if (!previous && optionLines.length === old?.options?.length && old.options[index] && !claimedOptionIds.has(old.options[index].id)) previous = old.options[index];
        if (previous) claimedOptionIds.add(previous.id);
        return { id: previous?.id || id("option"), label, color: /^#[0-9a-f]{6}$/i.test(color) ? color : COLORS[index % COLORS.length], order: index, ...(form.elements.systemRole.value === "status" ? { isDone: done === "完成" } : {}) };
      }).filter(Boolean);
      const thresholds = [0, 1, 2].map((index) => Number(form.elements[`progressThreshold${index}`].value));
      const progressThresholds = [Math.min(98, Math.max(1, thresholds[0] || 25)), 60, 100];
      progressThresholds[1] = Math.min(99, Math.max(progressThresholds[0] + 1, thresholds[1] || 60));
      progressThresholds[2] = Math.min(100, Math.max(progressThresholds[1] + 1, thresholds[2] || 100));
      return { id: form.dataset.fieldId, name: form.elements.name.value.trim(), type, description: form.elements.description.value.trim(), width: Math.max(90, Math.min(520, Number(form.elements.width.value) || 160)), required: form.elements.required.checked, hidden: form.elements.hidden.checked, systemRole: form.elements.systemRole.value, options, config: { multiline: form.elements.multiline.checked, includeTime: form.elements.includeTime.checked, format: form.elements.percent.checked ? "percent" : "number", min: Number(form.elements.min.value), max: Number(form.elements.max.value), step: Number(form.elements.step.value) || 1, progressColors: [0, 1, 2, 3].map((index) => form.elements[`progressColor${index}`].value || DEFAULT_PROGRESS_COLORS[index]), progressThresholds }, order: old?.order ?? this.fields.length, createdAt: old?.createdAt || now(), updatedAt: now() };
    }

    canConvert(field, nextType) {
      if (!field || field.type === nextType) return { ok: true, convert: (value) => value };
      const values = this.state.tasks.map((task) => task.values[field.id]).filter((value) => value != null && value !== "" && (!Array.isArray(value) || value.length));
      if (!values.length) return { ok: true, convert: () => null };
      if (field.type === "singleSelect" && nextType === "multiSelect") return { ok: true, convert: (value) => value ? [value] : [] };
      if (field.type === "multiSelect" && nextType === "singleSelect" && values.every((value) => Array.isArray(value) && value.length <= 1)) return { ok: true, convert: (value) => value?.[0] || "" };
      if (field.type === "text" && nextType === "number" && values.every((value) => Number.isFinite(Number(value)))) return { ok: true, convert: (value) => value === "" ? null : Number(value) };
      if (field.type === "text" && nextType === "date" && values.every((value) => !Number.isNaN(new Date(value).getTime()))) return { ok: true, convert: (value) => value ? new Date(value).toISOString().slice(0, 10) : "" };
      if (field.type === "text" && nextType === "link" && values.every((value) => { try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; } })) return { ok: true, convert: (value) => value };
      if (["number", "date", "link"].includes(field.type) && nextType === "text") return { ok: true, convert: (value) => String(value ?? "") };
      return { ok: false, message: `“${field.name}”已有 ${values.length} 条数据，不能安全地从${TYPE_LABELS[field.type]}转换为${TYPE_LABELS[nextType]}。请先清空该字段或新建字段。` };
    }

    async saveField(form) {
      const next = this.parseFieldForm(form), old = this.field(next.id), isNew = !old;
      if (!next.name) return this.toast("字段名称不能为空");
      if (next.systemRole === "status" && next.type !== "singleSelect") return this.toast("状态角色只能绑定单选字段");
      if (next.systemRole === "progress" && (next.type !== "number" || next.config.format !== "percent")) return this.toast("进度角色只能绑定百分比数字字段");
      if (next.systemRole === "status" && (!next.options.some((option) => option.isDone) || !next.options.some((option) => !option.isDone))) return this.toast("状态字段至少需要一个完成选项和一个未完成选项");
      if (old?.systemRole === "title") { next.type = "text"; next.systemRole = "title"; }
      if (old?.systemRole && old.systemRole !== "title" && next.systemRole !== old.systemRole && !this.state.taskFields.some((field) => field.id !== old.id && field.systemRole === old.systemRole)) return this.toast(`请先把“${old.systemRole === "status" ? "状态" : "进度"}”角色转交给另一个兼容字段，再修改此字段`);
      const conversion = this.canConvert(old, next.type); if (!conversion.ok) return this.toast(conversion.message);
      const snapshot = { field: clone(old || next), values: this.state.tasks.map((task) => ({ taskId: task.id, value: clone(task.values[next.id]) })) };
      await this.safety.recordRecovery("task-field-change", `修改字段“${next.name}”前`, snapshot);
      if (old && ["singleSelect", "multiSelect"].includes(old.type) && ["singleSelect", "multiSelect"].includes(next.type)) {
        const nextIds = new Set(next.options.map((option) => option.id));
        for (const removed of (old.options || []).filter((option) => !nextIds.has(option.id))) {
          const affected = this.state.tasks.filter((task) => Array.isArray(task.values[old.id]) ? task.values[old.id].includes(removed.id) : task.values[old.id] === removed.id);
          if (!affected.length) continue;
          const replacementLabel = prompt(`选项“${removed.label}”仍被 ${affected.length} 条任务使用。\n请输入替换选项名称；留空则清空这些值。`, "");
          if (replacementLabel === null) return this.toast("已取消字段修改");
          const replacement = next.options.find((option) => option.label === replacementLabel.trim());
          if (replacementLabel.trim() && !replacement) return this.toast(`找不到替换选项“${replacementLabel.trim()}”`);
          affected.forEach((task) => {
            if (Array.isArray(task.values[old.id])) task.values[old.id] = [...new Set(task.values[old.id].filter((entry) => entry !== removed.id).concat(replacement ? [replacement.id] : []))];
            else task.values[old.id] = replacement?.id || "";
          });
        }
      }
      if (next.systemRole) this.state.taskFields.forEach((field) => { if (field.id !== next.id && field.systemRole === next.systemRole) field.systemRole = ""; });
      if (old && old.type !== next.type) this.state.tasks.forEach((task) => { task.values[next.id] = conversion.convert(task.values[next.id]); });
      if (isNew) this.state.taskFields.push(next); else Object.assign(old, next);
      const saved = await this.options.persist(true, "field-change"); this.openFieldManager(next.id); this.render();
      this.toast(saved ? "字段已保存并通过回读校验" : "字段修改仍在内存中，数据库事务已回滚，请在数据安全中心重试");
    }

    async deleteField(fieldId) {
      const field = this.field(fieldId); if (!field || field.systemRole) return this.toast("核心角色字段不能直接删除");
      const used = this.state.tasks.filter((task) => { const value = task.values[fieldId]; return value != null && value !== "" && (!Array.isArray(value) || value.length); });
      if (!confirm(`字段“${field.name}”在 ${used.length} 条任务中有内容。删除后将进入 30 天紧急恢复，确定继续吗？`)) return;
      await this.safety.recordRecovery("task-field-delete", `删除任务字段“${field.name}”`, { field: clone(field), values: used.map((task) => ({ taskId: task.id, value: clone(task.values[fieldId]) })) });
      this.state.taskFields = this.state.taskFields.filter((entry) => entry.id !== fieldId); this.state.tasks.forEach((task) => delete task.values[fieldId]);
      this.view.cardFieldIds = this.view.cardFieldIds.filter((entry) => entry !== fieldId); if (this.view.tableGroupFieldId === fieldId) this.view.tableGroupFieldId = ""; if (this.view.boardGroupFieldId === fieldId) this.view.boardGroupFieldId = this.role("status")?.id || "";
      await this.options.persist(true, "danger"); this.openFieldManager(); this.render();
    }

    openRuleDialog(kind, selectedFieldId = "") {
      const isFilter = kind === "filter";
      this.modal.className = "task-modal task-rule-modal";
      this.modal.innerHTML = `<header><div><span>任务视图</span><h2>${isFilter ? "添加筛选条件" : "添加排序条件"}</h2></div><button data-task-modal-close>×</button></header><form data-rule-form="${kind}"><label><span>字段</span><select name="fieldId">${this.fields.map((field) => `<option value="${field.id}" ${field.id === selectedFieldId ? "selected" : ""}>${esc(field.name)}</option>`).join("")}</select></label>${isFilter ? `<label><span>条件</span><select name="operator"><option value="contains">包含</option><option value="equals">等于</option><option value="gte">大于等于</option><option value="lte">小于等于</option><option value="overdue">已逾期</option><option value="empty">为空</option><option value="notEmpty">不为空</option></select></label><label><span>值</span><input name="value" placeholder="筛选值"></label>` : `<label><span>方向</span><select name="direction"><option value="asc">升序</option><option value="desc">降序</option></select></label>`}<footer><button type="button" class="secondary-button" data-task-modal-close>取消</button><button class="primary-button">添加</button></footer></form>`;
      this.modalBackdrop.hidden = false;
    }

    openCardSettings() {
      this.modal.className = "task-modal task-card-modal";
      this.modal.innerHTML = `<header><div><span>任务看板</span><h2>自定义卡片</h2></div><button data-task-modal-close>×</button></header><form data-card-form><p>选择最多 5 个字段显示在卡片上（任务名称始终显示）。</p><div class="task-card-field-options">${this.fields.filter((field) => field.systemRole !== "title").map((field) => `<label><input type="checkbox" value="${field.id}" ${(this.view.cardFieldIds || []).includes(field.id) ? "checked" : ""}> ${esc(field.name)} <small>${TYPE_LABELS[field.type]}</small></label>`).join("")}</div><footer><button type="button" class="secondary-button" data-task-modal-close>取消</button><button class="primary-button">保存</button></footer></form>`;
      this.modalBackdrop.hidden = false;
    }

    closeModal() { this.modalBackdrop.hidden = true; this.modal.innerHTML = ""; }

    async uploadAttachments(files) {
      const target = this.uploadTarget, task = target && this.task(target.taskId), field = target && this.field(target.fieldId); if (!task || field?.type !== "attachment") return;
      const list = Array.isArray(task.values[field.id]) ? task.values[field.id] : [];
      for (const file of files) {
        try { const attachment = await this.safety.putAttachment(file, { name: file.name, type: file.type }); list.push({ attachmentId: attachment.id, name: file.name, size: attachment.size, type: attachment.type }); }
        catch (error) { this.toast(`${file.name} 上传失败：${error.message || error}`); }
      }
      task.values[field.id] = list; task.updatedAt = now(); await this.options.persist(true, "manual"); this.render(); this.renderDrawer();
    }

    menu(label, action = "", options = {}) { return { label, action, ...options }; }
    separator() { return { separator: true }; }
    actionValue(payload) { return JSON.stringify(payload); }

    displayValue(field, value) {
      if (value == null || value === "") return "";
      if (field.type === "singleSelect") return this.option(field, value)?.label || "";
      if (field.type === "multiSelect") return (value || []).map((entry) => this.option(field, entry)?.label || "").filter(Boolean).join("、");
      if (field.type === "checkbox") return value ? "是" : "否";
      if (field.type === "attachment") return (value || []).map((entry) => entry.name).join("、");
      if (field.type === "noteLink") return this.options.notes().find((note) => note.id === value)?.title || "";
      return String(value);
    }

    taskMenuItems(task) {
      const status = this.role("status"), progress = this.role("progress"), noteField = this.fields.find((field) => field.type === "noteLink" && task.values[field.id]);
      const items = [this.menu("打开任务详情", "task-open-detail", { value: task.id }), this.menu("复制任务", "task-duplicate", { value: task.id }), this.menu("复制任务名称", "task-copy-title", { value: task.id })];
      if (status) items.push(this.menu("设置状态", "", { submenu: (status.options || []).map((option) => this.menu(option.label, "task-set-value", { value: this.actionValue({ taskId: task.id, fieldId: status.id, value: option.id }) })) }));
      if (progress) items.push(this.menu("设置进度", "", { submenu: [0, 25, 50, 75, 100].map((value) => this.menu(`${value}%`, "task-set-value", { value: this.actionValue({ taskId: task.id, fieldId: progress.id, value }) })) }));
      if (noteField) items.push(this.menu("打开关联笔记", "task-open-note", { value: task.values[noteField.id] }));
      items.push(this.separator(), this.menu("删除任务", "task-delete", { value: task.id, danger: true }));
      return items;
    }

    cellMenuItems(task, field) {
      const value = task.values[field.id], payload = this.actionValue({ taskId: task.id, fieldId: field.id });
      const items = [this.menu("编辑单元格", "task-edit-cell", { value: payload, disabled: ["checkbox", "attachment"].includes(field.type) }), this.menu("复制单元格内容", "task-copy-value", { value: payload, disabled: !this.displayValue(field, value) })];
      if (field.type === "singleSelect") items.push(this.menu("选择选项", "", { submenu: (field.options || []).map((option) => this.menu(`${option.id === value ? "✓ " : ""}${option.label}`, "task-set-value", { value: this.actionValue({ taskId: task.id, fieldId: field.id, value: option.id }) })) }));
      if (field.type === "multiSelect") items.push(this.menu("切换选项", "", { submenu: (field.options || []).map((option) => this.menu(`${(value || []).includes(option.id) ? "✓ " : ""}${option.label}`, "task-toggle-option", { value: this.actionValue({ taskId: task.id, fieldId: field.id, optionId: option.id }) })) }));
      if (field.type === "date") items.push(this.menu("快捷日期", "", { submenu: [this.menu("今天", "task-date-offset", { value: this.actionValue({ taskId: task.id, fieldId: field.id, days: 0 }) }), this.menu("明天", "task-date-offset", { value: this.actionValue({ taskId: task.id, fieldId: field.id, days: 1 }) }), this.menu("下周", "task-date-offset", { value: this.actionValue({ taskId: task.id, fieldId: field.id, days: 7 }) })] }));
      if (field.type === "number" && field.config?.format === "percent") items.push(this.menu("预设进度", "", { submenu: [0, 25, 50, 75, 100].map((entry) => this.menu(`${entry}%`, "task-set-value", { value: this.actionValue({ taskId: task.id, fieldId: field.id, value: entry }) })) }));
      if (field.type === "link" && value) items.push(this.menu("在正文中打开", "task-open-link", { value }), this.menu("新网页打开", "task-open-link-browser", { value }), this.menu("复制链接", "task-copy-text", { value }));
      if (field.type === "attachment") {
        items.push(this.menu("上传附件", "task-upload-attachment", { value: payload }));
        for (const [index, attachment] of (value || []).entries()) items.push(this.menu(attachment.name, "", { submenu: [this.menu("预览", "task-preview-attachment", { value: attachment.attachmentId }), this.menu("下载", "task-download-attachment", { value: this.actionValue({ attachmentId: attachment.attachmentId, name: attachment.name }) }), this.menu("移除", "task-remove-attachment", { value: this.actionValue({ taskId: task.id, fieldId: field.id, index }), danger: true })] }));
      }
      if (field.type === "noteLink" && value) items.push(this.menu("打开关联笔记", "task-open-note", { value }));
      items.push(this.separator(), this.menu("清空单元格", "task-clear-cell", { value: payload, danger: true, disabled: field.required || value == null || value === "" || (Array.isArray(value) && !value.length) }), this.separator(), ...this.taskMenuItems(task));
      return items;
    }

    contextForTarget(target) {
      if (!this.active || !target.closest("#taskWorkspace")) return null;
      const cell = target.closest("[data-task-cell]"), row = target.closest("[data-task-row]"), card = target.closest("[data-task-card]"), head = target.closest("[data-field-head]"), group = target.closest("[data-task-group]"), column = target.closest("[data-board-group]");
      if (cell) { const task = this.task(cell.dataset.taskCell), field = this.field(cell.dataset.fieldId); if (task && field && !task._draft) return { items: this.cellMenuItems(task, field), payload: {} }; }
      if (head) { const field = this.field(head.dataset.fieldHead); if (!field) return null; return { items: [this.menu("字段设置", "task-field-settings", { value: field.id }), this.menu("升序排列", "task-sort-field", { value: this.actionValue({ fieldId: field.id, direction: "asc" }) }), this.menu("降序排列", "task-sort-field", { value: this.actionValue({ fieldId: field.id, direction: "desc" }) }), this.menu("添加筛选", "task-filter-field", { value: field.id }), this.separator(), this.menu("隐藏字段", "task-hide-field", { value: field.id }), this.menu("自动适配宽度", "task-auto-width", { value: field.id }), this.menu("恢复默认宽度", "task-reset-width", { value: field.id }), ...(field.systemRole ? [] : [this.separator(), this.menu("删除字段", "task-delete-field", { value: field.id, danger: true })])], payload: {} }; }
      const taskTarget = row || card; if (taskTarget) { const task = this.task(taskTarget.dataset.taskRow || taskTarget.dataset.taskCard); if (task && !task._draft) return { items: this.taskMenuItems(task), payload: {} }; }
      if (group || column) {
        const groupId = group?.dataset.taskGroup || column?.dataset.boardGroup || "unset", fieldId = group ? this.view.tableGroupFieldId : this.view.boardGroupFieldId;
        const items = [this.menu("在该组新建任务", "task-new-group", { value: this.actionValue({ groupId, fieldId }) })];
        if (group) items.push(this.menu((this.view.collapsedGroups || []).includes(groupId) ? "展开分组" : "折叠分组", "task-toggle-group", { value: groupId }));
        if (fieldId) items.push(this.menu("编辑分组字段", "task-field-settings", { value: fieldId }));
        return { items, payload: {} };
      }
      return { items: [this.menu("新建任务", "task-new"), this.menu("展开全部分组", "task-expand-groups"), this.menu("清除筛选和排序", "task-clear-rules", { disabled: !(this.view.filters?.length || this.view.sorts?.length) }), this.separator(), this.menu("自定义字段", "task-fields")], payload: {} };
    }

    copyText(value, success = "已复制") { navigator.clipboard?.writeText(String(value || "")).then(() => this.toast(success)).catch(() => this.toast("复制失败，请手动复制")); }

    duplicateTask(taskId) {
      const source = this.task(taskId); if (!source) return;
      const titleField = this.role("title"), stamp = now(), task = { ...clone(source), id: id("task"), values: clone(source.values), sortOrder: this.state.tasks.length, createdAt: stamp, updatedAt: stamp, completedAt: null, revision: undefined, checksum: undefined };
      delete task._quickNew; delete task._draft;
      if (titleField) task.values[titleField.id] = `${task.values[titleField.id] || "未命名任务"} 副本`;
      this.state.tasks.push(task); this.save(true, "manual"); this.render(); this.toast("任务副本已创建");
    }

    setSort(fieldId, direction) { this.view.sorts = (this.view.sorts || []).filter((sort) => sort.fieldId !== fieldId); this.view.sorts.push({ id: id("sort"), fieldId, direction }); this.save(true); this.render(); }

    runContextAction(action, rawValue = "") {
      let payload = null; try { payload = rawValue && rawValue.startsWith("{") ? JSON.parse(rawValue) : null; } catch { payload = null; }
      if (action === "task-open-detail") this.openDrawer(rawValue);
      else if (action === "task-duplicate") this.duplicateTask(rawValue);
      else if (action === "task-copy-title") this.copyText(this.titleOf(this.task(rawValue)), "任务名称已复制");
      else if (action === "task-delete") this.deleteTask(rawValue);
      else if (action === "task-set-value" && payload) this.updateValue(payload.taskId, payload.fieldId, payload.value, true);
      else if (action === "task-toggle-option" && payload) { const task = this.task(payload.taskId), values = [...(task?.values[payload.fieldId] || [])], index = values.indexOf(payload.optionId); index >= 0 ? values.splice(index, 1) : values.push(payload.optionId); this.updateValue(payload.taskId, payload.fieldId, values, true); }
      else if (action === "task-edit-cell" && payload) setTimeout(() => { const cell = document.querySelector(`[data-task-cell="${payload.taskId}"][data-field-id="${payload.fieldId}"]`); if (cell) this.startCellEdit(cell); }, 0);
      else if (action === "task-copy-value" && payload) { const task = this.task(payload.taskId), field = this.field(payload.fieldId); this.copyText(this.displayValue(field, task?.values[payload.fieldId]), "单元格内容已复制"); }
      else if (action === "task-clear-cell" && payload) { const field = this.field(payload.fieldId); this.updateValue(payload.taskId, payload.fieldId, field?.type === "multiSelect" || field?.type === "attachment" ? [] : field?.type === "checkbox" ? false : "", true); }
      else if (action === "task-date-offset" && payload) { const date = new Date(); date.setDate(date.getDate() + Number(payload.days || 0)); const value = this.field(payload.fieldId)?.config?.includeTime ? new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; this.updateValue(payload.taskId, payload.fieldId, value, true); }
      else if (action === "task-open-link") this.options.openLink(rawValue);
      else if (action === "task-open-link-browser") window.open(rawValue, "_blank", "noopener");
      else if (action === "task-copy-text") this.copyText(rawValue, "链接已复制");
      else if (action === "task-upload-attachment" && payload) { this.uploadTarget = payload; this.el.attachment.click(); }
      else if (action === "task-preview-attachment") this.openAttachment(rawValue);
      else if (action === "task-download-attachment" && payload) this.openAttachment(payload.attachmentId, payload.name);
      else if (action === "task-remove-attachment" && payload) { const task = this.task(payload.taskId), list = [...(task?.values[payload.fieldId] || [])]; list.splice(Number(payload.index), 1); this.updateValue(payload.taskId, payload.fieldId, list, true); }
      else if (action === "task-open-note") this.options.openNote(rawValue);
      else if (action === "task-field-settings") this.openFieldManager(rawValue);
      else if (action === "task-sort-field" && payload) this.setSort(payload.fieldId, payload.direction);
      else if (action === "task-filter-field") this.openRuleDialog("filter", rawValue);
      else if (action === "task-hide-field") { const field = this.field(rawValue); if (field) { field.hidden = true; this.save(true, "field-change"); this.render(); } }
      else if (action === "task-auto-width") this.autoFitField(rawValue);
      else if (action === "task-reset-width") this.resetFieldWidth(rawValue);
      else if (action === "task-delete-field") this.deleteField(rawValue);
      else if (action === "task-new-group" && payload) { const initial = {}; if (payload.fieldId && payload.groupId !== "unset" && payload.groupId !== "all") initial[payload.fieldId] = payload.groupId; this.createTask(initial); }
      else if (action === "task-toggle-group") { const groups = new Set(this.view.collapsedGroups || []); groups.has(rawValue) ? groups.delete(rawValue) : groups.add(rawValue); this.view.collapsedGroups = [...groups]; this.save(); this.render(); }
      else if (action === "task-new") this.createTask();
      else if (action === "task-expand-groups") { this.view.collapsedGroups = []; this.save(); this.render(); }
      else if (action === "task-clear-rules") { this.view.filters = []; this.view.sorts = []; this.save(true); this.render(); }
      else if (action === "task-fields") this.openFieldManager();
    }

    openAttachment(idValue, downloadName = "") {
      const blob = this.safety.getAttachmentBlob(idValue); if (!blob) return this.toast("附件内容缺失");
      const url = URL.createObjectURL(blob), anchor = document.createElement("a"); anchor.href = url;
      if (downloadName) { anchor.download = downloadName; anchor.click(); } else window.open(url, "_blank", "noopener");
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }

    async deleteTask(taskId) {
      const task = this.task(taskId); if (!task) return;
      await this.safety.recordRecovery("task-delete", `删除任务“${this.titleOf(task)}”`, { task: clone(task) });
      this.state.tasks = this.state.tasks.filter((entry) => entry.id !== taskId); this.closeDrawer(); await this.options.persist(true, "danger"); this.render(); this.toast("任务已删除，可在 30 天内恢复");
    }

    async restoreTaskHistory(historyId) {
      const record = await this.safety.getTaskHistoryRecord(historyId), current = this.task(this.openTaskId);
      if (!record || record.kind !== "task" || !current) return this.toast("该历史版本已不存在");
      if (!confirm(`恢复 ${new Date(record.createdAt).toLocaleString("zh-CN")} 的任务版本吗？当前版本会先进入紧急恢复。`)) return;
      await this.safety.recordRecovery("task-history-restore", `恢复任务“${this.titleOf(current)}”历史前`, { task: clone(current) });
      const restored = clone(record.snapshot); delete restored.checksum; delete restored.revision; Object.assign(current, restored, { id: current.id, updatedAt: now() });
      const saved = await this.options.persist(true, "manual"); this.render(); this.renderDrawer(); this.toast(saved ? "任务历史版本已恢复" : "恢复内容仍在内存中，请重试保存");
    }

    bind() {
      this.el.nav.addEventListener("click", (event) => { event.stopImmediatePropagation(); this.enter(); });
      document.querySelectorAll(".nav-item:not(#taskNavButton)").forEach((item) => item.addEventListener("click", () => this.leave(), { capture: true }));
      document.querySelector("#categoryList")?.addEventListener("click", (event) => { if (this.active && event.target.closest(".tree-folder-button,.tree-note-button,.tree-file-button")) this.leave(); }, { capture: true });
      document.querySelectorAll("[data-task-view]").forEach((button) => button.addEventListener("click", () => { this.cancelDraft(false); this.viewMode = button.dataset.taskView; this.render(); }));
      this.el.add.addEventListener("click", () => this.createTask());
      this.el.fields.addEventListener("click", () => this.openFieldManager());
      this.el.filter.addEventListener("click", () => this.openRuleDialog("filter"));
      this.el.sort.addEventListener("click", () => this.openRuleDialog("sort"));
      this.el.cards.addEventListener("click", () => this.openCardSettings());
      this.el.group.addEventListener("change", () => { if (this.viewMode === "board") this.view.boardGroupFieldId = this.el.group.value; else this.view.tableGroupFieldId = this.el.group.value; this.save(true, "manual"); this.render(); });
      this.el.attachment.addEventListener("change", () => { if (this.el.attachment.files.length) this.uploadAttachments([...this.el.attachment.files]); this.el.attachment.value = ""; });
      this.el.workspace.addEventListener("click", (event) => this.handleWorkspaceClick(event));
      this.el.workspace.addEventListener("dblclick", (event) => { if (event.target.closest("button,a,input[type='range'],[data-column-resizer]")) return; const target = event.target.closest("[data-task-row],[data-task-card]"), taskId = target?.dataset.taskRow || target?.dataset.taskCard; if (!taskId || this.task(taskId)?._draft) return; if (document.activeElement?.closest?.(`[data-task-row="${taskId}"],[data-task-card="${taskId}"]`) && document.activeElement.matches(".task-cell-editor input,.task-cell-editor textarea,.task-cell-editor select")) document.activeElement.blur(); setTimeout(() => this.openDrawer(taskId), 0); });
      this.el.workspace.addEventListener("pointerdown", (event) => { if (event.target.closest("[data-column-resizer]")) this.startColumnResize(event); });
      this.el.workspace.addEventListener("dblclick", (event) => { const handle = event.target.closest("[data-column-resizer]"); if (handle) { event.preventDefault(); event.stopPropagation(); this.autoFitField(handle.dataset.columnResizer); } });
      this.el.workspace.addEventListener("input", (event) => { const draftInput = event.target.closest("[data-draft-title]"); if (draftInput) this.handleDraftInput(draftInput); const progress = event.target.closest("[data-progress-task]"); if (progress) this.handleProgressInput(progress, false); });
      this.el.workspace.addEventListener("change", (event) => { const progress = event.target.closest("[data-progress-task]"); if (progress) this.handleProgressInput(progress, true); });
      this.el.workspace.addEventListener("focusout", (event) => { const input = event.target.closest("[data-draft-title]"); if (!input) return; setTimeout(() => { const task = this.task(input.dataset.draftTitle); if (!task) return; const staysInTask = Boolean(document.activeElement?.closest?.(`[data-task-row="${task.id}"],[data-task-card="${task.id}"]`)); if (task._draft) { if (!staysInTask) this.cancelDraft(); return; } if (staysInTask) { const titleField = this.role("title"); task.values[titleField.id] = input.value.trim(); if (task.values[titleField.id]) delete task._quickNew; this.save(false, "auto"); } else this.finishDraftInput(input); }, 0); });
      this.el.workspace.addEventListener("keydown", (event) => { const input = event.target.closest("[data-draft-title]"); if (!input) return; if (event.key === "Escape") { event.preventDefault(); this.cancelDraft(); } else if (event.key === "Enter") { event.preventDefault(); this.finishDraftInput(input); } else if (event.key === "Tab") { event.preventDefault(); this.finishDraftInput(input, event.shiftKey ? -1 : 1); } });
      this.el.workspace.addEventListener("dragstart", (event) => {
        if (event.target.closest("button,a,input,select,textarea,[contenteditable='true'],[data-column-resizer]")) return event.preventDefault();
        const row = event.target.closest("[data-task-row]");
        if (row && this.viewMode === "table" && !this.task(row.dataset.taskRow)?._draft) {
          if ((this.view.sorts || []).length) { event.preventDefault(); return this.toast("当前已启用字段排序，清除排序后可手动拖动"); }
          this.dragTaskId = row.dataset.taskRow; row.classList.add("task-row-dragging");
          event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/task-id", this.dragTaskId); return;
        }
        const card = event.target.closest("[data-task-card]");
        if (card && !this.task(card.dataset.taskCard)?._draft) { this.dragTaskId = card.dataset.taskCard; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/task-id", this.dragTaskId); }
      });
      this.el.workspace.addEventListener("dragover", (event) => {
        const boardDrop = event.target.closest("[data-board-drop]");
        if (boardDrop) { event.preventDefault(); boardDrop.classList.add("drag-over"); return; }
        if (!this.dragTaskId || this.viewMode !== "table") return;
        const group = event.target.closest("[data-task-group]"), row = event.target.closest("[data-task-row]"), quickRow = event.target.closest(".task-quick-row");
        if (!group) return;
        if (row && (row.dataset.taskRow === this.dragTaskId || this.task(row.dataset.taskRow)?._draft)) {
          this.el.table.querySelectorAll(".task-drop-before,.task-drop-after,.task-drop-end").forEach((element) => element.classList.remove("task-drop-before", "task-drop-after", "task-drop-end"));
          this.tableDrop = null; return;
        }
        event.preventDefault(); event.dataTransfer.dropEffect = "move";
        this.el.table.querySelectorAll(".task-drop-before,.task-drop-after,.task-drop-end").forEach((element) => element.classList.remove("task-drop-before", "task-drop-after", "task-drop-end"));
        this.tableDrop = null;
        if (row) {
          const rect = row.getBoundingClientRect(), after = event.clientY >= rect.top + rect.height / 2;
          row.classList.add(after ? "task-drop-after" : "task-drop-before");
          this.tableDrop = { targetId: row.dataset.taskRow, after, groupId: group.dataset.taskGroup };
        } else if (quickRow || event.target.closest("tbody")) {
          const endRow = quickRow || group.querySelector(".task-quick-row"); endRow?.classList.add("task-drop-end");
          this.tableDrop = { targetId: "", after: true, groupId: group.dataset.taskGroup };
        }
      });
      this.el.workspace.addEventListener("dragleave", (event) => {
        event.target.closest("[data-board-drop]")?.classList.remove("drag-over");
        if (this.viewMode === "table" && !this.el.table.contains(event.relatedTarget)) this.clearTableDropIndicators();
      });
      this.el.workspace.addEventListener("drop", (event) => {
        const drop = event.target.closest("[data-board-drop]");
        if (!drop && this.viewMode === "table" && this.dragTaskId && this.tableDrop) {
          event.preventDefault(); const taskId = this.dragTaskId, tableDrop = { ...this.tableDrop };
          this.clearTableDropIndicators(); this.dragTaskId = null; this.reorderTableTask(taskId, tableDrop); return;
        }
        if (!drop || !this.dragTaskId) return; event.preventDefault();
        const task = this.task(this.dragTaskId), field = this.field(this.view.boardGroupFieldId);
        if (task && field) {
          if (field.required && drop.dataset.boardDrop === "unset") { this.toast(`“${field.name}”是必填字段`); this.dragTaskId = null; return this.render(); }
          task.values[field.id] = drop.dataset.boardDrop === "unset" ? "" : drop.dataset.boardDrop; task.updatedAt = now(); this.applyProgressLink(task, field, task.values[field.id]);
          const target = event.target.closest("[data-task-card]"), ordered = this.state.tasks.slice().sort((a, b) => a.sortOrder - b.sortOrder), sourceIndex = ordered.findIndex((entry) => entry.id === task.id);
          if (sourceIndex >= 0) ordered.splice(sourceIndex, 1);
          const targetIndex = target ? ordered.findIndex((entry) => entry.id === target.dataset.taskCard) : ordered.length;
          ordered.splice(targetIndex < 0 ? ordered.length : targetIndex, 0, task); ordered.forEach((entry, index) => { entry.sortOrder = index; });
          this.save(true, "manual"); this.render();
        }
        this.dragTaskId = null;
      });
      this.el.workspace.addEventListener("dragend", () => {
        this.el.workspace.querySelectorAll(".drag-over").forEach((element) => element.classList.remove("drag-over"));
        this.clearTableDropIndicators(); this.dragTaskId = null;
      });
      this.modalBackdrop.addEventListener("click", (event) => { if (event.target === this.modalBackdrop || event.target.closest("[data-task-modal-close]")) this.closeModal(); });
      this.modal.addEventListener("click", (event) => this.handleModalClick(event));
      this.modal.addEventListener("change", (event) => { const form = event.target.closest("[data-field-form]"); if (form && ["type", "percent"].includes(event.target.name)) this.updateFieldConfigVisibility(form); });
      this.modal.addEventListener("submit", (event) => this.handleModalSubmit(event));
      this.drawer.addEventListener("click", (event) => this.handleDrawerClick(event));
      this.drawer.addEventListener("change", (event) => this.handleDrawerChange(event));
      this.drawer.addEventListener("input", (event) => { const progress = event.target.closest("[data-progress-task]"); if (progress) this.handleProgressInput(progress, false); });
      this.drawer.addEventListener("focusout", (event) => { const input = event.target.closest("[data-detail-input]"); if (input && !["select-one", "select-multiple", "checkbox"].includes(input.type)) this.commitDrawerInput(input); });
      document.addEventListener("keydown", (event) => { if (event.key === "Escape") { if (!this.modalBackdrop.hidden) this.closeModal(); else if (!this.drawer.hidden) this.closeDrawer(); } });
    }

    handleWorkspaceClick(event) {
      const cell = event.target.closest("[data-task-cell]");
      if (event.target.closest("[data-checkbox-task]")) { const button = event.target.closest("[data-checkbox-task]"); this.updateValue(button.dataset.checkboxTask, button.dataset.checkboxField, !this.task(button.dataset.checkboxTask)?.values[button.dataset.checkboxField], true); return; }
      if (event.target.closest("[data-task-link-browser]")) return window.open(event.target.closest("[data-task-link-browser]").dataset.taskLinkBrowser, "_blank", "noopener");
      if (event.target.closest("[data-task-link]")) return this.options.openLink(event.target.closest("[data-task-link]").dataset.taskLink);
      if (event.target.closest("[data-open-note]")) return this.options.openNote(event.target.closest("[data-open-note]").dataset.openNote);
      if (event.target.closest("[data-preview-attachment]")) return this.openAttachment(event.target.closest("[data-preview-attachment]").dataset.previewAttachment);
      if (event.target.closest("[data-upload-task]")) { const button = event.target.closest("[data-upload-task]"); this.uploadTarget = { taskId: button.dataset.uploadTask, fieldId: button.dataset.uploadField }; this.el.attachment.click(); return; }
      if (event.target.closest("[data-open-task]")) return this.openDrawer(event.target.closest("[data-open-task]").dataset.openTask);
      if (event.target.closest("[data-field-edit]")) return this.openFieldManager(event.target.closest("[data-field-edit]").dataset.fieldEdit);
      if (event.target.closest("[data-add-field]")) return this.openFieldManager("__new__") || this.showNewFieldForm();
      if (event.target.closest("[data-group-add],[data-task-empty-add]")) { const button = event.target.closest("[data-group-add],[data-task-empty-add]"), initial = {}, groupId = button.dataset.groupAdd; if (groupId && groupId !== "all" && groupId !== "unset" && this.viewMode === "table" && this.view.tableGroupFieldId) initial[this.view.tableGroupFieldId] = groupId; if (groupId && groupId !== "all" && groupId !== "unset" && this.viewMode === "board" && this.view.boardGroupFieldId) initial[this.view.boardGroupFieldId] = groupId; return this.createTask(initial); }
      if (event.target.closest("[data-toggle-task-group]")) { const group = event.target.closest("[data-toggle-task-group]").dataset.toggleTaskGroup, list = new Set(this.view.collapsedGroups || []); list.has(group) ? list.delete(group) : list.add(group); this.view.collapsedGroups = [...list]; this.save(); return this.render(); }
      if (event.target.closest("[data-remove-filter]")) { this.view.filters = this.view.filters.filter((rule) => rule.id !== event.target.closest("[data-remove-filter]").dataset.removeFilter); this.save(true); return this.render(); }
      if (event.target.closest("[data-remove-sort]")) { this.view.sorts = this.view.sorts.filter((rule) => rule.id !== event.target.closest("[data-remove-sort]").dataset.removeSort); this.save(true); return this.render(); }
      if (cell && !event.target.closest("button,a,input,select,textarea")) this.startCellEdit(cell);
    }

    showNewFieldForm() { const target = this.modal.querySelector("#taskFieldForm"); if (target) target.innerHTML = this.fieldForm(null, true); }

    handleModalClick(event) {
      const select = event.target.closest("[data-field-select]"); if (select) return this.openFieldManager(select.dataset.fieldSelect);
      if (event.target.closest("[data-field-new]")) return this.showNewFieldForm();
      const move = event.target.closest("[data-field-up],[data-field-down]"); if (move) {
        event.stopPropagation(); const fieldId = move.dataset.fieldUp || move.dataset.fieldDown, fields = this.fields, index = fields.findIndex((field) => field.id === fieldId), nextIndex = move.dataset.fieldUp ? index - 1 : index + 1;
        if (nextIndex >= 0 && nextIndex < fields.length) { [fields[index].order, fields[nextIndex].order] = [fields[nextIndex].order, fields[index].order]; this.save(true, "field-change"); this.openFieldManager(fieldId); this.render(); } return;
      }
      if (event.target.closest("[data-delete-field]")) this.deleteField(event.target.closest("[data-delete-field]").dataset.deleteField);
    }

    updateFieldConfigVisibility(form) {
      const isNumber = form?.elements?.type?.value === "number", isPercent = isNumber && form.elements.percent.checked;
      form?.querySelector(".task-number-config")?.classList.toggle("task-config-hidden", !isNumber);
      form?.querySelector(".task-progress-config")?.classList.toggle("task-config-hidden", !isPercent);
    }

    handleModalSubmit(event) {
      event.preventDefault();
      if (event.target.matches("[data-field-form]")) return this.saveField(event.target);
      if (event.target.matches("[data-rule-form]")) { const form = event.target, kind = form.dataset.ruleForm; if (kind === "filter") this.view.filters.push({ id: id("filter"), fieldId: form.elements.fieldId.value, operator: form.elements.operator.value, value: form.elements.value.value }); else this.view.sorts.push({ id: id("sort"), fieldId: form.elements.fieldId.value, direction: form.elements.direction.value }); this.save(true); this.closeModal(); return this.render(); }
      if (event.target.matches("[data-card-form]")) { const values = [...event.target.querySelectorAll("input:checked")].map((input) => input.value); if (values.length > 5) return this.toast("卡片最多显示 5 个字段"); this.view.cardFieldIds = values; this.save(true); this.closeModal(); this.render(); }
    }

    handleDrawerClick(event) {
      if (event.target.closest("[data-task-drawer-close]")) return this.closeDrawer();
      if (event.target.closest("[data-task-delete]")) return this.deleteTask(this.openTaskId);
      if (event.target.closest("[data-task-schedule]")) return this.options.scheduleTask?.(this.openTaskId);
      if (event.target.closest("[data-restore-task-history]")) return this.restoreTaskHistory(event.target.closest("[data-restore-task-history]").dataset.restoreTaskHistory);
      if (event.target.closest("[data-open-note]")) return this.options.openNote(event.target.closest("[data-open-note]").dataset.openNote);
      if (event.target.closest("[data-task-link-browser]")) return window.open(event.target.closest("[data-task-link-browser]").dataset.taskLinkBrowser, "_blank", "noopener");
      if (event.target.closest("[data-task-link]")) return this.options.openLink(event.target.closest("[data-task-link]").dataset.taskLink);
      if (event.target.closest("[data-upload-task]")) { const button = event.target.closest("[data-upload-task]"); this.uploadTarget = { taskId: button.dataset.uploadTask, fieldId: button.dataset.uploadField }; return this.el.attachment.click(); }
      if (event.target.closest("[data-preview-attachment]")) return this.openAttachment(event.target.closest("[data-preview-attachment]").dataset.previewAttachment);
      if (event.target.closest("[data-download-attachment]")) { const button = event.target.closest("[data-download-attachment]"); return this.openAttachment(button.dataset.downloadAttachment, button.dataset.downloadName); }
      if (event.target.closest("[data-remove-task-attachment]")) { const button = event.target.closest("[data-remove-task-attachment]"), task = this.task(button.dataset.removeTaskAttachment), list = task.values[button.dataset.removeField] || []; list.splice(Number(button.dataset.removeIndex), 1); this.updateValue(task.id, button.dataset.removeField, list, true); this.renderDrawer(); }
    }

    handleDrawerChange(event) { const progress = event.target.closest("[data-progress-task]"); if (progress) return this.handleProgressInput(progress, true); const input = event.target.closest("[data-detail-input]"); if (input) this.commitDrawerInput(input); }
    commitDrawerInput(input) { const field = this.field(input.dataset.detailInput); if (!field) return; let value = input.value; if (field.type === "number") value = input.value === "" ? null : Number(input.value); if (field.type === "checkbox") value = input.checked; if (field.type === "multiSelect") value = [...input.selectedOptions].map((option) => option.value); this.updateValue(this.openTaskId, field.id, value); if (field.systemRole === "title") document.querySelector("#taskDetailTitle").textContent = value || "未命名任务"; }
  }

export { TaskManager };
