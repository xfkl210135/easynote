import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { easyNoteRuntime, installEasyNoteRuntime } from "../src/services/legacy-runtime";
import { centeredWeek, periodRange, useProductivityStore } from "../src/stores/productivity";
import type { AppState } from "../src/types/easynote";

function emptyState(): AppState {
  return {
    version: 8, categories: [], files: [], notes: [], tasks: [], taskFields: [], taskViews: [], scheduleEntries: [], scheduleSeries: [], scheduleOccurrenceStates: [], scheduleDailyNotes: [], focusSessions: [], reviews: [], goals: [], milestones: [], whiteboards: [],
  };
}

function mountStore(state = emptyState()) {
  setActivePinia(createPinia());
  installEasyNoteRuntime({ state, safety: { recordRecovery: vi.fn().mockResolvedValue({}) }, persist: vi.fn().mockResolvedValue(true), toast: vi.fn(), openTask: vi.fn(), openNote: vi.fn() });
  return useProductivityStore();
}

describe("centered schedule week", () => {
  it("keeps the selected day between the previous and next three days", () => {
    expect(centeredWeek("2026-08-02")).toEqual([
      "2026-07-30", "2026-07-31", "2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04", "2026-08-05",
    ]);
  });

  it("crosses a year boundary without relying on UTC date parsing", () => {
    expect(centeredWeek("2027-01-01")).toEqual([
      "2026-12-29", "2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02", "2027-01-03", "2027-01-04",
    ]);
  });
});

describe("review periods", () => {
  it("uses Monday through Sunday for weekly reviews", () => {
    expect(periodRange("weekly", "2026-08-02")).toEqual({ start: "2026-07-27", end: "2026-08-02" });
  });

  it("uses calendar month boundaries for monthly reviews", () => {
    expect(periodRange("monthly", "2026-02-12")).toEqual({ start: "2026-02-01", end: "2026-02-28" });
  });
});

describe("focus, reviews and goal calculations", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-08-02T09:00:00+08:00")); localStorage.clear(); });
  afterEach(() => { easyNoteRuntime.value = null; vi.useRealTimers(); });

  it("uses timestamps across pause, resume, focus completion and a confirmed break", async () => {
    const store = mountStore();
    await store.startFocus("计时测试", "", "", 1, 1);
    vi.advanceTimersByTime(10_000);
    await store.pauseTimer();
    expect(store.activeSession?.status).toBe("paused");
    expect(store.activeSession?.remainingMs).toBe(50_000);

    vi.advanceTimersByTime(120_000);
    await store.tickTimer();
    expect(store.activeSession?.status).toBe("paused");
    expect(store.activeSession?.remainingMs).toBe(50_000);
    await store.resumeTimer();
    vi.advanceTimersByTime(50_001);
    await store.tickTimer();
    expect(store.activeSession?.phase).toBe("awaitingBreak");

    await store.startBreak();
    vi.advanceTimersByTime(60_001);
    await store.tickTimer();
    expect(store.activeSession).toBeNull();
    expect(store.sessions[0]).toMatchObject({ status: "completed", phase: "break" });
  });

  it("freezes review metrics when the review is saved", async () => {
    const state = emptyState();
    state.tasks.push({ id: "task-1", values: {}, sortOrder: 0, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-02T01:00:00.000Z", completedAt: "2026-08-02T01:00:00.000Z" });
    const store = mountStore(state);
    await store.saveReview("daily", "2026-08-02", { completed: "完成测试" }, "");
    expect(store.reviews[0].metrics.completedTasks).toBe(1);
    state.tasks[0].completedAt = null;
    store.refresh();
    expect(store.metricsBetween("2026-08-02", "2026-08-02").completedTasks).toBe(0);
    expect(store.reviews[0].metrics.completedTasks).toBe(1);
  });

  it("calculates weighted milestone and linked task progress", async () => {
    const state = emptyState();
    state.taskFields.push({ id: "status", name: "状态", type: "select", order: 0, options: [{ id: "todo", isDone: false }, { id: "done", isDone: true }], config: {}, systemRole: "status" });
    state.tasks.push(
      { id: "done-task", values: { status: "done" }, sortOrder: 0, createdAt: "", updatedAt: "", completedAt: "2026-08-02T01:00:00.000Z" },
      { id: "todo-task", values: { status: "todo" }, sortOrder: 1, createdAt: "", updatedAt: "" },
    );
    const store = mountStore(state);
    const goal = await store.saveGoal({ title: "长期目标" });
    await store.saveMilestone({ goalId: goal!.id, title: "任务里程碑", weight: 2, taskIds: ["done-task", "todo-task"] });
    await store.saveMilestone({ goalId: goal!.id, title: "完成里程碑", weight: 1, taskIds: [], completed: true });
    expect(store.goalProgress(goal!)).toBe(67);
  });
});
