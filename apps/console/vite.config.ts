import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/v1": {
        target: process.env.GATEWAY_ORIGIN ?? "http://127.0.0.1:3000",
        changeOrigin: true,
      },
    },
  },
});
