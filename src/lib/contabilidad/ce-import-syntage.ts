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
import { descargarXmlDeRef } from "@/lib/fiscal/cumplimiento/syntage/descarga-xml";
import { importarCatalogo, importarBalanza } from "./ce-import-apply";
import { parseCatalogoCuentas } from "./ce-import";

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
export function periodoDe(rec: Json): { anio: number; mes: number } {
  return { anio: Number(rec.year ?? 0), mes: Number(rec.month ?? 0) };
}
export function masReciente(a: Json, b: Json): Json {
  const pa = periodoDe(a);
  const pb = periodoDe(b);
  if (pa.anio !== pb.anio) return pa.anio > pb.anio ? a : b;
  return pa.mes >= pb.mes ? a : b;
}

// Cada registro de Contabilidad Electrónica trae CUATRO archivos: acuse de
// recibo (PDF), acuse de procesamiento (PDF), el documento del SAT (XML) y el
// SELLO DIGITAL — que también es XML. Elegir "el primer archivo con mimeType
// xml" es una apuesta al orden del arreglo: si el sello viene primero, se
// descarga `<SelloDigitalContElec>`, que no tiene una sola cuenta, el parser
// devuelve 0 y el arranque reporta vacío sin error. Ése es el modo de falla
// que dejó a MARGOM con 69 registros en Syntage y la apertura en cero.
//
// Aquí no se adivina el orden ni el nombre: se descartan los PDF, se prueban
// los XML restantes y se acepta el primero cuyo CONTENIDO sea el documento que
// se está importando. Verificar el contenido es lo único que no depende de
// cómo Syntage acomode o nombre los archivos.

export interface CandidatoXml {
  ref: string;
  nombre: string;
}

/** Refs XML descargables del registro (los acuses son PDF y quedan fuera). */
export function refsXmlDe(rec: Json): CandidatoXml[] {
  const files = Array.isArray(rec.files) ? (rec.files as Json[]) : [];
  return files
    .filter((f) => {
      const huella = `${f.mimeType ?? ""} ${f.filename ?? ""} ${f.extension ?? ""}`.toLowerCase();
      return !huella.includes("pdf");
    })
    .map((f) => ({
      ref: String(f["@id"] ?? f.id ?? ""),
      nombre: String(f.filename ?? f.id ?? ""),
    }))
    .filter((c) => c.ref !== "");
}

/**
 * ¿Este XML es el documento que buscamos? El sello digital comparte RFC y
 * namespace de ContabilidadE con la balanza, así que se descarta por su raíz
 * y el documento se confirma por la suya (`…:Catalogo` / `…:Balanza`).
 */
export function esDocumentoCe(xml: string, tipo: "CT" | "B"): boolean {
  if (/SelloDigitalContElec/i.test(xml)) return false;
  return tipo === "CT" ? /<[A-Za-z0-9]*:?Catalogo\b/i.test(xml) : /<[A-Za-z0-9]*:?Balanza\b/i.test(xml);
}

