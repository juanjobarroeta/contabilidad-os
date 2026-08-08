// ─────────────────────────────────────────────────────────────────────────────
// Sincronización de cumplimiento desde Syntage (modo LECTURA): trae los últimos
// resultados ya extraídos (tax-compliance-check / tax-status) de la entidad y
// los persiste. Rápido (solo GETs) — no corre extracción, así que no choca con
// el timeout del proxy. La frescura la dan los schedulers de Syntage (o un kick
// aparte). El companyId→entidad se resuelve por RFC.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import { planIncluyeSyntage } from "@/lib/planes";
import { persistComplianceResult } from "../persist";
import { SyntageClient } from "./client";
import {
  mapTaxCompliance,
  mapTaxStatus,
  anualesAutoritativas, mapTaxReturnAnual,
  camposAnualDesdeAcuse,
  mergeCamposAnual,
  type CamposAnualAcuse,
} from "./map";
import { fileRefDe } from "./declaraciones-backfill";
import { parseSatDocument } from "@/lib/fiscal/acuse/parse";
import { leerEImportarContabilidadElectronicaSyntage } from "@/lib/contabilidad/ce-import-syntage";

export interface SyncOptions {
  /**
   * Fuerza el re-parseo del acuse PDF de TODAS las anuales de la empresa aunque
   * el centinela (`isrIngresos != null`) diga que ya se extrajeron — para
   * corregir filas con datos parciales/erróneos de parseos viejos. Cuesta una
   * llamada a Claude por anual con PDF: úsalo puntual (cron con companyId), no
   * en la corrida global.
   */
  reparseAnuales?: boolean;
}

export interface SyncResult {
  companyId: string;
  rfc?: string;
  opinion?: { changed: boolean; hallazgos: number } | null;
  csf?: { changed: boolean; hallazgos: number } | null;
  /**
   * Declaraciones anuales históricas creadas a partir de los tax-returns.
   * `reparse` sólo viene cuando se pidió `reparseAnuales`: un renglón por anual
   * con el resultado del re-parseo ("actualizada" | "sin_cambios" |
   * "sin_datos_extraibles" | "sin_pdf" | "tipo_inesperado: X" | "error: ...")
   * y el tamaño del PDF guardado — para distinguir el acuse corto del
   * transcript completo sin acceso a la base.
   */
  declaracionesAnuales?: {
    creadas: number;
    /** Filas ya existentes SUSTITUIDAS por una complementaria más reciente. */
    complementariasAplicadas?: number;
    reparse?: { periodo: string; resultado: string; pdfKb: number | null }[];
  } | null;
  /**
   * Arranque ÚNICO de la Contabilidad Electrónica (apertura). `importado` indica
   * si en esta corrida se importó catálogo o balanza y se fijó `ceBootstrapAt`.
   * Ausente (null) si la empresa ya estaba arrancada o no aplica.
   */
  ceBootstrap?: { importado: boolean } | null;
  error?: string;
}

/**
 * Persiste las declaraciones ANUALES extraídas (tax-returns con intervalUnit
 * "Anual") como TaxDeclaration históricas, cerrando los faltantes de años
 * cerrados en /declaraciones. Sólo RELLENA huecos: si ya existe una anual para
 * ese ejercicio (capturada o calculada), no la toca. Devuelve cuántas creó.
 *
 * Las mensuales no se importan aquí: el recurso de Syntage trae un único
 * `payment` agregado (sin separar IVA/ISR) y nuestro modelo sí los separa con
 * importes propios; crear filas mensuales sin importe ocultaría la captura real
 * (subvaluando el arrastre de pagos provisionales).
 */
/**
 * Parsea el acuse ANUAL (PDF) con Claude y rellena en la DECLARACION_ANUAL las
 * columnas del coeficiente de utilidad (ingresos nominales ÷ utilidad fiscal) y
 * el remanente de pérdidas pendiente —que el motor usa como respaldo del valor
 * manual de la empresa (computeTaxPosition)—. Best-effort y gap-fill: se llama
 * sólo cuando esas columnas están vacías, así cada anual se parsea una vez (no
 * en cada corrida del sync). No toca el campo manual de la empresa.
 */
