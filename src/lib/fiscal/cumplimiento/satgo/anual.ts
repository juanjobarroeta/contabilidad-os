// ─────────────────────────────────────────────────────────────────────────────
// Declaración ANUAL por SatGo (`decanualfiel`). Probado en vivo el 5-oct-2026:
// funciona para personas FÍSICAS (HUOM 2024/2025, «DECLARACIÓN DEL EJERCICIO
// DE IMPUESTOS FEDERALES») y para MORALES (CBA 2024/2025, el formulario con
// «DATOS ADICIONALES … 32-A del CFF»). Devuelve un ZIP
// `DeclaracionesAnuales_<año>_<RFC>.zip` con `Anual_<año>_Normal_<op>.pdf`
// (puede traer más de uno: normal + complementaria).
//
// Persistencia, misma disciplina que el sync anual de Syntage:
//   · gap-fill: crea la fila DECLARACION_ANUAL si no existe (FILED, histórica,
//     con el PDF) y rellena coeficiente/pérdidas con Claude sólo cuando
//     faltan (`isrIngresos == null && acuseParseadoAt == null`);
//   · un parseo PAGADO que no se pudo leer deja la marca acuseParseadoAt para
//     no pagar el mismo PDF cada corrida;
//   · nunca sobreescribe importes capturados a mano.
// ─────────────────────────────────────────────────────────────────────────────

import JSZip from "jszip";
import { prisma } from "@/lib/prisma";
import { parseSatDocument, SatParsePagadoError, type AcuseAnual } from "@/lib/fiscal/acuse/parse";
import { camposAnualDesdeAcuse, mergeCamposAnual, type CamposAnualAcuse } from "../syntage/map";
import { SatGoClient, SatGoError } from "./client";
import { fielDeEmpresa, type FielResolver } from "./fiel";

/**
 * Ejercicios cerrados del rango de la empresa a los que les falta la anual
 * (sin fila, o fila sin PDF). PURA. El ejercicio en curso nunca entra; el
 * anterior sólo a partir de abril (PM presenta en marzo, PF en abril).
 */
export function ejerciciosAnualesPendientes(args: {
  hoy: Date;
  anios: number;
  inicio: Date | null;
  /** Ejercicios con fila DECLARACION_ANUAL y si ésta tiene PDF. */
  existentes: Map<number, { conPdf: boolean }>;
}): number[] {
  const { hoy, anios, inicio, existentes } = args;
  const ultimo = hoy.getMonth() + 1 >= 5 ? hoy.getFullYear() - 1 : hoy.getFullYear() - 2;
  const primero = Math.max(hoy.getFullYear() - anios, inicio ? inicio.getFullYear() : -Infinity);
  const out: number[] = [];
  for (let e = ultimo; e >= primero; e--) {
    const x = existentes.get(e);
    if (!x || !x.conPdf) out.push(e);
  }
  return out;
}

export interface AnualResultado {
  ejercicio: number;
  estado: "completo" | "importado" | "sin_archivo" | "error";
  archivos: number;
  acusesParseados: number;
  creada: boolean;
  pdfAdjuntado: boolean;
  campos: "actualizados" | "sin_cambios" | "sin_datos" | "no_parseado" | "error_pagado";
  error?: string;
}

async function pdfsDe(data: Buffer, contentType: string): Promise<Array<{ nombre: string; bytes: Buffer }>> {
  const esZip = /zip/.test(contentType) || (data[0] === 0x50 && data[1] === 0x4b);
  if (!esZip) return [{ nombre: "anual.pdf", bytes: data }];
  const zip = await JSZip.loadAsync(data);
  const out: Array<{ nombre: string; bytes: Buffer }> = [];
  for (const f of Object.values(zip.files)) {
    if (f.dir || !/\.pdf$/i.test(f.name)) continue;
    out.push({ nombre: f.name.split("/").pop() ?? f.name, bytes: Buffer.from(await f.async("uint8array")) });
  }
  // Complementarias después de la normal; dentro del mismo tipo, el número de operación más alto (la más reciente) primero.
  return out.sort((a, b) => (/complementaria/i.test(a.nombre) ? 1 : 0) - (/complementaria/i.test(b.nombre) ? 1 : 0) || b.nombre.localeCompare(a.nombre));
}

