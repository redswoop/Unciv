import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./", // relative asset paths — works at / and under /Unciv/ on Pages
  server: { port: 5199, host: "127.0.0.1" },
  preview: { port: 5199, host: "127.0.0.1" },
  build: {
    target: "esnext",
    rollupOptions: {
      input: {
        index: resolve(__dirname, "index.html"),
        chunk: resolve(__dirname, "chunk.html"),
        hero: resolve(__dirname, "hero.html"),
        gallery: resolve(__dirname, "gallery.html"),
        art: resolve(__dirname, "art.html"),
      },
    },
  },
});
