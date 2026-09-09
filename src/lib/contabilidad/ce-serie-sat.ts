// ─────────────────────────────────────────────────────────────────────────────
// La serie mensual de balanzas presentadas, bajada del SAT con e.firma
// (navegador). Sibling de importarSerieBalanzasSyntage: MISMA persistencia
// (balanzaASerie + guardarBalanzaMes de ce-serie.ts), otra fuente. Es el
// reemplazo de Syntage para CeBalanzaMes — costo marginal ~$0, sin cuota por RFC.
//
// Una sola sesión del buzón cubre todos los años. Idempotente: salta períodos ya
// guardados salvo `force` (para pisar una complementaria). Dentro de un año, la
// balanza complementaria (BC) le gana a la normal (BN) del mismo período.
// ─────────────────────────────────────────────────────────────────────────────
import { prisma } from "../prisma";
import { balanzaASerie, guardarBalanzaMes, type ImportarSerieResult } from "./ce-serie";
import { abrirBuzonSat, getFielBytes } from "@/lib/sat-portal/buzon-playwright";
import { descargarCeAnioSat, type CeXml } from "./ce-descarga-sat";

export interface ImportarSerieSatOpts {
  /** Años a bajar. Por defecto: año actual + 4 anteriores (el SAT sirve ~5 años). */
  anios?: number[];
  /** Re-descarga y reemplaza períodos ya guardados (p.ej. tras una complementaria). */
  force?: boolean;
  log?: (msg: string) => void;
}

export async function importarSerieBalanzasSat(
  companyId: string,
  opts: ImportarSerieSatOpts = {},
): Promise<ImportarSerieResult> {
  const log = opts.log ?? (() => {});
  const anios = opts.anios ?? aniosPorDefecto();
  const fiel = await getFielBytes(companyId);

  const yaGuardados = new Set(
    (await prisma.ceBalanzaMes.groupBy({ by: ["anio", "mes"], where: { companyId } })).map(
      (g) => `${g.anio}-${g.mes}`,
    ),
  );

  const result: ImportarSerieResult = { periodos: [], importados: 0 };

  await abrirBuzonSat(
    fiel,
    async (page) => {
      for (const anio of anios) {
        log(`balanzas ${anio}…`);
        const xmls = await descargarCeAnioSat(page, { anio, tipoArchivo: "2" }).catch((e) => {
          log(`año ${anio} falló: ${String(e).slice(0, 80)}`);
          return [] as CeXml[];
        });

        // Una fila por período; la complementaria (BC) pisa a la normal (BN).
        const porPeriodo = new Map<string, CeXml>();
        for (const x of xmls) {
          if (x.tipo !== "B") continue;
          const k = `${x.anio}-${x.mes}`;
          const esComp = /BC\.xml$/i.test(x.nombre);
          if (!porPeriodo.has(k) || esComp) porPeriodo.set(k, x);
        }

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

  return result;
}

/** Año actual + 4 anteriores (el SAT sólo sirve ~5 años de CE). */
function aniosPorDefecto(): number[] {
  const y = new Date().getUTCFullYear();
  return [y, y - 1, y - 2, y - 3, y - 4];
}
