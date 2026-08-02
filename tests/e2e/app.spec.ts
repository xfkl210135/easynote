import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
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
  await page.locator("#scheduleQuickInput").fill("移动网页回归日程");
  await page.locator("#scheduleQuickForm").evaluate((form: HTMLFormElement) => form.requestSubmit());
  await expect(page.locator(".schedule-agenda-item")).toContainText("移动网页回归日程");

  await page.locator("#whiteboardNavButton").click();
  await page.locator('[data-whiteboard-add="text"]').click();
  await expect(page.locator("[data-whiteboard-node]")).toHaveCount(1);
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
