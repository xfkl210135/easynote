import { shallowRef } from "vue";
import type { AppState } from "../types/easynote";

export interface RuntimeSafety {
  recordRecovery(kind: string, label: string, payload: unknown): Promise<unknown>;
}

export interface EasyNoteRuntime {
  state: AppState;
  safety: RuntimeSafety;
  persist(immediate?: boolean, reason?: string): Promise<boolean>;
  toast(message: string): void;
  openTask(id: string): void;
  openNote(id: string): void;
}

export type ScheduleCommand =
  | { id: number; type: "enter" | "leave" | "refresh" | "new" }
  | { id: number; type: "select-date"; date: string }
  | { id: number; type: "schedule-task"; taskId: string }
  | { id: number; type: "search"; value: string };
type ScheduleCommandInput =
  | { type: "enter" | "leave" | "refresh" | "new" }
  | { type: "select-date"; date: string }
  | { type: "schedule-task"; taskId: string }
  | { type: "search"; value: string };

export const easyNoteRuntime = shallowRef<EasyNoteRuntime | null>(null);
export const scheduleCommand = shallowRef<ScheduleCommand>({ id: 0, type: "refresh" });

let commandId = 0;

export function installEasyNoteRuntime(runtime: EasyNoteRuntime): void {
  easyNoteRuntime.value = runtime;
}

export function sendScheduleCommand(command: ScheduleCommandInput): void {
  scheduleCommand.value = { ...command, id: ++commandId } as ScheduleCommand;
}

export class VueScheduleAdapter {
  active = false;

  constructor(private readonly persistState: (immediate?: boolean, reason?: string) => Promise<boolean>) {}

  enter(): void {
    if (this.active) {
      sendScheduleCommand({ type: "refresh" });
      return;
    }
    this.active = true;
    document.body.classList.add("schedule-mode");
    const workspace = document.querySelector<HTMLElement>("#scheduleWorkspace");
    if (workspace) workspace.hidden = false;
    document.querySelector("#scheduleNavButton")?.classList.add("active");
    const create = document.querySelector<HTMLElement>("#newNoteTop");
    if (create) create.innerHTML = "<span>＋</span> 新建日程";
    const search = document.querySelector<HTMLInputElement>("#searchInput");
    if (search) { search.value = ""; search.placeholder = "搜索日程、复盘或长期目标…"; }
    const switcher = document.querySelector<HTMLElement>("#panelSwitcher"); if (switcher) switcher.hidden = true;
    const layout = document.querySelector<HTMLElement>("#layoutButton"); if (layout) layout.hidden = true;
    document.querySelector("#sidebar")?.classList.remove("open");
    document.querySelector("#sidebarScrim")?.classList.remove("open");
    sendScheduleCommand({ type: "enter" });
  }

  leave(): void {
    if (!this.active) return;
    this.active = false;
    document.body.classList.remove("schedule-mode");
    const workspace = document.querySelector<HTMLElement>("#scheduleWorkspace");
    if (workspace) workspace.hidden = true;
    document.querySelector("#scheduleNavButton")?.classList.remove("active");
    const create = document.querySelector<HTMLElement>("#newNoteTop");
    if (create) create.innerHTML = "<span>＋</span> 新建笔记";
    const search = document.querySelector<HTMLInputElement>("#searchInput");
    if (search) search.placeholder = "搜索标题、正文或标签…";
    const switcher = document.querySelector<HTMLElement>("#panelSwitcher"); if (switcher) switcher.hidden = false;
    const layout = document.querySelector<HTMLElement>("#layoutButton"); if (layout) layout.hidden = false;
    sendScheduleCommand({ type: "leave" });
  }

  render(): void {
    if (this.active) sendScheduleCommand({ type: "refresh" });
  }

  selectDate(date: string): void {
    this.enter();
    sendScheduleCommand({ type: "select-date", date });
  }

  scheduleTask(taskId: string): void {
    this.enter();
    sendScheduleCommand({ type: "schedule-task", taskId });
  }

  createSchedule(): void { sendScheduleCommand({ type: "new" }); }
  setSearch(value: string): void { sendScheduleCommand({ type: "search", value }); }

  flush(reason = "manual"): Promise<boolean> {
    return this.persistState(true, reason);
  }
}
