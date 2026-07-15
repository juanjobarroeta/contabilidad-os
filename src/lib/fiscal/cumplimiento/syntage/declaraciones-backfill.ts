// ─────────────────────────────────────────────────────────────────────────────
// Backfill de declaraciones MENSUALES desde Syntage.
//
// El recurso tax-return de Syntage no separa IVA/ISR (un solo `payment`), pero sí
// trae el ACUSE PDF (`files[]`). Aquí descargamos ese PDF y lo pasamos por el
// mismo parser de Claude del onboarding (parseSatDocument) para obtener el
// desglose IVA/ISR, y persistimos IVA_MENSUAL + ISR_PROVISIONAL.
//
// Es COSTOSO (1 llamada a Claude por mes), así que:
//   • Sólo descarga+parsea cuando falta alguna fila esperada del periodo
//     (según las obligaciones de la empresa). Si ya está capturado, ni toca el PDF.
//   • Gap-fill: nunca sobreescribe lo capturado/calculado.
//   • Idempotente y resumible: re-correr continúa donde quedó.
// Por eso vive en su propio job (cron declaraciones-backfill), NO en el sync diario.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import { SyntageClient } from "./client";
import { parseSatDocument, type AcuseMensual } from "@/lib/fiscal/acuse/parse";

export interface BackfillResult {
  companyId: string;
  rfc?: string;
  /** Filas TaxDeclaration creadas (IVA_MENSUAL / ISR_PROVISIONAL). */
  mesesCreados: number;
  /** Acuses PDF enviados a Claude (costo). */
  acusesParseados: number;
  /** True si se cortó por el tope de acuses de esta corrida (queda más por hacer). */
  topeAlcanzado?: boolean;
  error?: string;
}

const MESES: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};
const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();

/** "Diciembre" → 12, "03"/"3" → 3, 3 → 3. null si no se reconoce. */
export function mesDePeriodo(period: unknown): number | null {
  if (period == null) return null;
  if (typeof period === "number") return period >= 1 && period <= 12 ? period : null;
  const s = String(period).trim();
  const n = Number(s);
  if (Number.isInteger(n) && n >= 1 && n <= 12) return n;
  return MESES[norm(s)] ?? null;
}

/**
 * Referencia descargable del documento del tax-return (`files[]`), PREFIRIENDO
 * el transcript. Syntage adjunta hasta 3 archivos por declaración —
 * `tax_return.transcript` (PDF, el formulario completo con ingresos nominales
 * y la tabla de pérdidas), `tax_return.ack_receipt` (PDF corto, solo el acuse)
 * y `tax_return.financial_statements` (XLSX) — y el ORDEN del arreglo varía
 * entre declaraciones. Tomar "el primero" descargaba a veces el acuse corto,
 * que no trae nada parseable (caso real: la anual 2025 de una empresa quedó
 * con el receipt de 25 KB y el remanente de pérdidas nunca se extrajo).
 * Preferencia: transcript → cualquier PDF que no sea estados financieros →
 * lo que haya.
 */
export function fileRefDe(tr: Record<string, unknown>): string | null {
  const files = tr.files;
  const arr = Array.isArray(files) ? files : files ? [files] : [];

  const refDe = (f: unknown): string | null => {
    if (typeof f === "string") return f;
    if (f && typeof f === "object") {
      const o = f as Record<string, unknown>;
      if (typeof o["@id"] === "string") return o["@id"] as string;
      if (typeof o.resource === "string") return o.resource as string;
      if (typeof o.id === "string") return `/files/${o.id}`;
    }
    return null;
  };
  const tipoDe = (f: unknown): string =>
    f && typeof f === "object" ? String((f as Record<string, unknown>).type ?? "") : "";
  const esPdf = (f: unknown): boolean => {
    if (typeof f === "string") return true; // sin metadatos, no podemos descartar
    if (!f || typeof f !== "object") return false;
    const o = f as Record<string, unknown>;
    return o.mimeType == null || String(o.mimeType) === "application/pdf";
  };

  const transcript = arr.find((f) => tipoDe(f) === "tax_return.transcript" && esPdf(f));
  const otroPdf = arr.find((f) => esPdf(f) && tipoDe(f) !== "tax_return.financial_statements");
  for (const candidato of [transcript, otroPdf, arr[0]]) {
    const ref = candidato == null ? null : refDe(candidato);
    if (ref) return ref;
  }
  return null;
}

