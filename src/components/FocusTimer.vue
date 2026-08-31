<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from "vue";
import { useRouter } from "vue-router";
import { useProductivityStore } from "../stores/productivity";
import FloatingNoteWorkspace from "./FloatingNoteWorkspace.vue";

interface DocumentPictureInPictureController {
  requestWindow(options?: { width?: number; height?: number; disallowReturnToOpener?: boolean }): Promise<Window>;
}

const store = useProductivityStore();
const router = useRouter();
const open = ref(false);
const expanded = ref(true);
const error = ref("");
const actionBusy = ref(false);
const pipWindow = shallowRef<Window | null>(null);
const pipMount = shallowRef<HTMLElement | null>(null);
const pipMode = ref<"notes" | "focus">("notes");
const pipStartOpen = ref(false);
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
const progressPercent = computed(() => {
  const session = active.value;
  if (!session) return 0;
  if (session.phase === "awaitingBreak") return 100;
  const plannedMinutes = session.phase === "break" ? session.breakMinutes : session.focusMinutes;
  const plannedMs = Math.max(1, plannedMinutes * 60_000);
  return Math.max(0, Math.min(100, ((plannedMs - store.remainingMs) / plannedMs) * 100));
});

const pipStyles = `
  :root { color-scheme: light; font-family: Inter, "Microsoft YaHei", "Segoe UI", sans-serif; }
  :root[data-theme="dark"] { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body, #focusPictureInPictureMount { width: 100%; height: 100%; }
  body { margin: 0; min-width: 260px; min-height: 170px; overflow: hidden; background: var(--bg,#f5f7fb); }
  .companion-shell { width: 100%; height: 100%; display: flex; flex-direction: column; overflow: hidden; }
  .companion-tabs { height: 38px; flex: 0 0 auto; display: flex; align-items: center; gap: 4px; padding: 4px 8px; border-bottom: 1px solid var(--border,#dbe2f0); background: var(--surface,#fff); }
  .companion-tabs button { height: 29px; padding: 0 12px; border: 0; border-radius: 7px; color: var(--muted,#69758c); background: transparent; font: inherit; font-size: 11px; font-weight: 700; cursor: pointer; }
  .companion-tabs button.active { color: var(--primary,#2f6ddd); background: var(--primary-soft,#edf3ff); }
  .companion-tabs button:disabled { opacity: .45; cursor: not-allowed; }
  .companion-tabs span { min-width: 0; flex: 1; overflow: hidden; color: var(--muted,#69758c); font-size: 10px; text-align: right; text-overflow: ellipsis; white-space: nowrap; }
  .companion-body { min-width: 0; min-height: 0; flex: 1; overflow: hidden; }
  .focus-pip-card { width: 100%; height: 100%; display: flex; flex-direction: column; gap: 12px; padding: 17px 18px 15px; color: var(--text,#172033); background: linear-gradient(145deg,var(--surface,#f8faff) 0%,var(--primary-soft,#eef3ff) 100%); }
  .focus-pip-heading { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
  .focus-pip-status { display: flex; align-items: center; gap: 7px; color: var(--primary,#3674eb); font-size: 13px; font-weight: 700; }
  .focus-pip-status::before { width: 7px; height: 7px; border-radius: 50%; background: var(--primary,#3674eb); box-shadow: 0 0 0 4px color-mix(in srgb,var(--primary,#3674eb) 14%,transparent); content: ""; }
  .focus-pip-time { color: var(--text,#111a2e); font-size: clamp(34px,16vw,48px); font-weight: 780; line-height: 1; letter-spacing: 1px; font-variant-numeric: tabular-nums; }
  .focus-pip-label { min-height: 21px; overflow: hidden; color: var(--text-soft,#69758c); font-size: 15px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
  .focus-pip-progress { height: 5px; overflow: hidden; border-radius: 999px; background: var(--primary-soft,rgba(54,116,235,.14)); }
  .focus-pip-progress > i { display: block; width: var(--progress); height: 100%; border-radius: inherit; background: linear-gradient(90deg,var(--primary,#4d82f4),color-mix(in srgb,var(--primary,#4d82f4) 68%,#8a68ee)); transition: width .25s linear; }
  .focus-pip-actions { display: flex; gap: 8px; margin-top: auto; }
  .focus-pip-actions button { min-width: 0; min-height: 38px; flex: 1; padding: 0 10px; border: 1px solid var(--border,#dbe2f0); border-radius: 9px; color: var(--text-soft,#344057); background: var(--surface,#fff); font: inherit; font-size: 12px; font-weight: 650; cursor: pointer; }
  .focus-pip-actions button:hover { border-color: var(--primary,#76a0f5); color: var(--primary,#2868e8); background: var(--surface,#fff); }
  .focus-pip-actions button.primary { border-color: var(--primary,#3674eb); color: #fff; background: var(--primary,#3674eb); }
  .focus-pip-actions button.danger { color: #d44d5c; }
  .focus-pip-actions button:disabled { opacity: .55; cursor: wait; }
  .pip-start-backdrop { position: absolute; inset: 38px 0 0; z-index: 20; display: grid; place-items: center; padding: 14px; background: rgba(15,23,42,.34); }
  .pip-start-form { width: min(360px, 100%); max-height: 100%; overflow: auto; display: grid; gap: 10px; padding: 16px; border: 1px solid var(--border,#dbe2f0); border-radius: 13px; color: var(--text,#172033); background: var(--surface,#fff); box-shadow: 0 18px 46px rgba(15,23,42,.24); font-size: 12px; }
  .pip-start-form h3 { margin: 0 0 3px; font-size: 16px; }
  .pip-start-form label { display: grid; gap: 4px; color: var(--text-soft,#69758c); font-size: 11px; font-weight: 650; }
  .pip-start-form input,.pip-start-form select { min-width: 0; height: 32px; padding: 0 8px; border: 1px solid var(--border,#dbe2f0); border-radius: 7px; color: var(--text,#172033); background: var(--surface-soft,#f8faff); font: inherit; }
  .pip-start-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .pip-start-actions { display: flex; justify-content: flex-end; gap: 7px; margin-top: 3px; }
  .pip-start-actions button { min-height: 32px; padding: 0 12px; border: 1px solid var(--border,#dbe2f0); border-radius: 7px; color: var(--text-soft,#344057); background: var(--surface,#fff); font: inherit; cursor: pointer; }
  .pip-start-actions button.primary { border-color: var(--primary,#3674eb); color: #fff; background: var(--primary,#3674eb); }
  .pip-start-error { margin: 0; color: #d44d5c; font-size: 11px; }
  :root[data-theme="dark"] body { background: #101522; }
  :root[data-theme="dark"] .focus-pip-card { color: #e8edf8; background: linear-gradient(145deg,#1c2434 0%,#141b29 100%); }
  :root[data-theme="dark"] .focus-pip-time { color: #f4f7ff; }
  :root[data-theme="dark"] .focus-pip-label { color: #9ca8bd; }
  :root[data-theme="dark"] .focus-pip-actions button { border-color: #364158; color: #d7deeb; background: #252e40; }
  :root[data-theme="dark"] .focus-pip-actions button:hover { border-color: #6894ed; color: #8db1fa; background: #2b3549; }
  :root[data-theme="dark"] .focus-pip-actions button.primary { color: white; background: #4079e6; }
  :root[data-theme="dark"] .focus-pip-actions button.danger { color: #ff8b97; }
  :root[data-theme="dark"] .companion-tabs { border-color: #364158; background: #171e2b; }
  :root[data-theme="dark"] .companion-tabs button { color: #9ca8bd; }
  :root[data-theme="dark"] .companion-tabs button.active { color: #8db1fa; background: #26334a; }
  :root[data-theme="dark"] .companion-tabs span { color: #9ca8bd; }
`;

