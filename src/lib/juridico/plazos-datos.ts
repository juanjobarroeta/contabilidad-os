// ─────────────────────────────────────────────────────────────────────────────
// Los plazos, ya con base de datos. El cómputo vive en `plazos.ts` y es puro;
// aquí sólo se arma el calendario, se guarda el resultado con su rastro y se
// hace pasar por la confirmación de un abogado.
//
// Un plazo nace PROPUESTO. El producto no presenta una fecha como verdad hasta
// que alguien con cédula la revisó, porque el calendario del órgano puede tener
// suspensiones que ninguna ley lista y que nosotros no conocemos.
// ─────────────────────────────────────────────────────────────────────────────
import { prisma } from "@/lib/prisma";
import { apuntar, type Actor } from "./bitacora";
import { alcance } from "./despacho";
import { noEncontrado, conflicto } from "./errores-api";
import {
  type Calendario,
  type Computo,
  type Fuero,
  type PasoComputo,
  type SurteEfectos,
  type TipoDias,
  aISO,
  computarPlazo,
  diasHabilesRestantes,
  explicacion,
} from "./plazos";

export type EstadoPlazo = "propuesto" | "confirmado" | "cumplido" | "descartado";

const FUEROS: Fuero[] = ["amparo", "laboral", "federal", "local"];
export const esFuero = (v: unknown): v is Fuero => typeof v === "string" && (FUEROS as string[]).includes(v);
export const esTipoDias = (v: unknown): v is TipoDias => v === "habiles" || v === "naturales";
export const esSurte = (v: unknown): v is SurteEfectos => v === "mismo_dia" || v === "dia_siguiente_habil";

export interface Plazo {
  id: string;
  casoId: string;
  titulo: string;
  fundamento: string | null;
  ordenamiento: string | null;
  articulo: string | null;
  fuero: Fuero;
  entidad: string | null;
  notificacion: string;
  dias: number;
  tipo: TipoDias;
  surteEfectos: SurteEfectos;
  vence: string;
  traza: PasoComputo[];
  advertencias: string[];
  estado: EstadoPlazo;
  confirmadoPorUserId: string | null;
  confirmadoAt: Date | null;
  nota: string | null;
  origen: "manual" | "copiloto";
  creadoPorUserId: string;
  createdAt: Date;
  /** Calculado al leer, no guardado: cambia solo con el paso de los días. */
  diasHabilesRestantes: number;
  explicacion: string;
}

/**
 * El calendario con el que se computa: la ley por fuero (en `plazos.ts`) más
 * los inhábiles que cargó el despacho o el operador.
 */
export async function calendarioDe(args: { despachoId?: string | null; fuero: Fuero; entidad?: string | null; desde: string; hasta: string }): Promise<Calendario> {
  const filas = await prisma.juridicoInhabil.findMany({
    where: {
      fecha: { gte: new Date(`${args.desde}T00:00:00Z`), lte: new Date(`${args.hasta}T00:00:00Z`) },
      OR: [{ despachoId: null }, ...(args.despachoId ? [{ despachoId: args.despachoId }] : [])],
      AND: [{ OR: [{ fuero: null }, { fuero: args.fuero }] }, { OR: [{ entidad: null }, { entidad: args.entidad ?? null }] }],
    },
    select: { fecha: true },
  });
  const inhabilesExtra = [...new Set(filas.map((f) => aISO(f.fecha)))].sort();
  return { fuero: args.fuero, inhabilesExtra, finDeSemanaInhabil: true };
}

export interface NuevoPlazo {
  titulo: string;
  fuero: Fuero;
  entidad?: string | null;
  notificacion: string;
  dias: number;
  tipo?: TipoDias;
  surteEfectos?: SurteEfectos;
  fundamento?: string | null;
  ordenamiento?: string | null;
  articulo?: string | null;
  origen?: "manual" | "copiloto";
  nota?: string | null;
}

