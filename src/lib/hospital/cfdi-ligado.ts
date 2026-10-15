// ─────────────────────────────────────────────────────────────────────────────
// RENGLONES DE CFDI DE COMPRA → CATÁLOGO FÍSICO
//
// El inventario del hospital es el que se cuenta (los 1,377 insumos del Excel y
// sus lotes por almacén), no el que se lee de las facturas. Por eso un CFDI de
// compra ya NO da de alta insumos ni escribe kardex (HospConfig.
// cfdiCreaInventario = false, el default): la existencia la pone la RECEPCIÓN
// (POST /farmacia/lotes, a mano o con el escáner, contra la línea de la orden).
//
// Lo que sí hace el CFDI es decir qué se facturó. Cada renglón se liga a un
// insumo del catálogo, en este orden:
//
//   1. REQUISICION — el CFDI está ligado a una orden de compra (vínculo
//      ADJUDICACION). Sus renglones se emparejan con las líneas de esa orden
//      (las de la requisición que ganó esa cotización) por descripción,
//      cantidad e importe; la línea trae el insumo (hospInsumoId).
//   2. APRENDIDO — este proveedor ya llamó así a un insumo y alguien lo ligó
//      una vez: su NoIdentificacion («NI:…») o, sin él, la descripción
//      normalizada («D:…») → insumo (HospProveedorInsumo).
//   3. POR_LIGAR — lo demás que parece insumo (clasificarInsumo) queda en la
//      cola. Al ligarlo a mano se aprende la clave y se aplica a los otros
//      renglones pendientes del mismo proveedor.
//
// Idempotente por (invoiceId, llave). Lo ligado a mano (MANUAL) y lo ignorado
// no se vuelve a tocar en una re-pasada; lo automático sí se recalcula (si la
// factura se soltó de la orden, sus renglones vuelven a la cola).
// ─────────────────────────────────────────────────────────────────────────────

import type { Prisma, PrismaClient } from "@prisma/client";
import { normalizarDescripcion } from "./cfdi-texto";
import { VINCULO_ORDEN } from "./requisiciones";
import {
  cfdiCreaInventario,
  claveDeInsumo,
  clasificarInsumo,
  costoDeLinea,
  llaveLinea,
  prepararLineas,
  type LineaCfdiInsumo,
} from "./insumos-cfdi";

type Db = PrismaClient | Prisma.TransactionClient;

export const ESTADO_LINEA = { POR_LIGAR: "POR_LIGAR", LIGADA: "LIGADA", IGNORADA: "IGNORADA" } as const;
export const ORIGEN_LIGA = { REQUISICION: "REQUISICION", APRENDIDO: "APRENDIDO", MANUAL: "MANUAL" } as const;

const r2 = (n: number) => Math.round(n * 100) / 100;

// ─── Parecido de descripciones (puro) ────────────────────────────────────────

/** Palabras que no distinguen un producto de otro. */
const RELLENO = new Set([
  "DE", "DEL", "LA", "EL", "LOS", "LAS", "CON", "PARA", "Y", "EN", "X", "C", "P", "POR", "SIN",
  "PZA", "PZAS", "PZ", "PIEZA", "PIEZAS", "CAJA", "CJA", "CJ", "CAJAS", "UNIDAD", "UNIDADES", "PAQ", "PAQUETE",
]);

/** «500MG» y «500 MG», «10X10» y «10 X 10» son lo mismo: se parte en el cambio número↔letra. */
function fichas(s: string): Set<string> {
  return new Set(
    normalizarDescripcion(s)
      .replace(/(\d)([A-Z])/g, "$1 $2")
      .replace(/([A-Z])(\d)/g, "$1 $2")
      .split(" ")
      .filter((t) => t.length > 0 && !RELLENO.has(t))
  );
}

/** Coeficiente de Dice sobre las palabras con significado: 0 (nada en común) … 1 (iguales). */
export function similitud(a: string | null | undefined, b: string | null | undefined): number {
  const A = fichas(a ?? "");
  const B = fichas(b ?? "");
  if (A.size === 0 || B.size === 0) return 0;
  let comunes = 0;
  for (const t of A) if (B.has(t)) comunes++;
  return (2 * comunes) / (A.size + B.size);
}

