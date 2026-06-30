// ─────────────────────────────────────────────────────────────────────────────
// Conciliación MENSUAL de Contabilidad Electrónica (Anexo 24) — SÓLO LECTURA.
//
// Compara la balanza que el SAT tiene (la BCE descargada de Syntage) contra la
// balanza que NOSOTROS generamos del libro vivo (posting.ts) para el mismo
// periodo, y levanta un Hallazgo cuando hay discrepancias. NUNCA escribe en el
// ledger: es observar-y-señalar. La importación de la balanza del SAT como
// apertura ocurre UNA sola vez (sync.ts/ceBootstrapAt); aquí jamás se re-importa.
//
// El núcleo de comparación (`compararBalanzas`) es PURO (sin DB / sin Syntage)
// para poder probarlo con vitest alimentándole dos balanzas en memoria. La capa
// de I/O (`reconciliarCEEmpresa`) sólo lee: trae la BCE del SAT, arma la nuestra,
// llama al comparador y persiste el Hallazgo de forma idempotente.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import { planIncluyeSyntage } from "@/lib/planes";
import { SyntageClient } from "@/lib/fiscal/cumplimiento/syntage/client";
import { parseBalanza, type BalanzaCuentaParsed } from "./ce-import";
import { balanza } from "./posting";

// Tolerancia por defecto: diferencias de hasta 1 peso se consideran redondeo y
// NO se reportan como discrepancia. Configurable por llamador.
export const TOLERANCIA_PESOS_DEFAULT = 1;

/** Una cuenta normalizada para comparación: clave + magnitudes de la balanza. */
export interface CuentaBalanza {
  /** Clave de la cuenta (NumCta del SAT / subcuenta||cuentaSAT del libro). */
  cuenta: string;
  /** Descripción legible (sólo informativa; no participa en la comparación). */
  descripcion?: string;
  saldoFinal: number;
  debe: number;
  haber: number;
}

export type TipoDiscrepancia = "SALDO_FINAL" | "DEBE" | "HABER";

export interface Discrepancia {
  cuenta: string;
  descripcion: string;
  tipo: TipoDiscrepancia;
  saldoSat: number;
  saldoLibro: number;
  diff: number; // valor absoluto de la diferencia
}

export interface CuentaFaltante {
  cuenta: string;
  descripcion: string;
  saldoFinal: number;
}

export interface DiffBalanzas {
  periodo: string; // "YYYY-MM"
  cuentasComparadas: number;
  discrepancias: Discrepancia[];
  /** Cuentas presentes en el SAT pero ausentes en nuestro libro. */
  faltantesEnLibro: CuentaFaltante[];
  /** Cuentas presentes en nuestro libro pero ausentes en el SAT. */
  faltantesEnSat: CuentaFaltante[];
}

function indexar(cuentas: ReadonlyArray<CuentaBalanza>): Map<string, CuentaBalanza> {
  const m = new Map<string, CuentaBalanza>();
  for (const c of cuentas) {
    const key = c.cuenta.trim();
    if (!key) continue;
    const prev = m.get(key);
    if (prev) {
      // Colapsa duplicados (mismo NumCta repetido) sumando magnitudes.
      m.set(key, {
        cuenta: key,
        descripcion: prev.descripcion ?? c.descripcion,
        saldoFinal: prev.saldoFinal + c.saldoFinal,
        debe: prev.debe + c.debe,
        haber: prev.haber + c.haber,
      });
    } else {
      m.set(key, { ...c, cuenta: key });
    }
  }
  return m;
}

/**
 * Compara la balanza del SAT contra la nuestra (libro vivo) cuenta por cuenta.
 * PURA: sin DB / sin Syntage. Reglas:
 *   • Sólo se comparan cuentas presentes en AMBOS lados (las ausentes en un lado
 *     se reportan como faltantes, no como discrepancia de saldo).
 *   • Por cada cuenta común se comparan saldoFinal, debe y haber; cada magnitud
 *     cuya |dif| supere la tolerancia genera UNA discrepancia.
 *   • La tolerancia se aplica con `>`: una diferencia EXACTAMENTE igual a la
 *     tolerancia NO se reporta (se considera dentro del margen de redondeo).
 */
