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

describe("legacy records without checksums", () => {
  beforeEach(async () => {
    await deleteDatabase("easynote-db");
    await deleteDatabase("easynote-rescue-db");
  });

  it("saves the first edit instead of reporting a false multi-tab conflict", async () => {
    const safety = new EasyNoteDataSafety();
    const timestamp = new Date().toISOString();
    await safety.put("scheduleSeries", {
      id: "legacy-series", title: "八股文", startDate: "2026-08-01", allDay: false,
      startTime: "09:00", endTime: "10:00", timeSlots: [{ startTime: "09:00", endTime: "10:00" }],
      notes: "", color: "#4f7df3", taskId: "", noteId: "", url: "", urlLabel: "", reminderMode: "auto",
      recurrenceType: "daily", recurrenceInterval: 1, weekdays: [], dayOfMonth: 1, until: "", active: true,
      createdAt: timestamp, updatedAt: timestamp,
    });

    const state = await safety.load();
    expect(state).not.toBeNull();
    state.scheduleSeries[0].timeSlots.push({ startTime: "14:00", endTime: "15:00" });
    state.scheduleSeries[0].updatedAt = new Date(Date.now() + 1000).toISOString();

    expect(await safety.queueSave(state, true, "manual")).toBe(true);
    const saved = await safety.get("scheduleSeries", "legacy-series") as any;
    expect(saved.timeSlots).toHaveLength(2);
    expect(saved.checksum).toMatch(/^[a-f0-9]{64}$/);
    (safety as any).syncChannel?.close();
    (safety as any).db?.close();
  });

  it("reports a real same-record conflict as an unsuccessful save and keeps the committed version", async () => {
    const first = new EasyNoteDataSafety();
    const timestamp = new Date().toISOString();
    const initial = {
      version: 8, categories: [], files: [], notes: [], tasks: [], taskFields: [], taskViews: [], scheduleEntries: [],
      scheduleSeries: [{
        id: "shared-series", title: "共享日程", startDate: "2026-08-01", allDay: false,
        startTime: "09:00", endTime: "10:00", timeSlots: [{ startTime: "09:00", endTime: "10:00" }],
        notes: "", color: "#4f7df3", taskId: "", noteId: "", url: "", urlLabel: "", reminderMode: "auto",
        recurrenceType: "daily", recurrenceInterval: 1, weekdays: [], dayOfMonth: 1, until: "", active: true,
        createdAt: timestamp, updatedAt: timestamp,
      }],
      scheduleOccurrenceStates: [], scheduleDailyNotes: [], whiteboards: [], focusSessions: [], reviews: [], goals: [], milestones: [],
    };
    expect(await first.queueSave(initial, true, "manual")).toBe(true);

    const second = new EasyNoteDataSafety();
    const secondState = await second.load();
    const firstState = await first.load(false);
    firstState.scheduleSeries[0].timeSlots.push({ startTime: "11:00", endTime: "12:00" });
    firstState.scheduleSeries[0].updatedAt = new Date(Date.now() + 1000).toISOString();
    expect(await first.queueSave(firstState, true, "manual")).toBe(true);

    secondState.scheduleSeries[0].timeSlots.push({ startTime: "14:00", endTime: "15:00" });
    secondState.scheduleSeries[0].updatedAt = new Date(Date.now() + 2000).toISOString();
    expect(await second.queueSave(secondState, true, "manual")).toBe(false);
    const committed = await second.get("scheduleSeries", "shared-series") as any;
    expect(committed.timeSlots).toEqual([
      { startTime: "09:00", endTime: "10:00" },
      { startTime: "11:00", endTime: "12:00" },
    ]);
    expect((await second.getRecoveryItems()).some((item: any) => item.kind === "multi-tab-conflict")).toBe(true);

    for (const safety of [first, second]) {
      (safety as any).syncChannel?.close();
      (safety as any).db?.close();
    }
  });
});
