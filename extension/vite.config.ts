import { defineConfig } from "vite";

const chromeOnly = process.env.TDA_CHROME_ONLY_BUILD === "1";
const speedDiagnostics = process.env.TDA_SPEED_DIAGNOSTICS === "1";
const licenseEnforced = process.env.TDA_LICENSE_ENFORCED === "1";
const licenseApiBase = (process.env.TDA_LICENSE_API_BASE || "http://localhost:8766").replace(/\/+$/, "");

export default defineConfig({
  define: {
    __TDA_CHROME_ONLY__: JSON.stringify(chromeOnly),
    __TDA_SPEED_DIAGNOSTICS__: JSON.stringify(speedDiagnostics),
    __TDA_LICENSE_ENFORCED__: JSON.stringify(licenseEnforced),
    __TDA_LICENSE_API_BASE__: JSON.stringify(licenseApiBase),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: ["sidepanel.html", "dev/ui-preview.html"],
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
