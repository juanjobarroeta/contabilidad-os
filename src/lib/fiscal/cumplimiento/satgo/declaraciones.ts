// ─────────────────────────────────────────────────────────────────────────────
// Declaraciones MENSUALES desde SatGo (decfiel): el SAT entrega los acuses PDF
// del periodo pedido (uno, o un ZIP «Normal_2026_Agosto.pdf»…); aquí se pasan
// por el mismo parser de Claude del onboarding (parseSatDocument) para separar
// IVA / ISR / IEPS y se persisten como TaxDeclaration FILED históricas — las
// mismas reglas que el backfill de Syntage:
//   • Gap-fill: NUNCA sobreescribe una fila capturada/calculada. Sólo crea las
//     que faltan según las obligaciones de la empresa y adjunta el PDF a las
//     que existen sin él.
//   • Sin costo si no falta nada: si el periodo ya tiene sus filas con PDF, ni
//     se descarga. Si sólo falta el PDF, se descarga y adjunta SIN parsear.
//   • Un parseo PAGADO que no se pudo leer deja filas marcador (FILED, importes
//     null, acuseParseadoAt) con el PDF, para no pagar el mismo PDF cada corrida.
// Reemplaza a syntage/declaraciones-backfill.ts cuando Syntage se apague.
// ─────────────────────────────────────────────────────────────────────────────

import JSZip from "jszip";
import { prisma } from "@/lib/prisma";
import { parseSatDocument, SatParsePagadoError, type AcuseMensual } from "@/lib/fiscal/acuse/parse";
import { SatGoClient, SatGoError } from "./client";
import { fielDeEmpresa, type FielResolver } from "./fiel";

type TipoMensual = "IVA_MENSUAL" | "ISR_PROVISIONAL" | "IEPS_MENSUAL" | "RETENCIONES_ISR";
const TIPOS: TipoMensual[] = ["IVA_MENSUAL", "ISR_PROVISIONAL", "IEPS_MENSUAL", "RETENCIONES_ISR"];

const MESES: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};
const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();

/** «Normal_2026_Agosto.pdf» → { periodo: "2026-08", tipoPago: "NORMAL" }; «2026-08…» también. null si no se reconoce. */
export function periodoDeArchivo(nombre: string): { periodo: string; tipoPago: "NORMAL" | "COMPLEMENTARIA" | null } | null {
  const base = nombre.split("/").pop() ?? nombre;
  const m1 = base.match(/(normal|complementaria)?[_\s-]*(\d{4})[_\s-]+([a-záéíóúñ]+)/i);
  if (m1 && MESES[norm(m1[3])]) {
    const tipoPago = m1[1] ? (norm(m1[1]) === "normal" ? "NORMAL" : "COMPLEMENTARIA") : null;
    return { periodo: `${m1[2]}-${String(MESES[norm(m1[3])]).padStart(2, "0")}`, tipoPago };
  }
  const m2 = base.match(/(\d{4})[-_](0[1-9]|1[0-2])\b/);
  if (m2) return { periodo: `${m2[1]}-${m2[2]}`, tipoPago: /complementaria/i.test(base) ? "COMPLEMENTARIA" : /normal/i.test(base) ? "NORMAL" : null };
  return null;
}

export interface ImportacionDeclaracionesSatGo {
  companyId: string;
  rfc?: string;
  ejercicio: number;
  mes: number;
  /**
   * completo = ya estaba todo (filas + PDF), no se descargó nada ·
   * importado = se descargó y se persistió lo que faltaba ·
   * sin_obligaciones = la empresa no tiene IVA/ISR/IEPS mensual ·
   * sin_archivo = el SAT no devolvió acuses para el periodo · error.
   */
  estado: "completo" | "importado" | "sin_obligaciones" | "sin_archivo" | "error";
  /** PDFs que trajo el SAT. */
  archivos: number;
  /** PDFs enviados a Claude (costo). */
  acusesParseados: number;
  /** Filas TaxDeclaration creadas con importes. */
  creadas: number;
  /** Filas marcador (parseo pagado ilegible). */
  marcadores: number;
  /** Filas existentes a las que se les adjuntó el PDF. */
  pdfAdjuntados: number;
  omitidos: { archivo: string; motivo: string }[];
  error?: string;
}

