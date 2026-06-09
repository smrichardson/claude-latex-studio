import { defineConfig } from "vite";

// Frontend on 4318, backend on 4319. Proxy /api so the browser can reach
// latexmk + claude without CORS gymnastics.
export default defineConfig({
  server: {
    port: 4318,
    proxy: {
      "/api": "http://localhost:4319",
    },
  },
});
