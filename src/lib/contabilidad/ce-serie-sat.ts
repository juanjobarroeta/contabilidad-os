// ─────────────────────────────────────────────────────────────────────────────
// La Contabilidad Electrónica presentada, bajada del SAT con e.firma
// (navegador). Sibling de importarSerieBalanzasSyntage: MISMA persistencia de
// balanzas (balanzaASerie + guardarBalanzaMes de ce-serie.ts), otra fuente. Es
// el reemplazo de Syntage para CE — costo marginal ~$0, sin cuota por RFC.
//
// NO SE DESCARTA NADA: se piden todos los tipos de archivo y cada XML que baja
// (balanzas BN/BC, catálogo CT, pólizas PL, auxiliares XF/XC) queda en
// CeArchivo tal cual. De ahí se derivan:
//   · CeBalanzaMes — la serie de balanzas (la complementaria BC le gana a la
//     normal BN del mismo período).
//   · ChartAccount — el catálogo de cuentas MÁS RECIENTE presentado, con
//     importarCatalogo (upsert idempotente). Antes el CT se bajaba y se tiraba.
//
// Una sola sesión del buzón cubre todos los años. Idempotente: salta balanzas
// ya guardadas salvo `force`; un archivo idéntico (mismo hash) no se reescribe.
// ─────────────────────────────────────────────────────────────────────────────
import { createHash } from "node:crypto";
import { prisma } from "../prisma";
import { balanzaASerie, guardarBalanzaMes, type ImportarSerieResult } from "./ce-serie";
import { importarCatalogo, type ImportarCatalogoResult } from "./ce-import-apply";
import { abrirBuzonSat, getFielBytes } from "../sat-portal/buzon-playwright";
import { descargarCeAnioSat, type CeXml } from "./ce-descarga-sat";

export interface ImportarSerieSatOpts {
  /** Años a bajar. Por defecto: año actual + 4 anteriores (el SAT sirve ~5 años). */
  anios?: number[];
  /** Re-descarga y reemplaza balanzas ya guardadas (p.ej. tras una complementaria). */
  force?: boolean;
  log?: (msg: string) => void;
}

export interface ImportarCeSatResult extends ImportarSerieResult {
  /** XML guardados en CeArchivo por primera vez (o con contenido distinto). */
  archivosNuevos: number;
  /** El catálogo aplicado a ChartAccount en esta corrida, si había uno nuevo. */
  catalogo: (ImportarCatalogoResult & { anio: number; mes: number; nombre: string }) | null;
}

export const hashXml = (xml: string) => createHash("sha256").update(xml).digest("hex");

/** Una balanza por período; la complementaria (BC) pisa a la normal (BN). */
export function balanzaPorPeriodo(xmls: CeXml[]): Map<string, CeXml> {
  const porPeriodo = new Map<string, CeXml>();
  for (const x of xmls) {
    if (x.tipo !== "B") continue;
    const k = `${x.anio}-${x.mes}`;
    const esComp = /BC\.xml$/i.test(x.nombre);
    if (!porPeriodo.has(k) || esComp) porPeriodo.set(k, x);
  }
  return porPeriodo;
}

/** El catálogo más reciente (año, mes; a igualdad, el último nombre). */
export function catalogoMasReciente<T extends { anio: number; mes: number; nombre: string }>(cts: T[]): T | null {
  let mejor: T | null = null;
  for (const c of cts) {
    if (!mejor || c.anio * 100 + c.mes > mejor.anio * 100 + mejor.mes || (c.anio * 100 + c.mes === mejor.anio * 100 + mejor.mes && c.nombre > mejor.nombre)) {
      mejor = c;
    }
  }
  return mejor;
}

