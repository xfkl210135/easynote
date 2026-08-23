<script setup lang="ts">
import { computed, defineComponent, h, onBeforeUnmount, onMounted, reactive, ref, watch, type PropType } from "vue";
import { useRoute, useRouter } from "vue-router";
import { scheduleCommand } from "../services/legacy-runtime";
import { addDays, centeredWeek, localDate, parseLocalDate, persistProductivitySettings, useProductivityStore } from "../stores/productivity";
import type { FocusSession, FocusStatus, Goal, Milestone, ReviewPeriod, ScheduleEntry, ScheduleSeries, ScheduleTimeSlot } from "../types/easynote";

function scheduleSlotsFor(item: Pick<ScheduleEntry, "allDay" | "startTime" | "endTime" | "timeSlots">): ScheduleTimeSlot[] {
  if (item.allDay) return [];
  if (Array.isArray(item.timeSlots) && item.timeSlots.length) return item.timeSlots;
  return item.startTime ? [{ startTime: item.startTime, endTime: item.endTime || "" }] : [];
}

function scheduleTimeText(item: Pick<ScheduleEntry, "allDay" | "startTime" | "endTime" | "timeSlots">): string {
  if (item.allDay) return "全天";
  return scheduleSlotsFor(item).map((slot) => `${slot.startTime || "--:--"}${slot.endTime ? `–${slot.endTime}` : ""}`).join("、") || "未设置时间";
}

const ScheduleCard = defineComponent({
  name: "ScheduleCard",
  props: {
    item: { type: Object as PropType<ScheduleEntry>, required: true },
    statusAction: { type: Boolean, default: false },
  },
  emits: ["edit", "context"],
  setup(props, { emit }) {
    const cardStore = useProductivityStore();
    const completed = ref(Boolean(props.item.completed));
    const toggling = ref(false);
    watch(() => props.item.completed, (value) => { if (!toggling.value) completed.value = Boolean(value); });
    const taskAvailable = computed(() => !props.item.taskId || cardStore.tasks.some((task) => task.id === props.item.taskId));
    const noteAvailable = computed(() => !props.item.noteId || cardStore.notes.some((note) => note.id === props.item.noteId));
    const start = () => window.dispatchEvent(new CustomEvent("easynote:start-focus", { detail: { label: props.item.title, taskId: props.item.taskId || "", scheduleEntryId: props.item.id.includes("@") ? "" : props.item.id } }));
    const toggle = async (event?: Event) => {
      event?.stopPropagation();
      if (toggling.value) return;
      const previous = completed.value;
      const next = !previous;
      toggling.value = true;
      try { await cardStore.toggleSchedule(props.item.id, next); completed.value = next; }
      catch { completed.value = previous; cardStore.toast("完成状态保存失败，请重试"); }
      finally { toggling.value = false; }
    };
    const openUrl = () => { try { const url = new URL(props.item.url || ""); if (["http:", "https:"].includes(url.protocol)) window.open(url.href, "_blank", "noopener"); } catch { cardStore.toast("关联网址已失效，请编辑日程后重试"); } };
    return () => h("article", {
      class: ["productivity-schedule-card", { done: completed.value }],
      style: { "--schedule-color": props.item.color || "#4f7df3" },
      onContextmenu: (event: MouseEvent) => { event.preventDefault(); emit("context", { item: props.item, x: event.clientX, y: event.clientY }); },
    }, [
      h("button", { class: "schedule-check", type: "button", disabled: toggling.value, title: completed.value ? "重新打开" : "标记为完成", "aria-label": completed.value ? `重新打开：${props.item.title}` : `标记完成：${props.item.title}`, onClick: toggle }, completed.value ? "✓" : ""),
      h("button", { class: "schedule-card-main", onClick: () => emit("edit") }, [h("small", scheduleTimeText(props.item)), h("strong", props.item.title), props.item.notes ? h("span", props.item.notes) : null]),
      h("div", { class: "schedule-card-actions" }, [props.statusAction ? h("button", { class: "schedule-status-action", disabled: toggling.value, onClick: toggle }, toggling.value ? "保存中…" : completed.value ? "重新打开" : "标记完成") : null, h("button", { onClick: start }, "计时"), props.item.taskId ? taskAvailable.value ? h("button", { onClick: () => cardStore.openTask(props.item.taskId!) }, "任务") : h("span", { class: "broken-link" }, "任务已失效") : null, props.item.noteId ? noteAvailable.value ? h("button", { onClick: () => cardStore.openNote(props.item.noteId!) }, "笔记") : h("span", { class: "broken-link" }, "笔记已失效") : null, props.item.url ? h("button", { onClick: openUrl }, props.item.urlLabel || "链接") : null, h("button", { onClick: () => emit("edit") }, "编辑")]),
    ]);
  },
});

const store = useProductivityStore();
const route = useRoute();
const router = useRouter();
const selectedDate = ref(localDate());
const agendaMode = ref<"list" | "timeline">("list");
const showCompleted = ref(true);
const quickTitle = ref("");
const quickStart = ref("");
const quickEnd = ref("");
const quickError = ref("");
const quoteOffset = ref(0);
const quoteManagerOpen = ref(false);
const quoteDraft = ref("");
const quoteError = ref("");
const focusDateFrom = ref(localDate(addDays(new Date(), -29)));
const focusDateTo = ref(localDate());
const focusStatus = ref<"all" | FocusStatus>("all");
const focusTaskId = ref("");
const focusSearch = ref("");
const selectedFocusSessionId = ref("");
const scheduleContext = reactive<{ open: boolean; x: number; y: number; item: ScheduleEntry | null }>({ open: false, x: 0, y: 0, item: null });
const seriesContext = reactive<{ open: boolean; x: number; y: number; item: ScheduleSeries | null }>({ open: false, x: 0, y: 0, item: null });
const goalContext = reactive<{ open: boolean; x: number; y: number; goal: Goal | null; milestone: Milestone | null }>({ open: false, x: 0, y: 0, goal: null, milestone: null });
const searchTerm = ref("");
const notificationPermission = ref<NotificationPermission | "unsupported">("Notification" in window ? Notification.permission : "unsupported");
const nowClock = ref(Date.now());
let swipeStartX = 0;
let clockTimer = 0;

const builtInQuotes = [
  "把注意力放在下一步，进步会在回头时出现。", "完成比完美更接近目标。", "今天认真走的一小步，会成为明天的底气。",
  "先开始五分钟，动力常常出现在行动之后。", "专注于能够改变的事情，其他的交给时间。", "稳定地前进，本身就是一种了不起的能力。",
  "不必一次解决所有问题，先解决最重要的一个。", "休息不是停下成长，而是为下一段专注蓄力。", "记录让努力可见，复盘让努力产生复利。",
];

