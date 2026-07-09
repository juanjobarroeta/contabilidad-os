// ─────────────────────────────────────────────────────────────────────────────
// Importación del HISTÓRICO de nómina desde los CFDIs timbrados del SAT.
//
// La sincronización con el SAT trae los recibos de nómina (Invoice.tipo =
// NOMINA con rawXml del complemento 1.2). Este módulo los convierte en
// PayrollRun + PayrollItem "de sólo lectura" (origen = "SAT") para que la
// empresa vea su historial de quincenas al entrar por primera vez, y para que
// los agregados que leen PayrollItem (p. ej. la PTU pagada del ejercicio en
// computeTaxPosition) queden completos.
//
// Piezas, separadas a propósito (mismo patrón que roster-import):
//   1. parseReciboNominaHistorico(rawXml) — PURA. Extiende el parser del roster
//      con periodo (FechaInicial/FinalPago), días pagados y el desglose de
//      percepciones/deducciones/otros pagos mapeado a columnas de PayrollItem.
//   2. construirCorridasHistoricas(recibos, uuidsVinculados) — PURA. Aplica la
//      REGLA DE DEDUP (uuid ya vinculado a un PayrollItem → se omite) y agrupa
//      los recibos restantes por periodo + tipo en corridas.
//   3. detectarPeriodicidad / siguientePeriodo — PURAS. Detectan la cadencia
//      (semanal/quincenal/mensual) de un periodo y calculan el siguiente; las
//      usa también el prefill de "Iniciar desde la quincena anterior".
//   4. importarNominaHistorica(companyId) — lee/escribe la DB. Idempotente:
//      re-ejecutarla nunca duplica corridas porque la dedup es por folio
//      fiscal (Invoice.uuid ↔ PayrollItem.cfdiUuid), que cubre tanto los
//      recibos timbrados DESDE la app como los ya importados antes.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "../prisma";
import { calcularFactorIntegracion } from "./prestaciones";
import {
  parseComplementoNomina,
  clasificarEmpleado,
  partirNombre,
  type ComplementoNomina,
  type ReciboEvento,
} from "./roster-import";

// ── 1. Parser PURO del recibo histórico ──────────────────────────────────────

/** Desglose mapeado a las columnas de PayrollItem. */
export interface DesgloseNomina {
  // Percepciones (gravado + exento por TipoPercepcion)
  sueldoBase: number; // 001 Sueldos (incluye vacaciones pagadas como 001)
  horasExtra: number; // 019 Horas extra
  vales: number; // 029 Vales de despensa
  aguinaldo: number; // 002 Aguinaldo
  primaVacacional: number; // 021 Prima vacacional
  ptu: number; // 003 PTU
  otrasPercepciones: number; // resto de percepciones
  // Deducciones
  isrRetenido: number; // 002 ISR
  imssObrero: number; // 001 Seguridad social (cuota obrera)
  infonavit: number; // 009/010 crédito de vivienda
  otrasDeducc: number; // resto de deducciones
  // Otros pagos (no son percepción ni deducción; suman al neto)
  subsidioEmpleo: number; // TipoOtroPago 002 Subsidio para el empleo
  otrosPagos: number; // resto de otros pagos
  totalPercepciones: number;
  totalDeducciones: number;
  totalOtrosPagos: number;
  /** Neto = percepciones + otros pagos − deducciones. */
  netoAPagar: number;
}

export interface ReciboNominaHistorico {
  /** Datos del trabajador (parser del roster, reutilizado tal cual). */
  complemento: ComplementoNomina;
  /** RFC del EMISOR del CFDI — para confirmar que el recibo es de la empresa. */
  rfcEmisor: string | null;
  /** FechaInicialPago / FechaFinalPago del nodo Nomina (ISO date). */
  fechaInicialPago: string | null;
  fechaFinalPago: string | null;
  numDiasPagados: number | null;
  desglose: DesgloseNomina;
}

