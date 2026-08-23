import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { easyNoteRuntime } from "../services/legacy-runtime";
import type {
  FocusSession,
  Goal,
  Milestone,
  ReviewEntry,
  ReviewMetrics,
  ReviewPeriod,
  ScheduleEntry,
  ScheduleOccurrenceState,
  ScheduleSeries,
  ScheduleTimeSlot,
  Task,
} from "../types/easynote";

const DAY = 86_400_000;
function normalizedTimeSlots(input: Partial<ScheduleEntry> | undefined): ScheduleTimeSlot[] {
  if (input?.allDay !== false) return [];
  const source = Array.isArray(input?.timeSlots) ? input.timeSlots : [];
  const slots = source.map((slot) => ({ startTime: String(slot?.startTime || ""), endTime: String(slot?.endTime || "") }))
    .filter((slot) => /^\d{2}:\d{2}$/.test(slot.startTime))
    .filter((slot) => !slot.endTime || /^\d{2}:\d{2}$/.test(slot.endTime))
    .filter((slot) => !slot.endTime || slot.endTime > slot.startTime);
  if (slots.length) return slots;
  return input?.startTime ? [{ startTime: input.startTime, endTime: input.endTime || "" }] : [];
}
const nowIso = () => new Date().toISOString();
const makeId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;

export function localDate(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function parseLocalDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day, 12);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

export function addDays(date: Date, amount: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}

export function centeredWeek(value: string): string[] {
  const center = parseLocalDate(value) ?? new Date();
  return Array.from({ length: 7 }, (_, index) => localDate(addDays(center, index - 3)));
}

function dayDifference(left: Date, right: Date): number {
  return Math.round((new Date(left.getFullYear(), left.getMonth(), left.getDate()).getTime() - new Date(right.getFullYear(), right.getMonth(), right.getDate()).getTime()) / DAY);
}

function periodRange(period: ReviewPeriod, value: string): { start: string; end: string } {
  const date = parseLocalDate(value) ?? new Date();
  if (period === "daily") return { start: localDate(date), end: localDate(date) };
  if (period === "weekly") {
    const monday = addDays(date, -((date.getDay() + 6) % 7));
    return { start: localDate(monday), end: localDate(addDays(monday, 6)) };
  }
  const start = new Date(date.getFullYear(), date.getMonth(), 1, 12);
  const end = new Date(date.getFullYear(), date.getMonth() + 1, 0, 12);
  return { start: localDate(start), end: localDate(end) };
}