/** Computa sin guardar: sirve para la vista previa antes de aceptar. */
export async function simular(args: NuevoPlazo & { despachoId?: string | null }): Promise<Computo> {
  // Un año de holgura hacia adelante cubre cualquier plazo razonable.
  const anio = Number(args.notificacion.slice(0, 4));
  const cal = await calendarioDe({
    despachoId: args.despachoId,
    fuero: args.fuero,
    entidad: args.entidad,
    desde: args.notificacion,
    hasta: `${anio + 2}-12-31`,
  });
  return computarPlazo({
    notificacion: args.notificacion,
    dias: args.dias,
    tipo: args.tipo,
    surteEfectos: args.surteEfectos,
    calendario: cal,
  });
}

function aPlazo(f: Record<string, unknown>, hoy: string): Plazo {
  const fuero = esFuero(f.fuero) ? f.fuero : "federal";
  const traza = Array.isArray(f.traza) ? (f.traza as PasoComputo[]) : [];
  const vence = aISO(f.vence as Date);
  const p: Plazo = {
    id: f.id as string,
    casoId: f.casoId as string,
    titulo: f.titulo as string,
    fundamento: (f.fundamento as string) ?? null,
    ordenamiento: (f.ordenamiento as string) ?? null,
    articulo: (f.articulo as string) ?? null,
    fuero,
    entidad: (f.entidad as string) ?? null,
    notificacion: aISO(f.notificacion as Date),
    dias: f.dias as number,
    tipo: esTipoDias(f.tipo) ? f.tipo : "habiles",
    surteEfectos: esSurte(f.surteEfectos) ? f.surteEfectos : "mismo_dia",
    vence,
    traza,
    advertencias: Array.isArray(f.advertencias) ? (f.advertencias as string[]) : [],
    estado: (["propuesto", "confirmado", "cumplido", "descartado"].includes(f.estado as string) ? f.estado : "propuesto") as EstadoPlazo,
    confirmadoPorUserId: (f.confirmadoPorUserId as string) ?? null,
    confirmadoAt: (f.confirmadoAt as Date) ?? null,
    nota: (f.nota as string) ?? null,
    origen: f.origen === "copiloto" ? "copiloto" : "manual",
    creadoPorUserId: f.creadoPorUserId as string,
    createdAt: f.createdAt as Date,
    diasHabilesRestantes: 0,
    explicacion: "",
  };
  p.diasHabilesRestantes = diasHabilesRestantes(vence, { fuero, inhabilesExtra: [], finDeSemanaInhabil: true }, hoy);
  p.explicacion = explicacion({ vence, inicio: traza.find((x) => x.clase === "cuenta")?.fecha ?? vence, dias: p.dias, tipo: p.tipo, pasos: traza, advertencias: p.advertencias });
  return p;
}

