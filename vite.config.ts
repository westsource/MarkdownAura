import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";
import { readFileSync } from "node:fs";

const devHost = process.env.TAURI_DEV_HOST;

/* One source for the version the UI shows (`package.json`), instead of a literal in the markup that
   drifts the moment the version is bumped. */
const { version } = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8"),
) as { version: string };

export default defineConfig({
  clearScreen: false,

  define: { __APP_VERSION__: JSON.stringify(version) },

  /* design/ is the spec, not a copy source — the app imports the very same stylesheets the
     mockup uses, through one alias (IMPL.md §1). Never fork them into src/. */
  resolve: {
    alias: {
      "@design": fileURLToPath(new URL("./design", import.meta.url)),
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },

  server: {
    port: 1420,
    strictPort: true,
    /* Bind IPv4 explicitly. Node resolves the default `localhost` to ::1 on this machine, so
       vite listens on IPv6 only and WebView2 — which reaches for 127.0.0.1 — gets nothing.
       The symptom is a perfectly sized, perfectly black window, with no error anywhere. */
    host: devHost || "127.0.0.1",
    hmr: devHost ? { protocol: "ws", host: devHost, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },

  envPrefix: ["VITE_", "TAURI_ENV_"],

  build: {
    /* WebView2 is evergreen Chromium; this is the floor Tauri 2 supports. */
    target: "chrome110",
    minify: process.env.TAURI_ENV_DEBUG ? false : "esbuild",
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
  },
});