async function enriquecerAnualDesdePdf(
  declId: string,
  companyId: string,
  pdf: Uint8Array,
  existentes: CamposAnualAcuse,
): Promise<string> {
  let parsed;
  try {
    parsed = await parseSatDocument(Buffer.from(pdf).toString("base64"), {
      companyId,
      subtipo: "declaraciones.anual.coeficiente",
    });
  } catch (e) {
    // No rompemos el sync; se reintenta la próxima corrida. El motivo viaja en
    // el detalle del reparse para no depurar a ciegas.
    return `error: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (parsed.type !== "ACUSE_ANUAL" || !parsed.acuseAnual) {
    return `tipo_inesperado: ${parsed.type}`;
  }
  const extraidos = camposAnualDesdeAcuse(parsed.acuseAnual);
  // Mezcla y no sobreescritura ciega: lo extraído no-null gana, un null extraído
  // no borra lo guardado (una pasada de Claude puede no encontrar un renglón).
  const merged = mergeCamposAnual(existentes, extraidos);
  if (!merged) {
    // Distingue "el PDF no trae nada" (acuse corto sin la tabla de pérdidas) de
    // "trae lo mismo que ya está" — cambia el diagnóstico por completo.
    const vacio = Object.values(extraidos).every((v) => v == null);
    return vacio ? "sin_datos_extraibles" : "sin_cambios";
  }
  await prisma.taxDeclaration.update({ where: { id: declId }, data: { ...merged } });
  return "actualizada";
}

async function persistDeclaracionesAnuales(
  companyId: string,
  entityId: string,
  client: SyntageClient,
  opts: SyncOptions = {},
): Promise<NonNullable<SyncResult["declaracionesAnuales"]>> {
  const returns = await client.getEntityTaxReturns(entityId);
  let creadas = 0;
  let complementariasAplicadas = 0;
  const reparse: { periodo: string; resultado: string; pdfKb: number | null }[] = [];
  // UNA declaración por ejercicio: la vigente ante el SAT (complementaria más
  // reciente si existe). Iterar todos los returns procesaba "el primero que
  // viniera" y las complementarias posteriores jamás sustituían a la normal.
  for (const { tr, anual } of anualesAutoritativas(returns)) {
    const periodo = String(anual.ejercicio);
    const existing = await prisma.taxDeclaration.findFirst({
      where: { companyId, tipo: "DECLARACION_ANUAL", periodo },
      select: {
        id: true,
        isrIngresos: true,
        isrBaseGravable: true,
        isrCoeficienteUtilidad: true,
        isrPerdidaPendiente: true,
        acusePdf: true,
        fechaPresentacion: true,
      },
    });

    // ¿La fila guardada quedó SUPERADA por una presentación más reciente
    // (complementaria)? Se detecta por fecha: la fila conserva la fecha del
    // acuse del que nació, y la autoritativa trae la de la última presentada.
    const fechaAutoritativa = anual.fechaPresentacion ? new Date(anual.fechaPresentacion) : null;
    const superada =
      existing != null &&
      fechaAutoritativa != null &&
      (existing.fechaPresentacion == null ||
        existing.fechaPresentacion.getTime() < fechaAutoritativa.getTime());

    if (existing && superada) {
      // Sustituir: bajar el PDF de la complementaria, actualizar los campos del
      // return y re-parsear — el merge deja que lo extraído no-null gane, así
      // el coeficiente y las pérdidas pasan a ser los de la última presentada.
      const ref = fileRefDe(tr as Record<string, unknown>);
      let pdf: Uint8Array<ArrayBuffer> | null = null;
      if (ref) {
        try {
          pdf = new Uint8Array((await client.downloadAcuse(ref)).data);
        } catch {
          pdf = null; // sin red: el siguiente sync reintenta (la fecha no se toca)
        }
      }
      if (pdf) {
        await prisma.taxDeclaration.update({
          where: { id: existing.id },
          data: {
            acusePdf: pdf,
            acusePdfNombre: `acuse-anual-${periodo}.pdf`,
            isrPagar: anual.isrPagar,
            lineaCaptura: anual.lineaCaptura ?? null,
            fechaPresentacion: fechaAutoritativa,
          },
        });
        const resultado = await enriquecerAnualDesdePdf(existing.id, companyId, pdf, existing);
        complementariasAplicadas++;
        if (opts.reparseAnuales) {
          reparse.push({ periodo, resultado: `complementaria: ${resultado}`, pdfKb: Math.round(pdf.byteLength / 1024) });
        }
      }
      continue;
    }

    if (existing) {
      // Gap-fill del PDF: el acuse se descargaba SOLO al crear la fila
      // (best-effort) y un fallo de descarga dejaba la anual sin PDF para
      // siempre — sin documento descargable y sin nada que parsear (caso real:
      // 2023-2025 de una empresa existían como filas pero solo 2022 tenía
      // PDF, con Syntage teniendo los tres archivos disponibles). Reintenta
      // aquí en cada sync hasta conseguirlo.
      let pdf = existing.acusePdf ? new Uint8Array(existing.acusePdf) : null;
      // Con reparse forzado también RE-descarga aunque ya haya PDF: filas
      // viejas pueden tener guardado el ack_receipt (fileRefDe tomaba "el
      // primero" de files[]) y el documento correcto es el transcript.
      if (!pdf || opts.reparseAnuales) {
        const refExistente = fileRefDe(tr as Record<string, unknown>);
        if (refExistente) {
          try {
            const bajado = new Uint8Array((await client.downloadAcuse(refExistente)).data);
            if (!pdf || bajado.byteLength !== pdf.byteLength) {
              await prisma.taxDeclaration.update({
                where: { id: existing.id },
                data: { acusePdf: bajado, acusePdfNombre: `acuse-anual-${periodo}.pdf` },
              });
              pdf = bajado;
            }
          } catch {
            // sin red no hay upgrade; se sigue con el PDF guardado (si lo hay)
            // y el siguiente sync reintenta la descarga
          }
        }
      }
      // Re-parseo cuando la anual nunca se extrajo COMPLETA: `isrIngresos` es
      // el centinela — los ingresos nominales siempre vienen en un acuse anual,
      // así que su null significa "parse nunca completado" (p. ej. la fila
      // nació del onboarding solo con coeficiente). Usar la pérdida como
      // condición re-parsearía cada sync las anuales que legítimamente no
      // tienen pérdidas. El centinela tiene un punto ciego: una fila con datos
      // PARCIALES de un parseo viejo (isrIngresos poblado con la cifra
      // equivocada) nunca se re-parsea sola — para eso está `reparseAnuales`
      // (forzado puntual desde el cron con companyId). No toca importes
      // capturados/calculados: sólo las 4 columnas del coeficiente/pérdida.
      if (pdf && (existing.isrIngresos == null || opts.reparseAnuales)) {
        const resultado = await enriquecerAnualDesdePdf(existing.id, companyId, pdf, existing);
        if (opts.reparseAnuales) {
          reparse.push({ periodo, resultado, pdfKb: Math.round(pdf.byteLength / 1024) });
        }
      } else if (opts.reparseAnuales) {
        reparse.push({ periodo, resultado: "sin_pdf", pdfKb: null });
      }
      continue;
    }

    // Acuse PDF (sólo al crear, para que sea descargable). Best-effort.
    let acusePdf: Uint8Array<ArrayBuffer> | null = null;
    const ref = fileRefDe(tr as Record<string, unknown>);
    if (ref) {
      try {
        acusePdf = new Uint8Array((await client.downloadAcuse(ref)).data);
      } catch {
        acusePdf = null;
      }
    }

    const creada = await prisma.taxDeclaration.create({
      data: {
        companyId,
        tipo: "DECLARACION_ANUAL",
        periodo,
        status: "FILED",
        isHistorical: true,
        isrPagar: anual.isrPagar,
        lineaCaptura: anual.lineaCaptura ?? null,
        fechaPresentacion: anual.fechaPresentacion ? new Date(anual.fechaPresentacion) : null,
        ...(acusePdf ? { acusePdf, acusePdfNombre: `acuse-anual-${periodo}.pdf` } : {}),
      },
      select: { id: true },
    });
    if (acusePdf) {
      await enriquecerAnualDesdePdf(creada.id, companyId, acusePdf, {
        isrIngresos: null,
        isrBaseGravable: null,
        isrCoeficienteUtilidad: null,
        isrPerdidaPendiente: null,
      });
    }
    creadas++;
  }
  return { creadas, complementariasAplicadas, ...(opts.reparseAnuales ? { reparse } : {}) };
}

export async function syncCompanyComplianceSyntage(
  companyId: string,
  client = new SyntageClient(),
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { rfc: true, tier: true, ceBootstrapAt: true },
  });
  if (!company) return { companyId, error: "Empresa no encontrada" };

  const entity = await client.findEntityByRfc(company.rfc);
  if (!entity) return { companyId, rfc: company.rfc, error: "Sin entidad en Syntage para ese RFC" };

  const [opRaw, csfRaw] = await Promise.all([
    client.getLatestTaxComplianceCheck(entity.id),
    client.getLatestTaxStatus(entity.id),
  ]);

  const opinion = opRaw
    ? await persistComplianceResult(companyId, mapTaxCompliance(opRaw))
    : null;
  const csf = csfRaw ? await persistComplianceResult(companyId, mapTaxStatus(csfRaw)) : null;

  // Declaraciones anuales: aislado en try/catch para no romper opinión/CSF si
  // los tax-returns aún no se han extraído o el recurso cambia de forma.
  let declaracionesAnuales: SyncResult["declaracionesAnuales"] = null;
  try {
    declaracionesAnuales = await persistDeclaracionesAnuales(companyId, entity.id, client, opts);
  } catch (e) {
    // En la corrida normal se degrada en silencio; con reparse explícito el
    // error viaja en la respuesta (es una corrida de diagnóstico).
    declaracionesAnuales = opts.reparseAnuales
      ? { creadas: 0, reparse: [{ periodo: "*", resultado: `error: ${e instanceof Error ? e.message : String(e)}`, pdfKb: null }] }
      : null;
  }

  // Arranque ÚNICO de la Contabilidad Electrónica (apertura). Sólo si:
  //   - el plan incluye Syntage, y
  //   - aún no se ha arrancado (`ceBootstrapAt == null`).
  // Lee+importa SIN re-disparar (el provision ya disparó `electronic_accounting`).
  // Fija `ceBootstrapAt` SÓLO si de verdad importó catálogo y/o balanza; si aún
  // no hay registros (extracción async pendiente), deja la marca null para que un
  // sync posterior reintente. Una vez fijada, NUNCA se vuelve a importar la
  // balanza del SAT como apertura (sobreescribiría el libro vivo). Aislado en
  // try/catch para no romper la sincronización de opinión/CSF.
  let ceBootstrap: { importado: boolean } | null = null;
  if (company.ceBootstrapAt == null && planIncluyeSyntage(company.tier)) {
    try {
      const ce = await leerEImportarContabilidadElectronicaSyntage(companyId, client);
      const importadas =
        (ce.catalogo?.total ?? 0) > 0 || (ce.balanza?.entries ?? 0) > 0;
      if (importadas) {
        await prisma.company.update({
          where: { id: companyId },
          data: { ceBootstrapAt: new Date() },
        });
        ceBootstrap = { importado: true };
      } else {
        ceBootstrap = { importado: false };
      }
    } catch {
      ceBootstrap = null;
    }
  }

  return {
    companyId,
    rfc: company.rfc,
    opinion: opinion && { changed: opinion.changed, hallazgos: opinion.hallazgos },
    csf: csf && { changed: csf.changed, hallazgos: csf.hallazgos },
    declaracionesAnuales,
    ceBootstrap,
  };
}

/** Sincroniza todas las empresas (una sola instancia de cliente). */
export async function syncAllCompaniesComplianceSyntage(): Promise<{
  empresas: number;
  errores: number;
  resultados: SyncResult[];
}> {
  const client = new SyntageClient();
  const companies = await prisma.company.findMany({ select: { id: true } });
  const resultados: SyncResult[] = [];
  let errores = 0;
  for (const c of companies) {
    try {
      const r = await syncCompanyComplianceSyntage(c.id, client);
      if (r.error) errores++;
      resultados.push(r);
    } catch (e) {
      errores++;
      resultados.push({ companyId: c.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { empresas: companies.length, errores, resultados };
}