export function compararBalanzas(args: {
  periodo: string;
  sat: ReadonlyArray<CuentaBalanza>;
  libro: ReadonlyArray<CuentaBalanza>;
  toleranciaPesos?: number;
}): DiffBalanzas {
  const tol = args.toleranciaPesos ?? TOLERANCIA_PESOS_DEFAULT;
  const sat = indexar(args.sat);
  const libro = indexar(args.libro);

  const discrepancias: Discrepancia[] = [];
  const faltantesEnLibro: CuentaFaltante[] = [];
  const faltantesEnSat: CuentaFaltante[] = [];

  // Cuentas del SAT: comparar o marcar faltante en libro.
  for (const [cuenta, s] of sat) {
    const l = libro.get(cuenta);
    if (!l) {
      faltantesEnLibro.push({
        cuenta,
        descripcion: s.descripcion ?? "",
        saldoFinal: s.saldoFinal,
      });
      continue;
    }
    const desc = l.descripcion ?? s.descripcion ?? "";
    const push = (tipo: TipoDiscrepancia, satV: number, libroV: number) => {
      const diff = Math.abs(satV - libroV);
      if (diff > tol) {
        discrepancias.push({ cuenta, descripcion: desc, tipo, saldoSat: satV, saldoLibro: libroV, diff });
      }
    };
    push("SALDO_FINAL", s.saldoFinal, l.saldoFinal);
    push("DEBE", s.debe, l.debe);
    push("HABER", s.haber, l.haber);
  }

  // Cuentas del libro ausentes en el SAT.
  for (const [cuenta, l] of libro) {
    if (!sat.has(cuenta)) {
      faltantesEnSat.push({
        cuenta,
        descripcion: l.descripcion ?? "",
        saldoFinal: l.saldoFinal,
      });
    }
  }

  // Orden estable para Hallazgos/UI reproducibles.
  discrepancias.sort((a, b) => a.cuenta.localeCompare(b.cuenta) || a.tipo.localeCompare(b.tipo));
  faltantesEnLibro.sort((a, b) => a.cuenta.localeCompare(b.cuenta));
  faltantesEnSat.sort((a, b) => a.cuenta.localeCompare(b.cuenta));

  // Cuentas comparadas = unión de claves de ambos lados.
  const todas = new Set<string>([...sat.keys(), ...libro.keys()]);

  return {
    periodo: args.periodo,
    cuentasComparadas: todas.size,
    discrepancias,
    faltantesEnLibro,
    faltantesEnSat,
  };
}

/** ¿El diff está limpio (sin discrepancias ni faltantes)? */
export function diffEstaLimpio(diff: DiffBalanzas): boolean {
  return (
    diff.discrepancias.length === 0 &&
    diff.faltantesEnLibro.length === 0 &&
    diff.faltantesEnSat.length === 0
  );
}

/** Convierte una BCE parseada del SAT a las cuentas normalizadas del comparador. */
export function cuentasDesdeBalanzaSat(cuentas: ReadonlyArray<BalanzaCuentaParsed>): CuentaBalanza[] {
  return cuentas.map((c) => ({
    cuenta: c.numCta,
    saldoFinal: c.saldoFin,
    debe: c.debe,
    haber: c.haber,
  }));
}

/**
 * Convierte la balanza del libro vivo (posting.balanza) a cuentas normalizadas.
 * La clave de empate con el SAT es subcuenta||cuentaSAT (igual que el código
 * canónico que usa ce-import-apply al importar el catálogo).
 */
export function cuentasDesdeBalanzaLibro(
  rows: ReadonlyArray<{
    cuentaSAT: string;
    subcuenta: string | null;
    nombre: string;
    cargos: number;
    abonos: number;
    saldoFinal: number;
  }>,
): CuentaBalanza[] {
  return rows.map((r) => ({
    cuenta: r.subcuenta ?? r.cuentaSAT,
    descripcion: r.nombre,
    saldoFinal: r.saldoFinal,
    debe: r.cargos,
    haber: r.abonos,
  }));
}

// ── Periodo ─────────────────────────────────────────────────────────────────

/** Parsea "YYYY-MM" → { year, month }. Lanza si el formato es inválido. */
export function parsePeriodo(periodo: string): { year: number; month: number } {
  const m = /^(\d{4})-(\d{2})$/.exec(periodo.trim());
  if (!m) throw new Error(`Periodo inválido: "${periodo}" (se espera YYYY-MM)`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) throw new Error(`Mes fuera de rango en periodo: "${periodo}"`);
  return { year, month };
}

/** Mes cerrado anterior (en formato "YYYY-MM") respecto a una fecha de referencia. */
export function periodoMesAnterior(ref: Date = new Date()): string {
  const year = ref.getUTCFullYear();
  const month = ref.getUTCMonth() + 1; // 1-12
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  return `${prevYear}-${String(prevMonth).padStart(2, "0")}`;
}

