import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  base: "./",
  plugins: [
    vue(),
    VitePWA({
      registerType: "prompt",
      injectRegister: false,
      includeAssets: ["icons/easynote.svg", "icons/easynote-192.png", "icons/easynote-512.png", "icons/easynote-maskable-512.png"],
      manifest: {
        id: "./",
        name: "EasyNote",
        short_name: "EasyNote",
        description: "本地优先的笔记、任务、日程与白板工作台",
        lang: "zh-CN",
        start_url: "./#/notes",
        scope: "./",
        display: "standalone",
        orientation: "any",
        background_color: "#f5f7fb",
        theme_color: "#3976f6",
        categories: ["productivity", "utilities"],
        icons: [
          { src: "icons/easynote-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/easynote-512.png", sizes: "512x512", type: "image/png" },
          { src: "icons/easynote-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,ico,webp}"],
        navigateFallback: "index.html",
        cleanupOutdatedCaches: true,
        clientsClaim: false,
        skipWaiting: false,
        runtimeCaching: [],
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    host: "0.0.0.0",
    port: 4173,
    strictPort: true,
  },
  preview: {
    host: "0.0.0.0",
    port: 4173,
    strictPort: true,
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
