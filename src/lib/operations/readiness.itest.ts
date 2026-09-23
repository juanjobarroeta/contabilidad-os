import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import { GET } from "../../app/api/ready/route";

describe.skipIf(process.env.DB_TESTS_SKIP === "1")("readiness with real Postgres", () => {
  afterAll(async () => { await prisma.$disconnect(); });

  it("serves 200 through the production route and shared Prisma client without tenant data", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "ready" });
  });
});
