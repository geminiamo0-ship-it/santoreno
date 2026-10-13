import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      entry: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
      name: "SantoAI",
      formats: ["es"],
      fileName: () => "santo-ai.js",
    },
    outDir: "dist/browser",
    emptyOutDir: true,
    minify: "esbuild",
    sourcemap: false,
  },
});
