import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }, testInfo) => {
  if (testInfo.title === "visual baselines for all workspaces") {
    await page.clock.setFixedTime(new Date("2026-08-02T08:00:00+08:00"));
  }
  page.on("pageerror", (error) => console.error(`[pageerror] ${error.message}`));
  page.on("console", (message) => { if (message.type() === "error") console.error(`[console] ${message.text()}`); });
  page.on("response", (response) => {
    if (response.request().resourceType() === "script" && !String(response.headers()["content-type"] || "").includes("javascript")) {
      console.error(`[script-mime] ${response.status()} ${response.url()} ${response.headers()["content-type"] || "missing"}`);
    }
  });
  await page.goto("/#/notes");
  await expect(page.locator("#workspace")).toBeVisible();
  await expect(page.locator("#saveIndicator")).not.toHaveClass(/failed/);
  await page.waitForTimeout(450);
  await page.locator("#safetyBackdrop").waitFor({ state: "visible", timeout: 1_500 }).catch(() => undefined);
  if (await page.locator("#safetyBackdrop").isVisible()) await page.locator("#safetyClose").click();
});

test("loads the existing desktop experience", async ({ page }, testInfo) => {
  await expect(page.locator("#noteList")).toBeVisible();
  await expect(page.locator("#vue-shell-root")).toBeAttached();
  if (testInfo.project.name === "desktop-chromium") {
    await expect(page.locator(".mobile-bottom-nav")).toBeHidden();
  }
});

test("switches and persists all seven interface color themes", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "theme persistence regression runs once on desktop");
  const themes = [
    ["light", "#3976f6"], ["warm", "#b65f35"], ["mint", "#168874"], ["purple", "#7656c9"],
    ["rose", "#c45c7a"], ["dark", "#6c9aff"], ["ice", "#2795cc"],
  ] as const;
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.locator("#themeToggle").click();
  await expect(page.locator("#themePopover [data-theme-option]")).toHaveCount(7);

  for (const [theme, primary] of themes) {
    if (await page.locator("#themePopover").isHidden()) await page.locator("#themeToggle").click();
    const option = page.locator(`[data-theme-option="${theme}"]`);
    await option.click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(option).toHaveAttribute("aria-checked", "true");
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--primary").trim())).toBe(primary);
    expect(await page.evaluate(() => localStorage.getItem("easynote-theme"))).toBe(theme);
  }

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "ice");
  await page.locator("#themeToggle").click();
  await expect(page.locator('[data-theme-option="ice"]')).toHaveClass(/active/);
});

test("applies font, size and one-shot format painter in the rich-text editor", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "rich-text toolbar regression runs once on desktop");
  await page.locator("#newNoteTop").click();
  const editor = page.locator("#contentEditor");
  await editor.evaluate((element) => {
    element.innerHTML = '<p><span id="format-source">格式来源</span> 与 <span id="format-target">格式目标</span></p>';
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  });
  const selectContents = async (selector: string) => page.locator(selector).evaluate((element) => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  const selectedTextStyle = (selector: string) => page.locator(selector).evaluate((element) => {
    let leaf: Element = element;
    while (leaf.firstElementChild) leaf = leaf.firstElementChild;
    const style = getComputedStyle(leaf as HTMLElement);
    return { family: style.fontFamily, size: style.fontSize, weight: style.fontWeight };
  });

  await selectContents("#format-source");
  await page.locator("#fontFamilySelect").selectOption("SimHei, sans-serif");
  await page.locator("#fontSizeSelect").selectOption("24px");
  await page.locator('#formatToolbar button[data-command="bold"]').click();
  await expect.poll(() => selectedTextStyle("#format-source")).toMatchObject({ size: "24px", weight: "700" });
  expect((await selectedTextStyle("#format-source")).family).toContain("SimHei");

  await selectContents("#format-source");
  await page.locator("#formatPainterButton").click();
  await expect(page.locator("#formatPainterButton")).toHaveClass(/active/);
  await selectContents("#format-target");
  await editor.dispatchEvent("mouseup");
  await expect(page.locator("#formatPainterButton")).not.toHaveClass(/active/);
  await expect.poll(() => selectedTextStyle("#format-target")).toMatchObject({ size: "24px", weight: "700" });
  expect((await selectedTextStyle("#format-target")).family).toContain("SimHei");
});