function pictureInPictureController(): DocumentPictureInPictureController | null {
  return (window as Window & { documentPictureInPicture?: DocumentPictureInPictureController }).documentPictureInPicture || null;
}

function closePictureInPicture() {
  const current = pipWindow.value;
  pipMount.value = null;
  pipWindow.value = null;
  pipStartOpen.value = false;
  if (current && !current.closed) current.close();
}

async function openPictureInPicture(mode: "notes" | "focus" = "focus") {
  const current = pipWindow.value;
  pipMode.value = mode;
  if (current && !current.closed) {
    if (mode === "notes" && (current.innerWidth < 720 || current.innerHeight < 520)) try { current.resizeTo(980, 720); } catch { /* the user can resize the window manually */ }
    current.focus(); return;
  }
  if (mode === "focus" && !active.value) return;
  const controller = pictureInPictureController();
  if (!controller) {
    store.toast("当前浏览器不支持悬浮工作区，请使用最新版 Chrome 或 Edge");
    return;
  }
  try {
    const remembered = JSON.parse(localStorage.getItem("easynote-companion-window-size") || "null") as { width?: number; height?: number } | null;
    const width = mode === "notes" ? Math.max(720, remembered?.width || 980) : 340;
    const height = mode === "notes" ? Math.max(520, remembered?.height || 720) : 270;
    const floatingWindow = await controller.requestWindow({ width, height, disallowReturnToOpener: false });
    floatingWindow.document.title = mode === "notes" ? "EasyNote 悬浮笔记" : `专注 · ${active.value?.label || "EasyNote"}`;
    floatingWindow.document.documentElement.dataset.theme = document.documentElement.dataset.theme || "light";
    document.querySelectorAll<HTMLStyleElement | HTMLLinkElement>('style,link[rel="stylesheet"]').forEach((source) => {
      const clone = source.cloneNode(true) as HTMLStyleElement | HTMLLinkElement;
      if (source instanceof HTMLLinkElement && clone instanceof HTMLLinkElement) clone.href = source.href;
      floatingWindow.document.head.append(clone);
    });
    const style = floatingWindow.document.createElement("style");
    style.textContent = pipStyles;
    const mount = floatingWindow.document.createElement("div");
    mount.id = "focusPictureInPictureMount";
    floatingWindow.document.head.append(style);
    floatingWindow.document.body.append(mount);
    pipWindow.value = floatingWindow;
    pipMount.value = mount;
    floatingWindow.addEventListener("resize", () => {
      if (pipMode.value === "notes") localStorage.setItem("easynote-companion-window-size", JSON.stringify({ width: floatingWindow.innerWidth, height: floatingWindow.innerHeight }));
    });
    floatingWindow.addEventListener("pagehide", () => {
      if (pipWindow.value === floatingWindow) { pipMount.value = null; pipWindow.value = null; pipStartOpen.value = false; }
    }, { once: true });
  } catch (cause) {
    if ((cause as DOMException | undefined)?.name !== "NotAllowedError") store.toast("悬浮工作区打开失败，请稍后重试");
  }
}

