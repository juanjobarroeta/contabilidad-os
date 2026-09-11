// ─────────────────────────────────────────────────────────────────────────────
// Sincronización de la jurisprudencia de la SCJN con la base (F1).
//
// Recorre las páginas de ids del API (descendentes: lo más nuevo primero),
// baja el detalle de las tesis que no conoce, filtra por Época, normaliza,
// embebe por lotes y las guarda como FiscalDocument (source TESIS) + chunks.
//
// Tres modos:
//   - "nuevas"    → semanal: se detiene en la primera página sin ids que no
//                   haya visto (todo lo de abajo ya está).
//   - "faltantes" → carga inicial REANUDABLE: recorre todas las páginas pero
//                   sólo baja los ids que no ha visto (un redeploy a media
//                   carga no repite nada).
//   - "completo"  → pase de correcciones: baja todo y sólo re-embebe lo que
//                   cambió de huella.
// SjfTesisVista recuerda CADA tesis vista (también las de Épocas que no se
// ingieren) con su huella, para no volver a bajar lo que ya se decidió.
// ─────────────────────────────────────────────────────────────────────────────

import { randomUUID } from "crypto";
import { prisma } from "../../prisma";
import { embedTexts, toVectorLiteral } from "../embed";
import type { ClienteSjf } from "./cliente";
import { claveTesis, normalizarTesis, type TesisNormalizada, type TesisSjf } from "./normalizar";

export interface OpcionesSync {
  cliente: ClienteSjf;
  /** Épocas cortas a ingerir («9a.», «10a.», «11a.», «12a.»). Vacío = todas. */
  epocas?: ReadonlySet<string>;
  modo?: "nuevas" | "faltantes" | "completo";
  paginaInicio?: number;
  maxPaginas?: number;
  sizePagina?: number;
  /** Tesis por lote de descarga + embedding + transacción. */
  lote?: number;
  /** Peticiones simultáneas dentro de la página del navegador. */
  concurrencia?: number;
  log?: (msg: string) => void;
  /** Sin base de datos: entrega cada tesis descargada y no guarda nada (pruebas locales). */
  soloDescarga?: (t: TesisSjf) => void;
}

export interface ResumenSync {
  paginas: number;
  idsVistos: number;
  descargadas: number;
  ingeridas: number;
  actualizadas: number;
  sinCambios: number;
  saltadasEpoca: number;
  fallidas: number;
  ms: number;
  porEpoca: Record<string, number>;
}

function trozos<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** Huella conocida por registro (SjfTesisVista). */
async function vistas(registros: string[]): Promise<Map<string, { huella: string; ingerida: boolean }>> {
  if (registros.length === 0) return new Map();
  const rows = await prisma.sjfTesisVista.findMany({ where: { registro: { in: registros } }, select: { registro: true, huella: true, ingerida: true } });
  return new Map(rows.map((r) => [r.registro, { huella: r.huella, ingerida: r.ingerida }]));
}

/**
 * Inserta (o reemplaza) un lote de tesis: un solo llamado de embeddings para
 * todos los chunks del lote y una transacción. Una tesis cambiada se
 * reemplaza entera: no hay «versiones» de una tesis, hay correcciones.
 */
export async function insertarTesisLote(lista: TesisNormalizada[]): Promise<number> {
  if (lista.length === 0) return 0;
  const textos = lista.flatMap((t) => t.chunks.map((c) => c.texto));
  const embeddings = await embedTexts(textos, { companyId: null, subtipo: "kb.sjf.embed" });
  let k = 0;
  await prisma.$transaction(
    async (tx) => {
      for (const t of lista) {
        await tx.$executeRaw`DELETE FROM "FiscalDocument" WHERE "clave" = ${t.clave}`;
        const documentId = randomUUID();
        await tx.$executeRaw`
          INSERT INTO "FiscalDocument"
            ("id", "source", "clave", "titulo", "url", "publicadoDof", "vigenciaDesde", "vigenciaHasta", "hash", "createdAt",
             "materias", "ambito", "entidad",
             "registro", "numeroTesis", "epoca", "instancia", "organo", "tipoCriterio", "estadoCriterio", "fechaPublicacion")
          VALUES
            (${documentId}, 'TESIS'::"FiscalSource", ${t.clave}, ${t.titulo}, ${t.url}, ${t.fechaPublicacion}, ${t.vigenciaDesde}, NULL, ${t.hash}, NOW(),
             ${t.materias}::text[], 'FEDERAL'::"AmbitoJuridico", NULL,
             ${t.registro}, ${t.numeroTesis}, ${t.epoca}, ${t.instancia}, ${t.organo},
             ${t.tipoCriterio}::"TipoCriterio", ${t.estadoCriterio}::"EstadoCriterio", ${t.fechaPublicacion})`;
        for (const c of t.chunks) {
          await tx.$executeRaw`
            INSERT INTO "FiscalChunk"
              ("id", "documentId", "articulo", "parte", "contexto", "texto", "embedding", "vigenciaDesde", "vigenciaHasta", "regimenes")
            VALUES
              (${randomUUID()}, ${documentId}, ${t.registro}, ${c.parte}, ${t.contexto}, ${c.texto},
               ${toVectorLiteral(embeddings[k])}::vector, ${t.vigenciaDesde}, NULL, '{}')`;
          k++;
        }
      }
    },
    { timeout: 180_000 }
  );
  return lista.length;
}