test("inserts editable Mermaid source before rendering in both note editors", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Mermaid context-menu workflow runs once on desktop");

  await page.locator("#newNoteTop").click();
  const mainEditor = page.locator("#contentEditor");
  await mainEditor.click({ button: "right", position: { x: 80, y: 80 } });
  await page.locator("#contextMenu .context-item", { hasText: "插入 Mermaid 流程图" }).click();

  const mainSource = mainEditor.locator('pre[data-code-language="mermaid"]');
  await expect(mainSource).toBeVisible();
  await expect(mainEditor.locator(".mermaid-diagram")).toHaveCount(0);
  await mainSource.fill("flowchart LR\nA[输入源码] --> B[手动渲染]");
  await mainSource.click({ button: "right" });
  await page.locator("#contextMenu .context-item", { hasText: "渲染 Mermaid 图表" }).click();

  const mainDiagram = mainEditor.locator(".mermaid-diagram");
  await expect(mainDiagram.locator("svg")).toBeVisible();
  expect(await mainDiagram.evaluate((diagram) => {
    const svg = diagram.querySelector("svg")!;
    return svg.getBoundingClientRect().width <= diagram.getBoundingClientRect().width + 1;
  })).toBe(true);
  await mainDiagram.locator("svg").click({ button: "right" });
  await page.locator("#contextMenu .context-item", { hasText: "编辑 Mermaid 源码" }).click();
  await expect(mainSource).toContainText("输入源码");

  const floatingPagePromise = context.waitForEvent("page");
  await page.locator("#floatingNotesButton").click();
  const floating = await floatingPagePromise;
  const floatingEditor = floating.locator(".floating-content-editor");
  await expect(floatingEditor).toBeVisible();
  await floatingEditor.click({ button: "right", position: { x: 80, y: 80 } });
  await floating.getByRole("button", { name: "插入 Mermaid 流程图", exact: true }).click();

  const floatingSource = floatingEditor.locator('pre[data-code-language="mermaid"]').last();
  await expect(floatingSource).toBeVisible();
  await expect(floatingEditor.locator(".mermaid-diagram")).toHaveCount(0);
  await floatingSource.fill("flowchart TD\nA[悬浮窗编辑] --> B[悬浮窗渲染]");
  await floatingSource.click({ button: "right" });
  await floating.getByRole("button", { name: "渲染 Mermaid 图表", exact: true }).click();

  const floatingDiagram = floatingEditor.locator(".mermaid-diagram");
  await expect(floatingDiagram.locator("svg")).toBeVisible();
  expect(await floatingDiagram.evaluate((diagram) => {
    const svg = diagram.querySelector("svg")!;
    return svg.getBoundingClientRect().width <= diagram.getBoundingClientRect().width + 1;
  })).toBe(true);
  await floatingDiagram.locator("svg").click({ button: "right" });
  await floating.getByRole("button", { name: "编辑 Mermaid 源码", exact: true }).click();
  await expect(floatingSource).toContainText("悬浮窗编辑");
});

test("retries the current page after a verified save failure", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "save recovery regression runs once on desktop");
  const title = `保存恢复验证-${Date.now()}`;
  await page.locator("#newNoteTop").click();
  await page.evaluate((failedTitle) => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value: any, key?: IDBValidKey) {
      if (this.name === "notes" && value?.title === failedTitle) {
        IDBObjectStore.prototype.put = original;
        throw new DOMException("simulated write failure", "UnknownError");
      }
      return key === undefined ? original.call(this, value) : original.call(this, value, key);
    };
  }, title);
  await page.locator("#titleInput").fill(title);
  await expect(page.locator("#saveIndicator")).toHaveClass(/failed/, { timeout: 10_000 });

  await page.locator("#saveIndicator").click();
  await expect(page.locator("#safetyBackdrop")).toBeVisible();
  await expect(page.locator("#retrySaveButton")).toBeEnabled();
  await page.locator("#retrySaveButton").click();
  await expect(page.locator("#saveIndicator")).toHaveClass(/verified/, { timeout: 20_000 });
  await expect(page.locator("#toast")).toHaveText("当前页面已重新保存并通过校验");
  await expect(page.locator("#retrySaveButton")).toBeDisabled();

  await page.locator("#safetyClose").click();
  await page.reload();
  await expect(page.locator("#noteList .note-card").filter({ hasText: title })).toBeVisible();
});

test("opens the backup directory picker before starting a save", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "directory picker regression runs once on desktop");
  await page.evaluate(() => {
    (window as any).__pickerSaveStatus = "";
    (window as any).showDirectoryPicker = () => {
      (window as any).__pickerSaveStatus = document.querySelector("#saveIndicator")?.textContent || "";
      return Promise.reject(new DOMException("test cancellation", "AbortError"));
    };
  });
  await page.locator("#safetyCenterButton").click();
  await expect(page.locator("#safetyBackdrop")).toBeVisible();
  await page.locator("#chooseBackupDirectoryButton").click();
  await expect.poll(() => page.evaluate(() => (window as any).__pickerSaveStatus)).toContain("已验证保存");
});

