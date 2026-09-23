import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { $queryRaw: query } }));
vi.mock("@/lib/auth", () => { throw new Error("readiness must not require authentication"); });

describe("GET /api/ready", () => {
  beforeEach(() => {
    vi.resetModules();
    query.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("returns uncached 200 after a parameter-free SELECT 1 on the shared client", async () => {
    query.mockResolvedValue([{ "?column?": 1 }]);
    const route = await import("./route");
    const response = await route.GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(route.runtime).toBe("nodejs");
    expect(route.dynamic).toBe("force-dynamic");
    expect(query).toHaveBeenCalledExactlyOnceWith(["SELECT 1"]);
  });

  it("returns uncached 503 without exposing the database error or credentials", async () => {
    query.mockRejectedValue(new Error("postgresql://fixture:secret@private-host/customer-db"));
    const { GET } = await import("./route");
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "not_ready" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns 503 within the deadline for a stuck database", async () => {
    let finish!: () => void;
    query.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    const { GET } = await import("./route");
    const request = GET();
    await vi.advanceTimersByTimeAsync(2_000);
    const response = await request;
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "not_ready" });
    finish();
    await vi.advanceTimersByTimeAsync(0);
  });
});