let timer = 0;
function showStarter(initial: { label?: string; taskId?: string; scheduleEntryId?: string } = {}, showMain = true) {
  error.value = "";
  form.label = initial.label || "";
  form.taskId = initial.taskId || "";
  form.scheduleEntryId = initial.scheduleEntryId || "";
  form.focusMinutes = store.settings.focusMinutes;
  form.breakMinutes = store.settings.breakMinutes;
  open.value = showMain;
}
function showStarterFromPip() { showStarter({}, false); pipStartOpen.value = true; }
function onStartRequest(event: Event) { showStarter((event as CustomEvent<{ label?: string; taskId?: string; scheduleEntryId?: string }>).detail || {}); }
function onOpenNotesRequest() { void openPictureInPicture("notes"); }
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
    open.value = false; pipStartOpen.value = false; expanded.value = true;
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
function openFocusHistory() { void router.push("/schedule/focus"); window.focus(); }

let originalTitle = "EasyNote";
let themeObserver: MutationObserver | null = null;
watch([active, timeLabel], () => {
  const session = active.value;
  document.title = session ? `${timeLabel.value} · ${session.label} | EasyNote` : originalTitle;
  const floatingWindow = pipWindow.value;
  if (session && floatingWindow && !floatingWindow.closed) floatingWindow.document.title = `${timeLabel.value} · ${session.label}`;
  if (!session && floatingWindow && pipMode.value === "focus") pipMode.value = "notes";
});