test("edits and safely saves a full note inside the always-on-top companion window", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Document Picture-in-Picture is a desktop Chromium feature");
  const floatingPagePromise = context.waitForEvent("page");
  await page.locator("#floatingNotesButton").click();
  const floating = await floatingPagePromise;
  floating.on("pageerror", (error) => console.error(`[floating-pageerror] ${error.message}`));
  await expect(floating.locator(".floating-note-workspace")).toBeVisible();
  await expect(page.locator("#editorPanel")).toHaveClass(/floating-note-locked/);

  const listLayoutToggle = floating.locator(".floating-layout-toggle").last();
  await listLayoutToggle.click();
  await expect(floating.locator(".floating-note-workspace")).toHaveClass(/list-hidden/);
  await expect(floating.locator(".floating-note-list-panel")).toBeHidden();
  await expect(floating.locator(".floating-editor-new-note")).toBeVisible();
  await floating.locator(".floating-editor-new-note").click();
  await floating.locator(".floating-list-toggle").click();
  await expect(floating.locator(".floating-note-list-panel")).toBeVisible();
  await expect.poll(() => floating.evaluate(() => localStorage.getItem("easynote-floating-list-visible"))).toBe("true");
  await expect(floating.getByLabel("切换具体笔记")).toBeVisible();
  await floating.getByLabel("切换具体笔记").click();
  await expect(floating.locator(".floating-note-picker-popover")).toBeVisible();
  await expect(floating.locator(".floating-note-tree-folder").first()).toBeVisible();
  const title = `悬浮窗口笔记-${Date.now()}`;
  await floating.locator(".floating-title-input").fill(title);
  await floating.locator(".floating-content-editor").fill("在其他网页上方完成的完整笔记正文");
  const floatingEditor = floating.locator(".floating-content-editor");
  await expect.poll(() => floatingEditor.evaluate((root) => root.lastElementChild?.tagName === "P" && !(root.lastElementChild.textContent || "").trim())).toBe(true);
  const editorBox = await floatingEditor.boundingBox();
  if (editorBox) await floatingEditor.click({ position: { x: Math.min(120, editorBox.width - 10), y: editorBox.height - 8 } });
  await expect.poll(() => floatingEditor.evaluate((root) => {
    const selection = root.ownerDocument.getSelection();
    return Boolean(selection?.anchorNode && root.lastElementChild?.contains(selection.anchorNode));
  })).toBe(true);
  await floatingEditor.evaluate((root) => {
    root.insertAdjacentHTML("beforeend", "<pre>block-preserved-text</pre>");
    root.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  });
  await floatingEditor.locator("pre").click({ button: "right" });
  await expect(floating.locator(".floating-editor-context-menu")).toBeVisible();
  await floating.locator(".floating-editor-context-menu button").filter({ hasText: /保留文字/ }).click();
  await expect(floatingEditor.locator("pre")).toHaveCount(0);
  await expect(floatingEditor).toContainText("block-preserved-text");
  await floating.locator('.floating-format-toolbar input[type="file"]').setInputFiles({
    name: "floating-note.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
  });
  await expect.poll(() => floating.locator(".floating-content-editor img").evaluate((image: HTMLImageElement) => image.naturalWidth > 0)).toBe(true);
  expect(await floating.locator(".floating-content-editor").innerHTML()).toContain("data-attachment-id");
  await floating.keyboard.press("Control+s");
  await expect(floating.locator(".floating-save-status")).toHaveText("已验证保存", { timeout: 15_000 });
  await floating.getByTitle("关闭悬浮窗口").click();
  await expect(page.locator("#editorPanel")).not.toHaveClass(/floating-note-locked/);

  await page.locator("#searchInput").fill(title);
  await expect(page.locator("#noteList")).toContainText(title);
  await page.reload();
  await page.locator("#searchInput").fill(title);
  await expect(page.locator("#noteList")).toContainText(title);
  await page.locator("#noteList .note-card").filter({ hasText: title }).click();
  await expect(page.locator("#titleInput")).toHaveValue(title);
  expect(await page.locator("#contentEditor").innerHTML()).toContain("data-attachment-id");
  await expect.poll(() => page.locator("#contentEditor img").evaluate((image: HTMLImageElement) => image.naturalWidth > 0)).toBe(true);
});

