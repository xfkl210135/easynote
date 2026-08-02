import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { router } from "./router";
import "./mobile-pwa.css";

// Compatibility checkpoint: the proven v8 workspaces are now imported through
// one ES-module dependency graph while Vue owns routing and the responsive shell.
import "./legacy/app-v2";

const root = document.querySelector("#vue-shell-root");
if (!root) throw new Error("Vue shell mount point is missing");

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.mount(root);