export async function importarSerieBalanzasSat(companyId: string, opts: ImportarSerieSatOpts = {}): Promise<ImportarCeSatResult> {
  const log = opts.log ?? (() => {});
  const anios = opts.anios ?? aniosPorDefecto();
  const fiel = await getFielBytes(companyId);

  const yaGuardados = new Set(
    (await prisma.ceBalanzaMes.groupBy({ by: ["anio", "mes"], where: { companyId } })).map((g) => `${g.anio}-${g.mes}`),
  );
  const hashes = new Map(
    (await prisma.ceArchivo.findMany({ where: { companyId }, select: { nombre: true, hash: true } })).map((a) => [a.nombre, a.hash]),
  );

  const result: ImportarCeSatResult = { periodos: [], importados: 0, registros: 0, balanzas: 0, archivosNuevos: 0, catalogo: null };

  await abrirBuzonSat(
    fiel,
    async (page) => {
      for (const anio of anios) {
        log(`CE ${anio}…`);
        // "0" = todos los tipos: balanzas, catálogo, pólizas y auxiliares.
        const xmls = await descargarCeAnioSat(page, { anio, tipoArchivo: "0" }).catch((e) => {
          log(`año ${anio} falló: ${String(e).slice(0, 80)}`);
          return [] as CeXml[];
        });
        result.registros += xmls.length;

        // 1. Todo al archivo, tal cual.
        for (const x of xmls) {
          const hash = hashXml(x.xml);
          if (hashes.get(x.nombre) === hash) continue;
          await prisma.ceArchivo.upsert({
            where: { companyId_nombre: { companyId, nombre: x.nombre } },
            // Contenido distinto con el mismo nombre (reenvío): se reemplaza y,
            // si es catálogo, se vuelve a aplicar.
            update: { xml: x.xml, hash, anio: x.anio, mes: x.mes, tipo: x.codigo, importadoEn: null },
            create: { companyId, nombre: x.nombre, xml: x.xml, hash, anio: x.anio, mes: x.mes, tipo: x.codigo },
          });
          hashes.set(x.nombre, hash);
          result.archivosNuevos++;
        }

        // 2. Balanzas → CeBalanzaMes.
        const porPeriodo = balanzaPorPeriodo(xmls);
        result.balanzas += xmls.filter((x) => x.tipo === "B").length;
        for (const [k, x] of porPeriodo) {
          if (!opts.force && yaGuardados.has(k)) {
            result.periodos.push({ anio: x.anio, mes: x.mes, filas: 0, accion: "ya estaba" });
            continue;
          }
          const serie = balanzaASerie(x.xml);
          if (!serie) {
            result.periodos.push({ anio: x.anio, mes: x.mes, filas: 0, accion: "sin documento" });
            continue;
          }
          const filas = await guardarBalanzaMes(companyId, serie);
          yaGuardados.add(k);
          result.periodos.push({ anio: serie.anio, mes: serie.mes, filas, accion: "importado" });
          result.importados++;
        }
      }
    },
    { log },
  );

  result.catalogo = await aplicarCatalogoMasReciente(companyId, log);
  return result;
}

/**
 * Aplica a ChartAccount el catálogo (CT) más reciente guardado, si todavía no se
 * aplicó. Sirve también sin navegador: re-aplica lo que ya está en CeArchivo.
 */
export async function aplicarCatalogoMasReciente(
  companyId: string,
  log: (msg: string) => void = () => {},
): Promise<ImportarCeSatResult["catalogo"]> {
  const cts = await prisma.ceArchivo.findMany({
    where: { companyId, tipo: "CT" },
    select: { id: true, anio: true, mes: true, nombre: true, importadoEn: true },
  });
  const ultimo = catalogoMasReciente(cts);
  if (!ultimo || ultimo.importadoEn) return null;
  const arch = await prisma.ceArchivo.findUnique({ where: { id: ultimo.id }, select: { xml: true } });
  if (!arch) return null;
  const r = await importarCatalogo(companyId, arch.xml);
  await prisma.ceArchivo.update({ where: { id: ultimo.id }, data: { importadoEn: new Date() } });
  log(`catálogo ${ultimo.nombre}: ${r.total} cuentas (${r.creadas} nuevas)`);
  return { ...r, anio: ultimo.anio, mes: ultimo.mes, nombre: ultimo.nombre };
}

/** Año actual + 4 anteriores (el SAT sólo sirve ~5 años de CE). */
function aniosPorDefecto(): number[] {
  const y = new Date().getUTCFullYear();
  return [y, y - 1, y - 2, y - 3, y - 4];
}