export interface OpcionesImportacion {
  client?: SatGoClient;
  resolveFiel?: FielResolver;
  /** Recibe cada PDF que trajo el SAT (para guardarlo en disco, inspección). */
  onArchivo?: (nombre: string, bytes: Buffer) => void;
}

interface Archivo { nombre: string; bytes: Buffer }

/** Un PDF suelto o los PDFs de un ZIP, en orden estable (Normal antes que Complementaria). */
async function archivosDe(doc: { data: Buffer; contentType: string; filename?: string }, ejercicio: number, mes: number): Promise<Archivo[]> {
  const esZip = /zip/.test(doc.contentType) || (doc.data[0] === 0x50 && doc.data[1] === 0x4b);
  if (!esZip) {
    const nombre = doc.filename?.toLowerCase().endsWith(".pdf") ? doc.filename : `acuse-${ejercicio}-${String(mes).padStart(2, "0")}.pdf`;
    return [{ nombre, bytes: doc.data }];
  }
  const zip = await JSZip.loadAsync(doc.data);
  const out: Archivo[] = [];
  for (const entrada of Object.values(zip.files)) {
    if (entrada.dir || !/\.pdf$/i.test(entrada.name)) continue;
    out.push({ nombre: entrada.name.split("/").pop() ?? entrada.name, bytes: Buffer.from(await entrada.async("uint8array")) });
  }
  return out.sort((a, b) => (/complementaria/i.test(a.nombre) ? 1 : 0) - (/complementaria/i.test(b.nombre) ? 1 : 0) || a.nombre.localeCompare(b.nombre));
}

export function filasDeAcuse(acuse: AcuseMensual, faltan: Set<TipoMensual>): { tipo: TipoMensual; data: Record<string, unknown> }[] {
  const out: { tipo: TipoMensual; data: Record<string, unknown> }[] = [];
  const tieneIva = acuse.ivaAPagar != null || acuse.ivaCausado != null || acuse.ivaAFavor != null || acuse.ivaAcreditable != null;
  const tieneIsr = acuse.isrAPagar != null || acuse.isrIngresos != null;
  const tieneIeps = acuse.iepsAPagar != null || acuse.iepsAFavor != null;
  if (faltan.has("IVA_MENSUAL") && tieneIva) {
    out.push({ tipo: "IVA_MENSUAL", data: { ivaTrasladadoCobrado: acuse.ivaCausado, ivaAcreditableGastado: acuse.ivaAcreditable, ivaPagar: acuse.ivaAPagar, ivaSaldoFavor: acuse.ivaAFavor } });
  }
  if (faltan.has("ISR_PROVISIONAL") && tieneIsr) {
    out.push({ tipo: "ISR_PROVISIONAL", data: { isrIngresos: acuse.isrIngresos, isrPagar: acuse.isrAPagar, isrCoeficienteUtilidad: acuse.coeficienteUtilidadAplicado } });
  }
  if (faltan.has("IEPS_MENSUAL") && tieneIeps) {
    out.push({ tipo: "IEPS_MENSUAL", data: { iepsPagar: acuse.iepsAPagar, iepsSaldoFavor: acuse.iepsAFavor } });
  }
  // Retenciones de nómina enteradas (salarios + asimilados): concepto propio
  // del acuse, distinto del ISR de la empresa. Vive en su fila RETENCIONES_ISR.
  if (faltan.has("RETENCIONES_ISR") && acuse.retencionesSalarios != null) {
    out.push({ tipo: "RETENCIONES_ISR", data: { retencionesIsr: acuse.retencionesSalarios } });
  }
  return out;
}

