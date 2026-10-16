// ─────────────────────────────────────────────────────────────────────────────
// Surtir lo cotizado CONTRA INVENTARIO: la partida de medicamento/material de
// la cotización sale del almacén con su lote y entra a la cuenta al precio
// cotizado, en una sola transacción.
//
// · El INSUMO: la partida trae un servicio del tarifario, no un insumo. La
//   primera vez farmacia elige el insumo (sugerido por clave y nombre, de todo
//   el catálogo: inventario físico y lo derivado de CFDIs, con existencia 0 si
//   no hay) y el servicio lo recuerda (HospServicio.insumoId).
// · El LOTE: FEFO —el que caduca primero— entre TODOS los almacenes (farmacia
//   hoy surte de todos); la entrega se parte entre lotes si uno no alcanza y
//   cada tramo deja su cargo, su kardex y su nota (aplicarEnTx).
// · PARCIAL: una partida se surte en varias entregas; lo surtido es la suma de
//   sus cargos vivos. Cancelar o reducir un cargo la reabre.
// · DE MÁS: lo que pasa de lo cotizado se carga a precio de lista, marcado
//   «fuera de cotización».
// · Controlados: receta y prescriptor como en cualquier aplicación (el médico
//   del episodio si no se indica otro).
// ─────────────────────────────────────────────────────────────────────────────

import type { Prisma, PrismaClient } from "@prisma/client";
import { HospitalError } from "./errores";
import { CATEGORIAS_FARMACIA } from "./episodio";
import { aplicarEnTx } from "./aplicar-insumo";
import { exigeLibroControl } from "./controlados";
import { claveDia } from "./tz";
import { r2 } from "./util";

type Db = PrismaClient | Prisma.TransactionClient;

export interface LoteSurtible {
  id: string;
  lote: string;
  almacen: string;
  caducidad: Date | null;
  existencia: number;
  bloqueado?: boolean;
  recibidoAt?: Date | null;
}

export interface Tramo {
  loteId: string;
  lote: string;
  almacen: string;
  caducidad: Date | null;
  cantidad: number;
}

const hoyUtc = (ahora = new Date()) => new Date(`${claveDia(ahora)}T00:00:00.000Z`);

/** Lotes que se pueden surtir (no bloqueados, con caducidad vigente y existencia), en orden FEFO. */
export function lotesElegibles<T extends LoteSurtible>(lotes: T[], hoy: Date): T[] {
  return lotes
    .filter((l) => !l.bloqueado && l.caducidad && l.caducidad >= hoy && l.existencia > 0)
    .sort((a, b) => a.caducidad!.getTime() - b.caducidad!.getTime() || (a.recibidoAt?.getTime() ?? 0) - (b.recibidoAt?.getTime() ?? 0));
}

/** Reparte `cantidad` entre los lotes en orden FEFO. `disponible` es lo que hay en total. PURO. */
export function planFefo(lotes: LoteSurtible[], cantidad: number, hoy: Date): { tramos: Tramo[]; disponible: number; faltante: number } {
  const elegibles = lotesElegibles(lotes, hoy);
  const disponible = r2(elegibles.reduce((s, l) => s + l.existencia, 0));
  const tramos: Tramo[] = [];
  let resta = cantidad;
  for (const l of elegibles) {
    if (resta <= 0) break;
    const toma = Math.min(resta, l.existencia);
    tramos.push({ loteId: l.id, lote: l.lote, almacen: l.almacen, caducidad: l.caducidad, cantidad: r2(toma) });
    resta = r2(resta - toma);
  }
  return { tramos, disponible, faltante: Math.max(0, r2(resta)) };
}

/**
 * Parte los tramos en lo que cubre lo cotizado (`pendiente`, a precio
 * cotizado) y lo que pasa de ahí (a precio de lista). PURO.
 */
export function repartirCotizado(tramos: Tramo[], pendiente: number): Array<Tramo & { cotizada: boolean }> {
  const out: Array<Tramo & { cotizada: boolean }> = [];
  let resta = Math.max(0, pendiente);
  for (const t of tramos) {
    const cubre = Math.min(resta, t.cantidad);
    if (cubre > 0) out.push({ ...t, cantidad: r2(cubre), cotizada: true });
    if (t.cantidad - cubre > 0) out.push({ ...t, cantidad: r2(t.cantidad - cubre), cotizada: false });
    resta = r2(resta - cubre);
  }
  return out;
}