// Percepciones → columna de PayrollItem (mismos códigos que usa calc-nomina).
const PERCEPCION_COL: Record<string, keyof DesgloseNomina> = {
  "001": "sueldoBase",
  "019": "horasExtra",
  "029": "vales",
  "002": "aguinaldo",
  "021": "primaVacacional",
  "003": "ptu",
};

// Deducciones → columna (001 IMSS, 002 ISR, 009/010 vivienda; ver calc-nomina).
const DEDUCCION_COL: Record<string, keyof DesgloseNomina> = {
  "001": "imssObrero",
  "002": "isrRetenido",
  "009": "infonavit",
  "010": "infonavit",
};

function num(v: string | null | undefined): number {
  const n = v != null && v !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Parsea un CFDI de nómina timbrado y devuelve lo necesario para reconstruir
 * el PayrollItem histórico. Devuelve null si el XML no es un recibo de nómina
 * legible (mismos criterios que parseComplementoNomina). NO lanza.
 */
export function parseReciboNominaHistorico(
  rawXml: string | null | undefined
): ReciboNominaHistorico | null {
  const complemento = parseComplementoNomina(rawXml);
  if (!complemento || !rawXml) return null;

  const nominaAttrs = /<(?:[a-zA-Z0-9]+:)?Nomina\b([^>]*)>/.exec(rawXml)?.[1] ?? "";
  const nAttr = (name: string) =>
    new RegExp(`\\b${name}="([^"]*)"`).exec(nominaAttrs)?.[1] ?? null;

  const rfcEmisor =
    /<(?:[a-zA-Z0-9]+:)?Emisor\b[^>]*\bRfc="([^"]*)"/.exec(rawXml)?.[1]?.toUpperCase() ?? null;

  const desglose: DesgloseNomina = {
    sueldoBase: 0,
    horasExtra: 0,
    vales: 0,
    aguinaldo: 0,
    primaVacacional: 0,
    ptu: 0,
    otrasPercepciones: 0,
    isrRetenido: 0,
    imssObrero: 0,
    infonavit: 0,
    otrasDeducc: 0,
    subsidioEmpleo: 0,
    otrosPagos: 0,
    totalPercepciones: 0,
    totalDeducciones: 0,
    totalOtrosPagos: 0,
    netoAPagar: 0,
  };

  // Percepciones: importe = gravado + exento. El tag puede ser autocontenido o
  // envolver hijos (HorasExtra, SeparacionIndemnizacion) — sólo leemos attrs.
  const percRe = /<(?:[a-zA-Z0-9]+:)?Percepcion\b([^>]*?)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = percRe.exec(rawXml)) !== null) {
    const attrs = m[1];
    const get = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1] ?? null;
    const tipo = get("TipoPercepcion");
    if (!tipo) continue;
    const importe = num(get("ImporteGravado")) + num(get("ImporteExento"));
    const col = PERCEPCION_COL[tipo] ?? "otrasPercepciones";
    desglose[col] = round2(desglose[col] + importe);
    desglose.totalPercepciones = round2(desglose.totalPercepciones + importe);
  }

  // Deducciones.
  const dedRe = /<(?:[a-zA-Z0-9]+:)?Deduccion\b([^>]*?)\/?>/g;
  while ((m = dedRe.exec(rawXml)) !== null) {
    const attrs = m[1];
    const get = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1] ?? null;
    const tipo = get("TipoDeduccion");
    if (!tipo) continue;
    const importe = num(get("Importe"));
    const col = DEDUCCION_COL[tipo] ?? "otrasDeducc";
    desglose[col] = round2(desglose[col] + importe);
    desglose.totalDeducciones = round2(desglose.totalDeducciones + importe);
  }

  // Otros pagos (subsidio al empleo 002, viáticos 003, etc.). Suman al neto.
  const otroRe = /<(?:[a-zA-Z0-9]+:)?OtroPago\b([^>]*?)\/?>/g;
  while ((m = otroRe.exec(rawXml)) !== null) {
    const attrs = m[1];
    const get = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1] ?? null;
    const importe = num(get("Importe"));
    if (get("TipoOtroPago") === "002") desglose.subsidioEmpleo = round2(desglose.subsidioEmpleo + importe);
    else desglose.otrosPagos = round2(desglose.otrosPagos + importe);
    desglose.totalOtrosPagos = round2(desglose.totalOtrosPagos + importe);
  }

  // Los totales del nodo Nomina mandan si vienen (son los timbrados); el
  // desglose sumado es el fallback para XML sin totales.
  const totPerc = nAttr("TotalPercepciones");
  const totDed = nAttr("TotalDeducciones");
  const totOtros = nAttr("TotalOtrosPagos");
  if (totPerc != null && totPerc !== "") desglose.totalPercepciones = num(totPerc);
  if (totDed != null && totDed !== "") desglose.totalDeducciones = num(totDed);
  if (totOtros != null && totOtros !== "") desglose.totalOtrosPagos = num(totOtros);
  desglose.netoAPagar = round2(
    desglose.totalPercepciones + desglose.totalOtrosPagos - desglose.totalDeducciones
  );

  return {
    complemento,
    rfcEmisor,
    fechaInicialPago: nAttr("FechaInicialPago"),
    fechaFinalPago: nAttr("FechaFinalPago"),
    numDiasPagados: nAttr("NumDiasPagados") != null ? num(nAttr("NumDiasPagados")) : null,
    desglose,
  };
}

