import { createRouter, createWebHashHistory, type RouteRecordRaw } from "vue-router";

const EmptyRoute = { render: () => null };

const routes: RouteRecordRaw[] = [
  { path: "/", redirect: "/notes" },
  { path: "/notes", name: "notes", component: EmptyRoute },
  { path: "/notes/edit", name: "note-edit", component: EmptyRoute },
  { path: "/tasks", name: "tasks", component: EmptyRoute },
  { path: "/schedule", name: "schedule", component: EmptyRoute },
  { path: "/schedule/all", name: "schedule-all", component: EmptyRoute },
  { path: "/schedule/series", name: "schedule-series", component: EmptyRoute },
  { path: "/schedule/reviews", name: "schedule-reviews", component: EmptyRoute },
  { path: "/schedule/goals", name: "schedule-goals", component: EmptyRoute },
  { path: "/whiteboards", name: "whiteboards", component: EmptyRoute },
  { path: "/:pathMatch(.*)*", redirect: "/notes" },
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
});
