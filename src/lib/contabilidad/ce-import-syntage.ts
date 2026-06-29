// ─────────────────────────────────────────────────────────────────────────────
// Importación AUTOMÁTICA de Contabilidad Electrónica (Anexo 24) desde Syntage.
//
// Sustituye la subida manual de XML: Syntage expone el extractor
// `electronic_accounting`, que descarga del SAT los XML de la Contabilidad
// Electrónica (catálogo de cuentas, balanza de comprobación, pólizas). Aquí:
//
//   1. Resolvemos la entidad de Syntage por RFC (mismo patrón que el sync).
//   2. Disparamos la extracción `electronic_accounting` sobre el periodo
//      (idempotente: Syntage acumula registros; el disparo sólo refresca) y
//      registramos su CostEvent (gating por plan, igual que las demás).
//   3. Leemos los registros ya extraídos (electronic-accounting-records),
//      tomamos el catálogo (fileType "CT") y la ÚLTIMA balanza (fileType "B"),
//      descargamos sus XML y los pasamos a importarCatalogo / importarBalanza
//      (#289 — parsers + persistencia idempotente vía postApertura, que NUNCA
//      toca asientos CFDI/NOMINA/BANCO/MANUAL).
//
// Best-effort: si Syntage no tiene aún el dato (extracción async), devolvemos un
// resultado vacío sin romper. No se reimplementa parseo ni aritmética contable.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import { recordSyntageExtraction } from "@/lib/costos/record";
import { planIncluyeSyntage } from "@/lib/planes";
import { SyntageClient } from "@/lib/fiscal/cumplimiento/syntage/client";
import { importarCatalogo, importarBalanza } from "./ce-import-apply";

type Json = Record<string, unknown>;

export interface ImportarCeSyntageResult {
  companyId: string;
  rfc?: string;
  /** La extracción `electronic_accounting` se disparó (cobrada como CostEvent). */
  extraccionDisparada: boolean;
  catalogo: Awaited<ReturnType<typeof importarCatalogo>> | null;
  balanza: Awaited<ReturnType<typeof importarBalanza>> | null;
  /** Periodo (year/month) de la balanza importada, si la hubo. */
  balanzaPeriodo?: { anio: number; mes: number } | null;
  skipped?: boolean;
  error?: string;
}

/** Año/mes de un registro de Contabilidad Electrónica (orden cronológico). */
function periodoDe(rec: Json): { anio: number; mes: number } {
  return { anio: Number(rec.year ?? 0), mes: Number(rec.month ?? 0) };
}
function masReciente(a: Json, b: Json): Json {
  const pa = periodoDe(a);
  const pb = periodoDe(b);
  if (pa.anio !== pb.anio) return pa.anio > pb.anio ? a : b;
  return pa.mes >= pb.mes ? a : b;
}

/**
 * Primera referencia descargable (`@id` de un `/files/{id}`) de un registro de
 * Contabilidad Electrónica. Los XML del SAT vienen como `text/xml`; preferimos
 * ése y caemos al primer archivo disponible.
 */
function fileRefDe(rec: Json): string | null {
  const files = Array.isArray(rec.files) ? (rec.files as Json[]) : [];
  if (files.length === 0) return null;
  const xml = files.find((f) => String(f.mimeType ?? "").toLowerCase().includes("xml"));
  const elegido = xml ?? files[0];
  const id = elegido["@id"] ?? elegido.id;
  return id ? String(id) : null;
}

/**
 * LEE de Syntage los registros de Contabilidad Electrónica ya extraídos
 * (`electronic-accounting-records`) e importa el catálogo + la ÚLTIMA balanza
 * SIN DISPARAR una nueva extracción. Es la mitad "lectura + importación" del
 * flujo: la usa el arranque automático del sync (que NO debe re-disparar, sólo
 * cosechar lo que el provision ya pidió) y también la ruta manual tras disparar.
 *
 * Idempotente, best-effort y gateado por plan (AUTOMATIZADO+). Si Syntage aún no
 * tiene registros (extracción async pendiente), devuelve catálogo/balanza nulos
 * sin romper, para que un sync posterior reintente. No reimplementa parseo ni
 * aritmética contable: reutiliza por completo importarCatalogo / importarBalanza.
 */