const view = computed(() => route.path === "/schedule/all" ? "all" : route.path === "/schedule/series" ? "series" : route.path === "/schedule/focus" ? "focus" : route.path === "/schedule/reviews" ? "reviews" : route.path === "/schedule/goals" ? "goals" : "today");
const matchesSearch = (item: { title?: string; notes?: string }) => !searchTerm.value || `${item.title || ""} ${item.notes || ""}`.toLowerCase().includes(searchTerm.value);
const selectedItems = computed(() => store.entriesOn(selectedDate.value).filter((item) => (showCompleted.value || !item.completed) && matchesSearch(item)));
const allDayItems = computed(() => selectedItems.value.filter((item) => item.allDay));
const timedItems = computed(() => selectedItems.value.filter((item) => !item.allDay));
const sevenDays = computed(() => centeredWeek(selectedDate.value));
const currentQuote = computed(() => {
  const all = [...builtInQuotes, ...store.settings.customQuotes];
  const seed = Number(selectedDate.value.replaceAll("-", "")) + quoteOffset.value;
  const index = ((seed % all.length) + all.length) % all.length;
  return all[index];
});
const pendingCount = computed(() => store.entriesOn(selectedDate.value).filter((item) => !item.completed).length);
const completedCount = computed(() => store.entriesOn(selectedDate.value).filter((item) => item.completed).length);
const completionRate = computed(() => pendingCount.value + completedCount.value ? Math.round(completedCount.value / (pendingCount.value + completedCount.value) * 100) : 0);
const groupedSchedules = computed(() => {
  const groups = new Map<string, ScheduleEntry[]>();
  store.schedules.slice().sort((a, b) => `${a.date}${a.startTime || ""}`.localeCompare(`${b.date}${b.startTime || ""}`)).forEach((item) => {
    if ((!showCompleted.value && item.completed) || !matchesSearch(item)) return;
    if (!groups.has(item.date)) groups.set(item.date, []);
    groups.get(item.date)!.push(item);
  });
  return [...groups.entries()];
});
function focusSessionDate(item: FocusSession): string { return localDate(new Date(item.startedAt)); }
function linkedFocusTask(item: FocusSession) { return item.taskId ? store.tasks.find((task) => task.id === item.taskId) : undefined; }
function linkedFocusSchedule(item: FocusSession) { return item.scheduleEntryId ? store.schedules.find((entry) => entry.id === item.scheduleEntryId) : undefined; }
function focusTaskLabel(item: FocusSession): string { const task = linkedFocusTask(item); return task ? store.taskTitle(task) : item.taskId ? "关联任务已删除" : "未关联任务"; }
function focusScheduleLabel(item: FocusSession): string { const entry = linkedFocusSchedule(item); return entry?.title || (item.scheduleEntryId ? "关联日程已删除" : "未关联日程"); }
function focusActualSeconds(item: FocusSession): number {
  let seconds = Math.max(0, Number(item.actualSeconds) || 0);
  if (item.phase === "focus" && item.status === "active") {
    const started = new Date(item.phaseStartedAt || item.startedAt).getTime();
    const ended = Math.min(nowClock.value, new Date(item.endsAt).getTime());
    seconds += Math.max(0, Math.round((ended - started) / 1000));
  }
  return seconds;
}
function focusEndAt(item: FocusSession): string | null {
  if (item.focusCompletedAt) return item.focusCompletedAt;
  if (item.phase === "focus") return item.status === "completed" || item.status === "abandoned" ? item.completedAt : null;
  if (item.phase === "break") return item.phaseStartedAt || item.completedAt;
  return item.pausedAt || item.completedAt || item.updatedAt;
}
function focusStatusLabel(item: FocusSession): string {
  if (item.status === "abandoned") return "已放弃";
  if (item.phase === "awaitingBreak") return "专注完成";
  if (item.phase === "break" && item.status !== "completed") return item.status === "paused" ? "休息暂停" : "休息中";
  return item.status === "completed" ? "已完成" : item.status === "paused" ? "已暂停" : "进行中";
}
function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(date);
}
function formatFocusDuration(value: number): string {
  const seconds = Math.max(0, Math.round(value));
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60), rest = seconds % 60;
  return `${hours ? `${hours} 小时 ` : ""}${minutes ? `${minutes} 分 ` : ""}${rest || (!hours && !minutes) ? `${rest} 秒` : ""}`.trim();
}
const filteredFocusSessions = computed(() => store.sessions.slice().sort((a, b) => b.startedAt.localeCompare(a.startedAt)).filter((item) => {
  const date = focusSessionDate(item);
  if (focusDateFrom.value && date < focusDateFrom.value || focusDateTo.value && date > focusDateTo.value) return false;
  if (focusStatus.value !== "all" && item.status !== focusStatus.value) return false;
  if (focusTaskId.value && item.taskId !== focusTaskId.value) return false;
  const search = focusSearch.value.trim().toLowerCase();
  return !search || `${item.label} ${focusTaskLabel(item)} ${focusScheduleLabel(item)}`.toLowerCase().includes(search);
}));
const selectedFocusSession = computed(() => filteredFocusSessions.value.find((item) => item.id === selectedFocusSessionId.value) || filteredFocusSessions.value[0] || null);
const focusSummary = computed(() => {
  const items = filteredFocusSessions.value;
  const totalSeconds = items.reduce((sum, item) => sum + focusActualSeconds(item), 0);
  const finished = items.filter((item) => item.status !== "abandoned" && (item.focusCompletedAt || item.status === "completed" || item.phase !== "focus")).length;
  return { count: items.length, totalSeconds, averageSeconds: items.length ? Math.round(totalSeconds / items.length) : 0, finishRate: items.length ? Math.round(finished / items.length * 100) : 0 };
});
function setFocusDateRange(days: number | null) { focusDateFrom.value = days === null ? "" : localDate(addDays(new Date(), -(days - 1))); focusDateTo.value = days === null ? "" : localDate(); }
function openFocusSchedule(item: FocusSession) { const entry = linkedFocusSchedule(item); if (entry) selectDate(entry.date); }
function startFocusFromHistory() { window.dispatchEvent(new CustomEvent("easynote:start-focus")); }

function formatDate(value: string, options: Intl.DateTimeFormatOptions = { month: "long", day: "numeric", weekday: "long" }): string {
  const date = parseLocalDate(value); return date ? new Intl.DateTimeFormat("zh-CN", options).format(date) : value;
}
function timeLabel(item: ScheduleEntry): string { return item.allDay ? "全天" : `${item.startTime || "--:--"}${item.endTime ? `–${item.endTime}` : ""}`; }
function changeDay(delta: number) { selectedDate.value = localDate(addDays(parseLocalDate(selectedDate.value) ?? new Date(), delta)); }
function selectDate(value: string) { selectedDate.value = value; void router.push("/schedule"); }
function startDateSwipe(event: TouchEvent) { swipeStartX = event.changedTouches[0]?.clientX || 0; }
function finishDateSwipe(event: TouchEvent) { const distance = (event.changedTouches[0]?.clientX || 0) - swipeStartX; if (Math.abs(distance) >= 48) changeDay(distance < 0 ? 1 : -1); }
async function requestReminderPermission() {
  if (!("Notification" in window)) { store.toast("当前浏览器仅支持站内提醒"); return; }
  notificationPermission.value = await Notification.requestPermission();
  store.toast(notificationPermission.value === "granted" ? "系统日程提醒已开启" : "未获得系统通知权限，仍会显示站内提醒");
}

async function quickAdd() {
  quickError.value = "";
  if (!quickTitle.value.trim()) return;
  if (quickEnd.value && (!quickStart.value || quickEnd.value <= quickStart.value)) { quickError.value = "结束时间必须晚于开始时间"; return; }
  await store.saveSchedule({ title: quickTitle.value, date: selectedDate.value, allDay: !quickStart.value, startTime: quickStart.value, endTime: quickEnd.value });
  quickTitle.value = ""; quickStart.value = ""; quickEnd.value = "";
}

const scheduleOpen = ref(false);
const editingScheduleId = ref("");
const scheduleError = ref("");
const scheduleForm = reactive({ title: "", date: localDate(), allDay: true, startTime: "", endTime: "", timeSlots: [] as ScheduleTimeSlot[], notes: "", color: "#4f7df3", completed: false, taskId: "", noteId: "", url: "", urlLabel: "", reminderMode: "auto" as "auto" | "none" | "custom", customReminderAt: "" });
watch(() => scheduleForm.allDay, (allDay) => { if (!allDay && !scheduleForm.timeSlots.length) scheduleForm.timeSlots.push({ startTime: scheduleForm.startTime || "09:00", endTime: scheduleForm.endTime || "10:00" }); });
function slotsFrom(item?: Partial<ScheduleEntry>): ScheduleTimeSlot[] {
  if (item?.allDay !== false) return [];
  if (Array.isArray(item?.timeSlots) && item.timeSlots.length) return item.timeSlots.map((slot) => ({ startTime: slot.startTime || "", endTime: slot.endTime || "" }));
  return item?.startTime ? [{ startTime: item.startTime, endTime: item.endTime || "" }] : [{ startTime: "09:00", endTime: "10:00" }];
}
function editSchedule(item?: ScheduleEntry, initial: Partial<ScheduleEntry> = {}) {
  if (item?.id.includes("@")) { const source = store.series.find((entry) => entry.id === item.seriesId); if (source) editSeries(source); return; }
  const value = item || initial;
  editingScheduleId.value = item?.id || ""; scheduleError.value = "";
  const timeSlots = slotsFrom(value);
  Object.assign(scheduleForm, { title: value.title || "", date: value.date || selectedDate.value, allDay: value.allDay !== false, startTime: timeSlots[0]?.startTime || "", endTime: timeSlots[0]?.endTime || "", timeSlots, notes: value.notes || "", color: value.color || "#4f7df3", completed: Boolean(value.completed), taskId: value.taskId || "", noteId: value.noteId || "", url: value.url || "", urlLabel: value.urlLabel || "", reminderMode: value.reminderMode || "auto", customReminderAt: value.customReminderAt || "" });
  scheduleOpen.value = true;
}
async function submitSchedule() {
  scheduleError.value = "";
  try {
    if (!scheduleForm.allDay && !scheduleForm.timeSlots.length && scheduleForm.startTime) scheduleForm.timeSlots.push({ startTime: scheduleForm.startTime, endTime: scheduleForm.endTime || "" });
    if (!scheduleForm.allDay && !scheduleForm.timeSlots.length) throw new Error("请至少添加一个时间段");
    if (!scheduleForm.allDay && scheduleForm.timeSlots.some((slot) => !slot.startTime || slot.endTime && slot.endTime <= slot.startTime)) throw new Error("每个时间段的结束时间必须晚于开始时间");
    if (scheduleForm.reminderMode === "custom" && !scheduleForm.customReminderAt) throw new Error("请选择自定义提醒时间");
    await store.saveSchedule({ ...scheduleForm }, editingScheduleId.value); scheduleOpen.value = false;
  } catch (cause) { scheduleError.value = cause instanceof Error ? cause.message : "保存失败"; }
}
function startFor(item: ScheduleEntry) { window.dispatchEvent(new CustomEvent("easynote:start-focus", { detail: { label: item.title, taskId: item.taskId || "", scheduleEntryId: item.id.includes("@") ? "" : item.id } })); }
function visit(value: string) {
  try { const url = new URL(value); if (!["http:", "https:"].includes(url.protocol)) throw new Error(); window.open(url.href, "_blank", "noopener"); }
  catch { store.toast("关联网址已失效，请编辑日程后重试"); }
}