/** Llaves con que se aprende lo que el proveedor llama así: NI (si lo trae) y descripción. */
export function clavesProveedor(noIdentificacion: string | null | undefined, descripcion: string | null | undefined): string[] {
  const ni = claveDeInsumo(noIdentificacion, "");
  const d = normalizarDescripcion(descripcion).slice(0, 120).trim();
  return [...(ni ? [`NI:${ni}`] : []), ...(d ? [`D:${d}`] : [])];
}

// ─── Emparejar con la orden de compra (puro) ─────────────────────────────────

export interface LineaParaLigar {
  llave: string;
  descripcion: string;
  noIdentificacion: string | null;
  cantidad: number;
  /** Importe neto (menos descuento), sin IVA. */
  importe: number;
  /** clasificarInsumo: un flete o un servicio nunca entra por descarte. */
  esInsumo?: boolean;
}

export interface PartidaDeOrden {
  id: string;
  hospInsumoId: string;
  descripcion: string;
  cantidad: number;
  precioUnitario: number;
  insumoNombre: string;
  insumoClave: string;
}

const casi = (a: number, b: number, tol: number) => b > 0 && Math.abs(a - b) / b <= tol;

interface Puntaje {
  desc: number;
  cantidad: boolean;
  precio: boolean;
  total: number;
}

export function puntuar(l: LineaParaLigar, p: PartidaDeOrden): Puntaje {
  const ni = claveDeInsumo(l.noIdentificacion, "");
  const desc = ni && ni === p.insumoClave.trim().toUpperCase()
    ? 1
    : Math.max(similitud(l.descripcion, p.descripcion), similitud(l.descripcion, p.insumoNombre));
  const cantidad = casi(l.cantidad, p.cantidad, 0.005);
  const unitario = l.cantidad > 0 ? l.importe / l.cantidad : 0;
  const precio = casi(unitario, p.precioUnitario, 0.15);
  return { desc, cantidad, precio, total: desc + (cantidad ? 0.25 : 0) + (precio ? 0.15 : 0) };
}

/** Basta la descripción, o una descripción floja respaldada por cantidad Y precio. */
const aceptable = (s: Puntaje) => s.desc >= 0.5 || (s.desc >= 0.25 && s.cantidad && s.precio);
/** Dos candidatas de insumos distintos a menos de esto: no se adivina. */
const EMPATE = 0.05;

/**
 * Renglón del CFDI → línea de la orden. Codicioso por puntaje: el mejor par
 * primero, cada renglón a una línea. Si para un renglón las dos mejores
 * líneas (de insumos distintos) quedan empatadas, se queda en la cola.
 * Después:
 *   • si sobra UN renglón que parece insumo y UNA línea, van juntos cuando
 *     la cantidad, el precio o algo de la descripción lo respalda (la orden
 *     sólo tenía eso);
 *   • un renglón que es el mismo producto que una línea ya emparejada (el
 *     proveedor partió la línea en dos lotes) va a esa misma línea.
 */
export function emparejarConOrden(lineas: LineaParaLigar[], partidas: PartidaDeOrden[]): Map<string, PartidaDeOrden> {
  const res = new Map<string, PartidaDeOrden>();
  if (lineas.length === 0 || partidas.length === 0) return res;

  const ambiguas = new Set<string>();
  const pares: Array<{ l: LineaParaLigar; p: PartidaDeOrden; s: Puntaje }> = [];
  for (const l of lineas) {
    const cands = partidas.map((p) => ({ l, p, s: puntuar(l, p) })).filter((c) => aceptable(c.s)).sort((a, b) => b.s.total - a.s.total);
    if (cands.length >= 2 && cands[0].p.hospInsumoId !== cands[1].p.hospInsumoId && cands[0].s.total - cands[1].s.total < EMPATE) {
      ambiguas.add(l.llave);
      continue;
    }
    pares.push(...cands);
  }
  pares.sort((a, b) => b.s.total - a.s.total);
  const usadas = new Set<string>();
  for (const { l, p } of pares) {
    if (res.has(l.llave) || usadas.has(p.id)) continue;
    res.set(l.llave, p);
    usadas.add(p.id);
  }

  const libresL = lineas.filter((l) => !res.has(l.llave) && !ambiguas.has(l.llave) && l.esInsumo !== false);
  const libresP = partidas.filter((p) => !usadas.has(p.id));
  if (libresL.length === 1 && libresP.length === 1) {
    const s = puntuar(libresL[0], libresP[0]);
    if (s.cantidad || s.precio || s.desc >= 0.25) {
      res.set(libresL[0].llave, libresP[0]);
      usadas.add(libresP[0].id);
    }
  }

  const emparejadas = partidas.filter((p) => usadas.has(p.id));
  for (const l of lineas) {
    if (res.has(l.llave) || ambiguas.has(l.llave)) continue;
    const mejor = emparejadas
      .map((p) => ({ p, d: puntuar(l, p).desc }))
      .filter((c) => c.d >= 0.7)
      .sort((a, b) => b.d - a.d);
    if (mejor.length && (mejor.length === 1 || mejor[0].p.hospInsumoId === mejor[1].p.hospInsumoId || mejor[0].d - mejor[1].d >= EMPATE)) {
      res.set(l.llave, mejor[0].p);
    }
  }
  return res;
}

