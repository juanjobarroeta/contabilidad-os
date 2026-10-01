import { createHash } from "node:crypto";

export interface MovementEvidence {
  id: string;
  date: string;
  amount: number;
  description: string;
  reference?: string | null;
  time?: string | null;
  tracking?: string | null;
  bankId?: string | null;
  balance?: number | null;
  counterparty?: string | null;
}
export type RowPlan = { status: "NEW" | "LINKED" | "REVIEW"; movementId: string | null; candidateIds: string[]; reason: string };
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([key, v]) => [key, canonical(v)]));
  return value;
}
// PostgreSQL JSONB reorders object keys. A confirmed chat payload must retain
// its fingerprint across persistence without weakening ledger change detection.
export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(JSON.parse(JSON.stringify(value))))).digest("hex");
export const cents = (n: number) => Math.round(n * 100);
const norm = (s?: string | null) => (s ?? "").trim().toUpperCase().replace(/\s+/g, " ");
export const day = (d: Date | string) => new Date(d).toISOString().slice(0, 10);
const timeOf = (m: MovementEvidence) => m.time || (/^\d{2}:\d{2}(?::\d{2})?$/.test(m.reference ?? "") ? m.reference : null);
const refOf = (m: MovementEvidence) => timeOf(m) === m.reference ? "" : norm(m.reference);
export function sharedIdentity(a: MovementEvidence, b: MovementEvidence) {
  return Boolean((a.bankId && b.bankId && norm(a.bankId) === norm(b.bankId)) ||
    (a.tracking && b.tracking && norm(a.tracking) === norm(b.tracking)));
}
export function distinctEvidence(a: MovementEvidence, b: MovementEvidence) {
  if (sharedIdentity(a, b)) return false;
  return Boolean((a.bankId && b.bankId && norm(a.bankId) !== norm(b.bankId)) ||
    (a.tracking && b.tracking && norm(a.tracking) !== norm(b.tracking)) ||
    (timeOf(a) && timeOf(b) && timeOf(a)!.slice(0, 5) !== timeOf(b)!.slice(0, 5)) ||
    (refOf(a) && refOf(b) && refOf(a) !== refOf(b)));
}
export function compatible(a: MovementEvidence, b: MovementEvidence) {
  const conflict = (a.bankId && b.bankId && norm(a.bankId) !== norm(b.bankId)) || (a.tracking && b.tracking && norm(a.tracking) !== norm(b.tracking));
  return a.date === b.date && cents(a.amount) === cents(b.amount) && !conflict && !distinctEvidence(a, b);
}
/** Never collapse two occurrences in one document. Only a unique compatible
 * bank identity can link automatically; amount/date are review candidates. */
