import { beforeEach, describe, expect, it } from "vitest";
import { EasyNoteDataSafety } from "../src/legacy/data-safety";

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error(`Database ${name} is blocked`));
  });
}

describe("independent rescue snapshots", () => {
  beforeEach(async () => {
    await deleteDatabase("easynote-db");
    await deleteDatabase("easynote-rescue-db");
  });

  it("restores the latest verified state when the primary database disappears", async () => {
    const original = new EasyNoteDataSafety();
    const timestamp = new Date().toISOString();
    const state = {
      version: 8,
      categories: [{ id: "folder-rescue", name: "Rescue", color: "#4f7df3", parentId: null }],
      notes: [{ id: "note-rescue", title: "Power loss recovery", content: "<p>kept automatically</p>", categoryId: "folder-rescue", tags: [], favorite: false, createdAt: timestamp, updatedAt: timestamp, deletedAt: null }],
      files: [], tasks: [], taskFields: [], taskViews: [], scheduleEntries: [], scheduleSeries: [], scheduleOccurrenceStates: [], scheduleDailyNotes: [], whiteboards: [], focusSessions: [], reviews: [], goals: [], milestones: []
    };
    expect(await original.queueSave(state, true, "manual")).toBe(true);
    (original as any).db.close();
    await deleteDatabase("easynote-db");

    const recoveredSafety = new EasyNoteDataSafety();
    const recovered = await recoveredSafety.load();
    expect((recoveredSafety as any).restoredFromRescue).toBe(true);
    expect(recovered?.notes).toHaveLength(1);
    expect(recovered?.notes[0].title).toBe("Power loss recovery");
    expect(recovered?.notes[0].content).toContain("kept automatically");
    (recoveredSafety as any).db.close();
  });
});
