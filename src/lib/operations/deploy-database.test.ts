import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { deployDatabase } from "../../../scripts/lib/deploy-database.mjs";
import railway from "../../../railway.json";

function fixture(esquema = true, historial = true) {
  return {
    prisma: {
      $queryRawUnsafe: vi.fn().mockResolvedValue([{ esquema, historial }]),
      $disconnect: vi.fn().mockResolvedValue(undefined),
    },
    run: vi.fn(),
    log: vi.fn(),
  };
}

describe("migration and promotion gate", () => {
  it.each([[false, false], [true, true]])("deploys an empty or managed schema (%s, %s) without baselining", async (schema, history) => {
    const { prisma, run, log } = fixture(schema, history);
    await deployDatabase(prisma, run, log);
    expect(prisma.$disconnect).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledExactlyOnceWith("npx prisma migrate deploy");
    expect(log).toHaveBeenLastCalledWith("[deploy-db] Esquema al día.");
  });

  it("preserves the existing unmanaged-schema baseline before migrating", async () => {
    const { prisma, run, log } = fixture(true, false);
    await deployDatabase(prisma, run, log);
    expect(run.mock.calls).toEqual([
      ["npx prisma migrate resolve --applied 0_init"],
      ["npx prisma migrate deploy"],
    ]);
  });

  it("disconnects and stops before migrations when database inspection fails", async () => {
    const { prisma, run, log } = fixture();
    const error = new Error("database unavailable");
    prisma.$queryRawUnsafe.mockRejectedValue(error);
    await expect(deployDatabase(prisma, run, log)).rejects.toBe(error);
    expect(prisma.$disconnect).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("stops if disconnect fails instead of attempting migrations", async () => {
    const { prisma, run, log } = fixture();
    prisma.$disconnect.mockRejectedValue(new Error("connection teardown failed"));
    await expect(deployDatabase(prisma, run, log)).rejects.toThrow("connection teardown failed");
    expect(run).not.toHaveBeenCalled();
  });

  it("does not migrate after a failed baseline", async () => {
    const { prisma, run, log } = fixture(true, false);
    run.mockImplementation(() => { throw new Error("baseline failed"); });
    await expect(deployDatabase(prisma, run, log)).rejects.toThrow("baseline failed");
    expect(run).toHaveBeenCalledExactlyOnceWith("npx prisma migrate resolve --applied 0_init");
    expect(log).not.toHaveBeenCalledWith("[deploy-db] Esquema al día.");
  });

  it("propagates migration failure instead of reporting a ready schema", async () => {
    const { prisma, run, log } = fixture();
    run.mockImplementation(() => { throw new Error("migration failed"); });
    await expect(deployDatabase(prisma, run, log)).rejects.toThrow("migration failed");
    expect(log).not.toHaveBeenCalledWith("[deploy-db] Esquema al día.");
  });

  it("exits non-zero in the real CLI against a deliberately unreachable local DB", () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const result = spawnSync(process.execPath, ["scripts/deploy-db.mjs"], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: "postgresql://test:test@127.0.0.1:1/ops_gate_test?connect_timeout=1" },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("[deploy-db] FALLÓ");
    expect(result.stdout).not.toContain("Esquema al día");
    expect(result.stdout).not.toContain("$ npx prisma migrate");
  }, 15_000);

  it("keeps migrations mandatory and promotes on readiness, never liveness", () => {
    expect(railway.deploy.preDeployCommand).toBe("node scripts/deploy-db.mjs");
    expect(railway.deploy.startCommand).toBe("npm run start");
    expect(railway.deploy.healthcheckPath).toBe("/api/ready");
    expect(railway.deploy.healthcheckTimeout).toBe(120);
    expect(railway.deploy.restartPolicyType).toBe("ON_FAILURE");
  });
});