test("mobile navigation opens every workspace", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop-chromium", "mobile-only behavior");
  const nav = page.locator(".mobile-bottom-nav");
  await expect(nav).toBeVisible();
  await nav.getByRole("button", { name: /任务/ }).click();
  await expect(page).toHaveURL(/#\/tasks$/);
  await expect(page.locator("#taskWorkspace")).toBeVisible();
  await nav.getByRole("button", { name: /日程/ }).click();
  await expect(page).toHaveURL(/#\/schedule$/);
  await expect(page.locator("#scheduleWorkspace")).toBeVisible();
  await nav.getByRole("button", { name: /白板/ }).click();
  await expect(page).toHaveURL(/#\/whiteboards$/);
  await expect(page.locator("#whiteboardWorkspace")).toBeVisible();
  await nav.getByRole("button", { name: /笔记/ }).click();
  await expect(page).toHaveURL(/#\/notes$/);
  await expect(page.locator("#notePanel")).toBeVisible();
});

test("core note, task, schedule and whiteboard actions remain available", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "full mutation flow runs once on desktop");
  await expect(page.locator("#allCount")).toHaveText("3");
  await page.locator("#newNoteTop").click();
  await page.locator("#titleInput").fill("Vue 迁移回归笔记");
  await expect(page.locator("#allCount")).toHaveText("4");

  await page.locator("#taskNavButton").click();
  await page.locator("#taskAddButton").click();
  await expect(page.locator("[data-task-row]")).toHaveCount(1);

  await page.locator("#scheduleNavButton").click();
  await page.locator(".productivity-quick-form > input").fill("移动网页回归日程");
  await page.locator(".productivity-quick-form").evaluate((form: HTMLFormElement) => form.requestSubmit());
  await expect(page.locator(".productivity-schedule-card")).toContainText("移动网页回归日程");

  await page.locator("#whiteboardNavButton").click();
  await page.locator('[data-whiteboard-add="text"]').click();
  await expect(page.locator("[data-whiteboard-node]")).toHaveCount(1);
});

test("imports a portable v8 backup through the Vue schedule adapter and restores inline attachments", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "portable import regression runs once on desktop");
  const portable = {
    format: "easynote-portable", version: 8, exportedAt: new Date().toISOString(),
    categories: [{ id: "recovered", name: "恢复", color: "#4f7df3", parentId: null }],
    files: [],
    notes: [{
      id: "recovered-note", title: "便携备份恢复验证", categoryId: "recovered", tags: [], favorite: false,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), deletedAt: null,
      content: '<p>恢复正文</p><img data-attachment-id="old-device-id" alt="恢复图片" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=">',
    }],
    tasks: [], taskFields: [], taskViews: [], scheduleEntries: [], scheduleSeries: [], scheduleOccurrenceStates: [],
    scheduleDailyNotes: [], focusSessions: [], reviews: [], goals: [], milestones: [], whiteboards: [],
  };
  await page.locator("#importFile").setInputFiles({
    name: "portable-v8.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(portable)),
  });
  await expect(page.locator("#dialogBackdrop")).toBeVisible();
  await page.locator("#dialogConfirm").click();
  await expect(page.locator("#toast")).toHaveText("数据导入成功并已通过回读校验");
  const stored = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("easynote-db"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const all = (storeName: string) => new Promise<any[]>((resolve, reject) => {
      const request = db.transaction(storeName, "readonly").objectStore(storeName).getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const [notes, attachments] = await Promise.all([all("notes"), all("attachments")]); db.close();
    return { notes, attachmentCount: attachments.length };
  });
  expect(stored.notes).toHaveLength(1);
  expect(stored.notes[0].title).toBe("便携备份恢复验证");
  expect(stored.notes[0].content).toContain("data-attachment-id=");
  expect(stored.attachmentCount).toBe(1);
  const importedImage = page.locator('#contentEditor img[data-attachment-id]');
  await expect(importedImage).toBeVisible();
  await expect.poll(() => importedImage.evaluate((image: HTMLImageElement) => ({ width: image.naturalWidth, height: image.naturalHeight }))).toEqual({ width: 1, height: 1 });
  await page.reload();
  const reloadedImage = page.locator('#contentEditor img[data-attachment-id]');
  await expect(reloadedImage).toBeVisible();
  await expect.poll(() => reloadedImage.evaluate((image: HTMLImageElement) => image.naturalWidth > 0 && image.naturalHeight > 0)).toBe(true);
  const rescue = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("easynote-rescue-db"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const latest = await new Promise<any>((resolve, reject) => {
      const request = db.transaction("snapshots", "readonly").objectStore("snapshots").get("latest"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    db.close();
    return { notes: latest?.data?.notes?.length || 0, attachments: latest?.attachments?.length || 0 };
  });
  expect(rescue).toEqual({ notes: 1, attachments: 1 });
});

test("keeps different multi-tab edits and preserves same-note conflicts", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "multi-tab persistence runs once on desktop");
  const second = await context.newPage();
  await second.goto("/#/notes");
  await expect(second.locator("#workspace")).toBeVisible();

  const firstTitle = `第一页笔记-${Date.now()}`;
  await page.locator("#newNoteTop").click();
  await page.locator("#titleInput").fill(firstTitle);
  await page.locator("#contentEditor").fill("第一页保存的正文");
  await page.waitForTimeout(1_200);

  const secondTitle = `第二页笔记-${Date.now()}`;
  await second.locator("#titleInput").fill(secondTitle);
  await second.locator("#contentEditor").fill("第二页同时保存的正文");
  await second.waitForTimeout(1_500);

  const readNotes = (target: typeof page) => target.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("easynote-db");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return new Promise<Array<{ title: string; content: string }>>((resolve, reject) => {
      const request = database.transaction("notes", "readonly").objectStore("notes").getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  });
  let notes = await readNotes(page);
  expect(notes.some((note) => note.title === firstTitle && note.content.includes("第一页保存的正文"))).toBeTruthy();
  expect(notes.some((note) => note.title === secondTitle && note.content.includes("第二页同时保存的正文"))).toBeTruthy();

  const sharedTitle = `并发笔记-${Date.now()}`;
  await page.locator("#newNoteTop").click();
  await page.locator("#titleInput").fill(sharedTitle);
  await page.waitForTimeout(1_300);
  const firstSharedCard = page.locator(".note-card", { hasText: sharedTitle });
  const secondSharedCard = second.locator(".note-card", { hasText: sharedTitle });
  await expect(firstSharedCard).toHaveCount(1);
  await expect(secondSharedCard).toHaveCount(1);
  await firstSharedCard.click();
  await secondSharedCard.click();
  await page.locator("#contentEditor").fill("来自第一页的并发内容");
  await second.locator("#contentEditor").fill("来自第二页的并发内容");
  await page.waitForTimeout(2_000);

  notes = await readNotes(page);
  const sharedVersions = notes.filter((note) => note.title.startsWith(sharedTitle));
  expect(sharedVersions).toHaveLength(2);
  expect(sharedVersions.some((note) => note.content.includes("来自第一页的并发内容"))).toBeTruthy();
  expect(sharedVersions.some((note) => note.content.includes("来自第二页的并发内容"))).toBeTruthy();
  expect(sharedVersions.some((note) => note.title.includes("多页面冲突副本"))).toBeTruthy();
  await second.close();
});

