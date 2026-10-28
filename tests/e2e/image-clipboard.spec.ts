import { expect, test, type Page } from "@playwright/test";

const IMAGE = {
  name: "clipboard-image.png",
  mimeType: "image/png",
  buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
};

async function preparePage(page: Page) {
  await page.goto("/#/notes");
  await expect(page.locator("#workspace")).toBeVisible();
  await expect(page.locator("#saveIndicator")).not.toHaveClass(/failed/);
  await page.waitForTimeout(450);
  await page.locator("#safetyBackdrop").waitFor({ state: "visible", timeout: 1_500 }).catch(() => undefined);
  if (await page.locator("#safetyBackdrop").isVisible()) await page.locator("#safetyClose").click();
}

async function mockImageClipboard(page: Page) {
  await page.evaluate(() => {
    const state = window as any;
    state.__imageClipboardWrites = 0;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { write: async () => { state.__imageClipboardWrites += 1; } },
    });
    state.ClipboardItem = class ClipboardItem {
      constructor(public items: Record<string, Blob>) {}
    };
  });
}

test("copies and cuts a selected image in the main note editor", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop clipboard regression runs once");
  await preparePage(page);
  await page.locator("#newNoteTop").click();
  await page.locator("#imageFile").setInputFiles(IMAGE);

  const image = page.locator("#contentEditor img");
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
  await mockImageClipboard(page);

  await image.click({ button: "right" });
  await expect(page.locator("#contextMenu .context-item", { hasText: "剪切图片" })).toBeVisible();
  await page.keyboard.press("Escape");
  await image.click();
  await expect(page.locator("#imageResizeOverlay")).toBeVisible();
  await page.keyboard.press("Control+c");
  await expect.poll(() => page.evaluate(() => (window as any).__imageClipboardWrites)).toBe(1);
  await expect(image).toBeVisible();

  await page.keyboard.press("Control+x");
  await expect(image).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).__imageClipboardWrites)).toBe(2);
  await expect(page.locator("#toast")).toHaveText("图片已剪切");
});

test("copies and cuts a selected image in the floating note editor", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "floating clipboard regression runs once");
  await preparePage(page);

  const floatingPagePromise = context.waitForEvent("page");
  await page.locator("#floatingNotesButton").click();
  const floating = await floatingPagePromise;
  await expect(floating.locator(".floating-content-editor")).toBeVisible();
  await floating.locator(".floating-format-toolbar input[type='file']").setInputFiles(IMAGE);

  const image = floating.locator(".floating-content-editor img");
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
  await mockImageClipboard(floating);

  await image.click({ button: "right" });
  await expect(floating.locator(".floating-editor-context-menu button", { hasText: "剪切图片" })).toBeVisible();
  await floating.mouse.click(5, 5);
  await image.click();
  await expect(floating.locator(".floating-image-controls")).toBeVisible();
  await floating.keyboard.press("Control+c");
  await expect.poll(() => floating.evaluate(() => (window as any).__imageClipboardWrites)).toBe(1);
  await expect(image).toBeVisible();

  await floating.keyboard.press("Control+x");
  await expect(image).toHaveCount(0);
  await expect.poll(() => floating.evaluate(() => (window as any).__imageClipboardWrites)).toBe(2);
});
