import { createHash } from "node:crypto";

/** Canonical JSON: comparisons must not depend on database object key order. */
export function documentFingerprint(value: unknown): string {
  const plain = JSON.parse(JSON.stringify(value));
  function canonical(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(canonical);
    if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)]));
    return v;
  }
  return createHash("sha256").update(JSON.stringify(canonical(plain))).digest("hex");
}