test("adds and reloads every custom task field type without hidden validation failures", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "mutation regression runs once");
  await page.locator("#taskNavButton").click();
  await page.locator("#taskFieldsButton").click();
  const fieldTypes = ["text", "number", "date", "singleSelect", "multiSelect", "link", "attachment", "noteLink"];
  for (const [index, type] of fieldTypes.entries()) {
    await page.locator("[data-field-new]").click();
    const form = page.locator("[data-field-form]");
    const name = `回归字段-${index + 1}-${type}`;
    await form.locator('input[name="name"]').fill(name);
    await form.locator('select[name="type"]').selectOption(type);
    await form.evaluate((node: HTMLFormElement) => node.requestSubmit());
    await expect(page.locator("[data-field-select]", { hasText: name })).toHaveCount(1);
    await expect(page.locator("[data-field-form-error]")).toBeHidden();
  }
  await page.getByRole("button", { name: "完成" }).click();
  await page.reload();
  await page.locator("#taskNavButton").click();
  await page.locator("#taskFieldsButton").click();
  for (const [index, type] of fieldTypes.entries()) await expect(page.locator("[data-field-select]", { hasText: `回归字段-${index + 1}-${type}` })).toHaveCount(1);
});

test("centers seven days and keeps a focus timer across reload", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "timer persistence runs once");
  await page.locator("#scheduleNavButton").click();
  const days = page.locator(".centered-week-strip button");
  await expect(days).toHaveCount(7);
  await expect(days.nth(3)).toHaveClass(/selected/);
  await page.locator(".focus-start-button").click();
  await page.locator(".focus-start-modal input").first().fill("专注回归测试");
  await page.locator(".focus-start-modal").evaluate((form: HTMLFormElement) => form.requestSubmit());
  await expect(page.locator(".focus-mini-main")).toContainText("专注回归测试");
  await page.evaluate(() => {
    const frame = document.createElement("iframe");
    frame.id = "pipTestFrame";
    document.body.append(frame);
    Object.defineProperty(window, "documentPictureInPicture", { configurable: true, value: { requestWindow: async () => frame.contentWindow } });
  });
  await page.getByRole("button", { name: "悬浮到桌面" }).click();
  const pip = page.frameLocator("#pipTestFrame");
  await expect(pip.locator(".focus-pip-card")).toContainText("专注回归测试");
  await pip.getByRole("button", { name: "暂停", exact: true }).click();
  await expect(page.locator(".focus-mini-main")).toContainText("已暂停");
  await expect(pip.locator(".focus-pip-status")).toHaveText("已暂停");
  const pausedTime = await page.locator(".focus-mini-main strong").textContent();
  await page.waitForTimeout(1_100);
  await expect(page.locator(".focus-mini-main strong")).toHaveText(pausedTime || "");
  await page.locator(".focus-mini-actions").getByRole("button", { name: "继续", exact: true }).click();
  await page.reload();
  await expect(page.locator(".focus-mini-main")).toContainText("专注回归测试");
  await page.locator(".focus-mini-actions .danger-text").click();
  await page.getByRole("link", { name: "专注记录" }).click();
  const historyRow = page.locator(".focus-history-table tbody tr", { hasText: "专注回归测试" });
  await expect(historyRow).toHaveCount(1);
  await expect(historyRow).toContainText("已放弃");
  await expect(historyRow).toContainText("未关联任务");
  await expect(historyRow.locator("td").nth(0)).not.toHaveText("—");
  await expect(historyRow.locator("td").nth(1)).not.toHaveText("—");
  await expect(page.locator(".focus-history-detail")).toContainText("专注回归测试");
});

