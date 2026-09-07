// Vite configuration for the APCVW browser demo.
// Dev server and preview bind to localhost by default. Set APCVW_HOST to expose them on a LAN address.
// Build emits the page, a stable widget bundle (apcvw-widget.js), and a
// stable SDK bundle (apcvw-sdk.js) next to the hashed page assets.
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

export const DEMO_HOST = process.env.APCVW_HOST || "127.0.0.1";
export const DEMO_PORT = Number(process.env.APCVW_PORT || 19081);

export const BASE = process.env.APCVW_BASE || "/";

export default defineConfig({
  base: BASE,
  server: {
    host: DEMO_HOST,
    port: DEMO_PORT,
    strictPort: true,
    open: false,
    cors: true,
  },
  preview: {
    host: DEMO_HOST,
    port: DEMO_PORT,
    strictPort: true,
    open: false,
    cors: true,
  },
  worker: {
    format: "es",
  },
  build: {
    target: "es2022",
    sourcemap: false,
    rollupOptions: {
      input: {
        main: here("./index.html"),
        widget: here("./src/widget.js"),
        sdk: here("./src/lib/index.js"),
      },
      output: {
        entryFileNames: (chunk) => {
          if (chunk.name === "widget") return "apcvw-widget.js";
          if (chunk.name === "sdk") return "apcvw-sdk.js";
          return "assets/[name]-[hash].js";
        },
      },
    },
  },
});