/** Trae la anual de un ejercicio y la persiste (gap-fill). */
export async function importarAnualSatGo(
  companyId: string,
  ejercicio: number,
  opts: { client?: SatGoClient; resolveFiel?: FielResolver } = {},
): Promise<AnualResultado> {
  const base: AnualResultado = { ejercicio, estado: "completo", archivos: 0, acusesParseados: 0, creada: false, pdfAdjuntado: false, campos: "no_parseado" };
  const periodo = String(ejercicio);
  const existente = await prisma.taxDeclaration.findFirst({
    where: { companyId, tipo: "DECLARACION_ANUAL", periodo },
    select: { id: true, isrIngresos: true, isrBaseGravable: true, isrCoeficienteUtilidad: true, isrPerdidaPendiente: true, acusePdfNombre: true, acuseParseadoAt: true },
  });
  if (existente?.acusePdfNombre && (existente.isrIngresos != null || existente.acuseParseadoAt != null)) return base;

  const client = opts.client ?? new SatGoClient();
  let pdfs: Array<{ nombre: string; bytes: Buffer }>;
  try {
    const fiel = await (opts.resolveFiel ?? fielDeEmpresa)(companyId);
    const doc = await client.consultarDecAnualFiel(fiel, { ejercicio, tipoDocumento: "declaracion" });
    pdfs = await pdfsDe(doc.data, doc.contentType);
  } catch (e) {
    if (e instanceof SatGoError && !e.transitorio && /no se encontr|sin declaraciones|no existen|no hay/i.test(e.message)) return { ...base, estado: "sin_archivo", error: e.message };
    return { ...base, estado: "error", error: e instanceof Error ? e.message : String(e) };
  }
  base.archivos = pdfs.length;
  if (pdfs.length === 0) return { ...base, estado: "sin_archivo" };
  base.estado = "importado";

  // Parsear hasta encontrar el acuse anual (el ZIP puede traer un recibo corto que no trae renglones).
  let anual: AcuseAnual | null = null;
  let pdfElegido = pdfs[0];
  let pagadoIlegible = false;
  for (const p of pdfs) {
    try {
      const parsed = await parseSatDocument(p.bytes.toString("base64"), { companyId, subtipo: "declaraciones.anual.satgo" });
      base.acusesParseados++;
      if (parsed.type === "ACUSE_ANUAL" && parsed.acuseAnual) { anual = parsed.acuseAnual; pdfElegido = p; break; }
    } catch (e) {
      if (e instanceof SatParsePagadoError) { base.acusesParseados++; pagadoIlegible = true; continue; }
      return { ...base, estado: "error", error: `parseo: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  const pdf = new Uint8Array(pdfElegido.bytes);
  const nombre = `acuse-anual-${ejercicio}.pdf`;
  const extraidos: CamposAnualAcuse | null = anual
    ? camposAnualDesdeAcuse({
        ingresosNominales: anual.ingresosNominales,
        utilidadFiscal: anual.utilidadFiscal,
        perdidaFiscalRemanente: anual.perdidaFiscalRemanente ?? null,
        perdidasPendientes: anual.perdidasPendientes ?? null,
        coeficienteUtilidad: anual.coeficienteUtilidad ?? null,
      })
    : null;

  if (!existente) {
    await prisma.taxDeclaration.create({
      data: {
        companyId, tipo: "DECLARACION_ANUAL", periodo, status: "FILED", isHistorical: true,
        isrPagar: anual?.isrAPagar ?? null,
        lineaCaptura: anual?.lineaCaptura ?? null,
        fechaPresentacion: anual?.fechaPresentacion ? new Date(anual.fechaPresentacion) : null,
        ...(extraidos ?? {}),
        acusePdf: pdf, acusePdfNombre: nombre, acuseParseadoAt: new Date(),
      },
    });
    base.creada = true;
    base.campos = anual ? (Object.values(extraidos ?? {}).some((v) => v != null) ? "actualizados" : "sin_datos") : pagadoIlegible ? "error_pagado" : "no_parseado";
    return base;
  }

  // Fila existente: adjuntar PDF si faltaba y rellenar campos sin pisar lo capturado.
  const num = (v: unknown): number | null => (v == null ? null : Number(v));
  const merged = extraidos
    ? mergeCamposAnual(
        { isrIngresos: num(existente.isrIngresos), isrBaseGravable: num(existente.isrBaseGravable), isrCoeficienteUtilidad: num(existente.isrCoeficienteUtilidad), isrPerdidaPendiente: num(existente.isrPerdidaPendiente) },
        extraidos,
      )
    : null;
  await prisma.taxDeclaration.update({
    where: { id: existente.id },
    data: {
      ...(existente.acusePdfNombre ? {} : { acusePdf: pdf, acusePdfNombre: nombre }),
      ...(merged ?? {}),
      acuseParseadoAt: new Date(),
    },
  });
  base.pdfAdjuntado = !existente.acusePdfNombre;
  base.campos = merged ? "actualizados" : anual ? "sin_cambios" : pagadoIlegible ? "error_pagado" : "no_parseado";
  return base;
}

export async function anualesPendientes(companyId: string, hoy = new Date()): Promise<number[]> {
  const c = await prisma.company.findUnique({ where: { id: companyId }, select: { satBackfillYears: true, fechaInicioOperaciones: true } });
  if (!c) return [];
  const filas = await prisma.taxDeclaration.findMany({ where: { companyId, tipo: "DECLARACION_ANUAL" }, select: { periodo: true, acusePdfNombre: true } });
  const existentes = new Map<number, { conPdf: boolean }>();
  for (const f of filas) { const e = Number(f.periodo); if (Number.isInteger(e)) existentes.set(e, { conPdf: !!f.acusePdfNombre || existentes.get(e)?.conPdf === true }); }
  return ejerciciosAnualesPendientes({ hoy, anios: Math.max(1, c.satBackfillYears), inicio: c.fechaInicioOperaciones, existentes });
}