// ── 2. Agrupación PURA en corridas + regla de dedup ──────────────────────────

export type TipoCorrida =
  | "ORDINARIA"
  | "EXTRAORDINARIA"
  | "FINIQUITO"
  | "AGUINALDO"
  | "PTU";

export interface ReciboConUuid {
  /** Folio fiscal (Invoice.uuid), MAYÚSCULAS. */
  uuid: string;
  recibo: ReciboNominaHistorico;
}

export interface CorridaHistorica {
  /** "YYYY-MM-DD/YYYY-MM-DD" — mismo formato que PayrollRun.periodo. */
  periodo: string;
  /** Fecha de pago dominante del grupo (ISO date). */
  fechaPago: string;
  tipo: TipoCorrida;
  recibos: ReciboConUuid[];
  totalPercepciones: number;
  totalDeducciones: number;
  totalNeto: number;
}

/** Deriva el tipo de corrida de un recibo (finiquito > aguinaldo/PTU > O/E). */
export function derivarTipoCorrida(r: ReciboNominaHistorico): TipoCorrida {
  if (r.complemento.esFiniquito) return "FINIQUITO";
  if (r.complemento.tipoNomina === "E") {
    // Extraordinaria dominada por una sola prestación → tipo específico.
    if (r.desglose.aguinaldo > 0 && r.desglose.aguinaldo >= r.desglose.ptu) return "AGUINALDO";
    if (r.desglose.ptu > 0) return "PTU";
    return "EXTRAORDINARIA";
  }
  return "ORDINARIA";
}

/**
 * REGLA DE DEDUP + agrupación:
 *   - Un recibo cuyo uuid ya está vinculado a un PayrollItem (cfdiUuid) se
 *     OMITE — cubre corridas timbradas desde la app y re-ejecuciones.
 *   - Los restantes se agrupan por (FechaInicialPago/FechaFinalPago, tipo);
 *     los recibos sin periodo (p. ej. finiquitos) usan FechaPago como periodo
 *     de un día.
 *   - La fechaPago de la corrida es la más frecuente del grupo (empate → la
 *     más reciente). Corridas ordenadas cronológicamente.
 */
