// Piezas que repiten TODAS las rutas /api/hospital/*: validación de fechas
// ISO en zod, respuesta de error `{ error }`, el usuario como lo firman notas
// y traslados, y el envoltorio de bitácora con el prefijo del módulo.

import { NextResponse } from "next/server";
import { z } from "zod";
import { registrarBitacora, type EntradaBitacora } from "@/lib/audit";
import type { AuthUser } from "@/lib/authz";
import { nombreUsuario } from "./util";
import { fechaLocal, finDiaLocal, inicioDiaLocal } from "./tz";

/** Fecha ISO (con o sin hora). Se guarda como instante; el piso la ve local. */
export const fechaSchema = z
  .string()
  .min(1)
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: "fecha inválida" });

export const aFecha = (s: string | null | undefined): Date | null => (s ? new Date(s) : null);

export const dinero = z.number().min(0).max(1_000_000_000);
export const tasaIva = z.number().min(0).max(1).nullable();

export function error(mensaje: string, status = 400) {
  return NextResponse.json({ error: mensaje }, { status });
}

export function errorZod(e: z.ZodError) {
  return NextResponse.json({ error: e.flatten() }, { status: 400 });
}

export function usuarioDe(user: AuthUser): { id: string; nombre: string; email: string | null } {
  return { id: user.id, nombre: nombreUsuario(user), email: user.email };
}

/** Bitácora del módulo: `hospital.<entidad>.<verbo>` y el actor de la petición. */
export function bitacora(
  user: AuthUser,
  req: Request,
  entrada: Omit<EntradaBitacora, "userId" | "actorEmail" | "req"> & { companyId: string }
) {
  registrarBitacora({ ...entrada, userId: user.id, actorEmail: user.email, req });
}

/**
 * Rango de fechas de la query: un «2026-09-03» a secas es el DÍA LOCAL
 * completo (desde su medianoche; hasta la medianoche siguiente, exclusiva);
 * un ISO con hora es el instante. Sin esto `new Date("2026-09-03")` cae en
 * el 2 de septiembre a las 18:00 de la Ciudad de México.
 */
export function rangoDeQuery(desde: string | null, hasta: string | null, hoy: Date = new Date()): { desde: Date; hasta: Date } | null {
  const inicio = desde ? limiteLocal(desde, "inicio") : inicioDiaLocal(hoy);
  const fin = hasta ? limiteLocal(hasta, "fin") : desde ? limiteLocal(desde, "fin") : finDiaLocal(hoy);
  if (!inicio || !fin || Number.isNaN(inicio.getTime()) || Number.isNaN(fin.getTime())) return null;
  return { desde: inicio, hasta: fin };
}

function limiteLocal(s: string, borde: "inicio" | "fin"): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (m) {
    const dia = fechaLocal(Number(m[1]), Number(m[2]), Number(m[3]));
    return borde === "inicio" ? dia : finDiaLocal(dia);
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}
