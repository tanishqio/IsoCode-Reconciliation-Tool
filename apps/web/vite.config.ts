import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      // Set API_PROXY_TARGET to point the dev server at an API on another port.
      "/api": process.env["API_PROXY_TARGET"] ?? "http://localhost:4000",
    },
  },
});