export function construirCorridasHistoricas(
  recibos: ReciboConUuid[],
  uuidsVinculados: Set<string>
): CorridaHistorica[] {
  const grupos = new Map<string, ReciboConUuid[]>();

  for (const r of recibos) {
    if (uuidsVinculados.has(r.uuid.toUpperCase())) continue; // ← dedup
    const fechaPago = r.recibo.complemento.fechaPago;
    if (!fechaPago) continue; // sin fecha de pago no hay corrida
    const inicio = r.recibo.fechaInicialPago ?? fechaPago;
    const fin = r.recibo.fechaFinalPago ?? fechaPago;
    const tipo = derivarTipoCorrida(r.recibo);
    const key = `${inicio}/${fin}|${tipo}`;
    const arr = grupos.get(key);
    if (arr) arr.push(r);
    else grupos.set(key, [r]);
  }

  const corridas: CorridaHistorica[] = [];
  for (const [key, grupo] of grupos) {
    const [periodo, tipo] = key.split("|") as [string, TipoCorrida];

    // Fecha de pago dominante (moda; empate → la más reciente).
    const freq = new Map<string, number>();
    for (const r of grupo) {
      const f = r.recibo.complemento.fechaPago!;
      freq.set(f, (freq.get(f) ?? 0) + 1);
    }
    let fechaPago = "";
    let best = -1;
    for (const [f, n] of freq) {
      if (n > best || (n === best && f > fechaPago)) {
        fechaPago = f;
        best = n;
      }
    }

    corridas.push({
      periodo,
      fechaPago,
      tipo,
      recibos: grupo,
      totalPercepciones: round2(grupo.reduce((s, r) => s + r.recibo.desglose.totalPercepciones, 0)),
      totalDeducciones: round2(grupo.reduce((s, r) => s + r.recibo.desglose.totalDeducciones, 0)),
      totalNeto: round2(grupo.reduce((s, r) => s + r.recibo.desglose.netoAPagar, 0)),
    });
  }

  // Cronológico: al crearlas en este orden, la más reciente queda con el
  // createdAt más nuevo y aparece primero en el listado (orden desc).
  corridas.sort((a, b) => (a.fechaPago < b.fechaPago ? -1 : a.fechaPago > b.fechaPago ? 1 : 0));
  return corridas;
}

// ── 3. Periodicidad y siguiente periodo (PURAS; las usa el prefill) ──────────

export type Periodicidad = "SEMANAL" | "QUINCENAL" | "MENSUAL";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Días de un periodo inclusive (1-15 → 15). Fechas en UTC. */
function spanDias(inicio: Date, fin: Date): number {
  return Math.round((fin.getTime() - inicio.getTime()) / DAY_MS) + 1;
}

/** Detecta la cadencia de un periodo por su duración. */
export function detectarPeriodicidad(inicio: Date, fin: Date): Periodicidad {
  const dias = spanDias(inicio, fin);
  if (dias <= 10) return "SEMANAL";
  if (dias <= 20) return "QUINCENAL";
  return "MENSUAL";
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));

export interface SiguientePeriodo {
  periodicidad: Periodicidad;
  periodoInicio: string; // ISO date
  periodoFin: string;
  fechaPago: string;
  /** Días pagados convencionales: 7 semanal, 15 quincenal, 30 mensual. */
  diasPagados: number;
}

/**
 * Avanza un periodo de pago a la siguiente quincena/semana/mes.
 *
 * Quincenal respeta el calendario mexicano (1–15 y 16–fin de mes); mensual va
 * al mes calendario siguiente; semanal (y cualquier otra cadencia corta) corre
 * el periodo día a día. La fecha de pago conserva el desfase que tenía
 * respecto al fin del periodo anterior (pagar el mismo día del corte es el
 * caso típico), sin quedar antes del inicio del nuevo periodo.
 */