export const useProductivityStore = defineStore("productivity", () => {
  const revision = ref(0);
  const clock = ref(Date.now());
  const settings = ref(loadSettings());

  const state = computed(() => {
    revision.value;
    return easyNoteRuntime.value?.state ?? null;
  });
  const tasks = computed(() => { revision.value; return state.value?.tasks.slice() ?? []; });
  const notes = computed(() => { revision.value; return state.value?.notes.filter((note) => !note.deletedAt) ?? []; });
  const schedules = computed(() => { revision.value; return state.value?.scheduleEntries.map((entry) => ({ ...entry })) ?? []; });
  const series = computed(() => { revision.value; return state.value?.scheduleSeries.slice() ?? []; });
  const reviews = computed(() => { revision.value; return state.value?.reviews.slice() ?? []; });
  const goals = computed(() => { revision.value; return state.value?.goals.slice() ?? []; });
  const milestones = computed(() => { revision.value; return state.value?.milestones.slice() ?? []; });
  const sessions = computed(() => { revision.value; return state.value?.focusSessions.slice() ?? []; });
  function activeSessionRecord(): FocusSession | null {
    return state.value?.focusSessions.slice().reverse().find((item) => item.status === "active" || item.status === "paused") ?? null;
  }
  // Return a fresh view model whenever the revision changes. Runtime state is intentionally
  // stored outside Vue, so returning the same raw object would leave timer controls stale.
  const activeSession = computed(() => {
    revision.value;
    const session = activeSessionRecord();
    return session ? { ...session } : null;
  });
  const remainingMs = computed(() => {
    const session = activeSession.value;
    if (!session) return 0;
    if (session.status === "paused") return Math.max(0, session.remainingMs);
    return Math.max(0, new Date(session.endsAt).getTime() - clock.value);
  });

  function touch(): void { revision.value += 1; }
  async function persist(reason = "manual"): Promise<boolean> {
    touch();
    return easyNoteRuntime.value ? easyNoteRuntime.value.persist(true, reason) : false;
  }
  function toast(message: string): void { easyNoteRuntime.value?.toast(message); }

  function titleFieldId(): string {
    return state.value?.taskFields.find((field) => field.systemRole === "title")?.id ?? "task-title";
  }
  function statusField() { return state.value?.taskFields.find((field) => field.systemRole === "status"); }
  function taskTitle(task: Task): string { return String(task.values[titleFieldId()] || "未命名任务"); }
  function taskDone(task: Task): boolean {
    const field = statusField();
    const option = field?.options.find((item) => item.id === task.values[field.id]);
    return Boolean(option?.isDone);
  }

  function occurrenceState(seriesId: string, date: string): ScheduleOccurrenceState | undefined {
    return state.value?.scheduleOccurrenceStates.find((item) => item.seriesId === seriesId && item.date === date);
  }
  function seriesOccurs(item: ScheduleSeries, dateValue: string): boolean {
    if (item.active === false) return false;
    const date = parseLocalDate(dateValue), start = parseLocalDate(item.startDate);
    if (!date || !start || date < start || item.until && dateValue > item.until) return false;
    const interval = Math.max(1, Number(item.recurrenceInterval) || 1), days = dayDifference(date, start);
    const weekdays = Array.isArray(item.weekdays) ? item.weekdays.map(Number) : [];
    if (item.recurrenceType === "daily") return days % interval === 0;
    if (item.recurrenceType === "weekdays") return (weekdays.length ? weekdays : [1, 2, 3, 4, 5]).includes(date.getDay());
    if (item.recurrenceType === "weekly") return Math.floor(days / 7) % interval === 0 && (weekdays.length ? weekdays : [start.getDay()]).includes(date.getDay());
    if (item.recurrenceType === "monthly") return ((date.getFullYear() - start.getFullYear()) * 12 + date.getMonth()) % interval === 0 && date.getDate() === Math.min(Number(item.dayOfMonth) || start.getDate(), new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate());
    return false;
  }
  function entriesOn(date: string): ScheduleEntry[] {
    const direct = schedules.value.filter((entry) => entry.date === date).map((entry) => ({ ...entry }));
    const recurring = series.value.flatMap((item) => {
      if (!seriesOccurs(item, date)) return [];
      const occurrence = occurrenceState(item.id, date);
      if (occurrence?.deleted) return [];
      return [{ ...item, ...(occurrence?.override ?? {}), id: `${item.id}@${date}`, date, completed: Boolean(occurrence?.completed), seriesId: item.id } as ScheduleEntry];
    });
    return [...direct, ...recurring].sort((a, b) => Number(b.allDay) - Number(a.allDay) || String(a.startTime ?? "").localeCompare(String(b.startTime ?? "")));
  }

  async function saveSchedule(input: Partial<ScheduleEntry> & Pick<ScheduleEntry, "title" | "date">, existingId = ""): Promise<void> {
    if (!state.value) return;
    const stamp = nowIso();
    const timeSlots = normalizedTimeSlots(input);
    const clean: ScheduleEntry = {
      id: existingId || makeId("schedule"), title: input.title.trim(), date: input.date, allDay: input.allDay !== false,
      startTime: timeSlots[0]?.startTime || "", endTime: timeSlots[0]?.endTime || "", timeSlots,
      notes: input.notes || "", color: input.color || "#4f7df3", completed: Boolean(input.completed), taskId: input.taskId || "",
      noteId: input.noteId || "", url: input.url || "", urlLabel: input.urlLabel || "", reminderMode: input.reminderMode || "auto",
      customReminderAt: input.reminderMode === "custom" ? input.customReminderAt || "" : "", createdAt: input.createdAt || stamp, updatedAt: stamp,
    };
    if (clean.url) {
      const url = new URL(clean.url);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("链接仅支持 HTTP 或 HTTPS");
    }
    const index = state.value.scheduleEntries.findIndex((item) => item.id === existingId);
    if (index >= 0) Object.assign(state.value.scheduleEntries[index], clean); else state.value.scheduleEntries.push(clean);
    await persist("manual");
  }

  async function deleteSchedule(id: string): Promise<void> {
    if (!state.value) return;
    if (id.includes("@")) {
      const split = id.lastIndexOf("@");
      const seriesId = id.slice(0, split), date = id.slice(split + 1);
      const current = occurrenceState(seriesId, date);
      if (current) current.deleted = true;
      else state.value.scheduleOccurrenceStates.push({ id, seriesId, date, completed: false, deleted: true, override: {}, updatedAt: nowIso() });
    } else {
      const index = state.value.scheduleEntries.findIndex((item) => item.id === id);
      if (index >= 0) {
        const [entry] = state.value.scheduleEntries.splice(index, 1);
        await easyNoteRuntime.value?.safety.recordRecovery("schedule-delete", `删除日程“${entry.title}”`, { scheduleEntry: entry });
      }
    }
    await persist("danger");
  }

  async function toggleSchedule(id: string, completed?: boolean): Promise<void> {
    if (!state.value) return;
    if (id.includes("@")) {
      const split = id.lastIndexOf("@");
      const seriesId = id.slice(0, split), date = id.slice(split + 1);
      let current = occurrenceState(seriesId, date);
      if (!current) {
        current = { id, seriesId, date, completed: completed ?? true, deleted: false, override: {}, updatedAt: nowIso() };
        state.value.scheduleOccurrenceStates.push(current);
      } else { current.completed = completed ?? !current.completed; current.updatedAt = nowIso(); }
    } else {
      const entry = state.value.scheduleEntries.find((item) => item.id === id);
      if (entry) { entry.completed = completed ?? !entry.completed; entry.updatedAt = nowIso(); }
    }
    touch();
    await persist("manual");
  }

  async function saveSeries(input: Partial<ScheduleSeries> & Pick<ScheduleSeries, "title" | "startDate">, existingId = ""): Promise<void> {
    if (!state.value) return;
    const stamp = nowIso();
    const timeSlots = normalizedTimeSlots(input);
    const item = {
      id: existingId || makeId("series"), title: input.title.trim(), date: input.startDate, startDate: input.startDate,
      allDay: input.allDay !== false, startTime: timeSlots[0]?.startTime || "", endTime: timeSlots[0]?.endTime || "", timeSlots,
      notes: input.notes || "", color: input.color || "#4f7df3", completed: false, taskId: input.taskId || "", noteId: input.noteId || "", url: input.url || "", urlLabel: input.urlLabel || "",
      recurrenceType: input.recurrenceType || "daily", recurrenceInterval: Math.max(1, Number(input.recurrenceInterval) || 1), weekdays: Array.isArray(input.weekdays) ? [...input.weekdays] : [], dayOfMonth: Number(input.dayOfMonth) || parseLocalDate(input.startDate)?.getDate() || 1,
      until: input.until || "", active: input.active !== false, reminderMode: input.reminderMode === "none" ? "none" : "auto", createdAt: input.createdAt || stamp, updatedAt: stamp,
    } as ScheduleSeries;
    if (item.url) {
      const url = new URL(item.url);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("链接仅支持 HTTP 或 HTTPS");
    }
    const index = state.value.scheduleSeries.findIndex((entry) => entry.id === existingId);
    if (index >= 0) Object.assign(state.value.scheduleSeries[index], item); else state.value.scheduleSeries.push(item);
    await persist("manual");
  }

  async function deleteSeries(id: string): Promise<void> {
    if (!state.value) return;
    const index = state.value.scheduleSeries.findIndex((item) => item.id === id);
    if (index < 0) return;
    const [item] = state.value.scheduleSeries.splice(index, 1);
    const occurrences = state.value.scheduleOccurrenceStates.filter((entry) => entry.seriesId === id);
    state.value.scheduleOccurrenceStates = state.value.scheduleOccurrenceStates.filter((entry) => entry.seriesId !== id);
    await easyNoteRuntime.value?.safety.recordRecovery("schedule-series-delete", `删除固定日程“${item.title}”`, { scheduleSeries: item, scheduleOccurrenceStates: occurrences });
    await persist("danger");
  }

  function notifyTimer(session: FocusSession): void {
    const title = session.phase === "awaitingBreak" ? "专注完成，休息一下吧" : "休息结束，可以开始下一轮";
    toast(title);
    if (navigator.vibrate) navigator.vibrate([160, 80, 160]);
    try {
      const audio = new AudioContext();
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      oscillator.frequency.value = 740;
      gain.gain.setValueAtTime(0.0001, audio.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.12, audio.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.45);
      oscillator.connect(gain).connect(audio.destination);
      oscillator.start(); oscillator.stop(audio.currentTime + 0.46);
      oscillator.addEventListener("ended", () => void audio.close(), { once: true });
    } catch { /* Browsers may block sound until the next user gesture. */ }
    if ("Notification" in window && Notification.permission === "granted") new Notification("EasyNote", { body: `${session.label} · ${title}`, tag: `focus-${session.id}` });
  }

  async function startFocus(label: string, taskId = "", scheduleEntryId = "", focusMinutes = settings.value.focusMinutes, breakMinutes = settings.value.breakMinutes): Promise<void> {
    if (!state.value) return;
    if (activeSessionRecord()) throw new Error("已有正在进行的计时，请先完成或放弃");
    const start = Date.now();
    const session: FocusSession = { id: makeId("focus"), label: label.trim() || "专注", taskId, scheduleEntryId, phase: "focus", status: "active", focusMinutes: Math.max(1, focusMinutes), breakMinutes: Math.max(1, breakMinutes), startedAt: new Date(start).toISOString(), phaseStartedAt: new Date(start).toISOString(), endsAt: new Date(start + Math.max(1, focusMinutes) * 60_000).toISOString(), pausedAt: null, remainingMs: Math.max(1, focusMinutes) * 60_000, actualSeconds: 0, focusCompletedAt: null, completedAt: null, updatedAt: nowIso() } as FocusSession;
    state.value.focusSessions.push(session);
    settings.value.focusMinutes = session.focusMinutes; settings.value.breakMinutes = session.breakMinutes; saveSettings(settings.value);
    await persist("manual");
  }

  async function pauseTimer(): Promise<void> {
    const session = activeSessionRecord();
    if (!session || session.status !== "active") return;
    const now = Date.now();
    session.remainingMs = Math.max(0, new Date(session.endsAt).getTime() - now);
    if (session.phase === "focus") session.actualSeconds += Math.max(0, Math.round((Math.min(now, new Date(session.endsAt).getTime()) - new Date(session.phaseStartedAt || session.startedAt).getTime()) / 1000));
    session.status = "paused"; session.pausedAt = new Date(now).toISOString(); session.updatedAt = nowIso();
    await persist("manual");
  }

  async function resumeTimer(): Promise<void> {
    const session = activeSessionRecord();
    if (!session || session.status !== "paused" || session.phase === "awaitingBreak") return;
    const now = Date.now();
    session.status = "active"; session.pausedAt = null; session.phaseStartedAt = new Date(now).toISOString(); session.endsAt = new Date(now + session.remainingMs).toISOString(); session.updatedAt = nowIso();
    await persist("manual");
  }

  async function finishTimer(abandoned = false): Promise<void> {
    const session = activeSessionRecord();
    if (!session) return;
    const stamp = nowIso();
    if (session.phase === "focus") {
      if (session.status === "active") session.actualSeconds += Math.max(0, Math.round((Math.min(Date.now(), new Date(session.endsAt).getTime()) - new Date(session.phaseStartedAt || session.startedAt).getTime()) / 1000));
      session.focusCompletedAt ||= stamp;
    }
    session.status = abandoned ? "abandoned" : "completed"; session.completedAt = stamp; session.remainingMs = 0; session.updatedAt = stamp;
    await persist("manual");
  }

  async function startBreak(): Promise<void> {
    const session = activeSessionRecord();
    if (!session || session.phase !== "awaitingBreak") return;
    const now = Date.now();
    session.phase = "break"; session.status = "active"; session.phaseStartedAt = new Date(now).toISOString(); session.remainingMs = session.breakMinutes * 60_000; session.endsAt = new Date(now + session.remainingMs).toISOString(); session.updatedAt = nowIso();
    await persist("manual");
  }

  async function markLinkedComplete(sessionId: string): Promise<void> {
    if (!state.value) return;
    const session = state.value.focusSessions.find((item) => item.id === sessionId);
    if (!session) return;
    let changed = false;
    if (session.scheduleEntryId) {
      const entry = state.value.scheduleEntries.find((item) => item.id === session.scheduleEntryId);
      if (entry && !entry.completed) { entry.completed = true; entry.updatedAt = nowIso(); changed = true; }
    }
    if (session.taskId) {
      const task = state.value.tasks.find((item) => item.id === session.taskId);
      const field = statusField();
      const doneOption = field?.options.find((option) => option.isDone === true);
      const doneId = typeof doneOption?.id === "string" ? doneOption.id : "";
      if (task && field && doneId && !taskDone(task)) {
        task.values[field.id] = doneId;
        task.completedAt = nowIso(); task.updatedAt = nowIso(); changed = true;
      }
    }
    if (changed) { await persist("manual"); toast("关联事项已标记完成"); }
    else toast("关联事项已经完成或已不存在");
  }

  async function tickTimer(): Promise<void> {
    clock.value = Date.now();
    const session = activeSessionRecord();
    if (!session || session.status !== "active" || remainingMs.value > 0) return;
    if (session.phase === "focus") {
      const stamp = nowIso();
      session.actualSeconds += Math.max(0, Math.round((Math.min(Date.now(), new Date(session.endsAt).getTime()) - new Date(session.phaseStartedAt || session.startedAt).getTime()) / 1000));
      session.phase = "awaitingBreak"; session.status = "paused"; session.remainingMs = 0; session.focusCompletedAt = stamp; session.pausedAt = stamp; session.updatedAt = stamp;
      notifyTimer(session);
    } else {
      session.status = "completed"; session.completedAt = nowIso(); session.remainingMs = 0; session.updatedAt = nowIso();
      notifyTimer(session);
    }
    await persist("manual");
  }

  function metricsBetween(start: string, end: string): ReviewMetrics {
    const completedTasks = tasks.value.filter((task) => task.completedAt && task.completedAt.slice(0, 10) >= start && task.completedAt.slice(0, 10) <= end).length;
    const directSchedules = schedules.value.filter((entry) => entry.completed && entry.date >= start && entry.date <= end).length;
    const recurringSchedules = state.value?.scheduleOccurrenceStates.filter((entry) => entry.completed && !entry.deleted && entry.date >= start && entry.date <= end).length ?? 0;
    const completedSchedules = directSchedules + recurringSchedules;
    const completedSessions = sessions.value.filter((session) => session.status !== "abandoned" && session.actualSeconds > 0 && (session.phase !== "focus" || session.status === "completed") && session.startedAt.slice(0, 10) >= start && session.startedAt.slice(0, 10) <= end);
    return { completedTasks, completedSchedules, focusSessions: completedSessions.length, focusMinutes: Math.round(completedSessions.reduce((sum, item) => sum + item.actualSeconds, 0) / 60) };
  }

  function reviewFor(period: ReviewPeriod, value: string): ReviewEntry | undefined {
    const range = periodRange(period, value);
    return reviews.value.find((item) => item.periodType === period && item.periodStart === range.start);
  }

  async function saveReview(period: ReviewPeriod, value: string, answers: Record<string, string | number>, freeform: string): Promise<void> {
    if (!state.value) return;
    const range = periodRange(period, value), existing = reviewFor(period, value), stamp = nowIso();
    const entry: ReviewEntry = { id: existing?.id || `${period}:${range.start}`, periodType: period, periodStart: range.start, periodEnd: range.end, answers: { ...answers }, freeform, metrics: metricsBetween(range.start, range.end), createdAt: existing?.createdAt || stamp, updatedAt: stamp };
    if (existing) Object.assign(existing, entry); else state.value.reviews.push(entry);
    await persist("manual");
  }

  async function saveGoal(input: Partial<Goal> & Pick<Goal, "title">, existingId = ""): Promise<Goal | null> {
    if (!state.value) return null;
    const stamp = nowIso();
    const goal: Goal = { id: existingId || makeId("goal"), title: input.title.trim(), description: input.description || "", startDate: input.startDate || localDate(), dueDate: input.dueDate || "", color: input.color || "#4f7df3", status: input.status || "active", progressMode: input.progressMode || "automatic", manualProgress: Math.min(100, Math.max(0, Number(input.manualProgress) || 0)), createdAt: input.createdAt || stamp, updatedAt: stamp, deletedAt: input.deletedAt || null };
    const index = state.value.goals.findIndex((item) => item.id === existingId);
    if (index >= 0) Object.assign(state.value.goals[index], goal); else state.value.goals.push(goal);
    await persist("manual"); return goal;
  }

  async function saveMilestone(input: Partial<Milestone> & Pick<Milestone, "goalId" | "title">, existingId = ""): Promise<void> {
    if (!state.value) return;
    const stamp = nowIso();
    const item: Milestone = { id: existingId || makeId("milestone"), goalId: input.goalId, title: input.title.trim(), dueDate: input.dueDate || "", weight: Math.max(1, Number(input.weight) || 1), taskIds: Array.isArray(input.taskIds) ? [...new Set(input.taskIds)] : [], completed: Boolean(input.completed), createdAt: input.createdAt || stamp, updatedAt: stamp, deletedAt: input.deletedAt || null };
    const index = state.value.milestones.findIndex((entry) => entry.id === existingId);
    if (index >= 0) Object.assign(state.value.milestones[index], item); else state.value.milestones.push(item);
    await persist("manual");
  }

  async function deleteMilestone(id: string): Promise<void> {
    if (!state.value) return;
    const item = state.value.milestones.find((entry) => entry.id === id);
    if (!item || item.deletedAt) return;
    await easyNoteRuntime.value?.safety.recordRecovery("milestone-delete", `删除里程碑“${item.title}”`, { milestone: { ...item } });
    item.deletedAt = nowIso(); item.updatedAt = nowIso();
    await persist("danger");
  }

  async function archiveGoal(id: string, deleted = false): Promise<void> {
    const goal = goals.value.find((item) => item.id === id);
    if (!goal) return;
    if (deleted) { await easyNoteRuntime.value?.safety.recordRecovery("goal-delete", `删除长期目标“${goal.title}”`, { goal, milestones: milestones.value.filter((item) => item.goalId === id) }); goal.deletedAt = nowIso(); }
    else goal.status = goal.status === "archived" ? "active" : "archived";
    goal.updatedAt = nowIso(); await persist(deleted ? "danger" : "manual");
  }

  function goalProgress(goal: Goal): number {
    if (goal.progressMode === "manual") return Math.round(goal.manualProgress);
    const items = milestones.value.filter((item) => item.goalId === goal.id && !item.deletedAt);
    if (!items.length) return 0;
    const total = items.reduce((sum, item) => sum + item.weight, 0);
    const earned = items.reduce((sum, item) => {
      if (item.completed) return sum + item.weight;
      if (!item.taskIds.length) return sum;
      const done = item.taskIds.filter((id) => { const task = tasks.value.find((entry) => entry.id === id); return task ? taskDone(task) : false; }).length;
      return sum + item.weight * done / item.taskIds.length;
    }, 0);
    return total ? Math.round(earned / total * 100) : 0;
  }

  function openTask(id: string): void { easyNoteRuntime.value?.openTask(id); }
  function openNote(id: string): void { easyNoteRuntime.value?.openNote(id); }
  function refresh(): void { touch(); }

  return { state, tasks, notes, schedules, series, reviews, goals, milestones, sessions, activeSession, remainingMs, settings, taskTitle, taskDone, entriesOn, saveSchedule, deleteSchedule, toggleSchedule, saveSeries, deleteSeries, startFocus, pauseTimer, resumeTimer, finishTimer, startBreak, markLinkedComplete, tickTimer, reviewFor, saveReview, periodRange, metricsBetween, saveGoal, saveMilestone, deleteMilestone, archiveGoal, goalProgress, openTask, openNote, refresh, persist, toast };
});

interface ProductivitySettings { focusMinutes: number; breakMinutes: number; customQuotes: string[]; quoteHidden: boolean }
const SETTINGS_KEY = "easynote-productivity-settings-v1";
function loadSettings(): ProductivitySettings {
  try {
    const value = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    return { focusMinutes: Math.max(1, Number(value.focusMinutes) || 25), breakMinutes: Math.max(1, Number(value.breakMinutes) || 5), customQuotes: Array.isArray(value.customQuotes) ? value.customQuotes.map(String).filter(Boolean).slice(0, 100) : [], quoteHidden: Boolean(value.quoteHidden) };
  } catch { return { focusMinutes: 25, breakMinutes: 5, customQuotes: [], quoteHidden: false }; }
}
function saveSettings(value: ProductivitySettings): void { localStorage.setItem(SETTINGS_KEY, JSON.stringify(value)); }
export function persistProductivitySettings(value: ProductivitySettings): void { saveSettings(value); }
export { periodRange };
