import { describe, expect, it } from "vitest";
import { parseSatNativePilotWorkerAction } from "./worker-action";

describe("parseSatNativePilotWorkerAction", () => {
  it.each([undefined, "", "   "])("defaults %p to the inert action", (raw) => {
    expect(parseSatNativePilotWorkerAction(raw)).toBe("DISABLED");
  });

  it.each(["DISABLED", "PUBLIC_PREFLIGHT", "FIRST_SIGNED_POST"])(
    "accepts the exact action %s",
    (raw) => {
      expect(parseSatNativePilotWorkerAction(raw)).toBe(raw);
    },
  );

  it.each([
    "disabled",
    " DISABLED",
    "DISABLED ",
    " PUBLIC_PREFLIGHT ",
    " FIRST_SIGNED_POST ",
    "FIRST_SIGNED_POST_ONLY",
    "FIRST_SIGNED_POST extra",
    "PUBLIC-PREFLIGHT",
  ])("rejects the unrecognized action %s", (raw) => {
    expect(parseSatNativePilotWorkerAction(raw)).toBe("INVALID");
  });
});
