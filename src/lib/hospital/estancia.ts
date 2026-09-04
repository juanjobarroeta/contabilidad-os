// ─────────────────────────────────────────────────────────────────────────────
// Estancia: «cada noche de estancia se carga sola a la cuenta del paciente,
// con la tarifa de su pagador» (lámina 14).
//
// Una noche transcurre cuando el paciente cruza la medianoche LOCAL en una
// cama. Por cada noche transcurrida hay un HospCargo ESTANCIA con `fecha` =
// medianoche de esa noche; la clave del día es lo que lo hace idempotente,
// así que la lectura del expediente, la de la cuenta y el cron de las 06:30
// pueden llamar a `asegurarCargosEstancia` cuantas veces quieran.
//
// Sólo aplica a episodios HOSPITALIZACION ya admitidos (no PROGRAMADO ni
// CANCELADO) cuya cama tiene `servicioId`; el alta corta el conteo. Precio:
// HospTarifa del pagador del episodio, si no, el de lista del servicio.
// v1 cobra todas las noches con la cama ACTUAL: un traslado a una cama de
// otra tarifa no re-precia las noches ya cargadas (quedan escritas).
// ─────────────────────────────────────────────────────────────────────────────

import type { Prisma, PrismaClient } from "@prisma/client";
import { claveDia, diaMesCorto, diasEntre, inicioDiaLocal, sumarDias } from "./tz";
import { r2 } from "./util";

type Db = PrismaClient | Prisma.TransactionClient;

/** Noches calendario locales transcurridas entre el ingreso y `hasta`. */
export function nochesDeEstancia(fechaIngreso: Date, hasta: Date): number {
  if (hasta.getTime() <= fechaIngreso.getTime()) return 0;
  return Math.max(0, diasEntre(fechaIngreso, hasta));
}

/**
 * Medianoches locales de cada noche transcurrida: la noche i es la del día
 * del ingreso + i (la primera «noche» es la del día en que ingresó).
 */
export function nochesTranscurridas(fechaIngreso: Date, fechaAlta: Date | null | undefined, hoy: Date): Date[] {
  const hasta = fechaAlta && fechaAlta.getTime() < hoy.getTime() ? fechaAlta : hoy;
  const n = nochesDeEstancia(fechaIngreso, hasta);
  const primera = inicioDiaLocal(fechaIngreso);
  return Array.from({ length: n }, (_, i) => sumarDias(primera, i));
}

export interface ResultadoEstancia {
  episodioId: string;
  creados: number;
  importe: number;
  noches: number;
}

async function asegurarEnTx(db: Db, episodioId: string, hoy: Date): Promise<ResultadoEstancia> {
  const vacio = { episodioId, creados: 0, importe: 0, noches: 0 };
  const ep = await db.hospEpisodio.findUnique({
    where: { id: episodioId },
    select: {
      id: true,
      companyId: true,
      tipo: true,
      estado: true,
      fechaIngreso: true,
      fechaAlta: true,
      pagadorId: true,
      recurso: {
        select: {
          tipo: true,
          nombre: true,
          servicioId: true,
          servicio: { select: { id: true, nombre: true, precioLista: true, ivaTasa: true } },
        },
      },
    },
  });
  if (!ep || ep.tipo !== "HOSPITALIZACION") return vacio;
  if (ep.estado === "PROGRAMADO" || ep.estado === "CANCELADO") return vacio;
  const recurso = ep.recurso;
  if (!recurso || recurso.tipo !== "CAMA" || !recurso.servicioId || !recurso.servicio) return vacio;

  const noches = nochesTranscurridas(ep.fechaIngreso, ep.fechaAlta, hoy);
  if (noches.length === 0) return vacio;

  // Serializa dos lecturas concurrentes del mismo expediente (no-op fuera de
  // una transacción; ahí sólo protege la unicidad por fecha del chequeo de abajo).
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`hosp-estancia:${episodioId}`}))`;

  const existentes = await db.hospCargo.findMany({
    where: { episodioId, origen: "ESTANCIA" },
    select: { fecha: true },
  });
  // Una noche cancelada a mano no se vuelve a cargar: cuenta como existente.
  const yaCargadas = new Set(existentes.map((c) => claveDia(c.fecha)));
  const faltantes = noches.filter((n) => !yaCargadas.has(claveDia(n)));
  if (faltantes.length === 0) return { ...vacio, noches: noches.length };

  const tarifa = ep.pagadorId
    ? await db.hospTarifa.findUnique({
        where: { servicioId_pagadorId: { servicioId: recurso.servicioId, pagadorId: ep.pagadorId } },
        select: { precio: true },
      })
    : null;
  const precio = r2(Number(tarifa?.precio ?? recurso.servicio.precioLista));
  const ivaTasa = recurso.servicio.ivaTasa == null ? null : Number(recurso.servicio.ivaTasa);

  await db.hospCargo.createMany({
    data: faltantes.map((fecha) => ({
      companyId: ep.companyId,
      episodioId,
      fecha,
      categoria: "HABITACION" as const,
      descripcion: `Habitación ${recurso.nombre} · noche del ${diaMesCorto(fecha)}`,
      cantidad: 1,
      precioUnitario: precio,
      ivaTasa,
      importe: precio,
      origen: "ESTANCIA" as const,
      servicioId: recurso.servicioId,
    })),
  });

  return { episodioId, creados: faltantes.length, importe: r2(precio * faltantes.length), noches: noches.length };
}

/**
 * Garantiza un cargo ESTANCIA por noche transcurrida del episodio. Abre su
 * transacción cuando recibe el cliente raíz; dentro de una transacción ajena
 * (p. ej. el alta, que cobra las noches antes de soltar la cama) la reusa.
 */
export async function asegurarCargosEstancia(db: Db, episodioId: string, hoy: Date = new Date()): Promise<ResultadoEstancia> {
  if ("$transaction" in db && typeof db.$transaction === "function") {
    return db.$transaction((tx) => asegurarEnTx(tx, episodioId, hoy));
  }
  return asegurarEnTx(db, episodioId, hoy);
}