// ── Hallazgo (idempotente por empresa+periodo) ────────────────────────────────

export const RECONCILIACION_CHECK_CLAVE = "CE_RECONCILIACION_MENSUAL";

/** Clave de dedupe estable por empresa+periodo: una sola fila por mes. */
function dedupeKeyDe(periodo: string): string {
  return `${RECONCILIACION_CHECK_CLAVE}|${periodo}`;
}

/** Construye el mensaje FORMAL del hallazgo a partir del diff. */
export function mensajeHallazgo(diff: DiffBalanzas): string {
  const partes: string[] = [];
  if (diff.discrepancias.length > 0) {
    partes.push(`${diff.discrepancias.length} cuenta(s) con saldos distintos entre el SAT y el libro`);
  }
  if (diff.faltantesEnLibro.length > 0) {
    partes.push(`${diff.faltantesEnLibro.length} cuenta(s) presentes en el SAT y ausentes en el libro`);
  }
  if (diff.faltantesEnSat.length > 0) {
    partes.push(`${diff.faltantesEnSat.length} cuenta(s) presentes en el libro y ausentes en el SAT`);
  }
  const detalle = diff.discrepancias
    .slice(0, 5)
    .map(
      (d) =>
        `· ${d.cuenta} (${d.tipo}): SAT ${d.saldoSat.toFixed(2)} vs libro ${d.saldoLibro.toFixed(2)} (dif ${d.diff.toFixed(2)})`,
    )
    .join("\n");
  const cabecera = `Diferencias en la Contabilidad Electrónica del periodo ${diff.periodo}: ${partes.join("; ")}.`;
  return detalle ? `${cabecera}\n\n${detalle}` : cabecera;
}

// ── Nudge de presentación (composición PURA del push) ─────────────────────────
//
// Tras conciliar, empujamos al usuario un aviso de "presentación asistida": la CE
// del mes está LISTA para presentar (cuadra con el SAT) o NO CUADRA y debe
// revisarse antes de presentar. NUNCA se envía nada al SAT: sólo se genera+guía.

/** Nombres largos de mes (1-12) para los textos del nudge. */
const MESES_LARGO = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
] as const;

/** "2026-05" → "mayo de 2026". Tolera periodos fuera de rango devolviendo el crudo. */
export function periodoLargo(periodo: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(periodo.trim());
  if (!m) return periodo;
  const mes = Number(m[2]);
  if (mes < 1 || mes > 12) return periodo;
  return `${MESES_LARGO[mes - 1]} de ${m[1]}`;
}

/**
 * Cuántas cuentas DISTINTAS divergen entre el SAT y el libro (saldo distinto o
 * presentes en un solo lado). Una cuenta con varias magnitudes en discrepancia
 * cuenta una sola vez: es el número que ve el usuario en el nudge.
 */
export function cuentasQueNoCuadran(diff: DiffBalanzas): number {
  const claves = new Set<string>();
  for (const d of diff.discrepancias) claves.add(d.cuenta);
  for (const c of diff.faltantesEnLibro) claves.add(c.cuenta);
  for (const c of diff.faltantesEnSat) claves.add(c.cuenta);
  return claves.size;
}

export interface NudgeCE {
  title: string;
  body: string;
  /** Deep link a la pestaña de Contabilidad Electrónica (descargar/presentar). */
  url: string;
  tag: string;
}

/** Deep link a la CE del periodo (pestaña con catálogo + balanza descargables). */
export const CE_DEEP_LINK = "/contabilidad?tab=coe";

/**
 * Compone (PURO) el nudge de presentación a partir del diff de conciliación.
 *   • Limpio  → "lista para presentar" + deep link a descargar/presentar.
 *   • Diverge → "no cuadra con el SAT en N cuentas — revísala antes de presentar".
 * El `tag` colapsa el aviso por periodo (un solo nudge por mes y dispositivo).
 */
export function nudgeCEPresentacion(diff: DiffBalanzas): NudgeCE {
  const mes = periodoLargo(diff.periodo);
  const tag = `ce-presentar-${diff.periodo}`;
  if (diffEstaLimpio(diff)) {
    return {
      title: `Tu Contabilidad Electrónica de ${mes} está lista para presentar`,
      body: "Cuadra con la balanza del SAT. Toca para descargar los XML (catálogo y balanza) y presentarla.",
      url: CE_DEEP_LINK,
      tag,
    };
  }
  const n = cuentasQueNoCuadran(diff);
  return {
    title: `La Contabilidad Electrónica de ${mes} no cuadra con el SAT`,
    body: `No cuadra en ${n} cuenta${n === 1 ? "" : "s"} — revísala antes de presentar. Toca para ver el detalle.`,
    url: CE_DEEP_LINK,
    tag,
  };
}