// ─── Persistencia ────────────────────────────────────────────────────────────

const rfcDe = (f: { customer: { rfc: string } | null; contraparteRfc: string | null }) =>
  (f.customer?.rfc ?? f.contraparteRfc ?? "").trim().toUpperCase() || null;

/** Líneas de la orden (adjudicación) que ampara el CFDI, con su insumo. Vacío sin orden. */
async function partidasDeLaOrden(db: Db, companyId: string, invoiceId: string): Promise<PartidaDeOrden[]> {
  const v = await db.construccionCfdiVinculo.findUnique({
    where: { invoiceId },
    select: { companyId: true, estado: true, targetTipo: true, targetId: true },
  });
  if (!v || v.companyId !== companyId || v.estado !== "VINCULADA" || v.targetTipo !== VINCULO_ORDEN || !v.targetId) return [];
  const adj = await db.solicitudAdjudicacion.findFirst({
    where: { id: v.targetId, companyId },
    select: {
      cotizacionId: true,
      solicitud: {
        select: {
          partidas: {
            where: { hospInsumoId: { not: null } },
            select: {
              id: true, hospInsumoId: true, descripcion: true, cantidad: true, precioUnitario: true, cotizacionGanadoraId: true,
              hospInsumo: { select: { nombre: true, clave: true } },
            },
          },
        },
      },
    },
  });
  if (!adj) return [];
  return adj.solicitud.partidas
    .filter((p) => p.cotizacionGanadoraId === adj.cotizacionId && p.hospInsumoId && p.hospInsumo)
    .map((p) => ({
      id: p.id,
      hospInsumoId: p.hospInsumoId!,
      descripcion: p.descripcion,
      cantidad: Number(p.cantidad),
      precioUnitario: Number(p.precioUnitario),
      insumoNombre: p.hospInsumo!.nombre,
      insumoClave: p.hospInsumo!.clave,
    }));
}

/** Clave aprendida → insumo activo, para un proveedor. NI gana a la descripción. */
async function aprendidoPara(db: Db, companyId: string, proveedorRfc: string | null, llaves: string[]) {
  const mapa = new Map<string, string>();
  if (!proveedorRfc || llaves.length === 0) return mapa;
  const filas = await db.hospProveedorInsumo.findMany({
    where: { companyId, proveedorRfc, claveProveedor: { in: [...new Set(llaves)] }, insumo: { activo: true } },
    select: { claveProveedor: true, insumoId: true },
  });
  for (const f of filas) mapa.set(f.claveProveedor, f.insumoId);
  return mapa;
}

const insumoAprendido = (mapa: Map<string, string>, claves: string[]) => {
  for (const k of claves) {
    const id = mapa.get(k);
    if (id) return id;
  }
  return null;
};

export interface LigarCfdiResultado {
  ligadas: number;
  porLigar: number;
}

interface LineaPreparada extends LineaParaLigar {
  claveProdServ: string | null;
  claveUnidad: string | null;
  esInsumo: boolean;
}

