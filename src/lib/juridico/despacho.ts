// ─────────────────────────────────────────────────────────────────────────────
// El despacho: quién puede ver y hacer qué.
//
// Hasta la Fase 1 un caso era de UNA persona (`where: { userId }`), así que
// repartir trabajo en un equipo pasaba por compartir la contraseña. Aquí el
// acceso deja de ser propiedad y pasa a ser pertenencia: un caso es del
// despacho, y lo ve quien sea miembro.
//
// `userId` no desaparece de los casos: sigue diciendo quién lo abrió, y es el
// respaldo de los casos anteriores al despacho (o de un abogado que todavía no
// tiene uno). Por eso el filtro de acceso siempre es «mío O de mi despacho».
// ─────────────────────────────────────────────────────────────────────────────
import { prisma } from "@/lib/prisma";
import { crearAsiento, normalizarEmail, type AsientoJuridico } from "./usuarios";

export type RolDespacho = "socio" | "abogado" | "pasante" | "administrativo";

export const ROLES: RolDespacho[] = ["socio", "abogado", "pasante", "administrativo"];

export function esRol(v: unknown): v is RolDespacho {
  return typeof v === "string" && (ROLES as string[]).includes(v);
}

/**
 * Qué puede hacer cada papel. Deliberadamente corto: lo que de verdad cambia
 * entre un socio y un pasante es quién administra el despacho y quién cierra o
 * borra; trabajar el caso lo hacen todos menos el administrativo.
 */
export const PERMISOS = {
  administrarDespacho: ["socio"],
  cerrarCaso: ["socio", "abogado"],
  borrar: ["socio", "abogado"],
  redactar: ["socio", "abogado", "pasante"],
  trabajarCaso: ["socio", "abogado", "pasante"],
  ver: ROLES,
} as const;

export type Permiso = keyof typeof PERMISOS;

/** Puro: ¿este papel puede hacer esto? */
export function puede(rol: RolDespacho | null, permiso: Permiso): boolean {
  if (!rol) return permiso === "ver" || permiso === "trabajarCaso" || permiso === "redactar"; // sin despacho: su propio trabajo
  return (PERMISOS[permiso] as readonly string[]).includes(rol);
}

export interface Membresia {
  despachoId: string;
  nombre: string;
  rol: RolDespacho;
}

/** Los despachos a los que pertenece alguien (casi siempre uno). */
export async function membresias(userId: string): Promise<Membresia[]> {
  const filas = await prisma.juridicoMiembro.findMany({ where: { userId }, select: { despachoId: true, rol: true, despacho: { select: { nombre: true } } } });
  return filas.map((f) => ({ despachoId: f.despachoId, nombre: f.despacho.nombre, rol: (esRol(f.rol) ? f.rol : "abogado") as RolDespacho }));
}

/** El despacho principal (el primero). Null si todavía no tiene. */
export async function despachoDe(userId: string): Promise<Membresia | null> {
  return (await membresias(userId))[0] ?? null;
}

/**
 * El filtro de acceso: lo mío o lo de mi despacho. Se usa en TODA consulta de
 * casos y clientes; sin él, un miembro no vería el caso de su socio.
 */
export async function alcance(userId: string): Promise<{ OR: ({ userId: string } | { despachoId: { in: string[] } })[] }> {
  const ids = (await membresias(userId)).map((m) => m.despachoId);
  return { OR: [{ userId }, ...(ids.length ? [{ despachoId: { in: ids } }] : [])] };
}

/** El despacho al que hay que colgar lo que se crea (null si no tiene). */
export async function despachoParaCrear(userId: string): Promise<string | null> {
  return (await despachoDe(userId))?.despachoId ?? null;
}

/**
 * Su despacho, creándolo si es su primera vez. Quien llega sin despacho se
 * vuelve socio del suyo y sus casos y clientes se mudan ahí: para él no cambia
 * nada, y ya puede invitar a alguien.
 */
export async function asegurarDespacho(userId: string): Promise<Membresia> {
  const ya = await despachoDe(userId);
  if (ya) return ya;
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true } });
  const nombre = `Despacho de ${(u?.name ?? "").trim() || (u?.email ?? "abogado").split("@")[0]}`.slice(0, 120);
  const d = await prisma.juridicoDespacho.create({ data: { nombre, creadoPorUserId: userId, miembros: { create: { userId, rol: "socio" } } }, select: { id: true, nombre: true } });
  await prisma.$transaction([
    prisma.juridicoCaso.updateMany({ where: { userId, despachoId: null }, data: { despachoId: d.id } }),
    prisma.juridicoCliente.updateMany({ where: { userId, despachoId: null }, data: { despachoId: d.id } }),
  ]);
  return { despachoId: d.id, nombre: d.nombre, rol: "socio" };
}