/** Lo que falta por surtir de la partida. Una partida cargada sin inventario (cargoId) ya no tiene pendiente. */
export function pendienteDe(p: { cantidad: unknown; cargoId?: string | null }, surtidos: Array<{ cantidad: unknown }>): { surtido: number; pendiente: number } {
  if (p.cargoId) return { surtido: Number(p.cantidad), pendiente: 0 };
  const surtido = r2(surtidos.reduce((s, c) => s + Number(c.cantidad), 0));
  return { surtido, pendiente: Math.max(0, r2(Number(p.cantidad) - surtido)) };
}

const normal = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
/** Palabras que distinguen el concepto (sin unidades ni conectores). */
export function palabrasClave(texto: string): string[] {
  const vacias = new Set(["para", "con", "sin", "de", "del", "la", "el", "los", "las", "y", "en", "mg", "ml", "g", "pza", "pieza", "caja", "tab", "amp", "frasco", "sobre"]);
  return [...new Set(normal(texto).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !vacias.has(w) && !/^\d+$/.test(w)))];
}

/** Qué tanto se parece un insumo a la partida: clave igual manda; luego palabras en común. PURO. */
export function puntaje(insumo: { clave: string; nombre: string; sustanciaActiva?: string | null }, partida: { clave?: string | null; descripcion: string }): number {
  let p = 0;
  if (partida.clave && normal(insumo.clave) === normal(partida.clave)) p += 100;
  const del = new Set(palabrasClave(`${insumo.nombre} ${insumo.sustanciaActiva ?? ""}`));
  const pal = palabrasClave(partida.descripcion);
  for (const w of pal) if (del.has(w)) p += 10;
  // Números (dosis: 500, 10) que coinciden afinan entre presentaciones.
  const nums = (s: string) => new Set(normal(s).match(/\d+(?:[.,]\d+)?/g) ?? []);
  const ni = nums(insumo.nombre);
  for (const n of nums(partida.descripcion)) if (ni.has(n)) p += 3;
  return p;
}

const selectInsumo = {
  id: true, clave: true, nombre: true, presentacion: true, unidad: true, precioVenta: true, grupoControl: true, controlado: true, sustanciaActiva: true, activo: true,
  lotes: { select: { id: true, lote: true, almacen: true, caducidad: true, existencia: true, bloqueado: true, recibidoAt: true } },
} as const;

type InsumoFila = {
  id: string; clave: string; nombre: string; presentacion: string | null; unidad: string; precioVenta: unknown; grupoControl: string | null; controlado: boolean; sustanciaActiva: string | null;
  lotes: Array<{ id: string; lote: string; almacen: string; caducidad: Date | null; existencia: unknown; bloqueado: boolean; recibidoAt: Date }>;
};

function opcionInsumo(i: InsumoFila, pendiente: number, hoy: Date) {
  const lotes = i.lotes.map((l) => ({ ...l, existencia: Number(l.existencia) }));
  const plan = planFefo(lotes, pendiente, hoy);
  const porAlmacen: Record<string, number> = {};
  for (const l of lotesElegibles(lotes, hoy)) porAlmacen[l.almacen] = r2((porAlmacen[l.almacen] ?? 0) + l.existencia);
  return {
    id: i.id, clave: i.clave, nombre: i.nombre, presentacion: i.presentacion, unidad: i.unidad,
    precioVenta: i.precioVenta == null ? null : Number(i.precioVenta),
    controlado: exigeLibroControl(i.grupoControl as never) || i.controlado,
    grupoControl: i.grupoControl,
    existencia: plan.disponible,
    porAlmacen: Object.entries(porAlmacen).map(([almacen, existencia]) => ({ almacen, existencia })),
    plan: plan.tramos,
  };
}