export function siguientePeriodo(input: {
  periodoInicio: Date;
  periodoFin: Date;
  fechaPago: Date;
}): SiguientePeriodo {
  const { periodoInicio, periodoFin, fechaPago } = input;
  const periodicidad = detectarPeriodicidad(periodoInicio, periodoFin);

  let inicio: Date;
  let fin: Date;

  if (periodicidad === "QUINCENAL") {
    const y = periodoFin.getUTCFullYear();
    const mth = periodoFin.getUTCMonth();
    const finDeMes = utc(y, mth + 1, 0).getUTCDate();
    if (periodoFin.getUTCDate() <= 15) {
      // Primera quincena → segunda del mismo mes (16 – fin de mes).
      inicio = utc(y, mth, 16);
      fin = utc(y, mth + 1, 0);
    } else if (periodoFin.getUTCDate() === finDeMes) {
      // Segunda quincena → primera del mes siguiente (1 – 15).
      inicio = utc(y, mth + 1, 1);
      fin = utc(y, mth + 1, 15);
    } else {
      // Quincena "corrida" no alineada al calendario: avanza por duración.
      const dias = spanDias(periodoInicio, periodoFin);
      inicio = new Date(periodoFin.getTime() + DAY_MS);
      fin = new Date(inicio.getTime() + (dias - 1) * DAY_MS);
    }
  } else if (periodicidad === "MENSUAL") {
    const y = periodoFin.getUTCFullYear();
    const mth = periodoFin.getUTCMonth();
    inicio = utc(y, mth + 1, 1);
    fin = utc(y, mth + 2, 0);
  } else {
    const dias = spanDias(periodoInicio, periodoFin);
    inicio = new Date(periodoFin.getTime() + DAY_MS);
    fin = new Date(inicio.getTime() + (dias - 1) * DAY_MS);
  }

  // Desfase de la fecha de pago respecto al fin del periodo (típicamente 0).
  const offsetDias = Math.round((fechaPago.getTime() - periodoFin.getTime()) / DAY_MS);
  let pago = new Date(fin.getTime() + offsetDias * DAY_MS);
  if (pago.getTime() < inicio.getTime()) pago = fin;

  return {
    periodicidad,
    periodoInicio: iso(inicio),
    periodoFin: iso(fin),
    fechaPago: iso(pago),
    diasPagados: periodicidad === "SEMANAL" ? 7 : periodicidad === "QUINCENAL" ? 15 : 30,
  };
}

// ── 4. Importador (lee y escribe la DB) ──────────────────────────────────────

export interface ImportHistoriaResult {
  /** CFDIs de nómina de la empresa considerados (timbrados, con rawXml). */
  recibosTotales: number;
  /** Omitidos por la regla de dedup (uuid ya vinculado a un PayrollItem). */
  recibosYaVinculados: number;
  /** rawXml ilegible o sin complemento de nómina. */
  recibosNoParseables: number;
  /** El emisor del CFDI no es la empresa (p. ej. asimilados recibidos). */
  recibosOtroEmisor: number;
  corridasCreadas: number;
  itemsCreados: number;
  empleadosCreados: number;
}

const RESULTADO_VACIO: ImportHistoriaResult = {
  recibosTotales: 0,
  recibosYaVinculados: 0,
  recibosNoParseables: 0,
  recibosOtroEmisor: 0,
  corridasCreadas: 0,
  itemsCreados: 0,
  empleadosCreados: 0,
};

/**
 * Importa el histórico de nómina de una empresa desde sus CFDIs timbrados.
 *
 * Idempotente: la dedup por folio fiscal (Invoice.uuid ↔ PayrollItem.cfdiUuid)
 * garantiza que re-ejecutar no duplica nada — ni las corridas emitidas desde
 * la app (sus items ya traen cfdiUuid) ni las importadas en corridas previas.
 * Los empleados faltantes se crean con la misma lógica del roster bootstrap
 * (datos del último recibo ordinario, estado vía clasificarEmpleado).
 */