test("persists weekly schedules, reviews, goals and milestones", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "productivity mutation flow runs once");
  await page.locator("#scheduleNavButton").click();

  await page.getByRole("link", { name: "固定日程" }).click();
  await page.getByRole("button", { name: "新建固定日程" }).click();
  let modal = page.locator(".productivity-modal");
  await modal.locator("input").first().fill("每周规划回归");
  await modal.locator("select").first().selectOption("weekly");
  await modal.locator('.weekday-picker input[value="1"]').check();
  await modal.getByLabel("时间类型").selectOption("timed");
  const seriesTimeInputs = modal.locator('input[type="time"]');
  await seriesTimeInputs.nth(0).fill("09:15");
  await seriesTimeInputs.nth(1).fill("10:45");
  await modal.getByLabel("提醒方式").selectOption("none");
  await modal.evaluate((form: HTMLFormElement) => form.requestSubmit());
  await expect(modal).toBeHidden();
  const seriesCard = page.locator(".series-card", { hasText: "每周规划回归" });
  await expect(seriesCard).toContainText("09:15–10:45");
  await seriesCard.click({ button: "right" });
  await page.locator(".schedule-context-menu").getByRole("menuitem", { name: "编辑固定日程" }).click();
  modal = page.locator(".productivity-modal");
  await modal.getByRole("button", { name: "添加时间段" }).click();
  const editedTimeInputs = modal.locator('input[type="time"]');
  await editedTimeInputs.nth(2).fill("14:00");
  await editedTimeInputs.nth(3).fill("15:00");
  await modal.evaluate((form: HTMLFormElement) => form.requestSubmit());
  await expect(modal).toBeHidden();
  await expect(seriesCard).toContainText("14:00–15:00");
  await page.getByRole("link", { name: "总日程", exact: true }).click();
  await page.getByRole("button", { name: "列表", exact: true }).click();
  const recurringListCards = page.locator(".productivity-schedule-card", { hasText: "每周规划回归" });
  await expect(recurringListCards.first()).toBeVisible();
  expect(await recurringListCards.count()).toBeGreaterThan(0);
  await page.getByRole("link", { name: "固定日程", exact: true }).click();
  await seriesCard.click({ button: "right" });
  await expect(page.locator(".schedule-context-menu")).toContainText("复制固定日程");
  await page.locator(".schedule-context-menu").getByRole("menuitem", { name: "暂停固定日程" }).click();
  await expect(seriesCard).toHaveClass(/paused/);

  await page.getByRole("link", { name: "复盘" }).click();
  await page.locator(".review-editor textarea").first().fill("完成了时间与规划中心回归");
  await page.locator(".review-editor").evaluate((form: HTMLFormElement) => form.requestSubmit());
  await expect(page.locator(".review-history > button")).toHaveCount(1);

  await page.getByRole("link", { name: "长期规划" }).click();
  await page.getByRole("button", { name: "新建目标" }).click();
  modal = page.locator(".productivity-modal");
  await modal.locator("input").first().fill("长期能力建设");
  await modal.evaluate((form: HTMLFormElement) => form.requestSubmit());
  const goal = page.locator(".goal-card", { hasText: "长期能力建设" });
  await expect(goal).toHaveCount(1);
  await goal.getByRole("button", { name: "添加" }).click();
  modal = page.locator(".productivity-modal");
  await modal.locator("input").first().fill("完成第一阶段");
  await modal.evaluate((form: HTMLFormElement) => form.requestSubmit());
  await expect(goal).toContainText("完成第一阶段");
  await goal.click({ button: "right", position: { x: 260, y: 24 } });
  await expect(page.locator(".schedule-context-menu")).toContainText("添加里程碑");
  await page.keyboard.press("Escape");
  const milestone = goal.locator(".milestone-list > label", { hasText: "完成第一阶段" });
  await milestone.click({ button: "right" });
  await expect(page.locator(".schedule-context-menu")).toContainText("编辑里程碑");
  await page.keyboard.press("Escape");

  await page.reload();
  await expect(page.locator(".goal-card", { hasText: "长期能力建设" })).toContainText("完成第一阶段");
  await page.getByRole("link", { name: "复盘" }).click();
  await expect(page.locator(".review-history > button")).toHaveCount(1);
  await page.getByRole("link", { name: "固定日程" }).click();
  const reloadedSeries = page.locator(".series-card", { hasText: "每周规划回归" });
  await expect(reloadedSeries).toHaveCount(1);
  await expect(reloadedSeries).toContainText("14:00–15:00");
});

