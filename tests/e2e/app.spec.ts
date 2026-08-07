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
  if (await page.locator("#safetyBackdrop").isVisible()) await page.locator("#safetyClose").click();
});

test("loads the existing desktop experience", async ({ page }, testInfo) => {
  await expect(page.locator("#noteList")).toBeVisible();
  await expect(page.locator("#vue-shell-root")).toBeAttached();
  if (testInfo.project.name === "desktop-chromium") {
    await expect(page.locator(".mobile-bottom-nav")).toBeHidden();
  }
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
  await expect(page.locator(".series-card", { hasText: "每周规划回归" })).toHaveCount(1);
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
  let totalCard = page.locator(".productivity-schedule-card", { hasText: "时间线回归安排" });
  await totalCard.getByRole("button", { name: "标记完成", exact: true }).click();
  await expect(totalCard).toHaveClass(/done/);
  await page.reload();
  await expect(page).toHaveURL(/#\/schedule\/all$/);
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