export async function importarNominaHistorica(
  companyId: string,
  opts?: { hoy?: Date }
): Promise<ImportHistoriaResult> {
  const hoy = opts?.hoy ?? new Date();

  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { rfc: true },
  });
  if (!company) return { ...RESULTADO_VACIO };

  // Recibos timbrados con XML. Cancelados fuera; sin uuid no hay dedup posible.
  const invoices = await prisma.invoice.findMany({
    where: {
      companyId,
      tipo: "NOMINA",
      status: { not: "CANCELLED" },
      uuid: { not: null },
      rawXml: { not: null },
    },
    select: { uuid: true, rawXml: true },
  });

  // UUIDs ya vinculados a un PayrollItem de esta empresa (timbrados en la app
  // o importados antes) — la fuente de la regla de dedup.
  const vinculados = await prisma.payrollItem.findMany({
    where: { cfdiUuid: { not: null }, payrollRun: { companyId } },
    select: { cfdiUuid: true },
  });
  const uuidsVinculados = new Set(vinculados.map((v) => v.cfdiUuid!.toUpperCase()));

  const result: ImportHistoriaResult = { ...RESULTADO_VACIO, recibosTotales: invoices.length };
  const companyRfc = company.rfc.toUpperCase();
  const parseados: ReciboConUuid[] = [];

  for (const inv of invoices) {
    const uuid = inv.uuid!.toUpperCase();
    if (uuidsVinculados.has(uuid)) {
      result.recibosYaVinculados++;
      continue;
    }
    const recibo = parseReciboNominaHistorico(inv.rawXml);
    if (!recibo || !recibo.complemento.fechaPago) {
      result.recibosNoParseables++;
      continue;
    }
    // Sólo nómina EMITIDA por la empresa: un recibo donde la empresa es el
    // RECEPTOR (p. ej. asimilados a salarios recibidos) no es su nómina.
    if (recibo.rfcEmisor && recibo.rfcEmisor !== companyRfc) {
      result.recibosOtroEmisor++;
      continue;
    }
    parseados.push({ uuid, recibo });
  }

  const corridas = construirCorridasHistoricas(parseados, uuidsVinculados);
  if (corridas.length === 0) return result;

  // ── Empleados: vincular por RFC; crear los faltantes (lógica del roster) ──
  const existentes = await prisma.employee.findMany({
    where: { companyId },
    select: { id: true, rfc: true },
  });
  const idPorRfc = new Map(existentes.map((e) => [e.rfc.toUpperCase(), e.id]));

  // Recibos por RFC para clasificar estado y elegir el recibo fuente (el
  // ordinario más reciente manda, igual que en detectarRosterDesdeCfdis).
  const porRfc = new Map<string, ReciboConUuid[]>();
  for (const r of parseados) {
    const rfc = r.recibo.complemento.rfc;
    const arr = porRfc.get(rfc);
    if (arr) arr.push(r);
    else porRfc.set(rfc, [r]);
  }

  for (const [rfc, recibosEmpleado] of porRfc) {
    if (idPorRfc.has(rfc)) continue;

    const eventos: ReciboEvento[] = recibosEmpleado.map((r) => ({
      fechaPago: new Date(r.recibo.complemento.fechaPago!),
      tipoNomina: r.recibo.complemento.tipoNomina,
      esFiniquito: r.recibo.complemento.esFiniquito,
    }));
    const ordinarios = recibosEmpleado.filter(
      (r) => !r.recibo.complemento.esFiniquito && r.recibo.complemento.tipoNomina !== "E"
    );
    const pool = ordinarios.length > 0 ? ordinarios : recibosEmpleado;
    const fuente = pool.reduce((a, b) =>
      a.recibo.complemento.fechaPago! >= b.recibo.complemento.fechaPago! ? a : b
    ).recibo;

    const estado = clasificarEmpleado({
      recibos: eventos,
      hoy,
      cadencia: fuente.complemento.periodicidadPago,
    });
    const nombre = partirNombre(fuente.complemento.nombre);

    // Salario diario: SBC del recibo; si falta, se deriva del propio recibo.
    const salarioDiario =
      fuente.complemento.sbc ??
      (fuente.numDiasPagados && fuente.numDiasPagados > 0
        ? round2(fuente.desglose.totalPercepciones / fuente.numDiasPagados)
        : round2(fuente.desglose.totalPercepciones / 15));

    const fechaIngreso = fuente.complemento.fechaInicioRelLaboral
      ? new Date(fuente.complemento.fechaInicioRelLaboral)
      : new Date();
    const created = await prisma.employee.create({
      data: {
        companyId,
        nombre: nombre.nombrePila || rfc,
        apellidoPaterno: nombre.apellidoPaterno,
        apellidoMaterno: nombre.apellidoMaterno,
        rfc,
        curp: fuente.complemento.curp ?? "",
        nss: fuente.complemento.nss ?? "",
        fechaIngreso,
        isActive: estado === "ACTIVO",
        fechaBaja: estado === "BAJA" ? hoy : null,
        tipoContrato: fuente.complemento.tipoContrato ?? "01",
        tipoJornada: "01",
        tipoRegimen: fuente.complemento.tipoRegimen ?? "02",
        salarioDiario: Math.max(0.01, salarioDiario),
        // SDI del recibo; si falta, factor de integración real por antigüedad
        // (vacaciones reforma 2023 — año 1 = 1.0493, no el 1.0452 pre-reforma).
        salarioDiarioIntegrado:
          fuente.complemento.sdi ??
          round2(Math.max(0.01, salarioDiario) * calcularFactorIntegracion(fechaIngreso, hoy)),
        periodicidadPago: fuente.complemento.periodicidadPago ?? "04",
        departamento: fuente.complemento.departamento,
        puesto: fuente.complemento.puesto,
        riesgoPuesto: fuente.complemento.riesgoPuesto ?? "1",
      },
    });
    await prisma.employee.update({
      where: { id: created.id },
      data: { numEmpleado: created.id.slice(-6).toUpperCase() },
    });
    idPorRfc.set(rfc, created.id);
    result.empleadosCreados++;
  }

  // ── Crear corridas + items (STAMPED + origen SAT = sólo lectura en la UI) ──
  for (const corrida of corridas) {
    const run = await prisma.payrollRun.create({
      data: {
        companyId,
        periodo: corrida.periodo,
        fechaPago: new Date(corrida.fechaPago),
        tipo: corrida.tipo,
        status: "STAMPED",
        origen: "SAT",
        totalPercepciones: corrida.totalPercepciones,
        totalDeducciones: corrida.totalDeducciones,
        totalNeto: corrida.totalNeto,
        extraData: { importadaDeSat: true, recibosImportados: corrida.recibos.length },
      },
    });

    await prisma.payrollItem.createMany({
      data: corrida.recibos.map(({ uuid, recibo }) => {
        const d = recibo.desglose;
        return {
          payrollRunId: run.id,
          employeeId: idPorRfc.get(recibo.complemento.rfc)!,
          sueldoBase: d.sueldoBase,
          horasExtra: d.horasExtra,
          vales: d.vales,
          // El subsidio al empleo entregado y otros pagos suman al neto pero no
          // son percepción del complemento — se conservan en otrasPercepciones
          // sólo si vinieron como percepción; los OtrosPagos viven en el total.
          otrasPercepciones: d.otrasPercepciones,
          isrRetenido: d.isrRetenido,
          imssObrero: d.imssObrero,
          infonavit: d.infonavit,
          otrasDeducc: d.otrasDeducc,
          aguinaldo: d.aguinaldo,
          primaVacacional: d.primaVacacional,
          ptu: d.ptu,
          totalPercepciones: d.totalPercepciones,
          totalDeducciones: d.totalDeducciones,
          netoAPagar: d.netoAPagar,
          cfdiUuid: uuid, // ← vínculo con el CFDI; ancla de la idempotencia
        };
      }),
    });

    result.corridasCreadas++;
    result.itemsCreados += corrida.recibos.length;
  }

  return result;
}

/**
 * Importa el histórico para TODAS las empresas con recibos de nómina (modo
 * cron). Best-effort por empresa: un error no detiene a las demás.
 */
export async function importarNominaHistoricaTodas(opts?: {
  timeBudgetMs?: number;
}): Promise<{ companies: number; results: Record<string, ImportHistoriaResult | { error: string }> }> {
  const budget = opts?.timeBudgetMs ?? 240_000;
  const startedAt = Date.now();

  const conNomina = await prisma.invoice.findMany({
    where: { tipo: "NOMINA", rawXml: { not: null }, uuid: { not: null } },
    distinct: ["companyId"],
    select: { companyId: true },
  });

  const results: Record<string, ImportHistoriaResult | { error: string }> = {};
  for (const { companyId } of conNomina) {
    if (Date.now() - startedAt > budget) break;
    try {
      results[companyId] = await importarNominaHistorica(companyId);
    } catch (e) {
      results[companyId] = { error: e instanceof Error ? e.message : "Error desconocido" };
    }
  }
  return { companies: Object.keys(results).length, results };
}