export function planRows(rows: MovementEvidence[], existing: MovementEvidence[]): RowPlan[] {
  const used = new Set<string>();
  const identities = new Map<string, MovementEvidence[]>(), byAmount = new Map<string, MovementEvidence[]>();
  const keys = (m: MovementEvidence) => [m.bankId ? "id:" + norm(m.bankId) : "", m.tracking ? "tracking:" + norm(m.tracking) : ""].filter(Boolean);
  const index = (m: MovementEvidence) => { for (const key of keys(m)) { const bucket = identities.get(key) ?? []; bucket.push(m); identities.set(key,bucket); } };
  for (const m of existing) { index(m); const key = m.date + "|" + cents(m.amount), bucket = byAmount.get(key) ?? []; bucket.push(m); byAmount.set(key,bucket); }
  return rows.map((row) => {
    if (!Number.isFinite(row.amount) || cents(row.amount) === 0 || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) {
      return { status: "REVIEW", movementId: null, candidateIds: [], reason: "Fila sin fecha o importe válido; revisa el original." };
    }
    const strong = [...new Map(keys(row).flatMap((key) => identities.get(key) ?? []).map((m) => [m.id,m])).values()];
    if (strong.length) {
      if (strong.length === 1 && compatible(row, strong[0]) && !used.has(strong[0].id)) {
        used.add(strong[0].id);
        return { status: "LINKED", movementId: strong[0].id, candidateIds: [], reason: "Identificador bancario compatible; se conserva una sola operación." };
      }
      return { status: "REVIEW", movementId: null, candidateIds: strong.map((m) => m.id), reason:
        strong.some((m) => !compatible(row, m)) ? "El mismo identificador tiene fecha, importe u otra identidad distinta: requiere corrección revisada." :
          "Identificador repetido o ya usado por otra fila de este documento." };
    }
    const candidates = (byAmount.get(row.date + "|" + cents(row.amount)) ?? []).filter((m) => !distinctEvidence(row, m));
    if (candidates.length) return { status: "REVIEW", movementId: null, candidateIds: candidates.map((m) => m.id),
      reason: "Coinciden día e importe, pero falta una identidad bancaria única. Confirma si es otra operación o la misma." };
    index(row);
    used.add(row.id);
    return { status: "NEW", movementId: row.id, candidateIds: [], reason: "Nueva operación provisional; pendiente de cotejar con el estado completo." };
  });
}
export interface DuplicateCase { key: string; fingerprint: string; ids: [string, string]; strength: "IDENTIFIER" | "REVIEW"; reason: string }
export function duplicateCases(movements: MovementEvidence[], decisions: { pairKey: string; fingerprint: string }[] = []) {
  const decided = new Set(decisions.map((d) => d.pairKey + ":" + d.fingerprint));
  const buckets = new Map<string, MovementEvidence[]>();
  for (const m of movements) {
    const key = m.date + "|" + cents(m.amount);
    const group = buckets.get(key) ?? []; group.push(m); buckets.set(key, group);
  }
  const result: DuplicateCase[] = [];
  for (const group of buckets.values()) {
    if (group.length > 200 && !(group.every((m) => m.tracking) && new Set(group.map((m) => norm(m.tracking))).size === group.length)) throw new Error("Más de 200 movimientos ambiguos del mismo importe y día. Aporta identificadores bancarios para revisar el grupo completo.");
  }
  for (const group of buckets.values()) {
    if (group.length > 200) continue; // All have distinct tracking IDs, validated above.
    for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
    const pair = [group[i], group[j]].sort((a, b) => a.id.localeCompare(b.id));
    if (distinctEvidence(pair[0], pair[1])) continue;
    const key = pair.map((m) => m.id).join(":");
    const fingerprint = digest(pair);
    if (decided.has(key + ":" + fingerprint)) continue;
    const identity = sharedIdentity(pair[0], pair[1]);
    if (result.length >= 20000) throw new Error("La revisión excede 20,000 pares ambiguos. Se requieren identificadores bancarios antes de confirmar el mes.");
    result.push({ key, fingerprint, ids: [pair[0].id, pair[1].id], strength: identity ? "IDENTIFIER" : "REVIEW",
      reason: identity ? "Mismo identificador bancario, día e importe." : "Mismo día e importe; la evidencia aún no distingue las operaciones." });
  }
  }
  return result;
}
export function totals(rows: Pick<MovementEvidence, "amount">[]) {
  let credits = 0, debits = 0, creditCount = 0, debitCount = 0;
  for (const row of rows) if (row.amount > 0) { credits += cents(row.amount); creditCount++; } else { debits -= cents(row.amount); debitCount++; }
  return { credits: credits / 100, debits: debits / 100, creditCount, debitCount, net: (credits - debits) / 100, count: rows.length };
}
export function monthBounds(year: number, month: number) {
  if (!Number.isInteger(year) || year < 2000 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) throw new Error("Periodo inválido.");
  return { start: new Date(Date.UTC(year, month - 1, 1)), end: new Date(Date.UTC(year, month, 1)),
    from: day(new Date(Date.UTC(year, month - 1, 1))), to: day(new Date(Date.UTC(year, month, 0))) };
}
export interface ControlTotals { credits: number; debits: number; creditCount?: number | null; debitCount?: number | null }
export function checkControls(rows: Pick<MovementEvidence, "amount">[], opening: number | null, closing: number | null, controls: ControlTotals | null) {
  const actual = totals(rows); const errors: string[] = [];
  if (opening === null || closing === null || !Number.isFinite(opening) || !Number.isFinite(closing)) errors.push("Faltan saldos inicial/final declarados.");
  else if (cents(opening) + cents(actual.net) !== cents(closing)) errors.push("Saldo inicial más movimientos no coincide con el saldo final.");
  if (!controls || !Number.isFinite(controls.credits) || !Number.isFinite(controls.debits)) errors.push("Faltan totales declarados de abonos y cargos por separado.");
  else {
    if (cents(controls.credits) !== cents(actual.credits)) errors.push("El total de abonos no coincide con el banco.");
    if (cents(controls.debits) !== cents(actual.debits)) errors.push("El total de cargos no coincide con el banco.");
    if (controls.creditCount != null && controls.creditCount !== actual.creditCount) errors.push("El conteo de abonos no coincide.");
    if (controls.debitCount != null && controls.debitCount !== actual.debitCount) errors.push("El conteo de cargos no coincide.");
  }
  return { actual, errors };
}
