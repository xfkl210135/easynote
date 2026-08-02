<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useRegisterSW } from "virtual:pwa-register/vue";
import { useAppStore } from "./stores/app";
import ProductiveCenter from "./components/ProductivityCenter.vue";
import FocusTimer from "./components/FocusTimer.vue";
import ScheduleReminder from "./components/ScheduleReminder.vue";
import { easyNoteRuntime } from "./services/legacy-runtime";
import "./productivity.css";

type WorkspaceName = "notes" | "tasks" | "schedule" | "whiteboards";

const route = useRoute();
const router = useRouter();
const store = useAppStore();
const activeWorkspace = ref<WorkspaceName>("notes");
let routeSyncOrigin: "shell" | "legacy" | null = null;

const { needRefresh, offlineReady, updateServiceWorker } = useRegisterSW({
  immediate: true,
  onRegisteredSW(_url, registration) {
    if (registration) window.setInterval(() => registration.update(), 60 * 60 * 1000);
  },
});

const routeForWorkspace: Record<WorkspaceName, string> = {
  notes: "/notes",
  tasks: "/tasks",
  schedule: "/schedule",
  whiteboards: "/whiteboards",
};

function legacyTarget(workspace: WorkspaceName): HTMLElement | null {
  const selectors: Record<WorkspaceName, string> = {
    notes: '[data-view="all"]',
    tasks: "#taskNavButton",
    schedule: "#scheduleNavButton",
    whiteboards: "#whiteboardNavButton",
  };
  return document.querySelector(selectors[workspace]);
}

function activateLegacyWorkspace(workspace: WorkspaceName) {
  activeWorkspace.value = workspace;
  legacyTarget(workspace)?.click();
  if (workspace === "tasks" && matchMedia("(max-width: 620px)").matches) {
    window.setTimeout(() => document.querySelector<HTMLElement>('[data-task-view="board"]')?.click(), 0);
  }
}

async function navigate(workspace: WorkspaceName) {
  routeSyncOrigin = "shell";
  try {
    activateLegacyWorkspace(workspace);
    if (route.path !== routeForWorkspace[workspace]) await router.push(routeForWorkspace[workspace]);
  } finally {
    routeSyncOrigin = null;
  }
}

function workspaceFromBody(): WorkspaceName {
  if (document.body.classList.contains("task-mode")) return "tasks";
  if (document.body.classList.contains("schedule-mode")) return "schedule";
  if (document.body.classList.contains("whiteboard-mode")) return "whiteboards";
  return "notes";
}

function syncRouteFromLegacy() {
  const workspace = workspaceFromBody();
  activeWorkspace.value = workspace;
  if (routeSyncOrigin === "shell") return;
  if (workspace !== "notes") {
    const alreadyOnWorkspaceRoute = workspace === "schedule" ? route.path.startsWith("/schedule") : route.path === routeForWorkspace[workspace];
    if (!alreadyOnWorkspaceRoute) {
      routeSyncOrigin = "legacy";
      void router.replace(routeForWorkspace[workspace]).finally(() => { if (routeSyncOrigin === "legacy") routeSyncOrigin = null; });
    }
    return;
  }
  const editorOpen = document.querySelector("#workspace")?.classList.contains("editor-open");
  const target = editorOpen && matchMedia("(max-width: 620px)").matches ? "/notes/edit" : "/notes";
  if (route.path !== target) {
    routeSyncOrigin = "legacy";
    void router.replace(target).finally(() => { if (routeSyncOrigin === "legacy") routeSyncOrigin = null; });
  }
}

async function applyUpdate() {
  const saved = await store.flush();
  if (!saved) return;
  await updateServiceWorker(true);
}

function dismissPwaNotice() {
  offlineReady.value = false;
}

function onOnlineChange() {
  store.setOnline(navigator.onLine);
}

function onSaveStatus(event: Event) {
  const status = (event as CustomEvent<{ status?: string }>).detail?.status;
  if (["dirty", "saving", "saved", "failed"].includes(status || "")) {
    store.setSaveStatus(status as "dirty" | "saving" | "saved" | "failed");
  }
}

let observer: MutationObserver | null = null;

watch(() => route.path, (path) => {
  if (routeSyncOrigin) return;
  if (path === "/notes/edit") return;
  if (path.startsWith("/schedule")) {
    window.setTimeout(() => activateLegacyWorkspace("schedule"), 0);
    return;
  }
  const entry = Object.entries(routeForWorkspace).find(([, candidate]) => candidate === path);
  if (entry) window.setTimeout(() => activateLegacyWorkspace(entry[0] as WorkspaceName), 0);
  if (path === "/notes") document.querySelector<HTMLElement>("#backToList")?.click();
});

watch(easyNoteRuntime, () => {
  if (route.path.startsWith("/schedule")) window.setTimeout(() => activateLegacyWorkspace("schedule"), 0);
});

onMounted(() => {
  document.documentElement.classList.toggle("directory-backup-unsupported", !("showDirectoryPicker" in window));
  window.addEventListener("online", onOnlineChange);
  window.addEventListener("offline", onOnlineChange);
  window.addEventListener("easynote:save-status", onSaveStatus);
  observer = new MutationObserver(syncRouteFromLegacy);
  observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  const workspace = document.querySelector("#workspace");
  if (workspace) observer.observe(workspace, { attributes: true, attributeFilter: ["class"] });
  window.setTimeout(() => {
    const path = route.path;
    if (path === "/tasks") activateLegacyWorkspace("tasks");
    else if (path.startsWith("/schedule")) activateLegacyWorkspace("schedule");
    else if (path === "/whiteboards") activateLegacyWorkspace("whiteboards");
    else syncRouteFromLegacy();
  }, 100);
});

onBeforeUnmount(() => {
  observer?.disconnect();
  window.removeEventListener("online", onOnlineChange);
  window.removeEventListener("offline", onOnlineChange);
  window.removeEventListener("easynote:save-status", onSaveStatus);
});
</script>

<template>
  <nav class="mobile-bottom-nav" aria-label="手机端主导航">
    <button :class="{ active: activeWorkspace === 'notes' }" type="button" @click="navigate('notes')">
      <span aria-hidden="true">▤</span><b>笔记</b>
    </button>
    <button :class="{ active: activeWorkspace === 'tasks' }" type="button" @click="navigate('tasks')">
      <span aria-hidden="true">✓</span><b>任务</b>
    </button>
    <button :class="{ active: activeWorkspace === 'schedule' }" type="button" @click="navigate('schedule')">
      <span aria-hidden="true">▦</span><b>日程</b>
    </button>
    <button :class="{ active: activeWorkspace === 'whiteboards' }" type="button" @click="navigate('whiteboards')">
      <span aria-hidden="true">◇</span><b>白板</b>
    </button>
  </nav>

  <aside v-if="!store.online" class="pwa-status pwa-offline" role="status">当前离线，修改仍会保存在本机</aside>
  <aside v-if="offlineReady" class="pwa-status" role="status">
    <span>EasyNote 已可离线使用</span><button type="button" @click="dismissPwaNotice">知道了</button>
  </aside>
  <aside v-if="needRefresh" class="pwa-status" role="status">
    <span>发现新版本，保存后即可更新</span><button type="button" @click="applyUpdate">保存并更新</button>
  </aside>

  <Teleport v-if="easyNoteRuntime" to="#productivityCenterMount">
    <ProductiveCenter />
  </Teleport>
  <FocusTimer />
  <ScheduleReminder />

</template>