export async function crearPlazo(casoId: string, userId: string, nuevo: NuevoPlazo, actor: Actor, despachoId?: string | null): Promise<Plazo> {
  const titulo = (nuevo.titulo ?? "").trim().slice(0, 300);
  if (titulo.length < 3) throw conflicto("El plazo necesita un título que diga qué hay que presentar.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(nuevo.notificacion)) throw conflicto("La fecha de notificación va en formato AAAA-MM-DD.");
  if (!Number.isFinite(nuevo.dias) || nuevo.dias < 1 || nuevo.dias > 1825) throw conflicto("El número de días no es válido.");

  const c = await simular({ ...nuevo, despachoId });
  const f = await prisma.juridicoPlazo.create({
    data: {
      casoId,
      creadoPorUserId: userId,
      titulo,
      fundamento: nuevo.fundamento ?? null,
      ordenamiento: nuevo.ordenamiento ?? null,
      articulo: nuevo.articulo ?? null,
      fuero: nuevo.fuero,
      entidad: nuevo.entidad ?? null,
      notificacion: new Date(`${nuevo.notificacion}T00:00:00Z`),
      dias: Math.floor(nuevo.dias),
      tipo: c.tipo,
      surteEfectos: nuevo.surteEfectos ?? (nuevo.fuero === "amparo" ? "dia_siguiente_habil" : "mismo_dia"),
      vence: new Date(`${c.vence}T00:00:00Z`),
      traza: c.pasos as unknown as object,
      advertencias: c.advertencias as unknown as object,
      nota: nuevo.nota ?? null,
      origen: nuevo.origen ?? "manual",
    },
  });
  await apuntar({
    casoId,
    actor,
    accion: "plazo.propuesto",
    entidad: "plazo",
    entidadId: f.id,
    resumen: `propuso el plazo «${titulo}»: ${explicacion(c)}`,
    datos: { fuero: nuevo.fuero, dias: nuevo.dias, notificacion: nuevo.notificacion, vence: c.vence, fundamento: nuevo.fundamento ?? null },
  });
  return aPlazo(f as unknown as Record<string, unknown>, aISO(new Date()));
}

export async function listarPlazos(casoId: string, opts: { incluirCerrados?: boolean } = {}): Promise<Plazo[]> {
  const filas = await prisma.juridicoPlazo.findMany({
    where: { casoId, ...(opts.incluirCerrados ? {} : { estado: { in: ["propuesto", "confirmado"] } }) },
    orderBy: [{ vence: "asc" }],
  });
  const hoy = aISO(new Date());
  return filas.map((f) => aPlazo(f as unknown as Record<string, unknown>, hoy));
}

/** Lo que vence pronto en todos los casos a los que alcanza esta persona. */
export async function plazosProximos(userId: string, opts: { dias?: number; limite?: number } = {}): Promise<(Plazo & { casoTitulo: string })[]> {
  const horizonte = new Date(Date.now() + (opts.dias ?? 30) * 24 * 60 * 60 * 1000);
  const filas = await prisma.juridicoPlazo.findMany({
    where: { estado: { in: ["propuesto", "confirmado"] }, vence: { lte: horizonte }, caso: await alcance(userId) },
    include: { caso: { select: { titulo: true } } },
    orderBy: [{ vence: "asc" }],
    take: Math.min(opts.limite ?? 50, 200),
  });
  const hoy = aISO(new Date());
  return filas.map((f) => ({ ...aPlazo(f as unknown as Record<string, unknown>, hoy), casoTitulo: f.caso.titulo }));
}

async function conAlcance(id: string, userId: string) {
  const f = await prisma.juridicoPlazo.findFirst({ where: { id, caso: await alcance(userId) } });
  if (!f) throw noEncontrado("Ese plazo no existe o no es de tus casos.");
  return f;
}

/** El acto que convierte una propuesta en algo de lo que el despacho responde. */
export async function confirmarPlazo(id: string, userId: string, actor: Actor, nota?: string | null): Promise<Plazo> {
  const actual = await conAlcance(id, userId);
  if (actual.estado === "cumplido" || actual.estado === "descartado") {
    throw conflicto(`Ese plazo ya está ${actual.estado}; reábrelo antes de confirmarlo.`);
  }
  const f = await prisma.juridicoPlazo.update({
    where: { id },
    data: { estado: "confirmado", confirmadoPorUserId: userId, confirmadoAt: new Date(), ...(nota === undefined ? {} : { nota }) },
  });
  await apuntar({
    casoId: f.casoId,
    actor,
    accion: "plazo.confirmado",
    entidad: "plazo",
    entidadId: id,
    resumen: `confirmó que «${f.titulo}» vence el ${aISO(f.vence)}`,
    datos: { vence: aISO(f.vence) },
  });
  return aPlazo(f as unknown as Record<string, unknown>, aISO(new Date()));
}

export async function cambiarEstadoPlazo(id: string, userId: string, estado: "cumplido" | "descartado" | "confirmado", actor: Actor, nota?: string | null): Promise<Plazo> {
  if (estado === "confirmado") return confirmarPlazo(id, userId, actor, nota);
  const actual = await conAlcance(id, userId);
  const f = await prisma.juridicoPlazo.update({
    where: { id },
    data: { estado, cumplidoAt: estado === "cumplido" ? new Date() : null, ...(nota === undefined ? {} : { nota }) },
  });
  await apuntar({
    casoId: actual.casoId,
    actor,
    accion: estado === "cumplido" ? "plazo.cumplido" : "plazo.descartado",
    entidad: "plazo",
    entidadId: id,
    resumen: estado === "cumplido" ? `marcó cumplido «${actual.titulo}»` : `descartó el plazo «${actual.titulo}»`,
  });
  return aPlazo(f as unknown as Record<string, unknown>, aISO(new Date()));
}

/**
 * Recomputa con el calendario de hoy. Es la razón por la que se guarda la traza
 * y no sólo la fecha: cuando el juzgado publica una suspensión de labores, el
 * plazo se mueve y hay que poder verlo, no descubrirlo tarde.
 */
export async function recomputarPlazo(id: string, userId: string, actor: Actor, despachoId?: string | null): Promise<Plazo & { cambio: { antes: string; ahora: string } | null }> {
  const actual = await conAlcance(id, userId);
  const c = await simular({
    titulo: actual.titulo,
    fuero: esFuero(actual.fuero) ? actual.fuero : "federal",
    entidad: actual.entidad,
    notificacion: aISO(actual.notificacion),
    dias: actual.dias,
    tipo: esTipoDias(actual.tipo) ? actual.tipo : "habiles",
    surteEfectos: esSurte(actual.surteEfectos) ? actual.surteEfectos : "mismo_dia",
    despachoId,
  });
  const antes = aISO(actual.vence);
  const f = await prisma.juridicoPlazo.update({
    where: { id },
    data: { vence: new Date(`${c.vence}T00:00:00Z`), traza: c.pasos as unknown as object, advertencias: c.advertencias as unknown as object },
  });
  if (c.vence !== antes) {
    await apuntar({
      casoId: actual.casoId,
      actor,
      accion: "plazo.recomputado",
      entidad: "plazo",
      entidadId: id,
      resumen: `el plazo «${actual.titulo}» se movió del ${antes} al ${c.vence} por un cambio en el calendario`,
      datos: { antes, ahora: c.vence },
    });
  }
  return { ...aPlazo(f as unknown as Record<string, unknown>, aISO(new Date())), cambio: c.vence === antes ? null : { antes, ahora: c.vence } };
}

/** Cargar los inhábiles del órgano: suspensiones, vacaciones, festivos locales. */
export async function cargarInhabiles(args: { despachoId: string | null; fuero?: Fuero | null; entidad?: string | null; fechas: string[]; motivo: string; fuente?: string | null }): Promise<number> {
  const limpias = [...new Set(args.fechas.filter((f) => /^\d{4}-\d{2}-\d{2}$/.test(f)))];
  if (limpias.length === 0) return 0;
  const ya = await prisma.juridicoInhabil.findMany({
    where: { despachoId: args.despachoId, fuero: args.fuero ?? null, entidad: args.entidad ?? null, fecha: { in: limpias.map((f) => new Date(`${f}T00:00:00Z`)) } },
    select: { fecha: true },
  });
  const existentes = new Set(ya.map((f) => aISO(f.fecha)));
  const nuevas = limpias.filter((f) => !existentes.has(f));
  if (nuevas.length === 0) return 0;
  await prisma.juridicoInhabil.createMany({
    data: nuevas.map((f) => ({ despachoId: args.despachoId, fuero: args.fuero ?? null, entidad: args.entidad ?? null, fecha: new Date(`${f}T00:00:00Z`), motivo: args.motivo.slice(0, 300), fuente: args.fuente ?? null })),
  });
  return nuevas.length;
}