const timelineSlots = computed(() => timedItems.value.flatMap((item) => slotsFrom(item).map((slot) => ({ item, slot }))));
const timelineStart = computed(() => Math.min(6, ...timelineSlots.value.map(({ slot }) => Number(slot.startTime?.slice(0, 2) || 6))));
const timelineEnd = computed(() => Math.max(24, ...timelineSlots.value.map(({ slot }) => Math.ceil(Number(slot.endTime?.slice(0, 2) || slot.startTime?.slice(0, 2) || 23) + 1))));
const timelineHours = computed(() => Array.from({ length: timelineEnd.value - timelineStart.value + 1 }, (_, index) => timelineStart.value + index));
const timelineBlocks = computed(() => {
  const lanes: number[] = [];
  const blocks = timelineSlots.value.map(({ item, slot }) => {
    const [startHour, startMinute] = (slot.startTime || "00:00").split(":").map(Number);
    const [endHour, endMinute] = (slot.endTime || slot.startTime || "00:30").split(":").map(Number);
    const start = startHour * 60 + startMinute, end = Math.max(start + 30, endHour * 60 + endMinute);
    let lane = lanes.findIndex((laneEnd) => laneEnd <= start); if (lane < 0) lane = lanes.length; lanes[lane] = end;
    return { item, slot, start, end, lane };
  });
  const count = Math.max(1, lanes.length);
  return blocks.map((block) => ({ ...block, lanes: count, style: { "--top": `${(block.start - timelineStart.value * 60) * 1.05}px`, "--height": `${Math.max(42, (block.end - block.start) * 1.05)}px`, "--lane": block.lane, "--lanes": count, "--schedule-color": block.item.color || "#4f7df3" } }));
});
const currentHour = computed(() => new Date(nowClock.value).getHours());
const currentTimeStyle = computed(() => { const now = new Date(nowClock.value); return { top: `${(now.getHours() * 60 + now.getMinutes() - timelineStart.value * 60) * 1.05}px` }; });

const seriesOpen = ref(false);
const editingSeriesId = ref("");
const seriesForm = reactive({ title: "", startDate: localDate(), allDay: true, startTime: "", endTime: "", timeSlots: [] as ScheduleTimeSlot[], notes: "", color: "#4f7df3", taskId: "", noteId: "", url: "", urlLabel: "", recurrenceType: "daily" as ScheduleSeries["recurrenceType"], recurrenceInterval: 1, weekdays: [] as number[], dayOfMonth: 1, until: "", active: true, reminderMode: "auto" as "auto" | "none" });
const weekdayOptions = [[1, "一"], [2, "二"], [3, "三"], [4, "四"], [5, "五"], [6, "六"], [0, "日"]] as const;
function recurrenceLabel(type: ScheduleSeries["recurrenceType"]): string { return type === "daily" ? "每天" : type === "weekdays" ? "工作日" : type === "weekly" ? "每周" : "每月"; }
function timeSlotsLabel(item: Pick<ScheduleEntry, "allDay" | "startTime" | "endTime" | "timeSlots">): string {
  if (item.allDay) return "全天";
  const slots = Array.isArray(item.timeSlots) && item.timeSlots.length ? item.timeSlots : slotsFrom(item);
  return slots.map((slot) => `${slot.startTime || "未设置"}${slot.endTime ? `–${slot.endTime}` : ""}`).join("、") || "未设置";
}
function seriesTimeLabel(item: ScheduleSeries): string { return timeSlotsLabel(item); }
function setSeriesTimeType(event: Event) {
  const timed = (event.target as HTMLSelectElement).value === "timed";
  seriesForm.allDay = !timed;
  if (timed && !seriesForm.timeSlots.length) { seriesForm.timeSlots.push({ startTime: "09:00", endTime: "10:00" }); seriesForm.startTime = "09:00"; seriesForm.endTime = "10:00"; }
}
function addTimeSlot(target: { timeSlots: ScheduleTimeSlot[] }) { const previous = target.timeSlots[target.timeSlots.length - 1]; target.timeSlots.push({ startTime: previous?.endTime || "09:00", endTime: "" }); }
function removeTimeSlot(target: { timeSlots: ScheduleTimeSlot[] }, index: number) { if (target.timeSlots.length > 1) target.timeSlots.splice(index, 1); }
function editSeries(item?: ScheduleSeries) {
  editingSeriesId.value = item?.id || "";
  const startDate = item?.startDate || selectedDate.value;
  const timeSlots = slotsFrom(item);
  Object.assign(seriesForm, { title: item?.title || "", startDate, allDay: item?.allDay !== false, startTime: timeSlots[0]?.startTime || "", endTime: timeSlots[0]?.endTime || "", timeSlots, notes: item?.notes || "", color: item?.color || "#4f7df3", taskId: item?.taskId || "", noteId: item?.noteId || "", url: item?.url || "", urlLabel: item?.urlLabel || "", recurrenceType: item?.recurrenceType || "daily", recurrenceInterval: item?.recurrenceInterval || 1, weekdays: item?.weekdays?.length ? [...item.weekdays] : [parseLocalDate(startDate)?.getDay() ?? 1], dayOfMonth: item?.dayOfMonth || parseLocalDate(startDate)?.getDate() || 1, until: item?.until || "", active: item?.active !== false, reminderMode: item?.reminderMode === "none" ? "none" : "auto" });
  seriesOpen.value = true;
}
async function submitSeries() {
  if (!seriesForm.allDay && !seriesForm.timeSlots.length) return store.toast("请至少添加一个时间段");
  if (!seriesForm.allDay && seriesForm.timeSlots.some((slot) => !slot.startTime || slot.endTime && slot.endTime <= slot.startTime)) return store.toast("每个时间段的结束时间必须晚于开始时间");
  if (seriesForm.recurrenceType === "weekly" && !seriesForm.weekdays.length) return store.toast("请至少选择一个重复星期");
  try { await store.saveSeries({ ...seriesForm }, editingSeriesId.value); seriesOpen.value = false; }
  catch (cause) { store.toast(cause instanceof Error ? cause.message : "固定日程保存失败"); }
}
function openSeriesContext(item: ScheduleSeries, event: MouseEvent) {
  closeScheduleContext(); closeGoalContext();
  seriesContext.item = item; seriesContext.x = Math.max(8, Math.min(event.clientX, window.innerWidth - 220)); seriesContext.y = Math.max(8, Math.min(event.clientY, window.innerHeight - 280)); seriesContext.open = true;
}
function closeSeriesContext() { seriesContext.open = false; seriesContext.item = null; }
function editContextSeries() { const item = seriesContext.item; closeSeriesContext(); if (item) editSeries(item); }
async function duplicateContextSeries() { const item = seriesContext.item; closeSeriesContext(); if (item) await store.saveSeries({ ...item, title: `${item.title} 副本`, startDate: item.startDate }, ""); }
async function toggleContextSeries() { const item = seriesContext.item; closeSeriesContext(); if (item) await store.saveSeries({ ...item, active: item.active === false, startDate: item.startDate }, item.id); }
async function copyContextSeriesTitle() { const title = seriesContext.item?.title || ""; closeSeriesContext(); if (!title) return; try { await navigator.clipboard.writeText(title); store.toast("标题已复制"); } catch { store.toast("复制失败，请手动复制"); } }
async function deleteContextSeries() { const id = seriesContext.item?.id; closeSeriesContext(); if (id) await store.deleteSeries(id); }