// ── Lectura de la BCE del SAT (Syntage) para un periodo concreto ──────────────

/** Año/mes de un registro de Contabilidad Electrónica de Syntage. */
function periodoDeRecord(rec: Record<string, unknown>): { anio: number; mes: number } {
  return { anio: Number(rec.year ?? 0), mes: Number(rec.month ?? 0) };
}

/** Primera referencia descargable (XML preferido) de un registro de Syntage. */
function fileRefDe(rec: Record<string, unknown>): string | null {
  const files = Array.isArray(rec.files) ? (rec.files as Record<string, unknown>[]) : [];
  if (files.length === 0) return null;
  const xml = files.find((f) => String(f.mimeType ?? "").toLowerCase().includes("xml"));
  const elegido = xml ?? files[0];
  const id = elegido["@id"] ?? elegido.id;
  return id ? String(id) : null;
}

/**
 * LEE la balanza (BCE) del SAT para un periodo concreto desde Syntage SIN
 * disparar extracción ni importarla al ledger. Devuelve las cuentas normalizadas
 * o null si Syntage aún no tiene la balanza de ese mes.
 */
export async function leerBalanzaSatPeriodo(
  entityId: string,
  year: number,
  month: number,
  client: SyntageClient,
): Promise<CuentaBalanza[] | null> {
  const records = await client.getEntityElectronicAccounting(entityId);
  const balanzaRec = records.find((r) => {
    if (String(r.fileType ?? "") !== "B") return false;
    const p = periodoDeRecord(r);
    return p.anio === year && p.mes === month;
  });
  if (!balanzaRec) return null;
  const ref = fileRefDe(balanzaRec);
  if (!ref) return null;
  const xml = await client.downloadFileText(ref);
  const parsed = parseBalanza(xml);
  return cuentasDesdeBalanzaSat(parsed.cuentas);
}

// ── Orquestación (con DB / Syntage) — SÓLO LECTURA del ledger ─────────────────

export interface ReconciliarResult {
  companyId: string;
  rfc?: string;
  periodo: string;
  /** El diff completo, o null si no se pudo comparar (sin balanza del SAT, etc.). */
  diff: DiffBalanzas | null;
  /** Se levantó/actualizó un hallazgo en esta corrida. */
  hallazgoAbierto: boolean;
  /** Se resolvió un hallazgo previo (la conciliación quedó limpia). */
  hallazgoResuelto: boolean;
  skipped?: boolean;
  error?: string;
}

/**
 * Concilia (sólo lectura) la Contabilidad Electrónica de una empresa para un
 * periodo "YYYY-MM": compara la BCE del SAT contra la balanza del libro vivo y
 * levanta/actualiza/resuelve un Hallazgo de forma idempotente (una fila por
 * empresa+periodo). NO escribe en el ledger.
 */
export async function reconciliarCEEmpresa(
  companyId: string,
  periodo: string,
  opts: { client?: SyntageClient; toleranciaPesos?: number } = {},
): Promise<ReconciliarResult> {
  const { year, month } = parsePeriodo(periodo);

  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { rfc: true, tier: true, ceBootstrapAt: true },
  });
  if (!company) {
    return { companyId, periodo, diff: null, hallazgoAbierto: false, hallazgoResuelto: false, error: "Empresa no encontrada" };
  }

  if (!planIncluyeSyntage(company.tier)) {
    return { companyId, rfc: company.rfc, periodo, diff: null, hallazgoAbierto: false, hallazgoResuelto: false, skipped: true };
  }

  const client = opts.client ?? new SyntageClient();
  const entity = await client.findEntityByRfc(company.rfc);
  if (!entity) {
    return { companyId, rfc: company.rfc, periodo, diff: null, hallazgoAbierto: false, hallazgoResuelto: false, error: "Sin entidad en Syntage para ese RFC" };
  }

  const sat = await leerBalanzaSatPeriodo(entity.id, year, month, client);
  if (!sat) {
    // El SAT aún no tiene la balanza de ese mes: no es un error, no hay nada que comparar.
    return { companyId, rfc: company.rfc, periodo, diff: null, hallazgoAbierto: false, hallazgoResuelto: false, skipped: true };
  }

  const libroRows = await balanza(companyId, year, month);
  const libro = cuentasDesdeBalanzaLibro(libroRows);

  const diff = compararBalanzas({ periodo, sat, libro, toleranciaPesos: opts.toleranciaPesos });

  const { abierto, resuelto } = await persistirHallazgoReconciliacion(companyId, diff);

  return {
    companyId,
    rfc: company.rfc,
    periodo,
    diff,
    hallazgoAbierto: abierto,
    hallazgoResuelto: resuelto,
  };
}