export async function leerEImportarContabilidadElectronicaSyntage(
  companyId: string,
  client = new SyntageClient(),
): Promise<ImportarCeSyntageResult> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { rfc: true, tier: true },
  });
  if (!company) return { companyId, extraccionDisparada: false, catalogo: null, balanza: null, error: "Empresa no encontrada" };

  // Gating por plan: misma regla que el resto de extracciones Syntage.
  if (!planIncluyeSyntage(company.tier)) {
    return { companyId, rfc: company.rfc, extraccionDisparada: false, catalogo: null, balanza: null, skipped: true };
  }

  const entity = await client.findEntityByRfc(company.rfc);
  if (!entity) {
    return { companyId, rfc: company.rfc, extraccionDisparada: false, catalogo: null, balanza: null, error: "Sin entidad en Syntage para ese RFC" };
  }

  // Lee los registros ya extraídos y separa catálogo (CT) vs balanza (B).
  const records = await client.getEntityElectronicAccounting(entity.id);
  const catalogos = records.filter((r) => String(r.fileType ?? "") === "CT");
  const balanzas = records.filter((r) => String(r.fileType ?? "") === "B");

  // Catálogo primero (la balanza necesita el catálogo para resolver naturalezas).
  let catalogo: ImportarCeSyntageResult["catalogo"] = null;
  if (catalogos.length > 0) {
    const rec = catalogos.reduce(masReciente);
    const ref = fileRefDe(rec);
    if (ref) {
      const xml = await client.downloadFileText(ref);
      catalogo = await importarCatalogo(companyId, xml);
    }
  }

  // ÚLTIMA balanza → saldos de apertura (usar "final" por defecto, como la ruta
  // manual: el SaldoFin del último mes presentado = apertura del siguiente).
  let balanza: ImportarCeSyntageResult["balanza"] = null;
  let balanzaPeriodo: { anio: number; mes: number } | null = null;
  if (balanzas.length > 0) {
    const rec = balanzas.reduce(masReciente);
    const ref = fileRefDe(rec);
    if (ref) {
      const xml = await client.downloadFileText(ref);
      balanza = await importarBalanza(companyId, xml, { usar: "final" });
      balanzaPeriodo = periodoDe(rec);
    }
  }

  return {
    companyId,
    rfc: company.rfc,
    extraccionDisparada: false,
    catalogo,
    balanza,
    balanzaPeriodo,
  };
}

/**
 * Importa la Contabilidad Electrónica de una empresa directamente desde Syntage,
 * DISPARANDO primero la extracción del periodo (refresco/force) y leyendo +
 * importando enseguida lo que ya esté disponible. La usa el botón manual ("Traer
 * de Syntage automáticamente"). Idempotente, best-effort y gateado por plan.
 * Registra el costo del disparo. Delega la lectura+importación en
 * `leerEImportarContabilidadElectronicaSyntage` (sin reimplementarla).
 */
export async function importarContabilidadElectronicaSyntage(
  companyId: string,
  periodo: { from: string; to: string },
  client = new SyntageClient(),
): Promise<ImportarCeSyntageResult> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { rfc: true, tier: true },
  });
  if (!company) return { companyId, extraccionDisparada: false, catalogo: null, balanza: null, error: "Empresa no encontrada" };

  // Gating por plan: misma regla que el resto de extracciones Syntage.
  if (!planIncluyeSyntage(company.tier)) {
    return { companyId, rfc: company.rfc, extraccionDisparada: false, catalogo: null, balanza: null, skipped: true };
  }

  const entity = await client.findEntityByRfc(company.rfc);
  if (!entity) {
    return { companyId, rfc: company.rfc, extraccionDisparada: false, catalogo: null, balanza: null, error: "Sin entidad en Syntage para ese RFC" };
  }

  // Dispara la extracción del periodo (refresca registros). El resultado es
  // async; igualmente leemos enseguida lo que YA esté disponible. Si el disparo
  // falla (cuota/credencial), seguimos en modo lectura.
  let extraccionDisparada = false;
  try {
    await client.createExtraction({
      extractor: "electronic_accounting",
      entity: entity.id,
      options: { period: { from: periodo.from, to: periodo.to } },
    });
    extraccionDisparada = true;
    void recordSyntageExtraction("electronic_accounting", { companyId });
  } catch {
    extraccionDisparada = false;
  }

  // Lectura + importación (reutilizada). Conservamos el estado del disparo.
  const importado = await leerEImportarContabilidadElectronicaSyntage(companyId, client);
  return { ...importado, extraccionDisparada };
}