const reviewPeriod = ref<ReviewPeriod>("daily");
const reviewDate = ref(localDate());
const reviewAnswers = reactive<Record<string, string | number>>({});
const reviewFreeform = ref("");
const reviewPrompts = computed(() => reviewPeriod.value === "daily" ? [["completed", "今天完成了什么"], ["progress", "今天最大的进展"], ["blockers", "遇到的问题与原因"], ["tomorrow", "明天最重要的三件事"]] : reviewPeriod.value === "weekly" ? [["highlights", "本周亮点"], ["unfinished", "未完成事项与原因"], ["learning", "本周收获"], ["next", "下周重点"]] : [["goals", "本月目标进展"], ["achievements", "主要成果"], ["adjustments", "问题与调整"], ["next", "下月重点"]]);
const reviewRange = computed(() => store.periodRange(reviewPeriod.value, reviewDate.value));
const reviewMetrics = computed(() => store.metricsBetween(reviewRange.value.start, reviewRange.value.end));
function loadReview() {
  const item = store.reviewFor(reviewPeriod.value, reviewDate.value); Object.keys(reviewAnswers).forEach((key) => delete reviewAnswers[key]);
  Object.assign(reviewAnswers, item?.answers || { energy: 3 }); reviewFreeform.value = item?.freeform || "";
}
watch([reviewPeriod, reviewDate], loadReview, { immediate: true });
async function submitReview() { await store.saveReview(reviewPeriod.value, reviewDate.value, reviewAnswers, reviewFreeform.value); store.toast("复盘已保存"); }
function openReview(item: { periodType: ReviewPeriod; periodStart: string }) { reviewPeriod.value = item.periodType; reviewDate.value = item.periodStart; }

const goalOpen = ref(false), milestoneOpen = ref(false);
const showArchivedGoals = ref(false);
const editingGoalId = ref(""), editingMilestoneId = ref("");
const goalForm = reactive({ title: "", description: "", startDate: localDate(), dueDate: "", color: "#4f7df3", status: "active" as Goal["status"], progressMode: "automatic" as Goal["progressMode"], manualProgress: 0 });
const milestoneForm = reactive({ goalId: "", title: "", dueDate: "", weight: 1, taskIds: [] as string[], completed: false });
const visibleGoals = computed(() => store.goals.filter((goal) => !goal.deletedAt && (showArchivedGoals.value || goal.status !== "archived")));
function editGoal(item?: Goal) { editingGoalId.value = item?.id || ""; Object.assign(goalForm, { title: item?.title || "", description: item?.description || "", startDate: item?.startDate || localDate(), dueDate: item?.dueDate || "", color: item?.color || "#4f7df3", status: item?.status || "active", progressMode: item?.progressMode || "automatic", manualProgress: item?.manualProgress || 0 }); goalOpen.value = true; }
async function submitGoal() { await store.saveGoal({ ...goalForm }, editingGoalId.value); goalOpen.value = false; }
function editMilestone(goalId: string, item?: Milestone) { editingMilestoneId.value = item?.id || ""; Object.assign(milestoneForm, { goalId, title: item?.title || "", dueDate: item?.dueDate || "", weight: item?.weight || 1, taskIds: [...(item?.taskIds || [])], completed: Boolean(item?.completed) }); milestoneOpen.value = true; }
async function submitMilestone() { await store.saveMilestone({ ...milestoneForm }, editingMilestoneId.value); milestoneOpen.value = false; }
function milestonesFor(goalId: string) { return store.milestones.filter((item) => item.goalId === goalId && !item.deletedAt); }
async function toggleMilestone(item: Milestone) { await store.saveMilestone({ ...item, completed: !item.completed }, item.id); }
function openGoalContext(goal: Goal, event: MouseEvent, milestone: Milestone | null = null) {
  closeScheduleContext(); closeSeriesContext();
  goalContext.goal = goal; goalContext.milestone = milestone; goalContext.x = Math.max(8, Math.min(event.clientX, window.innerWidth - 230)); goalContext.y = Math.max(8, Math.min(event.clientY, window.innerHeight - 330)); goalContext.open = true;
}
function closeGoalContext() { goalContext.open = false; goalContext.goal = null; goalContext.milestone = null; }
function editContextGoal() { const goal = goalContext.goal; closeGoalContext(); if (goal) editGoal(goal); }
function addContextMilestone() { const goal = goalContext.goal; closeGoalContext(); if (goal) editMilestone(goal.id); }
function editContextMilestone() { const goal = goalContext.goal, milestone = goalContext.milestone; closeGoalContext(); if (goal && milestone) editMilestone(goal.id, milestone); }
async function toggleContextMilestone() { const milestone = goalContext.milestone; closeGoalContext(); if (milestone) await toggleMilestone(milestone); }
async function deleteContextMilestone() { const id = goalContext.milestone?.id; closeGoalContext(); if (id) await store.deleteMilestone(id); }
async function toggleContextGoalPaused() { const goal = goalContext.goal; closeGoalContext(); if (goal) await store.saveGoal({ ...goal, status: goal.status === "paused" ? "active" : "paused" }, goal.id); }
async function toggleContextGoalCompleted() { const goal = goalContext.goal; closeGoalContext(); if (goal) await store.saveGoal({ ...goal, status: goal.status === "completed" ? "active" : "completed" }, goal.id); }
async function archiveContextGoal() { const goal = goalContext.goal; closeGoalContext(); if (goal) await store.archiveGoal(goal.id); }
async function deleteContextGoal() { const goal = goalContext.goal; closeGoalContext(); if (goal) await store.archiveGoal(goal.id, true); }
async function copyContextGoalTitle() { const title = goalContext.milestone?.title || goalContext.goal?.title || ""; closeGoalContext(); if (!title) return; try { await navigator.clipboard.writeText(title); store.toast("标题已复制"); } catch { store.toast("复制失败，请手动复制"); } }

function addCustomQuote() {
  const value = quoteDraft.value.trim(); quoteError.value = "";
  if (!value) { quoteError.value = "请输入一句想保留的话。"; return; }
  if (store.settings.customQuotes.includes(value)) { quoteError.value = "这句话已经在自定义语句中。"; return; }
  if (store.settings.customQuotes.length >= 100) { quoteError.value = "最多保存 100 条自定义语句。"; return; }
  store.settings.customQuotes.push(value); persistProductivitySettings(store.settings); quoteDraft.value = "";
  const targetIndex = builtInQuotes.length + store.settings.customQuotes.length - 1;
  quoteOffset.value = targetIndex - Number(selectedDate.value.replaceAll("-", ""));
}
function removeCustomQuote(index: number) { store.settings.customQuotes.splice(index, 1); persistProductivitySettings(store.settings); quoteOffset.value = 0; }
function hideQuote() { store.settings.quoteHidden = true; persistProductivitySettings(store.settings); }

function openScheduleContext(payload: { item: ScheduleEntry; x: number; y: number }) {
  closeSeriesContext(); closeGoalContext();
  scheduleContext.item = payload.item;
  scheduleContext.x = Math.max(8, Math.min(payload.x, window.innerWidth - 210));
  scheduleContext.y = Math.max(8, Math.min(payload.y, window.innerHeight - 320));
  scheduleContext.open = true;
}
function openTimelineContext(item: ScheduleEntry, event: MouseEvent) { openScheduleContext({ item, x: event.clientX, y: event.clientY }); }
function closeScheduleContext() { scheduleContext.open = false; scheduleContext.item = null; }
function editContextSchedule() { const item = scheduleContext.item; closeScheduleContext(); if (item) editSchedule(item); }
async function copyContextTitle() { const title = scheduleContext.item?.title || ""; closeScheduleContext(); if (!title) return; try { await navigator.clipboard.writeText(title); store.toast("标题已复制"); } catch { store.toast("复制失败，请手动复制"); } }
function startContextFocus() { const item = scheduleContext.item; closeScheduleContext(); if (item) startFor(item); }
async function toggleContextSchedule() { const item = scheduleContext.item; closeScheduleContext(); if (item) await store.toggleSchedule(item.id, !item.completed); }
async function deleteContextSchedule() { const id = scheduleContext.item?.id; closeScheduleContext(); if (id) await store.deleteSchedule(id); }

