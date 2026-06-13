import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Unit tests for the PURE fiscal logic (no DB / network): factores INPC,
// amortización de pérdidas Art. 57, depreciación, ISN, auditor. Tests viven
// junto al código en *.test.ts. El alias "@/" espeja el de tsconfig.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
