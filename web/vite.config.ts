import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const backend = "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": backend,
      "/preview": backend,
      "/apps": backend,
      "/sdk": backend,
    },
  },
});
