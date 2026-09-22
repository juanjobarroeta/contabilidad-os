import { fileURLToPath } from "node:url";
import { loadConfigFromFile } from "@prisma/config";
import { describe, expect, it } from "vitest";

describe("Prisma configuration dependency compatibility", () => {
  it("loads and resolves a nested config through the patched merge dependency", async () => {
    const result = await loadConfigFromFile({
      configFile: fileURLToPath(new URL("./fixtures/prisma.config.cjs", import.meta.url)),
    });
    expect(result.error).toBeUndefined();
    expect(result.config?.schema).toBe(fileURLToPath(new URL("../../../prisma/schema.prisma", import.meta.url)));
    expect(result.config?.migrations?.path).toBe(fileURLToPath(new URL("../../../prisma/migrations", import.meta.url)));
  });
});
