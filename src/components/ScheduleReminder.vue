<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { sendScheduleCommand } from "../services/legacy-runtime";
import { localDate, useProductivityStore } from "../stores/productivity";
import type { ScheduleEntry } from "../types/easynote";

interface ReminderCandidate { key: string; due: Date; message: string; flexible?: boolean }
interface VisibleReminder { item: ScheduleEntry; message: string }

const LOG_KEY = "easynote-schedule-reminders-v2";
const store = useProductivityStore();
const router = useRouter();
const visible = ref<VisibleReminder | null>(null);
let timer = 0;

function readLog(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(LOG_KEY) || "{}"); }
  catch { return {}; }
}

function writeLog(log: Record<string, number>): void {
  const cutoff = Date.now() - 45 * 86_400_000;
  const compact = Object.fromEntries(Object.entries(log).filter(([, timestamp]) => timestamp >= cutoff));
  localStorage.setItem(LOG_KEY, JSON.stringify(compact));
}

function candidates(item: ScheduleEntry): ReminderCandidate[] {
  if (item.completed || item.reminderMode === "none") return [];
  if (item.reminderMode === "custom" && !item.id.includes("@")) {
    const due = new Date(item.customReminderAt || "");
    return Number.isNaN(due.getTime()) ? [] : [{ key: "custom", due, message: "这是你设置的自定义提醒" }];
  }
  if (item.allDay) return [
    { key: "morning", due: new Date(`${item.date}T09:00:00`), message: "今天有这项安排，准备开始吧", flexible: true },
    { key: "evening", due: new Date(`${item.date}T20:00:00`), message: "今天尚未完成，请确认进度", flexible: true },
  ];
  if (!item.startTime) return [];
  const result: ReminderCandidate[] = [{ key: "start", due: new Date(`${item.date}T${item.startTime}:00`), message: "日程现在开始，完成后记得标记" }];
  if (item.endTime) result.push({ key: "finish", due: new Date(`${item.date}T${item.endTime}:00`), message: "日程已到结束时间，请确认是否完成" });
  return result;
}

function show(item: ScheduleEntry, message: string, tag: string): void {
  visible.value = { item, message };
  if (navigator.vibrate) navigator.vibrate([140, 70, 140]);
  if ("Notification" in window && Notification.permission === "granted") {
    const notification = new Notification(`EasyNote · ${item.title}`, { body: message, tag });
    notification.onclick = () => { window.focus(); openSchedule(); notification.close(); };
  }
}

function check(): void {
  const now = Date.now();
  const log = readLog();
  let changed = false;
  for (const item of store.entriesOn(localDate())) {
    for (const reminder of candidates(item)) {
      const due = reminder.due.getTime();
      const key = `${item.id}|${reminder.key}|${due}`;
      if (log[key]) continue;
      const delta = now - due;
      const inWindow = reminder.flexible ? delta >= 0 && delta < 12 * 60 * 60_000 : delta >= 0 && delta <= 5 * 60_000;
      if (!inWindow) continue;
      log[key] = now; changed = true;
      show(item, reminder.message, `schedule-${key}`);
    }
  }
  if (changed) writeLog(log);
}

function openSchedule(): void {
  const reminder = visible.value;
  if (!reminder) return;
  sendScheduleCommand({ type: "select-date", date: reminder.item.date });
  void router.push("/schedule");
  visible.value = null;
}

async function complete(): Promise<void> {
  if (!visible.value) return;
  await store.toggleSchedule(visible.value.item.id);
  visible.value = null;
}

onMounted(() => { check(); timer = window.setInterval(check, 30_000); });
onBeforeUnmount(() => window.clearInterval(timer));
</script>

<template>
  <aside v-if="visible" class="schedule-reminder" role="alert">
    <div><span>日程提醒</span><strong>{{ visible.item.title }}</strong><small>{{ visible.message }}</small></div>
    <div><button type="button" @click="openSchedule">查看</button><button type="button" @click="complete">完成</button><button type="button" aria-label="关闭提醒" @click="visible = null">×</button></div>
  </aside>
</template>
