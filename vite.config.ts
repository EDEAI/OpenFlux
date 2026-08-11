import { defineConfig } from "vite";
import { dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
const projectRoot = dirname(fileURLToPath(import.meta.url));
const watchedTopLevel = new Set(["src", "public"]);
const watchedRootFiles = new Set([
  "index.html",
  "preview.html",
  "feedback.html",
  "canvas.html",
  "vite.config.ts",
]);

function ignoreFrontendWatchPath(candidate: string): boolean {
  const relativePath = relative(projectRoot, candidate).replace(/\\/g, "/");
  if (!relativePath || relativePath === ".") return false;
  if (relativePath.startsWith("../") || relativePath === "..") return true;

  const [topLevel] = relativePath.split("/");
  if (watchedTopLevel.has(topLevel)) return false;
  return !watchedRootFiles.has(relativePath);
}

// https://vite.dev/config/
export default defineConfig(async () => ({

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
        protocol: "ws",
        host,
        port: 1421,
      }
      : undefined,
    watch: {
      // The desktop workspace also contains the Rust target, Gateway runtime
      // data, sessions and generated artifacts. Watching those trees is both
      // unnecessary for the frontend and can create tens of thousands of file
      // handles during a long local test run.
      ignored: ignoreFrontendWatchPath,
    },
  },
  esbuild: {
    // Use tsc-compatible parsing: treat .ts files as modules, not scripts
    // This prevents esbuild from misinterpreting TypeScript generic syntax
    target: 'es2020',
    charset: 'utf8',
    legalComments: 'none',
  },
  build: {
    // Use rollup's built-in TypeScript handling for production builds
    // to avoid esbuild's limitations with complex TypeScript generics
    target: 'es2020',
    rollupOptions: {
      input: {
        main: 'index.html',
        preview: 'preview.html',
        feedback: 'feedback.html',
        canvas: 'canvas.html',
      },
    },
  },
}));