export async function backfillDeclaracionesMensuales(
  companyId: string,
  client = new SyntageClient(),
  opts: { maxAcuses?: number } = {},
): Promise<BackfillResult> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { rfc: true, isActive: true, obligations: { where: { activa: true }, select: { tipo: true } } },
  });
  if (!company) return { companyId, mesesCreados: 0, acusesParseados: 0, error: "Empresa no encontrada" };
  if (!company.isActive) return { companyId, rfc: company.rfc, mesesCreados: 0, acusesParseados: 0 };

  const tipos = new Set(company.obligations.map((o) => o.tipo));
  const tieneIVA = tipos.has("IVA_MENSUAL");
  const tieneISR = tipos.has("ISR_PROVISIONAL");
  if (!tieneIVA && !tieneISR) return { companyId, rfc: company.rfc, mesesCreados: 0, acusesParseados: 0 };

  const entity = await client.findEntityByRfc(company.rfc);
  if (!entity) return { companyId, rfc: company.rfc, mesesCreados: 0, acusesParseados: 0, error: "Sin entidad en Syntage" };

  const returns = (await client.getEntityTaxReturns(entity.id)).filter(
    (tr) => String((tr as Record<string, unknown>).intervalUnit) === "Mensual",
  );

  const decls = await prisma.taxDeclaration.findMany({
    where: { companyId, tipo: { in: ["IVA_MENSUAL", "ISR_PROVISIONAL"] } },
    select: { tipo: true, periodo: true },
  });
  const have = new Set(decls.map((d) => `${d.tipo}:${d.periodo}`));

  let mesesCreados = 0;
  let acusesParseados = 0;
  let topeAlcanzado = false;

  for (const trRaw of returns) {
    const tr = trRaw as Record<string, unknown>;
    const anio = Number(tr.fiscalYear);
    const mes = mesDePeriodo(tr.period);
    if (!Number.isFinite(anio) || !mes) continue;
    const periodo = `${anio}-${String(mes).padStart(2, "0")}`;

    const needIva = tieneIVA && !have.has(`IVA_MENSUAL:${periodo}`);
    const needIsr = tieneISR && !have.has(`ISR_PROVISIONAL:${periodo}`);
    if (!needIva && !needIsr) continue; // ya capturado → sin costo de parseo

    // Tope por corrida: cada invocación procesa un chunk acotado (evita timeouts);
    // el resto queda para la siguiente corrida (gap-fill).
    if (opts.maxAcuses != null && acusesParseados >= opts.maxAcuses) {
      topeAlcanzado = true;
      break;
    }

    const ref = fileRefDe(tr);
    if (!ref) continue;

    let acuse: AcuseMensual | null = null;
    let pdf: Uint8Array<ArrayBuffer> | null = null;
    try {
      const { data } = await client.downloadAcuse(ref);
      pdf = new Uint8Array(data); // conservar el PDF para descarga posterior
      const parsed = await parseSatDocument(Buffer.from(pdf).toString("base64"), { companyId, subtipo: "declaraciones.backfill" });
      acusesParseados++;
      if (parsed.type === "ACUSE_MENSUAL") acuse = parsed.acuseMensual;
    } catch {
      continue; // un acuse ilegible no detiene el resto
    }
    if (!acuse) continue;

    const fecha = acuse.fechaPresentacion ? new Date(acuse.fechaPresentacion) : null;
    const acusePdfNombre = `acuse-${periodo}.pdf`;
    const tieneDatosIva =
      acuse.ivaAPagar != null || acuse.ivaCausado != null || acuse.ivaAFavor != null || acuse.ivaAcreditable != null;
    const tieneDatosIsr = acuse.isrAPagar != null || acuse.isrIngresos != null;

    if (needIva && tieneDatosIva) {
      await prisma.taxDeclaration.create({
        data: {
          companyId, tipo: "IVA_MENSUAL", periodo, status: "FILED", isHistorical: true,
          ivaTrasladadoCobrado: acuse.ivaCausado, ivaAcreditableGastado: acuse.ivaAcreditable,
          ivaPagar: acuse.ivaAPagar, ivaSaldoFavor: acuse.ivaAFavor,
          ...(pdf ? { acusePdf: pdf, acusePdfNombre } : {}),
          lineaCaptura: acuse.lineaCaptura ?? null, fechaPresentacion: fecha,
        },
      });
      have.add(`IVA_MENSUAL:${periodo}`);
      mesesCreados++;
    }
    if (needIsr && tieneDatosIsr) {
      await prisma.taxDeclaration.create({
        data: {
          companyId, tipo: "ISR_PROVISIONAL", periodo, status: "FILED", isHistorical: true,
          isrIngresos: acuse.isrIngresos, isrPagar: acuse.isrAPagar,
          isrCoeficienteUtilidad: acuse.coeficienteUtilidadAplicado,
          lineaCaptura: acuse.lineaCaptura ?? null, fechaPresentacion: fecha,
          ...(pdf ? { acusePdf: pdf, acusePdfNombre } : {}),
        },
      });
      have.add(`ISR_PROVISIONAL:${periodo}`);
      mesesCreados++;
    }
  }

  return { companyId, rfc: company.rfc, mesesCreados, acusesParseados, topeAlcanzado };
}

export async function backfillAllDeclaracionesMensuales(opts: { maxAcuses?: number } = {}): Promise<{
  empresas: number;
  errores: number;
  acusesParseados: number;
  mesesCreados: number;
  /** True si se cortó por el tope: queda más por procesar (volver a llamar). */
  topeAlcanzado: boolean;
  resultados: BackfillResult[];
}> {
  const client = new SyntageClient();
  const companies = await prisma.company.findMany({ where: { isActive: true }, select: { id: true } });
  const resultados: BackfillResult[] = [];
  let errores = 0;
  let acusesParseados = 0;
  let mesesCreados = 0;
  let topeAlcanzado = false;

  for (const c of companies) {
    // Presupuesto restante de acuses para esta corrida (chunk acotado).
    const restante = opts.maxAcuses != null ? opts.maxAcuses - acusesParseados : undefined;
    if (restante != null && restante <= 0) {
      topeAlcanzado = true;
      break;
    }
    try {
      const r = await backfillDeclaracionesMensuales(c.id, client, restante != null ? { maxAcuses: restante } : {});
      if (r.error) errores++;
      acusesParseados += r.acusesParseados;
      mesesCreados += r.mesesCreados;
      if (r.topeAlcanzado) topeAlcanzado = true;
      resultados.push(r);
    } catch (e) {
      errores++;
      resultados.push({ companyId: c.id, mesesCreados: 0, acusesParseados: 0, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { empresas: companies.length, errores, acusesParseados, mesesCreados, topeAlcanzado, resultados };
}
