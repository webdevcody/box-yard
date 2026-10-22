import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

const api = `http://localhost:${process.env.PORT ?? 3000}`

export default defineConfig({
  root: "web",
  plugins: [react(), tailwindcss()],
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: api, changeOrigin: true },
      "/artifacts": { target: api, changeOrigin: true },
    },
  },
})
