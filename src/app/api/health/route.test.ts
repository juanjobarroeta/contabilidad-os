import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => { throw new Error("liveness must not load Prisma"); });
vi.mock("@/lib/auth", () => { throw new Error("liveness must not load auth"); });
import { GET, dynamic, runtime } from "./route";

describe("GET /api/health", () => {
  it("is public and live without database, auth, or provider dependencies", async () => {
    const response = GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("is evaluated dynamically in the server runtime", () => {
    expect(dynamic).toBe("force-dynamic");
    expect(runtime).toBe("nodejs");
  });
});