async function marcarVistas(items: { registro: string; epoca: string | null; huella: string; ingerida: boolean }[]): Promise<void> {
  for (const it of items) {
    await prisma.sjfTesisVista.upsert({
      where: { registro: it.registro },
      create: { registro: it.registro, epoca: it.epoca, huella: it.huella, ingerida: it.ingerida },
      update: { epoca: it.epoca, huella: it.huella, ingerida: it.ingerida, vistaAt: new Date() },
    });
  }
}

export async function sincronizarSjf(opts: OpcionesSync): Promise<ResumenSync> {
  const t0 = Date.now();
  const log = opts.log ?? (() => {});
  const modo = opts.modo ?? "nuevas";
  const size = Math.min(Math.max(1, opts.sizePagina ?? 1000), 1000);
  const lote = Math.min(Math.max(1, opts.lote ?? 50), 200);
  const conc = Math.min(Math.max(1, opts.concurrencia ?? 6), 12);
  const epocas = opts.epocas && opts.epocas.size > 0 ? opts.epocas : null;
  const r: ResumenSync = { paginas: 0, idsVistos: 0, descargadas: 0, ingeridas: 0, actualizadas: 0, sinCambios: 0, saltadasEpoca: 0, fallidas: 0, ms: 0, porEpoca: {} };

  const inicio = Math.max(0, opts.paginaInicio ?? 0);
  const fin = opts.maxPaginas ? inicio + opts.maxPaginas : Number.POSITIVE_INFINITY;
  for (let pagina = inicio; pagina < fin; pagina++) {
    const ids = await opts.cliente.ids(pagina, size);
    if (ids.length === 0) break;
    r.paginas++;
    r.idsVistos += ids.length;

    const conocidas = opts.soloDescarga ? new Map<string, { huella: string; ingerida: boolean }>() : await vistas(ids);
    const pendientes = modo === "completo" ? ids : ids.filter((id) => !conocidas.has(id));
    if (modo === "nuevas" && pendientes.length === 0 && !opts.soloDescarga) {
      log(`página ${pagina}: sin ids nuevos — lo de abajo ya está visto; fin.`);
      break;
    }

    const tPag = Date.now();
    let ingPag = 0;
    let fallPag = 0;
    for (const grupo of trozos(pendientes, lote)) {
      const det = await opts.cliente.tesis(grupo, conc);
      const aInsertar: TesisNormalizada[] = [];
      const aMarcar: { registro: string; epoca: string | null; huella: string; ingerida: boolean }[] = [];
      for (const d of det) {
        if (!d.tesis) {
          r.fallidas++;
          fallPag++;
          log(`  ${d.id}: ${d.error}`);
          continue;
        }
        r.descargadas++;
        if (opts.soloDescarga) {
          opts.soloDescarga(d.tesis);
          const e = normalizarTesis(d.tesis).epoca ?? "?";
          r.porEpoca[e] = (r.porEpoca[e] ?? 0) + 1;
          continue;
        }
        const n = normalizarTesis(d.tesis);
        const e = n.epoca ?? "?";
        r.porEpoca[e] = (r.porEpoca[e] ?? 0) + 1;
        const previa = conocidas.get(n.registro);
        if (epocas && (!n.epoca || !epocas.has(n.epoca))) {
          r.saltadasEpoca++;
          aMarcar.push({ registro: n.registro, epoca: n.epoca, huella: n.hash, ingerida: false });
          continue;
        }
        if (previa && previa.ingerida && previa.huella === n.hash) {
          r.sinCambios++;
          continue;
        }
        aInsertar.push(n);
        aMarcar.push({ registro: n.registro, epoca: n.epoca, huella: n.hash, ingerida: true });
        if (previa?.ingerida) r.actualizadas++;
        else r.ingeridas++;
      }
      if (aInsertar.length > 0) {
        try {
          await insertarTesisLote(aInsertar);
          ingPag += aInsertar.length;
        } catch (err) {
          // El lote entero falla junto (transacción): que cuente como fallido y siga.
          r.fallidas += aInsertar.length;
          fallPag += aInsertar.length;
          r.ingeridas -= aInsertar.filter((t) => !conocidas.get(t.registro)?.ingerida).length;
          r.actualizadas -= aInsertar.filter((t) => conocidas.get(t.registro)?.ingerida).length;
          log(`  lote de ${aInsertar.length} falló: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
          continue;
        }
      }
      if (aMarcar.length > 0) await marcarVistas(aMarcar);
    }
    log(
      `página ${pagina}: ${ids.length} ids, ${pendientes.length} pendientes, ${ingPag} guardadas, ${fallPag} fallidas ` +
        `(${((Date.now() - tPag) / 1000).toFixed(0)} s) · acumulado ${r.ingeridas} nuevas / ${r.actualizadas} actualizadas / ${r.saltadasEpoca} fuera de Época`
    );
  }
  r.ms = Date.now() - t0;
  return r;
}

/** Clave de documento de un registro del SJF (para búsquedas puntuales). */
export { claveTesis };
