import { describe, it, expect } from "vitest";
import { resolverFechaGeneracion } from "./fecha-generacion";
const now = new Date("2026-10-03T18:00:00Z");
describe("CFDI actual generation timestamp", () => {
  it("accepts the exact 72-hour boundary and preserves the supplied instant", () => {
    expect(
      resolverFechaGeneracion(
        "2026-09-30T12:00:00-06:00",
        now,
      ).fechaCfdi?.toISOString(),
    ).toBe("2026-09-30T18:00:00.000Z");
    expect(
      resolverFechaGeneracion("2026-09-30T11:59:59-06:00", now).error,
    ).toContain("72 horas");
  });
  it("handles other Mexican zones without substituting Mexico City or end-of-day", () => {
    expect(
      resolverFechaGeneracion(
        "2026-09-30T11:00:00-07:00",
        now,
      ).fechaCfdi?.toISOString(),
    ).toBe("2026-09-30T18:00:00.000Z");
    expect(
      resolverFechaGeneracion("2026-09-30T12:00:00-05:00", now).error,
    ).toContain("72 horas");
  });
  it("rejects future, impossible, date-only and unzoned timestamps", () => {
    expect(
      resolverFechaGeneracion("2026-10-03T18:00:01Z", now).error,
    ).toContain("futura");
    for (const input of [
      "2026-02-30T12:00:00-06:00",
      "2026-09-30",
      "2026-10-01T12:00",
    ])
      expect(resolverFechaGeneracion(input, now).error).toBeTruthy();
  });
});
