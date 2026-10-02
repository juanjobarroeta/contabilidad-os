import { afterEach, describe, expect, it, vi } from "vitest";
import { solicitar } from "./solicitar";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("onboarding network recovery", () => {
  it("surfaces network failure and lets a subsequent request succeed", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce(new Response("ok"));
    vi.stubGlobal("fetch", fetch);
    await expect(solicitar("/api/onboarding/fiel")).rejects.toThrow("intenta de nuevo");
    expect(await (await solicitar("/api/onboarding/fiel")).text()).toBe("ok");
  });
  it("aborts a stalled request", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(new Error("aborted")));
    })));
    const result = expect(solicitar("/api/onboarding/fiel", undefined, 50)).rejects.toThrow("intenta de nuevo");
    await vi.advanceTimersByTimeAsync(51);
    await result;
  });
});
