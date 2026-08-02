import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { router } from "./router";
import "./mobile-pwa.css";

const root = document.querySelector("#vue-shell-root");
if (!root) throw new Error("Vue shell mount point is missing");

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.mount(root);

// Vue and Pinia own the shell before compatibility workspaces initialize.
// New modules can therefore consume the typed runtime without window globals.
void import("./legacy/app-v2");
