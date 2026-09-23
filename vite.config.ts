import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "../dist", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:4000",
      "/files": "http://localhost:4000",
      "/hooks": "http://localhost:4001",
    },
  },
});