watch(scheduleCommand, (command) => {
  if (command.type === "select-date") selectDate(command.date);
  if (command.type === "schedule-task") { const task = store.tasks.find((item) => item.id === command.taskId); editSchedule(undefined, { title: task ? store.taskTitle(task) : "", taskId: command.taskId, date: selectedDate.value }); }
  if (command.type === "new") editSchedule();
  if (command.type === "search") searchTerm.value = command.value.trim().toLowerCase();
  store.refresh();
});
function closeTransientMenus(event: Event) { if (!(event.target as HTMLElement | null)?.closest(".schedule-context-menu")) { closeScheduleContext(); closeSeriesContext(); closeGoalContext(); } }
function handleEscape(event: KeyboardEvent) { if (event.key === "Escape") { closeScheduleContext(); closeSeriesContext(); closeGoalContext(); quoteManagerOpen.value = false; } }
onMounted(() => { clockTimer = window.setInterval(() => { nowClock.value = Date.now(); }, 60_000); document.addEventListener("pointerdown", closeTransientMenus); document.addEventListener("keydown", handleEscape); });
onBeforeUnmount(() => { window.clearInterval(clockTimer); document.removeEventListener("pointerdown", closeTransientMenus); document.removeEventListener("keydown", handleEscape); });
</script>