async function partidaConContexto(db: Db, companyId: string, partidaId: string) {
  const p = await db.hospCotizacionPartida.findUnique({
    where: { id: partidaId },
    select: {
      id: true, descripcion: true, categoria: true, cantidad: true, precioUnitario: true, sinCotizar: true, cargoId: true, servicioId: true, cotizacionId: true,
      cotizacion: { select: { companyId: true, folio: true } },
      servicio: { select: { id: true, clave: true, insumoId: true } },
      surtidos: { where: { cancelado: false }, select: { cantidad: true } },
    },
  });
  if (!p || p.cotizacion.companyId !== companyId) throw new HospitalError(404, "Partida no encontrada");
  if (p.sinCotizar || !(CATEGORIAS_FARMACIA as readonly string[]).includes(p.categoria)) throw new HospitalError(400, `«${p.descripcion}» no la surte farmacia`);
  return p;
}

/**
 * Para el diálogo de surtido: lo pendiente de la partida, el insumo ligado y
 * candidatos del catálogo con su existencia y el plan FEFO. Con `q` busca en
 * todo el catálogo (clave, nombre o sustancia).
 */
export async function opcionesSurtido(db: Db, companyId: string, partidaId: string, q?: string | null, ahora = new Date()) {
  const p = await partidaConContexto(db, companyId, partidaId);
  const { surtido, pendiente } = pendienteDe(p, p.surtidos);
  const hoy = hoyUtc(ahora);
  const clave = p.servicio?.clave ?? null;
  const busqueda = (q ?? "").trim();
  const palabras = busqueda ? [busqueda] : palabrasClave(p.descripcion).slice(0, 3);
  const or: Prisma.HospInsumoWhereInput[] = [
    ...(p.servicio?.insumoId && !busqueda ? [{ id: p.servicio.insumoId }] : []),
    ...(clave && !busqueda ? [{ clave: { equals: clave, mode: "insensitive" as const } }] : []),
    ...palabras.flatMap((w) => [
      { nombre: { contains: w, mode: "insensitive" as const } },
      { clave: { contains: w, mode: "insensitive" as const } },
      { sustanciaActiva: { contains: w, mode: "insensitive" as const } },
    ]),
  ];
  const insumos = or.length
    ? await db.hospInsumo.findMany({ where: { companyId, activo: true, OR: or }, select: selectInsumo, take: 60 })
    : [];
  const ref = { clave, descripcion: busqueda || p.descripcion };
  const candidatos = insumos
    .map((i) => ({ i, s: (i.id === p.servicio?.insumoId ? 1000 : 0) + puntaje(i, ref) + (i.lotes.some((l) => Number(l.existencia) > 0) ? 1 : 0) }))
    .sort((a, b) => b.s - a.s || a.i.nombre.localeCompare(b.i.nombre, "es"))
    .slice(0, 20)
    .map(({ i }) => opcionInsumo(i as InsumoFila, pendiente || Number(p.cantidad), hoy));
  return {
    partida: { id: p.id, descripcion: p.descripcion, clave, categoria: p.categoria, cantidad: Number(p.cantidad), precioUnitario: Number(p.precioUnitario), surtido, pendiente, folio: p.cotizacion.folio, cargadaSinInventario: Boolean(p.cargoId) },
    vinculado: p.servicio?.insumoId ?? null,
    candidatos,
  };
}

export interface SurtirArgs {
  companyId: string;
  episodioId: string;
  partidaId: string;
  insumoId: string;
  cantidad: number;
  /** Fuerza un lote (y sólo ese); sin él, FEFO entre todos los almacenes. */
  loteId?: string | null;
  recetaRef?: string | null;
  medicoId?: string | null;
  prescriptorNombre?: string | null;
  prescriptorCedula?: string | null;
  /** Cambia el insumo que el servicio recuerda (por omisión sólo se liga si no tenía). */
  recordar?: boolean;
  usuario: { id: string; nombre: string };
}

