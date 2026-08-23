import { describe, it } from "vitest";
import { EasyNoteDataSafety } from "../src/legacy/data-safety";
import { normalizePortableState } from "../src/services/data-repository";
import { expect } from "vitest";

// jsdom shims
if (!("createObjectURL" in URL)) {
  (URL as any).createObjectURL = () => "blob:mock";
  (URL as any).revokeObjectURL = () => {};
}

describe("portable backup import", () => {
  it("restores inline images whose old attachment id is unavailable", async () => {
    const state = normalizePortableState({
      format: "easynote-portable", version: 8, exportedAt: new Date().toISOString(),
      categories: [{ id: "recovered", name: "恢复", color: "#4f7df3", parentId: null }], files: [],
      notes: [{
        id: "recovered-note", title: "恢复验证", categoryId: "recovered", tags: [], favorite: false,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), deletedAt: null,
        content: '<p>恢复正文</p><img data-attachment-id="old-device-id" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=">',
      }],
      tasks: [], taskFields: [], taskViews: [], scheduleEntries: [], scheduleSeries: [], scheduleOccurrenceStates: [],
      scheduleDailyNotes: [], focusSessions: [], reviews: [], goals: [], milestones: [], whiteboards: [],
    });
    const safety = new EasyNoteDataSafety({});
    await safety.load();
    const saved = await safety.queueSave(state, true, "import");
    expect(saved).toBe(true);
    const restored = await safety.load();
    expect(restored?.notes).toHaveLength(1);
    expect(restored?.notes[0].content).toContain("data-attachment-id=");
    expect(await safety.getAll("attachments")).toHaveLength(1);
  }, 60000);
});
