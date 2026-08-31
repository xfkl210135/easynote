import { describe, expect, it, vi } from "vitest";
import { EasyNoteRepository, mergePortableState, normalizePortableState, type LegacyDataSafety } from "../src/services/data-repository";
import type { AppState } from "../src/types/easynote";

const legacyState = {
  version: 8,
  categories: [{ id: "folder-1", name: "工作", color: "#3976f6", parentId: null }],
  notes: [{
    id: "note-1",
    title: "兼容测试",
    categoryId: "folder-1",
    content: "<p><strong>原有 HTML</strong></p>",
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-02T01:00:00.000Z",
  }],
} as unknown as AppState;

describe("portable v8 compatibility", () => {
  it("normalizes the legacy portable shape without changing note HTML", () => {
    const state = normalizePortableState(legacyState);
    expect(state.version).toBe(8);
    expect(state.notes[0].content).toBe("<p><strong>原有 HTML</strong></p>");
    expect(state.notes[0].tags).toEqual([]);
    expect(state.notes[0].favorite).toBe(false);
    expect(state.notes[0].deletedAt).toBeNull();
    expect(state.tasks).toEqual([]);
    expect(state.focusSessions).toEqual([]);
    expect(state.reviews).toEqual([]);
    expect(state.goals).toEqual([]);
    expect(state.milestones).toEqual([]);
    expect(state.whiteboards).toEqual([]);
  });

  it("accepts the directory-backup wrapper", () => {
    const state = normalizePortableState({ format: "easynote-directory-backup", version: 6, data: legacyState });
    expect(state.notes).toHaveLength(1);
    expect(state.categories[0].id).toBe("folder-1");
  });

  it("rejects an incomplete archive", () => {
    expect(() => normalizePortableState({ version: 8, notes: [] })).toThrow("缺少笔记或文件夹");
  });

  it("creates recovery before a verified import", async () => {
    const recovery = vi.fn().mockResolvedValue({});
    const queueSave = vi.fn().mockResolvedValue(true);
    const safety = {
      recordRecovery: recovery,
      queueSave,
    } as unknown as LegacyDataSafety;
    const repository = new EasyNoteRepository(safety);
    const imported = await repository.importPortable(legacyState, normalizePortableState(legacyState));
    expect(recovery).toHaveBeenCalledOnce();
    expect(queueSave).toHaveBeenCalledWith(imported, true, "import");
  });

  it("merges imported collections without duplicating ids", () => {
    const current = normalizePortableState({ ...legacyState, notes: [{ ...legacyState.notes[0], id: "same", title: "本地" }, { ...legacyState.notes[0], id: "local-only", title: "本地新增" }] });
    const imported = normalizePortableState({ ...legacyState, notes: [{ ...legacyState.notes[0], id: "same", title: "备份版本" }, { ...legacyState.notes[0], id: "import-only", title: "备份新增" }] });
    const merged = mergePortableState(current, imported);
    expect(merged.notes.map((note) => note.id)).toEqual(["same", "local-only", "import-only"]);
    expect(merged.notes.find((note) => note.id === "same")?.title).toBe("备份版本");
  });

  it("supports merge mode in the repository import API", async () => {
    const queueSave = vi.fn().mockResolvedValue(true);
    const safety = { recordRecovery: vi.fn().mockResolvedValue({}), queueSave } as unknown as LegacyDataSafety;
    const repository = new EasyNoteRepository(safety);
    const current = normalizePortableState({ ...legacyState, notes: [{ ...legacyState.notes[0], id: "local-only" }] });
    const imported = { ...legacyState, notes: [{ ...legacyState.notes[0], id: "import-only" }] };
    const merged = await repository.importPortable(imported, current, "merge");
    expect(merged.notes.map((note) => note.id)).toEqual(["local-only", "import-only"]);
    expect(queueSave).toHaveBeenCalledWith(merged, true, "import");
  });

  it("does not report a failed import as successful", async () => {
    const safety = {
      recordRecovery: vi.fn().mockResolvedValue({}),
      queueSave: vi.fn().mockResolvedValue(false),
    } as unknown as LegacyDataSafety;
    const repository = new EasyNoteRepository(safety);
    await expect(repository.importPortable(legacyState, null)).rejects.toThrow("写入验证失败");
  });
});