export interface MiembroDelDespacho {
  userId: string;
  nombre: string | null;
  email: string;
  rol: RolDespacho;
  desde: Date;
  /** Casos en los que figura como responsable. */
  casos: number;
}

export async function listarMiembros(despachoId: string): Promise<MiembroDelDespacho[]> {
  const filas = await prisma.juridicoMiembro.findMany({
    where: { despachoId },
    orderBy: { createdAt: "asc" },
    select: { userId: true, rol: true, createdAt: true, user: { select: { name: true, email: true } } },
  });
  const casos = await prisma.juridicoCaso.groupBy({ by: ["responsableUserId"], where: { despachoId }, _count: { _all: true } });
  const porUsuario = new Map(casos.map((c) => [c.responsableUserId ?? "", c._count._all]));
  return filas.map((f) => ({
    userId: f.userId,
    nombre: f.user.name,
    email: f.user.email ?? "",
    rol: (esRol(f.rol) ? f.rol : "abogado") as RolDespacho,
    desde: f.createdAt,
    casos: porUsuario.get(f.userId) ?? 0,
  }));
}

/**
 * Suma a alguien al despacho. Si no tiene cuenta, se la crea con acceso al
 * copiloto y contraseña temporal (se enseña UNA vez); si ya la tiene, sólo se
 * le da acceso y se le suma. Lo hace el socio, sin pasar por nosotros.
 */
export async function invitar(despachoId: string, datos: { email: string; nombre: string; rol?: RolDespacho }): Promise<{ miembro: MiembroDelDespacho; contrasenaTemporal: string | null; yaExistia: boolean }> {
  const email = normalizarEmail(datos.email);
  const alta = await crearAsiento({ email, nombre: datos.nombre });
  const rol: RolDespacho = esRol(datos.rol) ? datos.rol : "abogado";
  await prisma.juridicoMiembro.upsert({
    where: { despachoId_userId: { despachoId, userId: alta.asiento.id } },
    create: { despachoId, userId: alta.asiento.id, rol },
    update: { rol },
  });
  const miembro: MiembroDelDespacho = { userId: alta.asiento.id, nombre: alta.asiento.nombre, email: alta.asiento.email, rol, desde: new Date(), casos: 0 };
  return { miembro, contrasenaTemporal: alta.contrasenaTemporal, yaExistia: alta.yaExistia };
}

/** Cambia el papel de alguien. Un despacho no se queda sin socios. */
export async function cambiarRol(despachoId: string, userId: string, rol: RolDespacho): Promise<void> {
  const actual = await prisma.juridicoMiembro.findUnique({ where: { despachoId_userId: { despachoId, userId } }, select: { rol: true } });
  if (!actual) throw new Error("Miembro no encontrado");
  if (actual.rol === "socio" && rol !== "socio" && (await socios(despachoId)) <= 1) {
    throw new Error("El despacho se quedaría sin socio: nombra a otro antes de cambiar este papel.");
  }
  await prisma.juridicoMiembro.update({ where: { despachoId_userId: { despachoId, userId } }, data: { rol } });
}

/**
 * Saca a alguien del despacho. No borra su cuenta ni los casos que trabajó:
 * un despacho no puede perder el expediente porque alguien se fue.
 */
export async function quitarMiembro(despachoId: string, userId: string): Promise<void> {
  const actual = await prisma.juridicoMiembro.findUnique({ where: { despachoId_userId: { despachoId, userId } }, select: { rol: true } });
  if (!actual) throw new Error("Miembro no encontrado");
  if (actual.rol === "socio" && (await socios(despachoId)) <= 1) throw new Error("El despacho se quedaría sin socio: nombra a otro antes de sacar a éste.");
  await prisma.juridicoMiembro.delete({ where: { despachoId_userId: { despachoId, userId } } });
}

async function socios(despachoId: string): Promise<number> {
  return prisma.juridicoMiembro.count({ where: { despachoId, rol: "socio" } });
}

export async function renombrar(despachoId: string, nombre: string): Promise<void> {
  const limpio = nombre.trim().slice(0, 120);
  if (limpio.length < 2) throw new Error("El despacho necesita un nombre.");
  await prisma.juridicoDespacho.update({ where: { id: despachoId }, data: { nombre: limpio } });
}

/** Lo que la UI necesita para la pantalla de equipo. */
export async function panelDespacho(userId: string): Promise<{ despacho: Membresia; miembros: MiembroDelDespacho[]; asientos?: AsientoJuridico[] } | null> {
  const m = await despachoDe(userId);
  if (!m) return null;
  return { despacho: m, miembros: await listarMiembros(m.despachoId) };
}
