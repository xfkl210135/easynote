<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { useProductivityStore } from "../stores/productivity";

const store = useProductivityStore();
const open = ref(false);
const expanded = ref(true);
const error = ref("");
const actionBusy = ref(false);
const form = reactive({ label: "", taskId: "", scheduleEntryId: "", focusMinutes: store.settings.focusMinutes, breakMinutes: store.settings.breakMinutes });

const active = computed(() => store.activeSession);
const unfinishedTasks = computed(() => store.tasks.filter((task) => !store.taskDone(task)));
const availableSchedules = computed(() => store.schedules.filter((entry) => !entry.completed).slice().sort((a, b) => `${a.date}${a.startTime || ""}`.localeCompare(`${b.date}${b.startTime || ""}`)).slice(0, 80));
const phaseLabel = computed(() => active.value?.phase === "break" ? "休息中" : active.value?.phase === "awaitingBreak" ? "专注完成" : active.value?.status === "paused" ? "已暂停" : "专注中");
const timeLabel = computed(() => {
  if (active.value?.phase === "awaitingBreak") return "可以休息了";
  const seconds = Math.ceil(store.remainingMs / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
});

let timer = 0;
function showStarter(initial: { label?: string; taskId?: string; scheduleEntryId?: string } = {}) {
  error.value = "";
  form.label = initial.label || "";
  form.taskId = initial.taskId || "";
  form.scheduleEntryId = initial.scheduleEntryId || "";
  form.focusMinutes = store.settings.focusMinutes;
  form.breakMinutes = store.settings.breakMinutes;
  open.value = true;
}
function onStartRequest(event: Event) { showStarter((event as CustomEvent<{ label?: string; taskId?: string; scheduleEntryId?: string }>).detail || {}); }
function syncLabelFromTask() {
  if (!form.taskId) return;
  const task = store.tasks.find((item) => item.id === form.taskId);
  if (task) form.label = store.taskTitle(task);
  form.scheduleEntryId = "";
}
function syncLabelFromSchedule() {
  if (!form.scheduleEntryId) return;
  const entry = store.schedules.find((item) => item.id === form.scheduleEntryId);
  if (entry) { form.label = entry.title; form.taskId = entry.taskId || ""; }
}
async function start() {
  error.value = "";
  try {
    if ("Notification" in window && Notification.permission === "default") void Notification.requestPermission();
    await store.startFocus(form.label, form.taskId, form.scheduleEntryId, Number(form.focusMinutes), Number(form.breakMinutes));
    open.value = false; expanded.value = true;
  } catch (cause) { error.value = cause instanceof Error ? cause.message : "无法启动计时"; }
}

async function runTimerAction(action: () => Promise<void>) {
  if (actionBusy.value) return;
  actionBusy.value = true;
  try { await action(); }
  catch (cause) { store.toast(cause instanceof Error ? cause.message : "计时操作失败，请重试"); }
  finally { actionBusy.value = false; }
}
const pause = () => runTimerAction(() => store.pauseTimer());
const resume = () => runTimerAction(() => store.resumeTimer());
const beginBreak = () => runTimerAction(() => store.startBreak());
const finish = () => runTimerAction(() => store.finishTimer(false));
const abandon = () => runTimerAction(() => store.finishTimer(true));

onMounted(() => {
  window.addEventListener("easynote:start-focus", onStartRequest);
  timer = window.setInterval(() => { void store.tickTimer(); }, 1000);
  void store.tickTimer();
});
onBeforeUnmount(() => { window.removeEventListener("easynote:start-focus", onStartRequest); window.clearInterval(timer); });
</script>

<template>
  <aside class="focus-mini" :class="{ active: active, collapsed: !expanded }" aria-live="polite">
    <template v-if="active">
      <button class="focus-mini-main" type="button" @click="expanded = !expanded">
        <span>{{ phaseLabel }}</span><strong>{{ timeLabel }}</strong><small>{{ active.label }}</small>
      </button>
      <div v-if="expanded" class="focus-mini-actions">
        <template v-if="active.phase === 'awaitingBreak'">
          <button type="button" class="focus-break-button" :disabled="actionBusy" @click="beginBreak">开始休息 {{ active.breakMinutes }} 分钟</button>
          <button v-if="active.taskId || active.scheduleEntryId" type="button" :disabled="actionBusy" @click="store.markLinkedComplete(active.id)">标记关联完成</button>
          <button type="button" :disabled="actionBusy" @click="finish">结束本轮</button>
        </template>
        <template v-else>
          <button v-if="active.status === 'active'" type="button" :disabled="actionBusy" @click="pause">暂停</button>
          <button v-else type="button" :disabled="actionBusy" @click="resume">继续</button>
          <button type="button" :disabled="actionBusy" @click="finish">提前完成</button>
        </template>
        <button v-if="active.phase !== 'awaitingBreak'" class="danger-text" type="button" :disabled="actionBusy" @click="abandon">放弃</button>
      </div>
    </template>
    <button v-else class="focus-start-button" type="button" @click="showStarter()"><span>◷</span> 开始专注</button>
  </aside>

  <div v-if="open" class="productivity-modal-backdrop" @click.self="open = false">
    <form class="productivity-modal focus-start-modal" @submit.prevent="start">
      <header><div><span>全局专注计时</span><h2>开始一段专注</h2></div><button type="button" aria-label="关闭" @click="open = false">×</button></header>
      <label><span>本轮名称</span><input v-model.trim="form.label" required maxlength="100" placeholder="例如：算法题练习"></label>
      <div class="productivity-form-grid">
        <label><span>关联任务</span><select v-model="form.taskId" @change="syncLabelFromTask"><option value="">不关联任务</option><option v-for="task in unfinishedTasks" :key="task.id" :value="task.id">{{ store.taskTitle(task) }}</option></select></label>
        <label><span>关联日程</span><select v-model="form.scheduleEntryId" @change="syncLabelFromSchedule"><option value="">不关联日程</option><option v-for="entry in availableSchedules" :key="entry.id" :value="entry.id">{{ entry.date }} · {{ entry.title }}</option></select></label>
      </div>
      <div class="productivity-form-grid">
        <label><span>专注分钟</span><input v-model.number="form.focusMinutes" type="number" min="1" max="480" required></label>
        <label><span>休息分钟</span><input v-model.number="form.breakMinutes" type="number" min="1" max="120" required></label>
      </div>
      <p v-if="error" class="productivity-form-error">{{ error }}</p>
      <footer><button type="button" @click="open = false">取消</button><button class="primary-button" type="submit">开始计时</button></footer>
    </form>
  </div>
</template>