onMounted(() => {
  originalTitle = document.title;
  window.addEventListener("easynote:start-focus", onStartRequest);
  window.addEventListener("easynote:open-floating-notes", onOpenNotesRequest);
  document.querySelector("#floatingNotesButton")?.addEventListener("click", onOpenNotesRequest);
  timer = window.setInterval(() => { void store.tickTimer(); }, 1000);
  themeObserver = new MutationObserver(() => {
    if (pipWindow.value && !pipWindow.value.closed) pipWindow.value.document.documentElement.dataset.theme = document.documentElement.dataset.theme || "light";
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  void store.tickTimer();
});
onBeforeUnmount(() => {
  window.removeEventListener("easynote:start-focus", onStartRequest);
  window.removeEventListener("easynote:open-floating-notes", onOpenNotesRequest);
  document.querySelector("#floatingNotesButton")?.removeEventListener("click", onOpenNotesRequest);
  window.clearInterval(timer);
  themeObserver?.disconnect();
  document.title = originalTitle;
  closePictureInPicture();
});
</script>

<template>
  <aside class="focus-mini" :class="{ active: active, collapsed: !expanded }" aria-live="polite">
    <template v-if="active">
      <button class="focus-mini-main" type="button" @click="expanded = !expanded">
        <span>{{ phaseLabel }}</span><strong>{{ timeLabel }}</strong><small>{{ active.label }}</small>
      </button>
      <div v-if="expanded" class="focus-mini-actions">
        <button type="button" class="focus-pip-button" :disabled="actionBusy" @click="openPictureInPicture('focus')">{{ pipWindow ? '切换到悬浮计时' : '悬浮到桌面' }}</button>
        <button type="button" class="focus-pip-button" @click="openPictureInPicture('notes')">悬浮笔记工作区</button>
        <button type="button" @click="openFocusHistory">查看记录</button>
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
    <template v-else><button class="focus-start-button" type="button" @click="showStarter()"><span>◷</span> 开始专注</button><button class="floating-notes-launch" type="button" @click="openPictureInPicture('notes')">▣ 悬浮笔记</button></template>
  </aside>

  <Teleport v-if="pipMount" :to="pipMount">
    <div class="companion-shell">
      <nav class="companion-tabs"><button type="button" :class="{ active: pipMode === 'notes' }" @click="pipMode = 'notes'; pipStartOpen = false">笔记工作区</button><button type="button" :disabled="!active" :class="{ active: pipMode === 'focus' }" @click="pipMode = 'focus'; pipStartOpen = false">专注计时</button><button v-if="pipMode === 'notes' && !active" type="button" class="companion-start" @click="showStarterFromPip">＋ 开始专注</button><span v-if="active">{{ timeLabel }} · {{ active.label }}</span></nav>
      <div class="companion-body">
        <FloatingNoteWorkspace v-if="pipMode === 'notes'" @close="closePictureInPicture" />
        <main v-else-if="active" class="focus-pip-card" aria-live="polite">
      <div class="focus-pip-heading">
        <span class="focus-pip-status">{{ phaseLabel }}</span>
        <strong class="focus-pip-time">{{ timeLabel }}</strong>
      </div>
      <div class="focus-pip-label" :title="active.label">{{ active.label }}</div>
      <div class="focus-pip-progress" aria-hidden="true"><i :style="{ '--progress': `${progressPercent}%` }"></i></div>
      <div class="focus-pip-actions">
        <template v-if="active.phase === 'awaitingBreak'">
          <button class="primary" type="button" :disabled="actionBusy" @click="beginBreak">开始休息</button>
          <button v-if="active.taskId || active.scheduleEntryId" type="button" :disabled="actionBusy" @click="store.markLinkedComplete(active.id)">关联完成</button>
          <button type="button" :disabled="actionBusy" @click="finish">结束本轮</button>
        </template>
        <template v-else>
          <button v-if="active.status === 'active'" class="primary" type="button" :disabled="actionBusy" @click="pause">暂停</button>
          <button v-else class="primary" type="button" :disabled="actionBusy" @click="resume">继续</button>
          <button type="button" :disabled="actionBusy" @click="finish">提前完成</button>
          <button class="danger" type="button" :disabled="actionBusy" @click="abandon">放弃</button>
        </template>
      </div>
        </main>
        <div v-if="pipStartOpen" class="pip-start-backdrop" @click.self="pipStartOpen = false">
          <form class="pip-start-form" @submit.prevent="start">
            <h3>开始专注计时</h3>
            <label><span>本轮名称</span><input v-model.trim="form.label" required maxlength="100" placeholder="例如：算法题练习"></label>
            <div class="pip-start-grid"><label><span>关联任务</span><select v-model="form.taskId" @change="syncLabelFromTask"><option value="">不关联任务</option><option v-for="task in unfinishedTasks" :key="task.id" :value="task.id">{{ store.taskTitle(task) }}</option></select></label><label><span>关联日程</span><select v-model="form.scheduleEntryId" @change="syncLabelFromSchedule"><option value="">不关联日程</option><option v-for="entry in availableSchedules" :key="entry.id" :value="entry.id">{{ entry.date }} · {{ entry.title }}</option></select></label></div>
            <div class="pip-start-grid"><label><span>专注分钟</span><input v-model.number="form.focusMinutes" type="number" min="1" max="480" required></label><label><span>休息分钟</span><input v-model.number="form.breakMinutes" type="number" min="1" max="120" required></label></div>
            <p v-if="error" class="pip-start-error">{{ error }}</p>
            <div class="pip-start-actions"><button type="button" @click="pipStartOpen = false">取消</button><button class="primary" type="submit">开始计时</button></div>
          </form>
        </div>
      </div>
    </div>
  </Teleport>

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
