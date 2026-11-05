import { resolve } from "node:path"
import tailwind from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// Each role is a separate bundle, embedded in its own server binary.
export default defineConfig(({ mode }) => {
  const backend = process.env.NYX_BACKEND ?? (mode === "manager" ? "http://127.0.0.1:8082" : "http://127.0.0.1:8081")
  return {
    root: mode === "test" ? __dirname : resolve(__dirname, "src", mode),
    publicDir: resolve(__dirname, "public"),
    plugins: [react(), tailwind()],
    build: { outDir: resolve(__dirname, "dist", mode), emptyOutDir: true },
    server: { proxy: { "/api": backend } },
  }
})
