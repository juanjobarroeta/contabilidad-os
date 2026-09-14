// ─────────────────────────────────────────────────────────────────────────────
// Alta y baja de los asientos del copiloto jurídico.
//
// Hasta hoy esto era un script que alguien corría a mano contra la base
// (`scripts/crear-usuario-juridico.ts`): dar de alta a un abogado dependía de
// que Juan estuviera frente a una terminal. Aquí vive la misma operación para
// que la haga la aplicación.
//
// La cuenta nace con `subscriptionStatus: ACTIVE` a propósito: el asiento
// jurídico no tiene empresa ni cargo, y un TRIALING vencido le cerraría la
// puerta al token del satélite.
// ─────────────────────────────────────────────────────────────────────────────
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { consumoDelMes, type Consumo } from "./consumo";

export interface AsientoJuridico {
  id: string;
  email: string;
  nombre: string | null;
  esOperador: boolean;
  activo: boolean;
  creado: Date;
  ultimaActividad: Date | null;
  conversaciones: number;
  casos: number;
  consumo?: Consumo;
}

/**
 * Contraseña temporal legible: sin caracteres que se confundan al dictarla
 * por teléfono (0/O, 1/l/I). Se enseña UNA vez y el abogado la cambia.
 */
export function generarContrasena(largo = 14): string {
  const alfabeto = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(largo);
  let out = "";
  for (let i = 0; i < largo; i++) out += alfabeto[bytes[i] % alfabeto.length];
  return out;
}

export function normalizarEmail(v: string): string {
  return v.trim().toLowerCase();
}

/** Forma de correo válida; no comprueba que exista. Puro. */
export function emailValido(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v.trim());
}

export async function listarAsientos(opts: { conConsumo?: boolean } = {}): Promise<AsientoJuridico[]> {
  const usuarios = await prisma.user.findMany({
    where: { accesoJuridico: true },
    orderBy: { createdAt: "asc" },
    select: {
      id: true, email: true, name: true, esOperador: true, accesoJuridico: true, createdAt: true,
      _count: { select: { juridicoConversaciones: true, juridicoCasos: true } },
      juridicoConversaciones: { orderBy: { updatedAt: "desc" }, take: 1, select: { updatedAt: true } },
    },
  });
  const base = usuarios.map((u) => ({
    id: u.id,
    email: u.email ?? "",
    nombre: u.name,
    esOperador: u.esOperador === true,
    activo: u.accesoJuridico === true,
    creado: u.createdAt,
    ultimaActividad: u.juridicoConversaciones[0]?.updatedAt ?? null,
    conversaciones: u._count.juridicoConversaciones,
    casos: u._count.juridicoCasos,
  }));
  if (!opts.conConsumo) return base;
  return Promise.all(base.map(async (a) => ({ ...a, consumo: await consumoDelMes(a.id) })));
}

/**
 * Da de alta (o reactiva) un asiento. Devuelve la contraseña temporal SÓLO
 * cuando se generó una: si la cuenta ya existía con contraseña, no se toca.
 */
export async function crearAsiento(datos: { email: string; nombre: string }): Promise<{ asiento: AsientoJuridico; contrasenaTemporal: string | null; yaExistia: boolean }> {
  const email = normalizarEmail(datos.email);
  if (!emailValido(email)) throw new Error("El correo no tiene forma de correo.");
  const nombre = datos.nombre.trim().slice(0, 120);
  if (nombre.length < 2) throw new Error("Falta el nombre de la persona.");

  const previo = await prisma.user.findUnique({ where: { email }, select: { id: true, password: true, accesoJuridico: true } });
  const contrasena = previo?.password ? null : generarContrasena();
  const u = await prisma.user.upsert({
    where: { email },
    create: { email, name: nombre, password: await bcrypt.hash(contrasena!, 10), accesoJuridico: true, emailVerified: new Date(), subscriptionStatus: "ACTIVE" },
    update: { name: nombre, accesoJuridico: true, subscriptionStatus: "ACTIVE" },
    select: { id: true, email: true, name: true, esOperador: true, accesoJuridico: true, createdAt: true },
  });
  return {
    asiento: { id: u.id, email: u.email ?? email, nombre: u.name, esOperador: u.esOperador === true, activo: true, creado: u.createdAt, ultimaActividad: null, conversaciones: 0, casos: 0 },
    contrasenaTemporal: contrasena,
    yaExistia: !!previo,
  };
}

/** Nueva contraseña temporal (la anterior deja de servir). */
export async function restablecerContrasena(userId: string): Promise<string> {
  const u = await prisma.user.findFirst({ where: { id: userId, accesoJuridico: true }, select: { id: true } });
  if (!u) throw new Error("Asiento no encontrado");
  const contrasena = generarContrasena();
  await prisma.user.update({ where: { id: userId }, data: { password: await bcrypt.hash(contrasena, 10) } });
  return contrasena;
}

/**
 * Quita el acceso. No borra la cuenta ni sus casos: un despacho no puede
 * perder el expediente porque alguien se fue.
 */
export async function revocarAcceso(userId: string): Promise<void> {
  const u = await prisma.user.findFirst({ where: { id: userId }, select: { id: true, esOperador: true } });
  if (!u) throw new Error("Asiento no encontrado");
  if (u.esOperador) throw new Error("No se le quita el acceso a un operador desde aquí.");
  await prisma.user.update({ where: { id: userId }, data: { accesoJuridico: false } });
}