/** Llave única por renglón: dos renglones idénticos en el mismo CFDI llevan #2, #3… */
function prepararParaLigar(lineas: LineaCfdiInsumo[]): LineaPreparada[] {
  const vistas = new Map<string, number>();
  return lineas
    .filter((l) => Number(l.cantidad) > 0)
    .map((l) => {
      const base = llaveLinea(l.descripcion, Number(l.cantidad), Number(l.importe));
      const n = (vistas.get(base) ?? 0) + 1;
      vistas.set(base, n);
      return {
        llave: n === 1 ? base : `${base}#${n}`,
        descripcion: l.descripcion,
        noIdentificacion: l.noIdentificacion ?? null,
        claveProdServ: l.claveProdServ ?? null,
        claveUnidad: l.claveUnidad ?? null,
        cantidad: Number(l.cantidad),
        importe: r2(costoDeLinea(l)),
        esInsumo: clasificarInsumo(l).esInsumo,
      };
    });
}

/**
 * Liga los renglones de UN CFDI de compra (EGRESO, no nota de crédito). Se
 * llama desde la derivación (import, cron, «poblar farmacia») cuando la
 * empresa no deja que el CFDI cree inventario, y al ligar/soltar el CFDI de
 * una orden. `lineas` ya preparadas (con NoIdentificacion del XML); sin ellas
 * se leen de la factura.
 */
export async function ligarCfdiCompra(
  db: Db,
  args: { companyId: string; invoiceId: string; lineas?: LineaCfdiInsumo[] }
): Promise<LigarCfdiResultado> {
  const vacio = { ligadas: 0, porLigar: 0 };
  const inv = await db.invoice.findFirst({
    where: { id: args.invoiceId, companyId: args.companyId },
    select: {
      tipo: true, tipoSat: true, status: true, rawXml: !args.lineas, contraparteRfc: true,
      customer: { select: { rfc: true } },
      items: args.lineas
        ? false
        : { select: { descripcion: true, cantidad: true, claveUnidad: true, claveProdServ: true, valorUnitario: true, importe: true, descuento: true } },
    },
  });
  if (!inv || inv.tipo !== "EGRESO" || (inv.tipoSat ?? "I") === "E" || inv.status === "CANCELLED") return vacio;

  const crudas: LineaCfdiInsumo[] =
    args.lineas ??
    prepararLineas(
      ((inv as { items?: Array<Record<string, unknown>> }).items ?? []).map((it) => ({
        descripcion: String(it.descripcion),
        cantidad: Number(it.cantidad),
        claveUnidad: (it.claveUnidad as string | null) ?? null,
        claveProdServ: (it.claveProdServ as string | null) ?? null,
        valorUnitario: Number(it.valorUnitario),
        importe: Number(it.importe),
        descuento: Number(it.descuento ?? 0),
      })),
      (inv as { rawXml?: string | null }).rawXml ?? null
    );
  const lineas = prepararParaLigar(crudas);
  if (lineas.length === 0) return vacio;

  const proveedorRfc = rfcDe(inv);
  const [previas, partidas] = await Promise.all([
    db.hospCfdiLinea.findMany({
      where: { invoiceId: args.invoiceId },
      select: { id: true, llave: true, estado: true, origen: true },
    }),
    partidasDeLaOrden(db, args.companyId, args.invoiceId),
  ]);
  const previaPorLlave = new Map(previas.map((p) => [p.llave, p]));
  // Lo decidido por una persona no se recalcula.
  const fijas = new Set(previas.filter((p) => p.estado === ESTADO_LINEA.IGNORADA || p.origen === ORIGEN_LIGA.MANUAL).map((p) => p.llave));
  const abiertas = lineas.filter((l) => !fijas.has(l.llave));

  const porOrden = emparejarConOrden(abiertas, partidas);
  const clavesDe = new Map(abiertas.map((l) => [l.llave, clavesProveedor(l.noIdentificacion, l.descripcion)]));
  const aprendido = await aprendidoPara(
    db,
    args.companyId,
    proveedorRfc,
    abiertas.filter((l) => !porOrden.has(l.llave)).flatMap((l) => clavesDe.get(l.llave)!)
  );

  const res = { ...vacio };
  for (const l of abiertas) {
    const partida = porOrden.get(l.llave) ?? null;
    const insumoId = partida?.hospInsumoId ?? insumoAprendido(aprendido, clavesDe.get(l.llave)!);
    const previa = previaPorLlave.get(l.llave);
    // Lo que no es insumo y no se ligó no entra a la cola (fletes, servicios…).
    if (!insumoId && !l.esInsumo && !previa) continue;
    const datos = insumoId
      ? {
          estado: ESTADO_LINEA.LIGADA,
          origen: partida ? ORIGEN_LIGA.REQUISICION : ORIGEN_LIGA.APRENDIDO,
          insumoId,
          solicitudPartidaId: partida?.id ?? null,
          ligadoPorId: null,
          ligadoAt: new Date(),
        }
      : { estado: ESTADO_LINEA.POR_LIGAR, origen: null, insumoId: null, solicitudPartidaId: null, ligadoPorId: null, ligadoAt: null };
    if (previa) {
      await db.hospCfdiLinea.update({ where: { id: previa.id }, data: { ...datos, proveedorRfc } });
    } else {
      await db.hospCfdiLinea.create({
        data: {
          companyId: args.companyId,
          invoiceId: args.invoiceId,
          llave: l.llave,
          descripcion: l.descripcion.slice(0, 1000),
          noIdentificacion: l.noIdentificacion,
          claveProdServ: l.claveProdServ,
          claveUnidad: l.claveUnidad,
          cantidad: l.cantidad,
          importe: l.importe,
          proveedorRfc,
          ...datos,
        },
      });
    }
    if (insumoId) res.ligadas++;
    else res.porLigar++;
  }
  return res;
}