<template>
  <div class="productivity-center">
    <nav class="productivity-tabs" aria-label="时间与规划页面">
      <RouterLink to="/schedule">今日</RouterLink><RouterLink to="/schedule/all">总日程</RouterLink><RouterLink to="/schedule/series">固定日程</RouterLink><RouterLink to="/schedule/focus">专注记录</RouterLink><RouterLink to="/schedule/reviews">复盘</RouterLink><RouterLink to="/schedule/goals">长期规划</RouterLink>
    </nav>

    <template v-if="view === 'today'">
      <header class="productivity-header">
        <div class="productivity-day-controls"><button type="button" @click="changeDay(-1)">‹</button><div><span>{{ pendingCount }} 项待完成</span><h1>{{ selectedDate === localDate() ? '今天 · ' : '' }}{{ formatDate(selectedDate) }}</h1></div><button type="button" @click="changeDay(1)">›</button><button type="button" @click="selectedDate = localDate()">回到今天</button></div>
        <div class="productivity-header-actions"><label><input v-model="showCompleted" type="checkbox"> 显示已完成</label><button v-if="store.settings.quoteHidden" type="button" @click="store.settings.quoteHidden = false; persistProductivitySettings(store.settings)">显示鼓励</button><button type="button" @click="requestReminderPermission">{{ notificationPermission === 'granted' ? '提醒已开启' : notificationPermission === 'denied' ? '提醒未授权' : notificationPermission === 'unsupported' ? '站内提醒' : '开启提醒' }}</button><button type="button" @click="editSchedule()">＋ 新建日程</button></div>
      </header>
      <section v-if="!store.settings.quoteHidden" class="motivation-card"><strong>{{ currentQuote }}</strong><button type="button" @click="quoteOffset++">换一句</button><button type="button" @click="quoteManagerOpen = true">管理语句</button><button type="button" aria-label="隐藏" @click="hideQuote">×</button></section>
      <div class="centered-week-strip" @touchstart.passive="startDateSwipe" @touchend.passive="finishDateSwipe">
        <button v-for="date in sevenDays" :key="date" type="button" :class="{ selected: date === selectedDate, today: date === localDate() }" @click="selectDate(date)"><span>{{ formatDate(date, { weekday: 'short' }) }}</span><strong>{{ Number(date.slice(-2)) }}</strong><small>{{ store.entriesOn(date).length || '' }}</small></button>
      </div>
      <div class="agenda-mode-switch"><button :class="{ active: agendaMode === 'list' }" type="button" @click="agendaMode = 'list'">列表</button><button :class="{ active: agendaMode === 'timeline' }" type="button" @click="agendaMode = 'timeline'">时间线</button></div>
      <form class="productivity-quick-form" @submit.prevent="quickAdd"><input v-model="quickTitle" maxlength="120" placeholder="输入一项安排，按 Enter 添加"><label>开始 <input v-model="quickStart" type="time"></label><label>结束 <input v-model="quickEnd" type="time"></label><button class="primary-button" type="submit">添加</button><p v-if="quickError">{{ quickError }}</p></form>
      <div class="productivity-today-layout">
        <main :class="{ 'timeline-main': agendaMode === 'timeline' }">
          <template v-if="agendaMode === 'list'">
            <section class="agenda-section"><header><strong>全天安排</strong><span>{{ allDayItems.length }}</span></header><ScheduleCard v-for="item in allDayItems" :key="item.id" :item="item" @edit="editSchedule(item)" @context="openScheduleContext" /><div v-if="!allDayItems.length" class="agenda-empty">暂无全天安排</div></section>
            <section class="agenda-section"><header><strong>时间安排</strong><span>{{ timedItems.length }}</span></header><ScheduleCard v-for="item in timedItems" :key="item.id" :item="item" @edit="editSchedule(item)" @context="openScheduleContext" /><div v-if="!timedItems.length" class="agenda-empty">设置开始时间后，安排会显示在这里和时间线上。</div></section>
          </template>
          <template v-else>
            <div class="timeline-view">
              <div class="timeline-scroll">
                <div v-if="!timedItems.length" class="timeline-empty-hint">暂无带具体时间的安排。为日程设置开始时间后，会显示在时间线上。</div>
                <div class="day-timeline" :style="{ height: `${(timelineEnd - timelineStart) * 63 + 20}px` }">
                  <div v-for="hour in timelineHours" :key="hour" class="timeline-hour" :style="{ top: `${(hour - timelineStart) * 63}px` }"><span>{{ String(hour).padStart(2, '0') }}:00</span></div>
                  <i v-if="selectedDate === localDate() && currentHour >= timelineStart && currentHour <= timelineEnd" class="timeline-now" :style="currentTimeStyle" :data-time="new Date(nowClock).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })"></i>
                  <button v-for="(block, index) in timelineBlocks" :key="`${block.item.id}-${block.start}-${index}`" class="timeline-block" type="button" :style="block.style" @click="editSchedule(block.item)" @contextmenu.prevent="openTimelineContext(block.item, $event)"><small>{{ block.slot.startTime }}{{ block.slot.endTime ? `–${block.slot.endTime}` : '' }}</small><strong>{{ block.item.title }}</strong><span><b @click.stop="startFor(block.item)">开始计时</b><b v-if="block.item.taskId && store.tasks.some(task => task.id === block.item.taskId)" @click.stop="store.openTask(block.item.taskId)">任务</b><b v-else-if="block.item.taskId" class="broken-link">任务已失效</b><b v-if="block.item.noteId && store.notes.some(note => note.id === block.item.noteId)" @click.stop="store.openNote(block.item.noteId)">笔记</b><b v-else-if="block.item.noteId" class="broken-link">笔记已失效</b><b v-if="block.item.url" @click.stop="visit(block.item.url)">{{ block.item.urlLabel || '链接' }}</b></span></button>
                </div>
              </div>
            </div>
          </template>
        </main>
        <aside class="productivity-dashboard"><section><header><strong>今日概览</strong><span>{{ completionRate }}%</span></header><div class="dashboard-metrics"><b>{{ pendingCount }}<small>待完成</small></b><b>{{ completedCount }}<small>已完成</small></b><b>{{ store.sessions.filter(s => s.completedAt?.slice(0,10) === selectedDate).length }}<small>专注</small></b></div></section><section><header><strong>今日便签</strong><span>自动保存</span></header><textarea :value="store.state?.scheduleDailyNotes.find(n => n.date === selectedDate)?.content || ''" placeholder="记录临时想法与准备事项" @input="async (event) => { const value = (event.target as HTMLTextAreaElement).value; const list = store.state!.scheduleDailyNotes; let note = list.find(n => n.date === selectedDate); if (note) { note.content = value; note.updatedAt = new Date().toISOString(); } else list.push({ id: selectedDate, date: selectedDate, content: value, updatedAt: new Date().toISOString() }); await store.persist('auto'); }"></textarea></section></aside>
      </div>
    </template>

    <section v-else-if="view === 'all'" class="productivity-page"><header><div><span>按日期浏览所有安排</span><h1>总日程</h1></div><label><input v-model="showCompleted" type="checkbox"> 显示已完成</label></header><div v-if="groupedSchedules.length" class="total-groups"><section v-for="[date, items] in groupedSchedules" :key="date"><header><button type="button" @click="selectDate(date)"><strong>{{ formatDate(date) }}</strong><span>{{ items.length }} 项</span></button></header><ScheduleCard v-for="item in items" :key="item.id" :item="item" status-action @edit="editSchedule(item)" @context="openScheduleContext" /></section></div><div v-else class="productivity-empty">暂无日程</div></section>
    <section v-else-if="view === 'series'" class="productivity-page"><header><div><span>管理重复规则</span><h1>固定日程</h1></div><button class="primary-button" type="button" @click="editSeries()">＋ 新建固定日程</button></header><div class="series-grid"><article v-for="item in store.series" :key="item.id" class="series-card" :class="{ paused: item.active === false }" :style="{ '--schedule-color': item.color }" @contextmenu.prevent="openSeriesContext(item, $event)"><header><div><strong>{{ item.title }}</strong><span>{{ recurrenceLabel(item.recurrenceType) }} · 每 {{ item.recurrenceInterval }} 个周期</span></div><b>{{ item.active === false ? '已暂停' : '启用中' }}</b></header><div class="series-time"><span>{{ seriesTimeLabel(item) }}</span><small>{{ item.reminderMode === 'none' ? '不提醒' : '按时间提醒' }}</small></div><p>{{ item.notes || '暂无备注' }}</p><footer><span>{{ item.startDate }}{{ item.until ? ` 至 ${item.until}` : ' · 长期' }}</span><div><button @click="editSeries(item)">编辑</button><button class="danger-text" @click="store.deleteSeries(item.id)">删除</button></div></footer></article><div v-if="!store.series.length" class="productivity-empty planning-empty"><strong>还没有固定日程</strong><span>把每天、每周或每月重复的安排建立成规则。</span><button type="button" @click="editSeries()">新建第一条规则</button></div></div></section>

    <section v-else-if="view === 'focus'" class="productivity-page focus-history-page">
      <header>
        <div><span>每一段专注都有迹可循</span><h1>专注记录</h1></div>
        <button class="primary-button" type="button" @click="startFocusFromHistory">＋ 开始专注</button>
      </header>
      <div class="focus-history-layout">
        <main class="focus-history-main">
          <section class="focus-history-summary">
            <article><span>记录次数</span><strong>{{ focusSummary.count }}</strong><small>当前筛选范围</small></article>
            <article><span>累计专注</span><strong>{{ formatFocusDuration(focusSummary.totalSeconds) }}</strong><small>实际有效时长</small></article>
            <article><span>平均每次</span><strong>{{ formatFocusDuration(focusSummary.averageSeconds) }}</strong><small>按全部记录计算</small></article>
            <article><span>完成率</span><strong>{{ focusSummary.finishRate }}%</strong><small>未放弃的完成占比</small></article>
          </section>
          <section class="focus-history-filters">
            <div class="focus-range-shortcuts"><button type="button" @click="setFocusDateRange(1)">今天</button><button type="button" @click="setFocusDateRange(7)">近 7 天</button><button type="button" @click="setFocusDateRange(30)">近 30 天</button><button type="button" @click="setFocusDateRange(null)">全部</button></div>
            <label><span>开始日期</span><input v-model="focusDateFrom" type="date"></label>
            <label><span>结束日期</span><input v-model="focusDateTo" type="date"></label>
            <label><span>状态</span><select v-model="focusStatus"><option value="all">全部状态</option><option value="active">进行中</option><option value="paused">暂停/等待休息</option><option value="completed">已完成</option><option value="abandoned">已放弃</option></select></label>
            <label><span>关联任务</span><select v-model="focusTaskId"><option value="">全部任务</option><option v-for="task in store.tasks" :key="task.id" :value="task.id">{{ store.taskTitle(task) }}</option></select></label>
            <label class="focus-search-field"><span>搜索</span><input v-model.trim="focusSearch" placeholder="任务、日程或本轮名称"></label>
          </section>
          <div class="focus-history-table-wrap">
            <table class="focus-history-table">
              <thead><tr><th>开始时间</th><th>结束时间</th><th>专注内容</th><th>实际时长</th><th>关联事项</th><th>状态</th><th></th></tr></thead>
              <tbody>
                <tr v-for="item in filteredFocusSessions" :key="item.id" :class="{ selected: selectedFocusSession?.id === item.id }" @dblclick="selectedFocusSessionId = item.id">
                  <td>{{ formatDateTime(item.startedAt) }}</td>
                  <td>{{ formatDateTime(focusEndAt(item)) }}</td>
                  <td><strong>{{ item.label }}</strong><small>计划 {{ item.focusMinutes }} 分钟</small></td>
                  <td><strong>{{ formatFocusDuration(focusActualSeconds(item)) }}</strong></td>
                  <td><span>{{ focusTaskLabel(item) }}</span><small v-if="item.scheduleEntryId">{{ focusScheduleLabel(item) }}</small></td>
                  <td><span class="focus-status-pill" :data-status="item.status">{{ focusStatusLabel(item) }}</span></td>
                  <td><button type="button" @click="selectedFocusSessionId = item.id">详情</button></td>
                </tr>
              </tbody>
            </table>
            <div v-if="!filteredFocusSessions.length" class="productivity-empty planning-empty"><strong>当前范围内没有专注记录</strong><span>开始计时后，开始、结束、实际时长和关联任务会自动保存在这里。</span><button type="button" @click="setFocusDateRange(null)">查看全部记录</button></div>
          </div>
        </main>
        <aside v-if="selectedFocusSession" class="focus-history-detail">
          <header><div><span>记录详情</span><strong>{{ selectedFocusSession.label }}</strong></div><b class="focus-status-pill" :data-status="selectedFocusSession.status">{{ focusStatusLabel(selectedFocusSession) }}</b></header>
          <dl>
            <div><dt>开始时间</dt><dd>{{ formatDateTime(selectedFocusSession.startedAt) }}</dd></div>
            <div><dt>专注结束</dt><dd>{{ formatDateTime(focusEndAt(selectedFocusSession)) }}</dd></div>
            <div><dt>实际专注</dt><dd>{{ formatFocusDuration(focusActualSeconds(selectedFocusSession)) }}</dd></div>
            <div><dt>计划时长</dt><dd>{{ selectedFocusSession.focusMinutes }} 分钟</dd></div>
            <div><dt>计划休息</dt><dd>{{ selectedFocusSession.breakMinutes }} 分钟</dd></div>
          </dl>
          <section><span>关联任务</span><strong>{{ focusTaskLabel(selectedFocusSession) }}</strong><button v-if="linkedFocusTask(selectedFocusSession)" type="button" @click="store.openTask(selectedFocusSession.taskId)">打开任务</button></section>
          <section><span>关联日程</span><strong>{{ focusScheduleLabel(selectedFocusSession) }}</strong><button v-if="linkedFocusSchedule(selectedFocusSession)" type="button" @click="openFocusSchedule(selectedFocusSession)">打开日程</button></section>
          <small class="focus-record-id">记录 ID：{{ selectedFocusSession.id }}</small>
        </aside>
      </div>
    </section>

    <section v-else-if="view === 'reviews'" class="productivity-page review-page"><header><div><span>记录、总结并回看成长</span><h1>复盘</h1></div></header><div class="review-layout"><form class="review-editor" @submit.prevent="submitReview"><div class="review-period-controls"><select v-model="reviewPeriod"><option value="daily">每日复盘</option><option value="weekly">周总结</option><option value="monthly">月总结</option></select><input v-model="reviewDate" type="date"><span>{{ reviewRange.start }} 至 {{ reviewRange.end }}</span></div><div class="review-metrics"><b>{{ reviewMetrics.completedTasks }}<small>完成任务</small></b><b>{{ reviewMetrics.completedSchedules }}<small>完成日程</small></b><b>{{ reviewMetrics.focusSessions }}<small>专注次数</small></b><b>{{ reviewMetrics.focusMinutes }}<small>专注分钟</small></b></div><label v-if="reviewPeriod === 'daily'"><span>精力评分（1–5）</span><input v-model.number="reviewAnswers.energy" type="range" min="1" max="5"><strong>{{ reviewAnswers.energy || 3 }}</strong></label><label v-for="[key, label] in reviewPrompts" :key="key"><span>{{ label }}</span><textarea v-model="reviewAnswers[key]" rows="3"></textarea></label><label><span>自由记录</span><textarea v-model="reviewFreeform" rows="5" placeholder="任何想进一步保留的想法……"></textarea></label><button class="primary-button" type="submit">保存复盘与统计快照</button></form><aside class="review-history"><header><strong>历史记录</strong><span>{{ store.reviews.length }}</span></header><button v-for="item in store.reviews.slice().sort((a,b) => b.periodStart.localeCompare(a.periodStart))" :key="item.id" type="button" @click="openReview(item)"><strong>{{ item.periodType === 'daily' ? '每日' : item.periodType === 'weekly' ? '周' : '月' }} · {{ item.periodStart }}</strong><span>{{ item.metrics.completedTasks }} 个任务 · {{ item.metrics.focusMinutes }} 分钟</span></button><div v-if="!store.reviews.length" class="productivity-empty">完成第一篇复盘后，可以在这里回看。</div></aside></div></section>

    <section v-else class="productivity-page goals-page"><header><div><span>把长期方向拆成可以行动的里程碑</span><h1>长期规划</h1></div><div class="productivity-header-actions"><label><input v-model="showArchivedGoals" type="checkbox"> 显示已归档</label><button class="primary-button" type="button" @click="editGoal()">＋ 新建目标</button></div></header><div class="goal-grid"><article v-for="goal in visibleGoals" :key="goal.id" class="goal-card" :style="{ '--goal-color': goal.color }" @contextmenu.prevent="openGoalContext(goal, $event)"><header><div><strong>{{ goal.title }}</strong><span>{{ goal.status === 'active' ? '进行中' : goal.status === 'paused' ? '已暂停' : goal.status === 'archived' ? '已归档' : '已完成' }}</span></div><b>{{ store.goalProgress(goal) }}%</b></header><div class="goal-progress"><i :style="{ width: `${store.goalProgress(goal)}%` }"></i></div><p>{{ goal.description || '暂无说明' }}</p><small>{{ goal.startDate }}{{ goal.dueDate ? ` → ${goal.dueDate}` : ' · 长期' }}</small><section class="milestone-list"><header><strong>里程碑</strong><button @click="editMilestone(goal.id)">＋ 添加</button></header><label v-for="item in milestonesFor(goal.id)" :key="item.id" @contextmenu.stop.prevent="openGoalContext(goal, $event, item)"><input :checked="item.completed" type="checkbox" @change="toggleMilestone(item)"><span><strong>{{ item.title }}</strong><small>{{ item.dueDate || '无期限' }} · {{ item.taskIds.length }} 个任务</small></span><button @click.prevent="editMilestone(goal.id, item)">编辑</button></label><div v-if="!milestonesFor(goal.id).length" class="productivity-empty compact">还没有里程碑</div></section><footer><button @click="editGoal(goal)">编辑目标</button><button @click="store.archiveGoal(goal.id)">{{ goal.status === 'archived' ? '恢复使用' : '归档' }}</button><button class="danger-text" @click="store.archiveGoal(goal.id, true)">删除</button></footer></article><div v-if="!visibleGoals.length" class="productivity-empty planning-empty"><strong>从一个真正重要的方向开始</strong><span>建立目标，再用里程碑和现有任务把它变成行动。</span><button type="button" @click="editGoal()">新建第一个目标</button></div></div></section>

    <div v-if="scheduleOpen" class="productivity-modal-backdrop" @click.self="scheduleOpen = false"><form class="productivity-modal" @submit.prevent="submitSchedule"><header><div><span>时间与规划</span><h2>{{ editingScheduleId ? '编辑日程' : '新建日程' }}</h2></div><button type="button" @click="scheduleOpen = false">×</button></header><label><span>标题</span><input v-model.trim="scheduleForm.title" required maxlength="120"></label><div class="productivity-form-grid"><label><span>日期</span><input v-model="scheduleForm.date" type="date" required></label><label class="inline-check"><input v-model="scheduleForm.allDay" type="checkbox"> 全天</label></div><div v-if="!scheduleForm.allDay" class="series-clock-fields"><div v-for="(slot, index) in scheduleForm.timeSlots" :key="index" class="productivity-form-grid series-time-slot"><label><span>时间段 {{ index + 1 }} · 开始</span><input v-model="slot.startTime" type="time" required></label><label><span>结束时间（可选）</span><div class="time-slot-end"><input v-model="slot.endTime" type="time"><button v-if="scheduleForm.timeSlots.length > 1" type="button" class="danger-text" @click="removeTimeSlot(scheduleForm, index)">删除</button></div></label></div><button type="button" class="secondary-button add-time-slot" @click="addTimeSlot(scheduleForm)">＋ 添加时间段</button></div><label><span>备注</span><textarea v-model="scheduleForm.notes" rows="3"></textarea></label><div class="productivity-form-grid"><label><span>提醒方式</span><select v-model="scheduleForm.reminderMode"><option value="auto">按日程时间提醒</option><option value="custom">自定义时间</option><option value="none">不提醒</option></select></label><label v-if="scheduleForm.reminderMode === 'custom'"><span>提醒时间</span><input v-model="scheduleForm.customReminderAt" type="datetime-local" required></label></div><div class="productivity-form-grid"><label><span>关联任务</span><select v-model="scheduleForm.taskId"><option value="">不关联</option><option v-for="task in store.tasks" :key="task.id" :value="task.id">{{ store.taskTitle(task) }}</option></select></label><label><span>关联笔记</span><select v-model="scheduleForm.noteId"><option value="">不关联</option><option v-for="note in store.notes" :key="note.id" :value="note.id">{{ note.title || '无标题笔记' }}</option></select></label></div><div class="productivity-form-grid"><label><span>网址</span><input v-model.trim="scheduleForm.url" type="url" placeholder="https://"></label><label><span>链接名称</span><input v-model.trim="scheduleForm.urlLabel" placeholder="例如：打开题库"></label></div><p v-if="scheduleError" class="productivity-form-error">{{ scheduleError }}</p><footer><button v-if="editingScheduleId" type="button" class="danger-text" @click="store.deleteSchedule(editingScheduleId); scheduleOpen = false">删除</button><span></span><button type="button" @click="scheduleOpen = false">取消</button><button class="primary-button" type="submit">保存</button></footer></form></div>
    <div v-if="seriesOpen" class="productivity-modal-backdrop" @click.self="seriesOpen = false">
      <form class="productivity-modal" @submit.prevent="submitSeries">
        <header><div><span>固定日程</span><h2>{{ editingSeriesId ? '编辑规则' : '新建规则' }}</h2></div><button type="button" @click="seriesOpen = false">×</button></header>
        <label><span>标题</span><input v-model.trim="seriesForm.title" required></label>
        <div class="productivity-form-grid"><label><span>开始日期</span><input v-model="seriesForm.startDate" type="date" required></label><label><span>重复方式</span><select v-model="seriesForm.recurrenceType"><option value="daily">每天</option><option value="weekdays">工作日</option><option value="weekly">每周</option><option value="monthly">每月</option></select></label></div>
        <fieldset v-if="seriesForm.recurrenceType === 'weekly'" class="weekday-picker"><legend>重复星期</legend><label v-for="[value, label] in weekdayOptions" :key="value"><input v-model="seriesForm.weekdays" type="checkbox" :value="value"><span>{{ label }}</span></label></fieldset>
        <div class="productivity-form-grid"><label><span>间隔周期</span><input v-model.number="seriesForm.recurrenceInterval" type="number" min="1" max="99"></label><label v-if="seriesForm.recurrenceType === 'monthly'"><span>每月日期</span><input v-model.number="seriesForm.dayOfMonth" type="number" min="1" max="31"></label><label v-else><span>结束日期（可选）</span><input v-model="seriesForm.until" type="date"></label></div>
        <label v-if="seriesForm.recurrenceType === 'monthly'"><span>结束日期（可选）</span><input v-model="seriesForm.until" type="date"></label>
        <div class="productivity-form-grid"><label><span>时间类型</span><select :value="seriesForm.allDay ? 'allDay' : 'timed'" @change="setSeriesTimeType"><option value="allDay">全天</option><option value="timed">指定开始和结束时间</option></select></label><label><span>提醒方式</span><select v-model="seriesForm.reminderMode"><option value="auto">按日程时间提醒</option><option value="none">不提醒</option></select></label></div>
        <div v-if="!seriesForm.allDay" class="series-clock-fields"><div v-for="(slot, index) in seriesForm.timeSlots" :key="index" class="productivity-form-grid series-time-slot"><label><span>时间段 {{ index + 1 }} · 开始</span><input v-model="slot.startTime" type="time" required></label><label><span>结束时间（可选）</span><div class="time-slot-end"><input v-model="slot.endTime" type="time"><button v-if="seriesForm.timeSlots.length > 1" type="button" class="danger-text" @click="removeTimeSlot(seriesForm, index)">删除</button></div></label></div><button type="button" class="secondary-button add-time-slot" @click="addTimeSlot(seriesForm)">＋ 添加时间段</button></div>
        <label><span>备注</span><textarea v-model="seriesForm.notes" rows="3"></textarea></label>
        <div class="productivity-form-grid"><label><span>关联任务</span><select v-model="seriesForm.taskId"><option value="">不关联</option><option v-for="task in store.tasks" :key="task.id" :value="task.id">{{ store.taskTitle(task) }}</option></select></label><label><span>关联笔记</span><select v-model="seriesForm.noteId"><option value="">不关联</option><option v-for="note in store.notes" :key="note.id" :value="note.id">{{ note.title || '无标题笔记' }}</option></select></label></div>
        <div class="productivity-form-grid"><label><span>网址</span><input v-model.trim="seriesForm.url" type="url" placeholder="https://"></label><label><span>链接名称</span><input v-model.trim="seriesForm.urlLabel" placeholder="例如：打开题库"></label></div>
        <label class="inline-check"><input v-model="seriesForm.active" type="checkbox"> 启用这条规则</label>
        <footer><button type="button" @click="seriesOpen = false">取消</button><button class="primary-button" type="submit">保存规则</button></footer>
      </form>
    </div>
    <div v-if="goalOpen" class="productivity-modal-backdrop" @click.self="goalOpen = false"><form class="productivity-modal" @submit.prevent="submitGoal"><header><div><span>长期规划</span><h2>{{ editingGoalId ? '编辑目标' : '新建目标' }}</h2></div><button type="button" @click="goalOpen = false">×</button></header><label><span>目标名称</span><input v-model.trim="goalForm.title" required maxlength="120"></label><label><span>目标说明</span><textarea v-model="goalForm.description" rows="4"></textarea></label><div class="productivity-form-grid"><label><span>开始日期</span><input v-model="goalForm.startDate" type="date"></label><label><span>目标日期</span><input v-model="goalForm.dueDate" type="date"></label></div><div class="productivity-form-grid"><label><span>目标状态</span><select v-model="goalForm.status"><option value="active">进行中</option><option value="paused">暂停</option><option value="completed">完成</option><option value="archived">归档</option></select></label><label><span>进度方式</span><select v-model="goalForm.progressMode"><option value="automatic">按里程碑自动计算</option><option value="manual">手动设置</option></select></label></div><label v-if="goalForm.progressMode === 'manual'"><span>当前进度</span><input v-model.number="goalForm.manualProgress" type="number" min="0" max="100"></label><footer><button type="button" @click="goalOpen = false">取消</button><button class="primary-button" type="submit">保存目标</button></footer></form></div>
    <div v-if="milestoneOpen" class="productivity-modal-backdrop" @click.self="milestoneOpen = false"><form class="productivity-modal" @submit.prevent="submitMilestone"><header><div><span>长期规划</span><h2>{{ editingMilestoneId ? '编辑里程碑' : '新建里程碑' }}</h2></div><button type="button" @click="milestoneOpen = false">×</button></header><label><span>里程碑名称</span><input v-model.trim="milestoneForm.title" required></label><div class="productivity-form-grid"><label><span>期限</span><input v-model="milestoneForm.dueDate" type="date"></label><label><span>进度权重</span><input v-model.number="milestoneForm.weight" type="number" min="1" max="100"></label></div><fieldset class="task-link-picker"><legend>关联任务</legend><label v-for="task in store.tasks" :key="task.id"><input v-model="milestoneForm.taskIds" type="checkbox" :value="task.id"> {{ store.taskTitle(task) }}</label></fieldset><label class="inline-check"><input v-model="milestoneForm.completed" type="checkbox"> 直接标记为完成</label><footer><button type="button" @click="milestoneOpen = false">取消</button><button class="primary-button" type="submit">保存里程碑</button></footer></form></div>
    <div v-if="quoteManagerOpen" class="productivity-modal-backdrop" @click.self="quoteManagerOpen = false"><section class="productivity-modal quote-manager" role="dialog" aria-modal="true" aria-label="自定义语句"><header><div><span>激励语轮换</span><h2>管理自定义语句</h2></div><button type="button" @click="quoteManagerOpen = false">×</button></header><form class="quote-add-form" @submit.prevent="addCustomQuote"><input v-model="quoteDraft" maxlength="160" autofocus placeholder="写下一句想反复看到的话"><button class="primary-button" type="submit">添加</button></form><p v-if="quoteError" class="productivity-form-error">{{ quoteError }}</p><div class="quote-custom-list"><article v-for="(quote, index) in store.settings.customQuotes" :key="`${quote}-${index}`"><span>{{ quote }}</span><button type="button" aria-label="删除这条语句" @click="removeCustomQuote(index)">删除</button></article><div v-if="!store.settings.customQuotes.length" class="productivity-empty compact">还没有自定义语句。添加后会和内置语句一起轮换。</div></div><footer><small>共 {{ store.settings.customQuotes.length }} 条自定义语句</small><button type="button" @click="quoteManagerOpen = false">完成</button></footer></section></div>
    <div v-if="scheduleContext.open && scheduleContext.item" class="schedule-context-menu" :style="{ left: `${scheduleContext.x}px`, top: `${scheduleContext.y}px` }" role="menu" @pointerdown.stop><button type="button" role="menuitem" @click="toggleContextSchedule">{{ scheduleContext.item.completed ? '重新打开' : '标记为完成' }}</button><button type="button" role="menuitem" @click="editContextSchedule">编辑日程</button><button type="button" role="menuitem" @click="startContextFocus">开始计时</button><button type="button" role="menuitem" @click="copyContextTitle">复制标题</button><button v-if="scheduleContext.item.taskId" type="button" role="menuitem" @click="store.openTask(scheduleContext.item.taskId); closeScheduleContext()">打开关联任务</button><button v-if="scheduleContext.item.noteId" type="button" role="menuitem" @click="store.openNote(scheduleContext.item.noteId); closeScheduleContext()">打开关联笔记</button><button v-if="scheduleContext.item.url" type="button" role="menuitem" @click="visit(scheduleContext.item.url); closeScheduleContext()">访问链接</button><hr><button class="danger-text" type="button" role="menuitem" @click="deleteContextSchedule">{{ scheduleContext.item.id.includes('@') ? '仅删除本次' : '删除日程' }}</button></div>
    <div v-if="seriesContext.open && seriesContext.item" class="schedule-context-menu" :style="{ left: `${seriesContext.x}px`, top: `${seriesContext.y}px` }" role="menu" @pointerdown.stop><button type="button" role="menuitem" @click="editContextSeries">编辑固定日程</button><button type="button" role="menuitem" @click="duplicateContextSeries">复制固定日程</button><button type="button" role="menuitem" @click="toggleContextSeries">{{ seriesContext.item.active === false ? '启用固定日程' : '暂停固定日程' }}</button><button type="button" role="menuitem" @click="copyContextSeriesTitle">复制标题</button><hr><button class="danger-text" type="button" role="menuitem" @click="deleteContextSeries">删除固定日程</button></div>
    <div v-if="goalContext.open && goalContext.goal" class="schedule-context-menu" :style="{ left: `${goalContext.x}px`, top: `${goalContext.y}px` }" role="menu" @pointerdown.stop>
      <template v-if="goalContext.milestone"><button type="button" role="menuitem" @click="editContextMilestone">编辑里程碑</button><button type="button" role="menuitem" @click="toggleContextMilestone">{{ goalContext.milestone.completed ? '标记为未完成' : '标记为完成' }}</button><button type="button" role="menuitem" @click="copyContextGoalTitle">复制标题</button><hr><button class="danger-text" type="button" role="menuitem" @click="deleteContextMilestone">删除里程碑</button></template>
      <template v-else><button type="button" role="menuitem" @click="editContextGoal">编辑目标</button><button type="button" role="menuitem" @click="addContextMilestone">添加里程碑</button><button type="button" role="menuitem" @click="toggleContextGoalPaused">{{ goalContext.goal.status === 'paused' ? '继续目标' : '暂停目标' }}</button><button type="button" role="menuitem" @click="toggleContextGoalCompleted">{{ goalContext.goal.status === 'completed' ? '重新开始目标' : '标记目标完成' }}</button><button type="button" role="menuitem" @click="copyContextGoalTitle">复制标题</button><button type="button" role="menuitem" @click="archiveContextGoal">{{ goalContext.goal.status === 'archived' ? '恢复目标' : '归档目标' }}</button><hr><button class="danger-text" type="button" role="menuitem" @click="deleteContextGoal">删除目标</button></template>
    </div>
  </div>
</template>