/**
 * Persiste el resultado de la conciliación como FiscalHallazgo idempotente
 * (única fila por empresa+periodo vía dedupeKey). Si hay diferencias, abre o
 * actualiza el hallazgo (ABIERTO). Si está limpio, resuelve el hallazgo previo
 * (si existía) marcándolo RESUELTO; no crea nada nuevo.
 */
async function persistirHallazgoReconciliacion(
  companyId: string,
  diff: DiffBalanzas,
): Promise<{ abierto: boolean; resuelto: boolean }> {
  const dedupeKey = dedupeKeyDe(diff.periodo);

  if (diffEstaLimpio(diff)) {
    // Conciliación limpia: resolver un hallazgo ABIERTO previo, sin crear uno nuevo.
    const previo = await prisma.fiscalHallazgo.findUnique({
      where: { companyId_dedupeKey: { companyId, dedupeKey } },
      select: { id: true, estado: true },
    });
    if (previo && previo.estado === "ABIERTO") {
      await prisma.fiscalHallazgo.update({
        where: { id: previo.id },
        data: { estado: "RESUELTO" },
      });
      return { abierto: false, resuelto: true };
    }
    return { abierto: false, resuelto: false };
  }

  const referencias = [
    ...diff.discrepancias.map((d) => `${d.cuenta}:${d.tipo}`),
    ...diff.faltantesEnLibro.map((c) => `falta-libro:${c.cuenta}`),
    ...diff.faltantesEnSat.map((c) => `falta-sat:${c.cuenta}`),
  ];

  await prisma.fiscalHallazgo.upsert({
    where: { companyId_dedupeKey: { companyId, dedupeKey } },
    create: {
      companyId,
      dedupeKey,
      checkClave: RECONCILIACION_CHECK_CLAVE,
      severidad: "warn",
      mensaje: mensajeHallazgo(diff),
      referencias,
      sugerencia:
        "Revise los asientos del periodo y vuelva a postear el mes para alinear el libro con la Contabilidad Electrónica presentada al SAT.",
      fundamentoLey: "CFF",
      fundamentoArticulo: "28",
      fundamentoFraccion: "III",
    },
    // Reabre y refresca: si un mes vuelve a discrepar tras haberse resuelto,
    // el hallazgo regresa a ABIERTO con el detalle actualizado.
    update: {
      estado: "ABIERTO",
      severidad: "warn",
      mensaje: mensajeHallazgo(diff),
      referencias,
    },
    select: { id: true },
  });

  return { abierto: true, resuelto: false };
}

/**
 * Concilia (sólo lectura) la CE de TODAS las empresas elegibles para un periodo:
 * plan con Syntage y ya arrancadas (ceBootstrapAt != null). Por defecto el mes
 * cerrado anterior. Una sola instancia de cliente Syntage. Best-effort: el error
 * de una empresa no detiene a las demás.
 */
export async function reconciliarTodasCEEmpresas(
  periodo: string = periodoMesAnterior(),
  opts: { toleranciaPesos?: number } = {},
): Promise<{ empresas: number; conHallazgo: number; resueltos: number; errores: number; periodo: string; resultados: ReconciliarResult[] }> {
  const client = new SyntageClient();
  const companies = await prisma.company.findMany({
    where: { ceBootstrapAt: { not: null }, tier: { not: "ASISTENTE" } },
    select: { id: true },
  });

  const resultados: ReconciliarResult[] = [];
  let conHallazgo = 0;
  let resueltos = 0;
  let errores = 0;
  for (const c of companies) {
    try {
      const r = await reconciliarCEEmpresa(c.id, periodo, { client, toleranciaPesos: opts.toleranciaPesos });
      if (r.error) errores++;
      if (r.hallazgoAbierto) conHallazgo++;
      if (r.hallazgoResuelto) resueltos++;
      resultados.push(r);
    } catch (e) {
      errores++;
      resultados.push({
        companyId: c.id,
        periodo,
        diff: null,
        hallazgoAbierto: false,
        hallazgoResuelto: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return { empresas: companies.length, conHallazgo, resueltos, errores, periodo, resultados };
}