/**
 * Al ligar o soltar el CFDI de una orden: re-liga sus renglones (por la orden,
 * o de vuelta a la cola si se soltó). Nunca lanza: el vínculo ya quedó, y el
 * cron y la cola reintentan.
 */
export async function religarCfdiDeOrden(db: Db, companyId: string, invoiceId: string): Promise<LigarCfdiResultado | null> {
  try {
    if (await cfdiCreaInventario(db, companyId)) return null;
    return await ligarCfdiCompra(db, { companyId, invoiceId });
  } catch (e) {
    console.error(`[hospital] re-ligar renglones del CFDI ${invoiceId} falló:`, e);
    return null;
  }
}

/**
 * Ligado a mano desde la cola. Aprende la clave del proveedor y la aplica a
 * los demás renglones pendientes de ese proveedor con la misma clave.
 */
export async function ligarLineaManual(
  db: Db,
  args: { companyId: string; lineaId: string; insumoId: string; userId: string }
): Promise<{ lineaId: string; insumoId: string; propagadas: number }> {
  const linea = await db.hospCfdiLinea.findFirst({
    where: { id: args.lineaId, companyId: args.companyId },
    select: { id: true, proveedorRfc: true, noIdentificacion: true, descripcion: true },
  });
  if (!linea) throw new LigadoError(404, "Renglón no encontrado");
  const insumo = await db.hospInsumo.findFirst({ where: { id: args.insumoId, companyId: args.companyId, activo: true }, select: { id: true } });
  if (!insumo) throw new LigadoError(404, "Insumo no encontrado o inactivo");

  const ahora = new Date();
  await db.hospCfdiLinea.update({
    where: { id: linea.id },
    data: { estado: ESTADO_LINEA.LIGADA, origen: ORIGEN_LIGA.MANUAL, insumoId: insumo.id, solicitudPartidaId: null, ligadoPorId: args.userId, ligadoAt: ahora },
  });

  let propagadas = 0;
  const claves = clavesProveedor(linea.noIdentificacion, linea.descripcion);
  if (linea.proveedorRfc && claves.length) {
    for (const claveProveedor of claves) {
      await db.hospProveedorInsumo.upsert({
        where: { companyId_proveedorRfc_claveProveedor: { companyId: args.companyId, proveedorRfc: linea.proveedorRfc, claveProveedor } },
        create: { companyId: args.companyId, proveedorRfc: linea.proveedorRfc, claveProveedor, insumoId: insumo.id, creadoPorId: args.userId },
        update: { insumoId: insumo.id, creadoPorId: args.userId },
      });
    }
    const pendientes = await db.hospCfdiLinea.findMany({
      where: { companyId: args.companyId, proveedorRfc: linea.proveedorRfc, estado: ESTADO_LINEA.POR_LIGAR, id: { not: linea.id } },
      select: { id: true, noIdentificacion: true, descripcion: true },
    });
    const mias = new Set(claves);
    const hermanas = pendientes.filter((p) => {
      const suyas = clavesProveedor(p.noIdentificacion, p.descripcion);
      // NI manda: si las dos traen NoIdentificacion, sólo cuenta ésa.
      const niSuya = suyas.find((k) => k.startsWith("NI:"));
      const niMia = claves.find((k) => k.startsWith("NI:"));
      if (niSuya && niMia) return niSuya === niMia;
      return suyas.some((k) => mias.has(k));
    });
    if (hermanas.length) {
      const { count } = await db.hospCfdiLinea.updateMany({
        where: { id: { in: hermanas.map((h) => h.id) }, estado: ESTADO_LINEA.POR_LIGAR },
        data: { estado: ESTADO_LINEA.LIGADA, origen: ORIGEN_LIGA.APRENDIDO, insumoId: insumo.id, ligadoAt: ahora },
      });
      propagadas = count;
    }
  }
  return { lineaId: linea.id, insumoId: insumo.id, propagadas };
}

