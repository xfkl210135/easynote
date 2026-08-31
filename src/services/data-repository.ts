import type { AppState, PortableArchive, SaveStatus } from "../types/easynote";

export interface SaveResult {
  committedAt?: string;
  operationId?: string;
  [key: string]: unknown;
}

export interface IntegrityReport {
  checkedAt: string;
  ok: boolean;
  errors: string[];
  warnings: string[];
  counts: Record<string, number>;
}

export interface LegacyDataSafety {
  load(): Promise<AppState | null>;
  queueSave(state: AppState, immediate?: boolean, reason?: string): Promise<boolean>;
  flush(): Promise<boolean>;
  exportPortable(state: AppState): Promise<PortableArchive>;
  integrityCheck(options?: { full?: boolean }): Promise<IntegrityReport>;
  recordRecovery(kind: string, label: string, payload: unknown): Promise<unknown>;
  get(storeName: string, key: IDBValidKey): Promise<unknown>;
  put(storeName: string, value: unknown): Promise<unknown>;
}

export interface RepositoryOptions {
  onStatus?: (status: SaveStatus, detail?: Record<string, unknown>) => void;
}

export class EasyNoteRepository {
  readonly safety: LegacyDataSafety;

  constructor(safety: LegacyDataSafety) {
    this.safety = safety;
  }

  load(): Promise<AppState | null> {
    return this.safety.load();
  }

  queueSave(state: AppState, immediate = false, reason = "auto"): Promise<boolean> {
    return this.safety.queueSave(state, immediate, reason);
  }

  flush(): Promise<boolean> {
    return this.safety.flush();
  }

  exportPortable(state: AppState): Promise<PortableArchive> {
    return this.safety.exportPortable(state);
  }

  integrityCheck(full = false): Promise<IntegrityReport> {
    return this.safety.integrityCheck({ full });
  }

  async importPortable(input: unknown, currentState: AppState | null, mode: "replace" | "merge" = "replace"): Promise<AppState> {
    const imported = normalizePortableState(input);
    const state = mode === "merge" && currentState ? mergePortableState(currentState, imported) : imported;
    if (currentState) {
      await this.safety.recordRecovery("import", "Vue 迁移导入前完整数据", structuredClone(currentState));
    }
    const saved = await this.safety.queueSave(state, true, "import");
    if (!saved) throw new Error("导入数据写入验证失败");
    return state;
  }
}

/** Merge a portable archive into the current state by stable record id. */
export function mergePortableState(current: AppState, imported: AppState): AppState {
  const keys: Array<keyof AppState> = [
    "categories", "files", "notes", "tasks", "taskFields", "taskViews",
    "scheduleEntries", "scheduleSeries", "scheduleOccurrenceStates", "scheduleDailyNotes",
    "focusSessions", "reviews", "goals", "milestones", "whiteboards",
  ];
  const merged = structuredClone(current) as AppState;
  for (const key of keys) {
    const existing = Array.isArray(merged[key]) ? merged[key] as Array<Record<string, unknown>> : [];
    const additions = Array.isArray(imported[key]) ? imported[key] as Array<Record<string, unknown>> : [];
    const byId = new Map<string, Record<string, unknown>>();
    const withoutId: Record<string, unknown>[] = [];
    for (const item of existing) {
      const id = String(item?.id || "");
      if (id) byId.set(id, item); else withoutId.push(item);
    }
    for (const item of additions) {
      const copy = structuredClone(item);
      const id = String(copy?.id || "");
      if (id) byId.set(id, copy); else withoutId.push(copy);
    }
    (merged as unknown as Record<string, unknown>)[key] = [...byId.values(), ...withoutId];
  }
  merged.version = 8;
  return merged;
}

export function normalizePortableState(input: unknown): AppState {
  if (!input || typeof input !== "object") throw new Error("数据格式无效");
  const source = input as Partial<AppState> & { data?: Partial<AppState> };
  const candidate = source.data && Array.isArray(source.data.notes) ? source.data : source;
  if (!Array.isArray(candidate.notes) || !Array.isArray(candidate.categories)) {
    throw new Error("数据格式无效：缺少笔记或文件夹");
  }

  return {
    version: 8,
    categories: candidate.categories,
    files: Array.isArray(candidate.files) ? candidate.files : [],
    notes: candidate.notes.map((note) => ({
      ...note,
      tags: Array.isArray(note.tags) ? note.tags : [],
      favorite: Boolean(note.favorite),
      content: note.content || "",
      deletedAt: note.deletedAt || null,
    })),
    tasks: Array.isArray(candidate.tasks) ? candidate.tasks : [],
    taskFields: Array.isArray(candidate.taskFields) ? candidate.taskFields : [],
    taskViews: Array.isArray(candidate.taskViews) ? candidate.taskViews : [],
    scheduleEntries: Array.isArray(candidate.scheduleEntries) ? candidate.scheduleEntries : [],
    scheduleSeries: Array.isArray(candidate.scheduleSeries) ? candidate.scheduleSeries : [],
    scheduleOccurrenceStates: Array.isArray(candidate.scheduleOccurrenceStates) ? candidate.scheduleOccurrenceStates : [],
    scheduleDailyNotes: Array.isArray(candidate.scheduleDailyNotes) ? candidate.scheduleDailyNotes : [],
    focusSessions: Array.isArray(candidate.focusSessions) ? candidate.focusSessions : [],
    reviews: Array.isArray(candidate.reviews) ? candidate.reviews : [],
    goals: Array.isArray(candidate.goals) ? candidate.goals : [],
    milestones: Array.isArray(candidate.milestones) ? candidate.milestones : [],
    whiteboards: Array.isArray(candidate.whiteboards) ? candidate.whiteboards : [],
  } as AppState;
}