test("opens task, note and web links from a schedule", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "cross-workspace link flow runs once");
  await page.locator("#taskNavButton").click();
  await page.waitForTimeout(800);
  if (await page.locator("#safetyBackdrop").isVisible()) await page.locator("#safetyClose").click();
  await page.locator("#taskAddButton").click();
  await page.locator("[data-draft-title]").fill("关联任务回归");
  await page.locator("[data-draft-title]").press("Enter");
  await expect(page.locator("[data-task-row]:not(.task-draft-row)")).toHaveCount(1);
  await page.locator("#scheduleNavButton").click();
  await page.locator(".productivity-header").getByRole("button", { name: "新建日程" }).click();
  const modal = page.locator(".productivity-modal");
  await modal.getByLabel("标题").fill("带快捷入口的日程");
  await modal.getByLabel("提醒方式").selectOption("none");
  await modal.getByLabel("关联任务").selectOption({ index: 1 });
  await modal.getByLabel("关联笔记").selectOption({ index: 1 });
  await modal.getByLabel("网址").fill("http://127.0.0.1:4174/#/notes");
  await modal.getByLabel("链接名称").fill("打开题库");
  await modal.evaluate((form: HTMLFormElement) => form.requestSubmit());
  await expect(modal).toBeHidden();
  let card = page.locator(".productivity-schedule-card", { hasText: "带快捷入口的日程" });
  await card.getByRole("button", { name: "任务", exact: true }).click();
  await expect(page.locator("#taskWorkspace")).toBeVisible();
  await expect(page.locator("#taskDetailDrawer")).toBeVisible();

  await page.locator("#scheduleNavButton").click();
  card = page.locator(".productivity-schedule-card", { hasText: "带快捷入口的日程" });
  await card.getByRole("button", { name: "笔记", exact: true }).click();
  await expect(page.locator("#notePanel")).toBeVisible();

  await page.locator("#scheduleNavButton").click();
  card = page.locator(".productivity-schedule-card", { hasText: "带快捷入口的日程" });
  const popupPromise = page.waitForEvent("popup");
  await card.getByRole("button", { name: "打开题库" }).click();
  const popup = await popupPromise;
  await expect.poll(() => popup.url()).toContain("127.0.0.1:4174/#/notes");
  await popup.close();
});

test("mobile date strip supports horizontal swipe", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "desktop-chromium", "touch layout only");
  await page.locator(".mobile-bottom-nav").getByRole("button", { name: /日程/ }).click();
  const center = page.locator(".centered-week-strip button").nth(3);
  const before = await center.locator("strong").textContent();
  const strip = page.locator(".centered-week-strip");
  await strip.dispatchEvent("touchstart", { changedTouches: [{ identifier: 1, clientX: 280, clientY: 100 }] });
  await strip.dispatchEvent("touchend", { changedTouches: [{ identifier: 1, clientX: 120, clientY: 100 }] });
  await expect(center).toHaveClass(/selected/);
  await expect(center.locator("strong")).not.toHaveText(before || "");
});

