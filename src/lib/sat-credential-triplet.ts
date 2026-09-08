export type SatCredentialKind = "FIEL" | "CSD";

export type SatCredentialTripletState = "NONE" | "COMPLETE" | "INVALID";

const FIELDS: Readonly<Record<SatCredentialKind, readonly string[]>> = Object.freeze({
  FIEL: Object.freeze(["fielCer", "fielKey", "fielPassword"]),
  CSD: Object.freeze(["csdCer", "csdKey", "csdPassword"]),
});

/**
 * SAT credentials are an indivisible certificate/key/password triplet.
 * A partial request must be rejected before it can overwrite one stored part
 * while leaving the other two from a different credential.
 */
export function inspectSatCredentialTriplet(
  body: unknown,
  kind: SatCredentialKind,
): SatCredentialTripletState {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "NONE";

  const record = body as Record<string, unknown>;
  const fields = FIELDS[kind];
  const present = fields.map((field) => Object.prototype.hasOwnProperty.call(record, field));

  if (present.every((value) => !value)) return "NONE";
  if (!present.every(Boolean)) return "INVALID";

  return fields.every((field) => typeof record[field] === "string" && record[field].length > 0)
    ? "COMPLETE"
    : "INVALID";
}