/** Ignorar (no es inventario) o reabrir (vuelve a la cola). */
export async function cambiarEstadoLinea(db: Db, args: { companyId: string; lineaId: string; estado: "IGNORADA" | "POR_LIGAR"; userId: string }) {
  const linea = await db.hospCfdiLinea.findFirst({ where: { id: args.lineaId, companyId: args.companyId }, select: { id: true } });
  if (!linea) throw new LigadoError(404, "Renglón no encontrado");
  await db.hospCfdiLinea.update({
    where: { id: linea.id },
    data:
      args.estado === "IGNORADA"
        ? { estado: ESTADO_LINEA.IGNORADA, origen: ORIGEN_LIGA.MANUAL, insumoId: null, solicitudPartidaId: null, ligadoPorId: args.userId, ligadoAt: new Date() }
        : { estado: ESTADO_LINEA.POR_LIGAR, origen: null, insumoId: null, solicitudPartidaId: null, ligadoPorId: null, ligadoAt: null },
  });
  return { lineaId: linea.id, estado: args.estado };
}

/**
 * Reintento barato de la cola: los CFDIs con renglones pendientes que ya
 * tienen orden ligada, y los renglones cuyo proveedor ya tiene la clave
 * aprendida. Para cuando la factura se ligó a la orden después de llegar.
 */
export async function religarPendientes(db: Db, companyId: string, limite = 200): Promise<LigarCfdiResultado & { cfdis: number }> {
  const res = { ligadas: 0, porLigar: 0, cfdis: 0 };
  const conOrden = await db.hospCfdiLinea.findMany({
    where: {
      companyId,
      estado: ESTADO_LINEA.POR_LIGAR,
      invoice: { construccionVinculo: { estado: "VINCULADA", targetTipo: VINCULO_ORDEN } },
    },
    distinct: ["invoiceId"],
    select: { invoiceId: true },
    take: limite,
  });
  for (const { invoiceId } of conOrden) {
    const r = await ligarCfdiCompra(db, { companyId, invoiceId });
    res.ligadas += r.ligadas;
    res.cfdis++;
  }

  const pendientes = await db.hospCfdiLinea.findMany({
    where: { companyId, estado: ESTADO_LINEA.POR_LIGAR, proveedorRfc: { not: null } },
    select: { id: true, proveedorRfc: true, noIdentificacion: true, descripcion: true },
    take: 5_000,
  });
  const rfcs = [...new Set(pendientes.map((p) => p.proveedorRfc!))];
  if (rfcs.length) {
    const aprendidas = await db.hospProveedorInsumo.findMany({
      where: { companyId, proveedorRfc: { in: rfcs }, insumo: { activo: true } },
      select: { proveedorRfc: true, claveProveedor: true, insumoId: true },
    });
    const mapa = new Map(aprendidas.map((a) => [`${a.proveedorRfc}|${a.claveProveedor}`, a.insumoId]));
    const ahora = new Date();
    for (const p of pendientes) {
      const insumoId = clavesProveedor(p.noIdentificacion, p.descripcion)
        .map((k) => mapa.get(`${p.proveedorRfc}|${k}`))
        .find(Boolean);
      if (!insumoId) continue;
      const { count } = await db.hospCfdiLinea.updateMany({
        where: { id: p.id, estado: ESTADO_LINEA.POR_LIGAR },
        data: { estado: ESTADO_LINEA.LIGADA, origen: ORIGEN_LIGA.APRENDIDO, insumoId, ligadoAt: ahora },
      });
      res.ligadas += count;
    }
  }
  res.porLigar = await db.hospCfdiLinea.count({ where: { companyId, estado: ESTADO_LINEA.POR_LIGAR } });
  return res;
}

