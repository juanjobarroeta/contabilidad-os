// ─────────────────────────────────────────────────────────────────────────────
// La SERIE mensual de balanzas presentadas (CE-first).
//
// Hasta ahora sólo la última balanza entraba al sistema —como asiento de
// apertura—; la historia (42 períodos en MARGOM) vivía sólo en Syntage. Esta
// pieza la baja completa a `CeBalanzaMes`: una fila por (período, cuenta) con
// SaldoIni/Debe/Haber/SaldoFin tal cual se presentaron. De aquí leen:
//   • los estados financieros CE-first (lo declarado, no lo derivado);
//   • el conciliador por montos (buscar el cargo de una unidad en el Debe
//     mensual de cada cuenta).
//
// Reutiliza los parsers puros de ce-import.ts y la selección por CONTENIDO de
// ce-import-syntage.ts (el sello digital también es XML: nunca elegir por
// orden ni por nombre de archivo). Una balanza re-presentada (complementaria)
// REEMPLAZA su período completo — deleteMany + createMany por período.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "../prisma";
import { SyntageClient } from "@/lib/fiscal/cumplimiento/syntage/client";
import { parseBalanza, padresDeBalanza } from "./ce-import";
import { descargarDocumentoCe, periodoDe } from "./ce-import-syntage";

export interface FilaSerie {
  numCta: string;
  saldoIni: number;
  debe: number;
  haber: number;
  saldoFin: number;
  esPadre: boolean;
}

export interface BalanzaMensual {
  anio: number;
  mes: number;
  filas: FilaSerie[];
}

/**
 * XML de balanza → filas de la serie, con `esPadre` decidido por
 * padresDeBalanza (el saldo de un mayor YA suma sus hijas: los reportes que
 * suman deben filtrar hojas). Pura; null si el XML no trae Anio/Mes.
 *
 * Un mismo NumCta puede venir VARIAS veces: la era agrupador presenta cada
 * subcuenta interna como su propio renglón bajo el código compartido —
 * «102.01» (bancos) aparece 19 veces en la balanza 2023-01 de MARGOM, una por
 * banco. Son cuentas distintas del mismo código: se SUMAN (guardarlas tal cual
 * revienta el unique por período+cuenta, que fue como se descubrió).
 */
export function balanzaASerie(xml: string): BalanzaMensual | null {
  const bal = parseBalanza(xml);
  if (!bal.anio || !bal.mes) return null;

  const porCta = new Map<string, FilaSerie>();
  for (const c of bal.cuentas) {
    const ya = porCta.get(c.numCta);
    if (ya) {
      ya.saldoIni += c.saldoIni;
      ya.debe += c.debe;
      ya.haber += c.haber;
      ya.saldoFin += c.saldoFin;
    } else {
      porCta.set(c.numCta, {
        numCta: c.numCta,
        saldoIni: c.saldoIni,
        debe: c.debe,
        haber: c.haber,
        saldoFin: c.saldoFin,
        esPadre: false,
      });
    }
  }
  const padres = padresDeBalanza(porCta.keys());
  for (const f of porCta.values()) f.esPadre = padres.has(f.numCta);

  return { anio: bal.anio, mes: bal.mes, filas: [...porCta.values()] };
}

/** Reemplaza el período completo (una complementaria pisa a la normal). */
export async function guardarBalanzaMes(companyId: string, b: BalanzaMensual): Promise<number> {
  await prisma.$transaction([
    prisma.ceBalanzaMes.deleteMany({ where: { companyId, anio: b.anio, mes: b.mes } }),
    prisma.ceBalanzaMes.createMany({
      data: b.filas.map((f) => ({ companyId, anio: b.anio, mes: b.mes, ...f })),
    }),
  ]);
  return b.filas.length;
}

export interface ImportarSerieResult {
  periodos: { anio: number; mes: number; filas: number; accion: "importado" | "ya estaba" | "sin documento" }[];
  importados: number;
}

/**
 * Baja TODA la serie de balanzas B de Syntage y la guarda. Sólo GETs contra
 * Syntage (no dispara extracciones). Idempotente: por default salta períodos ya
 * guardados (`force` los re-descarga y reemplaza — p.ej. tras una
 * complementaria). Si un período aparece varias veces en los registros, gana
 * el más reciente (los registros vienen DESC por createdAt).
 */
export async function importarSerieBalanzasSyntage(
  companyId: string,
  opts: { force?: boolean } = {},
  client = new SyntageClient(),
): Promise<ImportarSerieResult> {
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { rfc: true } });
  if (!company) throw new Error("Empresa no encontrada");
  const entity = await client.findEntityByRfc(company.rfc);
  if (!entity) throw new Error("Sin entidad en Syntage para ese RFC");

  const records = await client.getEntityElectronicAccounting(entity.id);
  const balanzas = records.filter((r) => String(r.fileType ?? "") === "B");

  // DESC por createdAt: el primero de cada período es el vigente.
  const porPeriodo = new Map<string, (typeof balanzas)[number]>();
  for (const rec of balanzas) {
    const { anio, mes } = periodoDe(rec);
    const k = `${anio}-${mes}`;
    if (!porPeriodo.has(k)) porPeriodo.set(k, rec);
  }

  const yaGuardados = new Set(
    (
      await prisma.ceBalanzaMes.groupBy({ by: ["anio", "mes"], where: { companyId } })
    ).map((g) => `${g.anio}-${g.mes}`),
  );

  const result: ImportarSerieResult = { periodos: [], importados: 0 };
  const ordenados = [...porPeriodo.entries()].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
  for (const [k, rec] of ordenados) {
    const { anio, mes } = periodoDe(rec);
    if (!opts.force && yaGuardados.has(k)) {
      result.periodos.push({ anio, mes, filas: 0, accion: "ya estaba" });
      continue;
    }
    const doc = await descargarDocumentoCe(client, rec, "B");
    const serie = doc ? balanzaASerie(doc.xml) : null;
    if (!serie) {
      result.periodos.push({ anio, mes, filas: 0, accion: "sin documento" });
      continue;
    }
    const filas = await guardarBalanzaMes(companyId, serie);
    result.periodos.push({ anio: serie.anio, mes: serie.mes, filas, accion: "importado" });
    result.importados++;
  }
  return result;
}
