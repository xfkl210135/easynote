import { defineStore } from "pinia";
import type { AppState, SaveStatus } from "../types/easynote";
import type { EasyNoteRepository } from "../services/data-repository";

export const useAppStore = defineStore("app", {
  state: () => ({
    data: null as AppState | null,
    saveStatus: "saved" as SaveStatus,
    online: navigator.onLine,
    repository: null as EasyNoteRepository | null,
  }),
  actions: {
    attachRepository(repository: EasyNoteRepository) {
      this.repository = repository;
    },
    setData(data: AppState) {
      this.data = data;
    },
    setSaveStatus(status: SaveStatus) {
      this.saveStatus = status;
    },
    setOnline(online: boolean) {
      this.online = online;
    },
    async flush() {
      return this.repository ? this.repository.flush() : flushLegacyWorkspace();
    },
  },
});

export async function flushLegacyWorkspace(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("easynote:flush-complete", onComplete);
      resolve(result);
    };
    const onComplete = (event: Event) => finish(Boolean((event as CustomEvent<{ ok?: boolean }>).detail?.ok));
    window.addEventListener("easynote:flush-complete", onComplete, { once: true });
    window.dispatchEvent(new CustomEvent("easynote:flush-request"));
    window.setTimeout(() => {
      const indicator = document.querySelector("#saveIndicator");
      finish(!indicator?.classList.contains("failed"));
    }, 5000);
  });
}
