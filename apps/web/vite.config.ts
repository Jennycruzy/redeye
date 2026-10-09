import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The site reaches the agent under /api; in production nginx strips the prefix the same way.
const agent = process.env.REDEYE_AGENT_ORIGIN ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  build: { target: "es2022", sourcemap: true },
  server: {
    proxy: {
      "/api": { target: agent, rewrite: (path) => path.replace(/^\/api/, "") },
      "/.well-known": agent,
      "/a2a": agent
    }
  },
  preview: {
    proxy: {
      "/api": { target: agent, rewrite: (path) => path.replace(/^\/api/, "") },
      "/.well-known": agent,
      "/a2a": agent
    }
  }
});
