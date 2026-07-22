import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { resolve } from "node:path";

// Single-file build: everything inlined, zero network requests.
//   bunx vite build --config vite.embedded.config.ts
export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    target: "esnext",
    rollupOptions: { input: resolve(__dirname, "embedded.html") },
    outDir: "dist-embedded",
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 100_000,
    copyPublicDir: false,
  },
});