test("schedule scrolling, timeline and custom quotes stay usable", async ({ page }, testInfo) => {
  const mobileNav = page.locator(".mobile-bottom-nav");
  if (await mobileNav.isVisible()) await mobileNav.getByRole("button", { name: /日程/ }).click();
  else await page.locator("#scheduleNavButton").click();

  await expect(page.locator(".productivity-today-layout")).toBeVisible();
  await page.waitForTimeout(700);
  const pwaGuideClose = page.getByRole("button", { name: "知道了", exact: true });
  if (await pwaGuideClose.isVisible()) await pwaGuideClose.click();
  await page.locator(".productivity-quick-form > input").fill("时间线回归安排");
  if (testInfo.project.name === "desktop-chromium") {
    await page.locator(".productivity-quick-form input[type=time]").nth(0).fill("09:00");
    await page.locator(".productivity-quick-form input[type=time]").nth(1).fill("10:00");
  }
  await page.locator(".productivity-quick-form").evaluate((form: HTMLFormElement) => form.requestSubmit());
  await expect(page.locator(".productivity-schedule-card", { hasText: "时间线回归安排" })).toBeVisible();

  if (testInfo.project.name === "desktop-chromium") {
    await page.locator(".productivity-schedule-card", { hasText: "时间线回归安排" }).click({ button: "right" });
    await expect(page.locator(".schedule-context-menu")).toBeVisible();
    await expect(page.locator(".schedule-context-menu")).toContainText("编辑日程");
    await page.keyboard.press("Escape");
  }

  await page.getByRole("button", { name: "时间线", exact: true }).click();
  await expect(page.locator(".timeline-all-day")).toHaveCount(0);
  await expect(page.locator(".timeline-scroll")).toBeVisible();
  await expect(page.locator(".day-timeline")).toBeVisible();
  expect((await page.locator(".day-timeline").boundingBox())?.height || 0).toBeGreaterThan(900);

  await page.getByRole("button", { name: "管理语句", exact: true }).click();
  const quote = `保持节奏-${testInfo.project.name}`;
  await page.getByPlaceholder("写下一句想反复看到的话").fill(quote);
  if (await pwaGuideClose.isVisible()) await pwaGuideClose.click();
  await page.locator(".quote-add-form").getByRole("button", { name: "添加" }).click();
  await expect(page.locator(".motivation-card strong")).toHaveText(quote);
  await page.locator(".quote-manager").getByRole("button", { name: "完成" }).click();

  await page.getByRole("link", { name: "复盘", exact: true }).click();
  const saveReview = page.locator(".review-editor").getByRole("button", { name: "保存复盘与统计快照" });
  await saveReview.scrollIntoViewIfNeeded();
  await expect(saveReview).toBeVisible();

  await page.getByRole("link", { name: "总日程", exact: true }).click();
  await expect(page.locator(".month-calendar-day")).toHaveCount(42);
  await expect(page.locator(".month-calendar-event", { hasText: "时间线回归安排" })).toBeVisible();
  await page.getByRole("button", { name: "列表", exact: true }).click();
  let totalCard = page.locator(".productivity-schedule-card", { hasText: "时间线回归安排" });
  await totalCard.getByRole("button", { name: "标记完成", exact: true }).click();
  await expect(totalCard).toHaveClass(/done/);
  await page.reload();
  await expect(page).toHaveURL(/#\/schedule\/all$/);
  await page.getByRole("button", { name: "列表", exact: true }).click();
  totalCard = page.locator(".productivity-schedule-card", { hasText: "时间线回归安排" });
  await expect(totalCard).toHaveClass(/done/);
  await totalCard.getByRole("button", { name: "重新打开", exact: true }).click();
  await expect(totalCard).not.toHaveClass(/done/);
});

test("manifest is deployable and contains install icons", async ({ page }) => {
  const manifest = await page.evaluate(async () => {
    const response = await fetch("./manifest.webmanifest");
    if (!response.ok) throw new Error(`manifest request failed: ${response.status}`);
    return response.json();
  });
  expect(manifest.name).toBe("EasyNote");
  expect(manifest.display).toBe("standalone");
  expect(manifest.icons).toEqual(expect.arrayContaining([expect.objectContaining({ sizes: "192x192" }), expect.objectContaining({ sizes: "512x512" })]));
});

test("visual baselines for all workspaces", async ({ page }) => {
  await page.addStyleTag({ content: ".pwa-status,.toast,.save-indicator,.edited-time{visibility:hidden!important}" });
  const mobileNav = page.locator(".mobile-bottom-nav");
  const openWorkspace = async (desktopSelector: string, mobileLabel: RegExp) => {
    if (await mobileNav.isVisible()) await mobileNav.getByRole("button", { name: mobileLabel }).click();
    else await page.locator(desktopSelector).click();
  };
  await expect(page).toHaveScreenshot("notes-workspace.png", { animations: "disabled", maxDiffPixelRatio: 0.02 });
  await openWorkspace("#taskNavButton", /任务/);
  await expect(page.locator("#taskWorkspace")).toBeVisible();
  await expect(page).toHaveScreenshot("tasks-workspace.png", { animations: "disabled", maxDiffPixelRatio: 0.02 });
  await openWorkspace("#scheduleNavButton", /日程/);
  await expect(page.locator("#scheduleWorkspace")).toBeVisible();
  await expect(page).toHaveScreenshot("schedule-workspace.png", { animations: "disabled", maxDiffPixelRatio: 0.02 });
  await page.getByRole("button", { name: "时间线", exact: true }).click();
  await expect(page).toHaveScreenshot("schedule-timeline.png", { animations: "disabled", maxDiffPixelRatio: 0.02 });
  await page.getByRole("link", { name: "复盘", exact: true }).click();
  await expect(page).toHaveScreenshot("schedule-reviews.png", { animations: "disabled", maxDiffPixelRatio: 0.02 });
  await page.getByRole("link", { name: "长期规划", exact: true }).click();
  await expect(page.locator(".planning-empty")).toBeVisible();
  await expect(page).toHaveScreenshot("schedule-goals.png", { animations: "disabled", maxDiffPixelRatio: 0.02 });
  await openWorkspace("#whiteboardNavButton", /白板/);
  await expect(page.locator("#whiteboardWorkspace")).toBeVisible();
  await expect(page).toHaveScreenshot("whiteboard-workspace.png", { animations: "disabled", maxDiffPixelRatio: 0.02 });
});

test("keeps core data available after an offline reload", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "service worker offline check runs once in Chromium");
  await page.waitForFunction(() => "serviceWorker" in navigator);
  await page.reload();
  await expect(page.locator("#noteList")).toBeVisible();
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator("#workspace")).toBeVisible();
  await expect(page.locator("#noteList")).toBeVisible();
  await context.setOffline(false);
});
