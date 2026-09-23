import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReadinessCheck, READINESS_TIMEOUT_MS } from "./readiness";

function deferred() {
  let resolve!: (value?: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("database readiness", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it("succeeds only after the database probe completes and clears its timer", async () => {
    const db = deferred();
    const check = createReadinessCheck(() => db.promise);
    const response = check();
    db.resolve();
    expect(await response).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not cache success across requests", async () => {
    const probe = vi.fn().mockResolvedValueOnce(1).mockRejectedValueOnce(new Error("offline"));
    const check = createReadinessCheck(probe);
    expect(await check()).toBe(true);
    expect(await check()).toBe(false);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("shares a single probe among concurrent requests", async () => {
    const db = deferred();
    const probe = vi.fn(() => db.promise);
    const check = createReadinessCheck(probe);
    const responses = Array.from({ length: 50 }, () => check());
    expect(responses.every((response) => response === responses[0])).toBe(true);
    db.resolve();
    expect(await Promise.all(responses)).toEqual(Array(50).fill(true));
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("fails closed for synchronous client errors", async () => {
    const check = createReadinessCheck(() => { throw new Error("invalid connection configuration"); });
    expect(await check()).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out without creating more queries while the original one is pending", async () => {
    const db = deferred();
    const probe = vi.fn(() => db.promise);
    const check = createReadinessCheck(probe);
    const response = check();
    await vi.advanceTimersByTimeAsync(READINESS_TIMEOUT_MS);
    expect(await response).toBe(false);
    expect(await Promise.all(Array.from({ length: 50 }, () => check()))).toEqual(Array(50).fill(false));
    expect(probe).toHaveBeenCalledTimes(1);
    db.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(await response).toBe(false);
  });

  it("requires a fresh probe after a timed-out query eventually succeeds", async () => {
    const db = deferred();
    const probe = vi.fn().mockReturnValueOnce(db.promise).mockRejectedValueOnce(new Error("still offline"));
    const check = createReadinessCheck(probe);
    const response = check();
    await vi.advanceTimersByTimeAsync(READINESS_TIMEOUT_MS);
    expect(await response).toBe(false);
    db.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(await check()).toBe(false);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("handles late rejection and recovers on the next fresh probe", async () => {
    const db = deferred();
    const probe = vi.fn().mockReturnValueOnce(db.promise).mockResolvedValueOnce(1);
    const check = createReadinessCheck(probe);
    const response = check();
    await vi.advanceTimersByTimeAsync(READINESS_TIMEOUT_MS);
    expect(await response).toBe(false);
    db.reject(new Error("late database error"));
    await vi.advanceTimersByTimeAsync(0);
    expect(await check()).toBe(true);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("rejects success past the monotonic deadline even if the timer was delayed", async () => {
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(READINESS_TIMEOUT_MS + 1);
    const check = createReadinessCheck(async () => 1);
    expect(await check()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