/** Surte la partida contra inventario: FEFO, se parte entre lotes, a precio cotizado hasta lo pendiente. */
export async function surtirPartida(db: PrismaClient, args: SurtirArgs) {
  const cantidad = r2(Number(args.cantidad));
  if (!(cantidad > 0)) throw new HospitalError(400, "La cantidad debe ser mayor que cero");
  return db.$transaction(async (tx) => {
    // Dos personas surtiendo la misma partida: la segunda espera y ve lo que ya se surtió.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`surtido:${args.companyId}:${args.partidaId}`}))`;
    const p = await partidaConContexto(tx, args.companyId, args.partidaId);
    if (p.cargoId) throw new HospitalError(409, `«${p.descripcion}» ya se cargó a la cuenta sin inventario`);
    const ep = await tx.hospEpisodio.findUnique({ where: { id: args.episodioId }, select: { id: true, companyId: true, folio: true, medicoId: true, cotizacion: { select: { id: true } } } });
    if (!ep || ep.companyId !== args.companyId) throw new HospitalError(404, "Episodio no encontrado");
    if (ep.cotizacion?.id !== p.cotizacionId) throw new HospitalError(400, `La partida no es de la cotización del episodio ${ep.folio}`);
    const insumo = await tx.hospInsumo.findFirst({ where: { id: args.insumoId, companyId: args.companyId }, select: selectInsumo });
    if (!insumo) throw new HospitalError(404, "Insumo no encontrado");
    if (!insumo.activo) throw new HospitalError(409, `El insumo ${insumo.nombre} está dado de baja`);

    const { pendiente } = pendienteDe(p, p.surtidos);
    const hoy = hoyUtc();
    const lotes = insumo.lotes
      .filter((l) => !args.loteId || l.id === args.loteId)
      .map((l) => ({ ...l, existencia: Number(l.existencia) }));
    if (args.loteId && !lotes.length) throw new HospitalError(404, "Lote no encontrado para ese insumo");
    const plan = planFefo(lotes, cantidad, hoy);
    if (plan.faltante > 0) {
      throw new HospitalError(409, `${insumo.nombre}: sólo hay ${plan.disponible} ${insumo.unidad} surtibles${args.loteId ? " en ese lote" : ""} (piden ${cantidad})`);
    }

    // El prescriptor sólo cuenta en controlados; en lo demás el cargo no lleva médico.
    const controlado = exigeLibroControl(insumo.grupoControl as never);
    const medicoId = controlado ? (args.medicoId ?? ep.medicoId ?? null) : null;
    const fecha = new Date();
    const cargos = [];
    const advertencias: string[] = [];
    let cotizado = 0;
    let extra = 0;
    for (const t of repartirCotizado(plan.tramos, pendiente)) {
      const r = await aplicarEnTx(
        tx,
        {
          companyId: args.companyId, episodioId: ep.id, insumoId: insumo.id, loteId: t.loteId, cantidad: t.cantidad,
          usuarioId: args.usuario.id, usuarioNombre: args.usuario.nombre, medicoId,
          recetaRef: args.recetaRef, prescriptorNombre: args.prescriptorNombre, prescriptorCedula: args.prescriptorCedula,
          nota: t.cotizada ? `Surtido de la cotización ${p.cotizacion.folio}.` : `Fuera de la cotización ${p.cotizacion.folio}.`,
        },
        t.cotizada
          ? { fecha, precioUnitario: Number(p.precioUnitario), cotizacionPartidaId: p.id, sufijo: `cot. ${p.cotizacion.folio}` }
          : { fecha, sufijo: "fuera de cotización" },
      );
      cargos.push(r.cargo);
      advertencias.push(...r.advertencias);
      if (t.cotizada) cotizado = r2(cotizado + t.cantidad);
      else extra = r2(extra + t.cantidad);
    }

    if (p.servicio && (!p.servicio.insumoId || (args.recordar && p.servicio.insumoId !== insumo.id))) {
      await tx.hospServicio.update({ where: { id: p.servicio.id }, data: { insumoId: insumo.id } });
    }
    const quedan = Math.max(0, r2(pendiente - cotizado));
    if (quedan === 0) await tx.hospCotizacionPartida.update({ where: { id: p.id }, data: { surtidaAt: fecha, surtidaPor: args.usuario.nombre } });

    return {
      folio: ep.folio,
      cargos: cargos.length,
      importe: r2(cargos.reduce((s, c) => s + Number(c.importe), 0)),
      cotizado,
      extra,
      pendiente: quedan,
      tramos: plan.tramos,
      advertencias,
    };
  });
}
