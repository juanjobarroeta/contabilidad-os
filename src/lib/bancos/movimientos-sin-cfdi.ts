// ─────────────────────────────────────────────────────────────────────────────
// Detector de movimientos SIN CFDI (cruce de dos vías) — SÓLO LECTURA.
//
// Cruza la conciliación bancaria de un periodo en ambos sentidos y levanta
// Hallazgos cuando algo no cuadra:
//
//   1. BANCO sin CFDI  → movimientos bancarios sin factura conciliada
//      (posible ingreso/egreso no facturado o CFDI faltante).
//   2. CFDI sin BANCO  → CFDIs que deberían tener un movimiento bancario
//      (PUE timbrados, que se asumen pagados al emitirse) y NO lo tienen
//      (posible cobro/pago pendiente o liquidación en efectivo).
//
// El núcleo (`detectarSinCfdi`) es PURO (sin DB): recibe los movimientos y los
// CFDIs ya cargados y devuelve resultados estructurados, para poder probarlo con
// vitest en memoria. La capa de I/O (`detectarMovimientosSinCfdi`) sólo LEE: trae
// los datos, llama al núcleo y persiste el/los Hallazgo(s) de forma idempotente
// (dos dedupeKeys por empresa+periodo, uno por dirección). NUNCA escribe en el
// ledger ni des-concilia nada.
//
// Sólo aplica cuando la empresa concilia banco (hay movimientos). Si no, no
// podemos juzgar y nos quedamos callados (evita falsos positivos masivos), igual
// que conciliacion-pue.reconciliacionActiva.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";

// Tolerancia de monto por defecto: diferencias de hasta 1 peso se consideran
// redondeo y no impiden una coincidencia. Configurable por llamador.
export const TOLERANCIA_PESOS_DEFAULT = 1;

const MXN = (n: number) => n.toLocaleString("es-MX", { style: "currency", currency: "MXN" });

// ── Tipos de entrada (mínimos, para que el núcleo sea puro y testeable) ───────

/** Un movimiento bancario normalizado para el cruce. */
export interface MovimientoBanco {
  id: string;
  /** Positivo = crédito (entra dinero); negativo = débito (sale dinero). */
  monto: number;
  fecha: Date;
  descripcion: string;
  /** UNMATCHED | MATCHED | IGNORED. Sólo se evalúan los UNMATCHED. */
  status: string;
}

/** Un CFDI normalizado para el cruce. */
export interface CfdiCruce {
  id: string;
  /** INGRESO | EGRESO | … Sólo INGRESO/EGRESO participan. */
  tipo: string;
  /** PUE | PPD. Sólo los PUE se asumen pagados al emitirse. */
  metodoPago: string;
  fecha: Date;
  total: number;
  /** Folio fiscal, sólo informativo para las referencias. */
  uuid?: string | null;
  /** True si ya tiene al menos un movimiento bancario MATCHED ligado. */
  tieneMovimientoConciliado: boolean;
}

// ── Resultado estructurado del cruce ──────────────────────────────────────────

export interface BancoSinCfdiItem {
  transaccionId: string;
  monto: number;
  fecha: Date;
  descripcion: string;
}

export interface CfdiSinBancoItem {
  invoiceId: string;
  uuid?: string | null;
  tipo: string;
  total: number;
  fecha: Date;
}

export interface CruceSinCfdi {
  periodo: string; // "YYYY-MM"
  /** Movimientos bancarios UNMATCHED sin CFDI que los respalde. */
  bancoSinCfdi: BancoSinCfdiItem[];
  /** CFDIs PUE INGRESO/EGRESO sin movimiento bancario conciliado. */
  cfdiSinBanco: CfdiSinBancoItem[];
  /** Suma en valor absoluto de los movimientos banco-sin-CFDI. */
  totalBancoSinCfdi: number;
  /** Suma del total de los CFDIs sin banco. */
  totalCfdiSinBanco: number;
}

// ── Núcleo PURO ───────────────────────────────────────────────────────────────