export class LigadoError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// ─── Cola «por ligar» ────────────────────────────────────────────────────────

export interface SugerenciaInsumo {
  id: string;
  clave: string;
  nombre: string;
  parecido: number;
}

/** Las tres más parecidas del catálogo físico (activo, no derivado del CFDI). */
export function sugerir(descripcion: string, catalogo: Array<{ id: string; clave: string; nombre: string }>, n = 3): SugerenciaInsumo[] {
  return catalogo
    .map((c) => ({ ...c, parecido: r2(similitud(descripcion, c.nombre)) }))
    .filter((c) => c.parecido >= 0.3)
    .sort((a, b) => b.parecido - a.parecido)
    .slice(0, n);
}

export async function listarLineas(
  db: Db,
  companyId: string,
  opts: { estado?: string; q?: string; page?: number; take?: number } = {}
) {
  const take = Math.min(Math.max(opts.take ?? 50, 1), 200);
  const page = Math.max(opts.page ?? 0, 0);
  const q = (opts.q ?? "").trim();
  const where: Prisma.HospCfdiLineaWhereInput = {
    companyId,
    ...(opts.estado ? { estado: opts.estado } : {}),
    ...(q
      ? {
          OR: [
            { descripcion: { contains: q, mode: "insensitive" } },
            { noIdentificacion: { contains: q, mode: "insensitive" } },
            { proveedorRfc: { contains: q, mode: "insensitive" } },
            { invoice: { contraparteNombre: { contains: q, mode: "insensitive" } } },
            { invoice: { customer: { razonSocial: { contains: q, mode: "insensitive" } } } },
          ],
        }
      : {}),
  };
  const [filas, total, porEstado] = await Promise.all([
    db.hospCfdiLinea.findMany({
      where,
      orderBy: [{ invoice: { fecha: "desc" } }, { id: "asc" }],
      skip: page * take,
      take,
      select: {
        id: true, descripcion: true, noIdentificacion: true, claveProdServ: true, cantidad: true, importe: true,
        proveedorRfc: true, estado: true, origen: true, ligadoAt: true, solicitudPartidaId: true,
        insumo: { select: { id: true, clave: true, nombre: true } },
        invoice: { select: { id: true, uuid: true, serie: true, folio: true, fecha: true, contraparteNombre: true, customer: { select: { razonSocial: true } } } },
      },
    }),
    db.hospCfdiLinea.count({ where }),
    db.hospCfdiLinea.groupBy({ by: ["estado"], where: { companyId }, _count: { _all: true } }),
  ]);

  const catalogo = filas.some((f) => f.estado === ESTADO_LINEA.POR_LIGAR)
    ? await db.hospInsumo.findMany({ where: { companyId, activo: true, derivadoDeCfdi: false }, select: { id: true, clave: true, nombre: true } })
    : [];

  return {
    total,
    page,
    take,
    conteos: Object.fromEntries(porEstado.map((e) => [e.estado, e._count._all])) as Record<string, number>,
    lineas: filas.map((f) => {
      const cantidad = Number(f.cantidad);
      const importe = Number(f.importe);
      return {
        id: f.id,
        descripcion: f.descripcion,
        noIdentificacion: f.noIdentificacion,
        claveProdServ: f.claveProdServ,
        cantidad,
        importe,
        costoUnitario: cantidad > 0 ? r2(importe / cantidad) : null,
        estado: f.estado,
        origen: f.origen,
        ligadoAt: f.ligadoAt,
        solicitudPartidaId: f.solicitudPartidaId,
        insumo: f.insumo,
        proveedor: { rfc: f.proveedorRfc, nombre: f.invoice.customer?.razonSocial ?? f.invoice.contraparteNombre ?? null },
        cfdi: {
          id: f.invoice.id,
          uuid: f.invoice.uuid,
          referencia: [f.invoice.serie?.trim(), f.invoice.folio?.trim()].filter(Boolean).join("-") || f.invoice.uuid?.slice(0, 8).toUpperCase() || f.invoice.id,
          fecha: f.invoice.fecha,
        },
        sugerencias: f.estado === ESTADO_LINEA.POR_LIGAR ? sugerir(f.descripcion, catalogo) : [],
      };
    }),
  };
}
