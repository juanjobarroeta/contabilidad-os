export const READINESS_TIMEOUT_MS = 2_000;

/**
 * Share only an outstanding probe, never a completed healthy result.
 * A request deadline cannot cancel Prisma's query. Keep its single-flight slot
 * until the underlying query settles so a DB outage cannot accumulate probes.
 * After a timeout, callers keep receiving false; late success is not reused.
 */
export function createReadinessCheck(probe: () => PromiseLike<unknown>) {
  let inFlight: Promise<boolean> | undefined;

  return function checkReadiness(): Promise<boolean> {
    if (inFlight) return inFlight;

    let settle!: (ready: boolean) => void;
    const result = new Promise<boolean>((resolve) => { settle = resolve; });
    inFlight = result;
    const deadline = performance.now() + READINESS_TIMEOUT_MS;
    const timer = setTimeout(() => settle(false), READINESS_TIMEOUT_MS);
    const finish = (ready: boolean) => {
      clearTimeout(timer);
      inFlight = undefined;
      settle(ready);
    };

    // Start in a promise so synchronous client/setup errors also fail closed.
    void Promise.resolve().then(probe).then(
      () => finish(performance.now() < deadline),
      () => finish(false),
    );

    return result;
  };
}