/**
 * Cruza movimientos bancarios y CFDIs de un periodo en ambos sentidos. PURO:
 * sin DB. Reglas:
 *
 *  • BANCO sin CFDI: un movimiento UNMATCHED es "sin CFDI" si NO existe ningún
 *    CFDI compatible (mismo signo de flujo: crédito↔INGRESO, débito↔EGRESO) cuyo
 *    total empate con el monto dentro de la tolerancia. Los MATCHED/IGNORED se
 *    ignoran (ya conciliados o descartados por el usuario).
 *
 *  • CFDI sin BANCO: un CFDI INGRESO/EGRESO con metodoPago PUE (se asume pagado
 *    al emitirse) es "sin banco" si NO tiene movimiento conciliado ligado Y no
 *    hay ningún movimiento UNMATCHED compatible que lo pudiera respaldar. Los PPD
 *    se excluyen (su pago llega después, vía complemento). Los CFDIs cancelados
 *    no deben llegar aquí (se filtran en la capa de I/O).
 *
 * La tolerancia se aplica con `<=`: una diferencia exactamente igual a la
 * tolerancia SÍ cuenta como coincidencia (dentro del margen).
 */
export function detectarSinCfdi(args: {
  periodo: string;
  movimientos: ReadonlyArray<MovimientoBanco>;
  cfdis: ReadonlyArray<CfdiCruce>;
  toleranciaPesos?: number;
}): CruceSinCfdi {
  const tol = args.toleranciaPesos ?? TOLERANCIA_PESOS_DEFAULT;

  const movsUnmatched = args.movimientos.filter((m) => m.status === "UNMATCHED");
  const cfdisRelevantes = args.cfdis.filter((c) => c.tipo === "INGRESO" || c.tipo === "EGRESO");

  // Un movimiento empata con un CFDI si el flujo coincide (crédito→INGRESO,
  // débito→EGRESO) y el monto absoluto cuadra dentro de la tolerancia.
  const empata = (mov: MovimientoBanco, cfdi: CfdiCruce): boolean => {
    const tipoEsperado = mov.monto >= 0 ? "INGRESO" : "EGRESO";
    if (cfdi.tipo !== tipoEsperado) return false;
    return Math.abs(Math.abs(mov.monto) - Math.abs(cfdi.total)) <= tol;
  };

  // 1) BANCO sin CFDI: ningún CFDI relevante empata con el movimiento.
  const bancoSinCfdi: BancoSinCfdiItem[] = movsUnmatched
    .filter((mov) => !cfdisRelevantes.some((cfdi) => empata(mov, cfdi)))
    .map((mov) => ({
      transaccionId: mov.id,
      monto: mov.monto,
      fecha: mov.fecha,
      descripcion: mov.descripcion,
    }));

  // 2) CFDI sin BANCO: PUE INGRESO/EGRESO, sin movimiento conciliado y sin
  //    movimiento UNMATCHED compatible que lo respalde.
  const cfdiSinBanco: CfdiSinBancoItem[] = cfdisRelevantes
    .filter((cfdi) => cfdi.metodoPago === "PUE")
    .filter((cfdi) => !cfdi.tieneMovimientoConciliado)
    .filter((cfdi) => !movsUnmatched.some((mov) => empata(mov, cfdi)))
    .map((cfdi) => ({
      invoiceId: cfdi.id,
      uuid: cfdi.uuid ?? null,
      tipo: cfdi.tipo,
      total: cfdi.total,
      fecha: cfdi.fecha,
    }));

  // Orden estable para Hallazgos/UI reproducibles (por fecha, luego id).
  bancoSinCfdi.sort(
    (a, b) => a.fecha.getTime() - b.fecha.getTime() || a.transaccionId.localeCompare(b.transaccionId),
  );
  cfdiSinBanco.sort(
    (a, b) => a.fecha.getTime() - b.fecha.getTime() || a.invoiceId.localeCompare(b.invoiceId),
  );

  return {
    periodo: args.periodo,
    bancoSinCfdi,
    cfdiSinBanco,
    totalBancoSinCfdi: bancoSinCfdi.reduce((s, i) => s + Math.abs(i.monto), 0),
    totalCfdiSinBanco: cfdiSinBanco.reduce((s, i) => s + Math.abs(i.total), 0),
  };
}

