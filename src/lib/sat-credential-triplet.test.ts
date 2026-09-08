import { describe, expect, it } from "vitest";
import { inspectSatCredentialTriplet } from "./sat-credential-triplet";

describe("inspectSatCredentialTriplet", () => {
  it("classifies an omitted credential as NONE", () => {
    expect(inspectSatCredentialTriplet({}, "FIEL")).toBe("NONE");
    expect(inspectSatCredentialTriplet(null, "CSD")).toBe("NONE");
  });

  it("accepts only a complete non-empty triplet", () => {
    expect(inspectSatCredentialTriplet({
      fielCer: "certificate",
      fielKey: "private-key",
      fielPassword: "password",
    }, "FIEL")).toBe("COMPLETE");
  });

  it("rejects every partial or empty replacement", () => {
    expect(inspectSatCredentialTriplet({ fielCer: "certificate" }, "FIEL")).toBe("INVALID");
    expect(inspectSatCredentialTriplet({
      fielCer: "certificate",
      fielKey: "private-key",
      fielPassword: "",
    }, "FIEL")).toBe("INVALID");
    expect(inspectSatCredentialTriplet({
      csdCer: "certificate",
      csdKey: null,
      csdPassword: "password",
    }, "CSD")).toBe("INVALID");
  });

  it("does not confuse FIEL fields with CSD fields", () => {
    const body = { fielCer: "c", fielKey: "k", fielPassword: "p" };
    expect(inspectSatCredentialTriplet(body, "CSD")).toBe("NONE");
  });
});