/**
 * Trae del SAT (vía SatGo) los acuses del periodo y persiste lo que falte.
 * `mes` 1–12 para un mes; 0 para el ejercicio completo (un ZIP con todos).
 */
export async function importarDeclaracionesSatGo(
  companyId: string,
  p: { ejercicio: number; mes: number },
  opts: OpcionesImportacion = {},
): Promise<ImportacionDeclaracionesSatGo> {
  const base: ImportacionDeclaracionesSatGo = {
    companyId, ejercicio: p.ejercicio, mes: p.mes, estado: "completo",
    archivos: 0, acusesParseados: 0, creadas: 0, marcadores: 0, pdfAdjuntados: 0, omitidos: [],
  };
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { rfc: true, isActive: true, obligations: { where: { activa: true }, select: { tipo: true } } },
  });
  if (!company) return { ...base, estado: "error", error: "Empresa no encontrada" };
  base.rfc = company.rfc;
  if (!company.isActive) return { ...base, estado: "error", error: "Empresa inactiva" };

  const obligadas = new Set(company.obligations.map((o) => o.tipo).filter((t): t is TipoMensual => (TIPOS as string[]).includes(t)));
  if (obligadas.size === 0) return { ...base, estado: "sin_obligaciones" };

  // Qué falta por periodo (filas y/o PDF). Sin faltantes no se descarga nada.
  const periodos = p.mes === 0
    ? Array.from({ length: 12 }, (_, i) => `${p.ejercicio}-${String(i + 1).padStart(2, "0")}`)
    : [`${p.ejercicio}-${String(p.mes).padStart(2, "0")}`];
  const existentes = await prisma.taxDeclaration.findMany({
    where: { companyId, periodo: { in: periodos }, tipo: { in: TIPOS } },
    select: { id: true, tipo: true, periodo: true, acusePdfNombre: true },
  });
  const faltanFilas = new Map<string, Set<TipoMensual>>();
  const faltaPdf = new Set<string>();
  for (const periodo of periodos) {
    const filas = existentes.filter((e) => e.periodo === periodo);
    const faltan = new Set<TipoMensual>([...obligadas].filter((t) => !filas.some((f) => f.tipo === t)));
    if (faltan.size) faltanFilas.set(periodo, faltan);
    if (filas.some((f) => !f.acusePdfNombre)) faltaPdf.add(periodo);
  }
  if (faltanFilas.size === 0 && faltaPdf.size === 0) return base;

  // Descarga. Visto en vivo (BARTIZ, 22-sep-2026): «declaracion» es el
  // formulario completo (ingresos, IVA causado/acreditable, coeficiente — lo
  // que el parser necesita, 3 s); «acuse» falló con 500 del propio SAT
  // (RecuperarArchivoPagadas) y «pago» (34 s) sólo trae importes a pagar y la
  // línea de captura. Se intenta en ese orden y se queda con el primero que
  // responda; un fallo del SAT en uno no condena a los demás.
  const client = opts.client ?? new SatGoClient();
  const resolveFiel = opts.resolveFiel ?? fielDeEmpresa;
  let archivos: Archivo[] = [];
  let ultimoError: unknown = null;
  try {
    const fiel = await resolveFiel(companyId);
    for (const tipoDocumento of ["declaracion", "acuse", "pago"] as const) {
      try {
        const doc = await client.consultarDecFiel(fiel, { ejercicio: p.ejercicio, mes: p.mes, tipoDocumento });
        archivos = await archivosDe(doc, p.ejercicio, p.mes);
        ultimoError = null;
        break;
      } catch (e) {
        ultimoError = e;
        if (!(e instanceof SatGoError)) throw e;
      }
    }
  } catch (e) {
    ultimoError = e;
  }
  if (ultimoError) {
    const e = ultimoError;
    // «Sin declaraciones» del SAT no es un fallo nuestro: el periodo no se ha presentado.
    if (e instanceof SatGoError && !e.transitorio && /no se encontr|sin declaraciones|no existen|no hay/i.test(e.message)) {
      return { ...base, estado: "sin_archivo", error: e.message };
    }
    return { ...base, estado: "error", error: e instanceof Error ? e.message : String(e) };
  }
  base.archivos = archivos.length;
  if (archivos.length === 0) return { ...base, estado: "sin_archivo" };
  for (const a of archivos) opts.onArchivo?.(a.nombre, a.bytes);

  const etiqueta = `[declaraciones-satgo] ${company.rfc}`;
  for (const archivo of archivos) {
    const meta = periodoDeArchivo(archivo.nombre);
    const periodo = meta?.periodo ?? (p.mes !== 0 ? periodos[0] : null);
    if (!periodo || !periodos.includes(periodo)) {
      base.omitidos.push({ archivo: archivo.nombre, motivo: `periodo no reconocido${periodo ? ` (${periodo} fuera de lo pedido)` : ""}` });
      continue;
    }
    const nombrePdf = `acuse-${periodo}${meta?.tipoPago === "COMPLEMENTARIA" ? "-complementaria" : ""}.pdf`;
    const faltan = faltanFilas.get(periodo);
    const pdf = new Uint8Array(archivo.bytes);

    if (faltan && faltan.size) {
      let acuse: AcuseMensual | null = null;
      let pagadoIlegible = false;
      try {
        const parsed = await parseSatDocument(archivo.bytes.toString("base64"), { companyId, subtipo: "declaraciones.satgo" });
        base.acusesParseados++;
        if (parsed.type === "ACUSE_MENSUAL" && parsed.acuseMensual) acuse = parsed.acuseMensual;
        else base.omitidos.push({ archivo: archivo.nombre, motivo: `Claude lo clasificó como ${parsed.type}` });
      } catch (e) {
        if (e instanceof SatParsePagadoError) { base.acusesParseados++; pagadoIlegible = true; }
        else { base.omitidos.push({ archivo: archivo.nombre, motivo: `parseo: ${e instanceof Error ? e.message : String(e)}` }); }
      }
      if (acuse) {
        if (acuse.periodoAnio && acuse.periodoMes && `${acuse.periodoAnio}-${String(acuse.periodoMes).padStart(2, "0")}` !== periodo) {
          console.warn(`${etiqueta}: ${archivo.nombre} dice ${acuse.periodoAnio}-${acuse.periodoMes} y el nombre ${periodo}; se usa el nombre`);
        }
        const fecha = acuse.fechaPresentacion ? new Date(acuse.fechaPresentacion) : null;
        for (const fila of filasDeAcuse(acuse, faltan)) {
          await prisma.taxDeclaration.create({
            data: {
              companyId, tipo: fila.tipo, periodo, status: "FILED", isHistorical: true,
              ...fila.data,
              lineaCaptura: acuse.lineaCaptura ?? null, fechaPresentacion: fecha,
              acusePdf: pdf, acusePdfNombre: nombrePdf, acuseParseadoAt: new Date(),
            },
          });
          faltan.delete(fila.tipo);
          base.creadas++;
        }
      } else if (pagadoIlegible) {
        for (const tipo of [...faltan]) {
          await prisma.taxDeclaration.create({
            data: { companyId, tipo, periodo, status: "FILED", isHistorical: true, acuseParseadoAt: new Date(), acusePdf: pdf, acusePdfNombre: nombrePdf },
          });
          faltan.delete(tipo);
          base.marcadores++;
        }
      }
    }

    // El mismo acuse sirve a todas las filas del periodo: se adjunta a las que no tienen PDF.
    const adj = await prisma.taxDeclaration.updateMany({
      where: { companyId, periodo, tipo: { in: TIPOS }, acusePdf: null },
      data: { acusePdf: pdf, acusePdfNombre: nombrePdf },
    });
    base.pdfAdjuntados += adj.count;
  }
  base.estado = "importado";
  return base;
}