/** ¿No hay movimientos banco-sin-CFDI? */
export function bancoLimpio(cruce: CruceSinCfdi): boolean {
  return cruce.bancoSinCfdi.length === 0;
}

/** ¿No hay CFDIs sin banco? */
export function cfdiLimpio(cruce: CruceSinCfdi): boolean {
  return cruce.cfdiSinBanco.length === 0;
}

// ── Periodo ───────────────────────────────────────────────────────────────────

/** Parsea "YYYY-MM" → { year, month }. Lanza si el formato es inválido. */
export function parsePeriodo(periodo: string): { year: number; month: number } {
  const m = /^(\d{4})-(\d{2})$/.exec(periodo.trim());
  if (!m) throw new Error(`Periodo inválido: "${periodo}" (se espera YYYY-MM)`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) throw new Error(`Mes fuera de rango en periodo: "${periodo}"`);
  return { year, month };
}

/** Mes en curso (formato "YYYY-MM") respecto a una fecha de referencia. */
export function periodoMesActual(ref: Date = new Date()): string {
  const year = ref.getUTCFullYear();
  const month = ref.getUTCMonth() + 1; // 1-12
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** Límites [inicio, finExclusivo) UTC del mes de un periodo "YYYY-MM". */
export function limitesPeriodo(periodo: string): { inicio: Date; finExclusivo: Date } {
  const { year, month } = parsePeriodo(periodo);
  const inicio = new Date(Date.UTC(year, month - 1, 1));
  const finExclusivo = new Date(Date.UTC(year, month, 1));
  return { inicio, finExclusivo };
}

// ── Mensajes FORMALES ─────────────────────────────────────────────────────────

export function mensajeBancoSinCfdi(cruce: CruceSinCfdi): string {
  const n = cruce.bancoSinCfdi.length;
  const cabecera = `Se detectaron ${n} movimiento(s) bancario(s) del periodo ${cruce.periodo} sin un CFDI que los respalde, por un total de ${MXN(cruce.totalBancoSinCfdi)}.`;
  const detalle = cruce.bancoSinCfdi
    .slice(0, 5)
    .map((m) => `· ${m.fecha.toISOString().slice(0, 10)} ${MXN(m.monto)} — ${m.descripcion}`)
    .join("\n");
  return detalle ? `${cabecera}\n\n${detalle}` : cabecera;
}

export function mensajeCfdiSinBanco(cruce: CruceSinCfdi): string {
  const n = cruce.cfdiSinBanco.length;
  const cabecera = `Se detectaron ${n} CFDI(s) PUE del periodo ${cruce.periodo} sin movimiento bancario conciliado, por un total de ${MXN(cruce.totalCfdiSinBanco)}.`;
  const detalle = cruce.cfdiSinBanco
    .slice(0, 5)
    .map((c) => `· ${c.fecha.toISOString().slice(0, 10)} ${c.tipo} ${MXN(c.total)}${c.uuid ? ` (${c.uuid})` : ""}`)
    .join("\n");
  return detalle ? `${cabecera}\n\n${detalle}` : cabecera;
}

// ── Hallazgo (idempotente por empresa+periodo+dirección) ──────────────────────

export const BANCO_SIN_CFDI_CHECK_CLAVE = "BANCO_SIN_CFDI";
export const CFDI_SIN_BANCO_CHECK_CLAVE = "CFDI_SIN_BANCO";

function dedupeKeyBancoSinCfdi(periodo: string): string {
  return `${BANCO_SIN_CFDI_CHECK_CLAVE}|${periodo}`;
}
function dedupeKeyCfdiSinBanco(periodo: string): string {
  return `${CFDI_SIN_BANCO_CHECK_CLAVE}|${periodo}`;
}

// ── Orquestación (con DB) — SÓLO LECTURA del ledger ───────────────────────────

export interface DetectarResult {
  companyId: string;
  periodo: string;
  /** El cruce completo, o null si no se evaluó (empresa sin conciliación bancaria). */
  cruce: CruceSinCfdi | null;
  bancoHallazgoAbierto: boolean;
  bancoHallazgoResuelto: boolean;
  cfdiHallazgoAbierto: boolean;
  cfdiHallazgoResuelto: boolean;
  skipped?: boolean;
  error?: string;
}

/**
 * Detecta (sólo lectura) movimientos sin CFDI en ambos sentidos para una empresa
 * y un periodo "YYYY-MM", y levanta/actualiza/resuelve hasta dos Hallazgos
 * idempotentes (uno por dirección). NO escribe en el ledger.
 *
 * Se salta empresas sin movimientos bancarios (no conciliamos → no juzgamos).
 */
export async function detectarMovimientosSinCfdi(
  companyId: string,
  periodo: string = periodoMesActual(),
  opts: { toleranciaPesos?: number } = {},
): Promise<DetectarResult> {
  const { inicio, finExclusivo } = limitesPeriodo(periodo);

  // ¿La empresa concilia banco? Si no hay movimientos en absoluto, callar.
  const totalMovs = await prisma.bankTransaction.count({ where: { companyId } });
  if (totalMovs === 0) {
    return {
      companyId,
      periodo,
      cruce: null,
      bancoHallazgoAbierto: false,
      bancoHallazgoResuelto: false,
      cfdiHallazgoAbierto: false,
      cfdiHallazgoResuelto: false,
      skipped: true,
    };
  }

  const [movimientos, cfdis] = await Promise.all([
    prisma.bankTransaction.findMany({
      where: { companyId, fecha: { gte: inicio, lt: finExclusivo } },
      select: { id: true, monto: true, fecha: true, descripcion: true, status: true },
    }),
    prisma.invoice.findMany({
      where: {
        companyId,
        status: "STAMPED",
        tipo: { in: ["INGRESO", "EGRESO"] },
        canceladaAt: null,
        fecha: { gte: inicio, lt: finExclusivo },
      },
      select: {
        id: true,
        tipo: true,
        metodoPago: true,
        fecha: true,
        total: true,
        uuid: true,
        bankTransactions: { where: { status: "MATCHED" }, select: { id: true }, take: 1 },
        // Conciliación uno-a-varios: una porción asignada también respalda el CFDI.
        conciliacionDetalles: { select: { id: true }, take: 1 },
      },
    }),
  ]);

  const cruce = detectarSinCfdi({
    periodo,
    toleranciaPesos: opts.toleranciaPesos,
    movimientos,
    cfdis: cfdis.map((c) => ({
      id: c.id,
      tipo: c.tipo,
      metodoPago: c.metodoPago,
      fecha: c.fecha,
      total: c.total,
      uuid: c.uuid,
      tieneMovimientoConciliado: c.bankTransactions.length > 0 || c.conciliacionDetalles.length > 0,
    })),
  });

  const banco = await persistirHallazgoBanco(companyId, cruce);
  const cfdi = await persistirHallazgoCfdi(companyId, cruce);

  return {
    companyId,
    periodo,
    cruce,
    bancoHallazgoAbierto: banco.abierto,
    bancoHallazgoResuelto: banco.resuelto,
    cfdiHallazgoAbierto: cfdi.abierto,
    cfdiHallazgoResuelto: cfdi.resuelto,
  };
}

async function persistirHallazgoBanco(
  companyId: string,
  cruce: CruceSinCfdi,
): Promise<{ abierto: boolean; resuelto: boolean }> {
  const dedupeKey = dedupeKeyBancoSinCfdi(cruce.periodo);

  if (bancoLimpio(cruce)) {
    return resolverSiAbierto(companyId, dedupeKey);
  }

  await prisma.fiscalHallazgo.upsert({
    where: { companyId_dedupeKey: { companyId, dedupeKey } },
    create: {
      companyId,
      dedupeKey,
      checkClave: BANCO_SIN_CFDI_CHECK_CLAVE,
      severidad: "warn",
      mensaje: mensajeBancoSinCfdi(cruce),
      referencias: cruce.bancoSinCfdi.map((m) => m.transaccionId),
      sugerencia:
        "Revise estos movimientos bancarios: emita o registre el CFDI que los respalda, o concílielos con la factura correspondiente. Si corresponden a operaciones sin comprobante fiscal, documente su origen.",
      fundamentoLey: "CFF",
      fundamentoArticulo: "29",
    },
    update: {
      estado: "ABIERTO",
      severidad: "warn",
      mensaje: mensajeBancoSinCfdi(cruce),
      referencias: cruce.bancoSinCfdi.map((m) => m.transaccionId),
    },
    select: { id: true },
  });

  return { abierto: true, resuelto: false };
}

async function persistirHallazgoCfdi(
  companyId: string,
  cruce: CruceSinCfdi,
): Promise<{ abierto: boolean; resuelto: boolean }> {
  const dedupeKey = dedupeKeyCfdiSinBanco(cruce.periodo);

  if (cfdiLimpio(cruce)) {
    return resolverSiAbierto(companyId, dedupeKey);
  }

  await prisma.fiscalHallazgo.upsert({
    where: { companyId_dedupeKey: { companyId, dedupeKey } },
    create: {
      companyId,
      dedupeKey,
      checkClave: CFDI_SIN_BANCO_CHECK_CLAVE,
      severidad: "warn",
      mensaje: mensajeCfdiSinBanco(cruce),
      referencias: cruce.cfdiSinBanco.map((c) => c.invoiceId),
      sugerencia:
        "Verifique el cobro o pago de estos CFDI PUE: si ya se liquidaron, concílielos con el movimiento bancario correspondiente; si siguen pendientes, dé seguimiento a la cobranza o al pago.",
      fundamentoLey: "LIVA",
      fundamentoArticulo: "1-B",
    },
    update: {
      estado: "ABIERTO",
      severidad: "warn",
      mensaje: mensajeCfdiSinBanco(cruce),
      referencias: cruce.cfdiSinBanco.map((c) => c.invoiceId),
    },
    select: { id: true },
  });

  return { abierto: true, resuelto: false };
}

/** Resuelve un Hallazgo ABIERTO previo (si existe) sin crear uno nuevo. */
async function resolverSiAbierto(
  companyId: string,
  dedupeKey: string,
): Promise<{ abierto: boolean; resuelto: boolean }> {
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

/**
 * Detecta movimientos sin CFDI en TODAS las empresas activas para un periodo
 * (por defecto el mes en curso). Best-effort: el error de una empresa no detiene
 * a las demás. Las empresas sin conciliación bancaria se saltan.
 */
export async function detectarTodasEmpresasSinCfdi(
  periodo: string = periodoMesActual(),
  opts: { toleranciaPesos?: number } = {},
): Promise<{
  empresas: number;
  conHallazgo: number;
  resueltos: number;
  saltadas: number;
  errores: number;
  periodo: string;
  resultados: DetectarResult[];
}> {
  const companies = await prisma.company.findMany({
    where: { isActive: true },
    select: { id: true },
  });

  const resultados: DetectarResult[] = [];
  let conHallazgo = 0;
  let resueltos = 0;
  let saltadas = 0;
  let errores = 0;

  for (const c of companies) {
    try {
      const r = await detectarMovimientosSinCfdi(c.id, periodo, opts);
      if (r.skipped) saltadas++;
      if (r.bancoHallazgoAbierto || r.cfdiHallazgoAbierto) conHallazgo++;
      if (r.bancoHallazgoResuelto || r.cfdiHallazgoResuelto) resueltos++;
      resultados.push(r);
    } catch (e) {
      errores++;
      resultados.push({
        companyId: c.id,
        periodo,
        cruce: null,
        bancoHallazgoAbierto: false,
        bancoHallazgoResuelto: false,
        cfdiHallazgoAbierto: false,
        cfdiHallazgoResuelto: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return { empresas: companies.length, conHallazgo, resueltos, saltadas, errores, periodo, resultados };
}
