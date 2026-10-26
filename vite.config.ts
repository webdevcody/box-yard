import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { execSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { selfUrl } from "./server/bind"

// The API server listens on 127.0.0.1 with no password (server/bind.ts), so don't let "localhost" pick ::1.
const api = selfUrl(process.env.HOST ?? "127.0.0.1", Number(process.env.PORT ?? 3000))

// Shown in Settings > About. The commit is best effort: Docker builds may have no .git.
const version = (JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string }).version
let commit = ""
try {
  commit = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim()
} catch {}

export default defineConfig({
  root: "web",
  plugins: [react(), tailwindcss()],
  define: { __APP_VERSION__: JSON.stringify(version), __APP_COMMIT__: JSON.stringify(commit) },
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: api, changeOrigin: true },
      "/artifacts": { target: api, changeOrigin: true },
    },
  },
})