/** Descarga el primer XML del registro cuyo contenido sea el documento pedido. */
export async function descargarDocumentoCe(
  client: { downloadAcuse(ref: string): Promise<{ data: ArrayBuffer }> },
  rec: Json,
  tipo: "CT" | "B",
): Promise<{ xml: string; nombre: string } | null> {
  for (const cand of refsXmlDe(rec)) {
    const xml = await descargarXmlDeRef(client, cand.ref);
    if (esDocumentoCe(xml, tipo)) return { xml, nombre: cand.nombre };
    console.warn(`[ce-syntage] ${cand.nombre}: no es el documento ${tipo}; probando el siguiente`);
  }
  return null;
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
    // descargarXmlDeRef abre el .zip si el SAT lo entregó comprimido.
    const doc = await descargarDocumentoCe(client, rec, "CT");
    if (doc) {
      catalogo = await importarCatalogo(companyId, doc.xml);
      console.info(`[ce-syntage] ${companyId} catálogo ${doc.nombre}: ${catalogo?.total ?? 0} cuentas`);
    } else {
      console.error(`[ce-syntage] ${companyId}: ningún archivo del registro CT es el catálogo`);
    }
  }

  // ÚLTIMA balanza → saldos de apertura (usar "final" por defecto, como la ruta
  // manual: el SaldoFin del último mes presentado = apertura del siguiente).
  let balanza: ImportarCeSyntageResult["balanza"] = null;
  let balanzaPeriodo: { anio: number; mes: number } | null = null;
  if (balanzas.length > 0) {
    const rec = balanzas.reduce(masReciente);
    const doc = await descargarDocumentoCe(client, rec, "B");
    if (doc) {
      balanza = await importarBalanza(companyId, doc.xml, { usar: "final" });
      balanzaPeriodo = periodoDe(rec);
      console.info(
        `[ce-syntage] ${companyId} balanza ${balanzaPeriodo.anio}-${balanzaPeriodo.mes} ` +
          `${doc.nombre}: ${balanza?.entries ?? 0} asientos`,
      );
    } else {
      console.error(`[ce-syntage] ${companyId}: ningún archivo del registro B es la balanza`);
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
export interface RellenoNombresResult {
  companyId: string;
  rfc?: string;
  /** Cuántas cuentas tenían el código por nombre al empezar. */
  sinNombreAntes: number;
  /** Cuántas se nombraron con este barrido. */
  nombradas: number;
  /** Las que siguen sin nombre real: no aparecen con Desc en ningún catálogo. */
  siguenSinNombre: string[];
  /** Catálogos leídos, del más nuevo al más viejo. */
  catalogosLeidos: Array<{ periodo: string; cuentasConDesc: number; nombro: number }>;
  error?: string;
}

/**
 * Rellena el NOMBRE de las cuentas que se quedaron con su propio código.
 *
 * POR QUÉ EXISTE. `leerEImportarContabilidadElectronicaSyntage` importa sólo el
 * catálogo MÁS RECIENTE (`catalogos.reduce(masReciente)`) y descarta los demás
 * —MARGOM tiene 27—. Si la cuenta no venía con `Desc` en ése, se quedó con el
 * código de nombre para siempre. Y una cuenta sin nombre real rompe cualquier
 * conciliación por familia: manda dinero bien contabilizado al bucket «sin
 * explicar». Medido: 16 cuentas así, `1301-0028-0000` con $6.98M.
 *
 * SÓLO ACTUALIZA, NUNCA CREA, y eso es deliberado. El plan de cuentas cambió en
 * 2024-10: antes se presentaba con el código agrupador del SAT (inventario =
 * `115`) y desde entonces con la numeración propia (`1301-0000-0000`). Leer los
 * catálogos viejos para CREAR cuentas duplicaría el catálogo bajo dos
 * numeraciones. Aquí sólo se pega el nombre sobre cuentas que ya existen, así
 * que da igual de qué generación venga el archivo.
 *
 * Va del catálogo más NUEVO al más viejo y se detiene en cuanto no queda nada
 * por nombrar: el nombre vigente gana, y no se bajan 27 XML para nada.
 */
export async function rellenarNombresDeCuentas(
  companyId: string,
  client: SyntageClient,
  opts: { maxCatalogos?: number } = {},
): Promise<RellenoNombresResult> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { rfc: true, tier: true },
  });
  if (!company) return { companyId, sinNombreAntes: 0, nombradas: 0, siguenSinNombre: [], catalogosLeidos: [], error: "Empresa no encontrada" };

  const base = { companyId, rfc: company.rfc };
  const entity = await client.findEntityByRfc(company.rfc);
  if (!entity) {
    return { ...base, sinNombreAntes: 0, nombradas: 0, siguenSinNombre: [], catalogosLeidos: [], error: "Sin entidad en Syntage para ese RFC" };
  }

  // Las que traen el código por nombre. Para una cuenta sin subcuenta el código
  // es `cuentaSAT` (los códigos con guiones no llevan punto, así que no se
  // descomponen); con subcuenta, el código es la subcuenta.
  const cuentas = await prisma.chartAccount.findMany({
    where: { companyId },
    select: { id: true, cuentaSAT: true, subcuenta: true, nombre: true },
  });
  const pendientes = new Map<string, { id: string; codigo: string }>();
  for (const c of cuentas) {
    const codigo = c.subcuenta ?? c.cuentaSAT;
    if (c.nombre.trim() === codigo.trim()) pendientes.set(codigo.trim(), { id: c.id, codigo: codigo.trim() });
  }
  const sinNombreAntes = pendientes.size;
  if (sinNombreAntes === 0) {
    return { ...base, sinNombreAntes: 0, nombradas: 0, siguenSinNombre: [], catalogosLeidos: [] };
  }

  const entityId = String((entity as Json).id ?? "");
  const records = await client.getEntityElectronicAccounting(entityId);
  const catalogos = records
    .filter((r) => String((r as Json).fileType ?? "") === "CT")
    .sort((a, b) => {
      const pa = periodoDe(a as Json);
      const pb = periodoDe(b as Json);
      return pb.anio - pa.anio || pb.mes - pa.mes; // más nuevo primero
    });

  const catalogosLeidos: RellenoNombresResult["catalogosLeidos"] = [];
  let nombradas = 0;
  const tope = opts.maxCatalogos ?? 40;

  for (const rec of catalogos.slice(0, tope)) {
    if (pendientes.size === 0) break;
    const doc = await descargarDocumentoCe(client, rec as Json, "CT");
    if (!doc) continue;
    const { cuentas: delXml } = parseCatalogoCuentas(doc.xml);
    const conDesc = delXml.filter((c) => c.desc.trim() !== "");
    let nombroAqui = 0;
    for (const c of conDesc) {
      const pend = pendientes.get(c.numCta.trim());
      if (!pend) continue;
      await prisma.chartAccount.update({ where: { id: pend.id }, data: { nombre: c.desc.trim() } });
      pendientes.delete(pend.codigo);
      nombroAqui++;
      nombradas++;
    }
    const p = periodoDe(rec as Json);
    catalogosLeidos.push({
      periodo: `${p.anio}-${String(p.mes).padStart(2, "0")}`,
      cuentasConDesc: conDesc.length,
      nombro: nombroAqui,
    });
  }

  return {
    ...base,
    sinNombreAntes,
    nombradas,
    // Éstas no aparecen con descripción en NINGÚN catálogo presentado: hay que
    // preguntarle al contador, no seguir barriendo.
    siguenSinNombre: [...pendientes.keys()].sort(),
    catalogosLeidos,
  };
}

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
