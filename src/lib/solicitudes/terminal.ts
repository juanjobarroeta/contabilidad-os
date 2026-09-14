import { prisma } from "@/lib/prisma";
import { faltantesDeTerminal, lotesDeTerminal } from "@/lib/bancos/terminal-faltantes";
import { abrirSolicitud, llavesResueltas } from "./registro";

// ─────────────────────────────────────────────────────────────────────────────
// EL CASO DE LA TERMINAL, CERRADO DE PUNTA A PUNTA.
//
// Detecta los meses con liquidaciones de terminal cuyo estado de cuenta nunca
// se cargó, y abre la solicitud que corresponde — sin modelo, sólo consultas y
// una regla. Corre dentro de la pasada diaria de salud: la empresa ya se está
// mirando entera ahí, y un cron más por esto sería un cron de más.
//
// Es la historia del centro de procedimientos: el sistema reconocía la
// liquidación por la afiliación, no podía cuadrarla sin el estado de cuenta, y
// no tenía dónde decirlo. Ahora lo dice, y lo dice UNA VEZ.
// ─────────────────────────────────────────────────────────────────────────────

/** Prefijo de las llaves de este motor. Acota la consulta de lo ya resuelto. */
export const PREFIJO_TERMINAL = "terminal:";

/** Cuántos meses hacia atrás se miran. Más atrás ya no se puede pedir nada útil. */
export const MESES_ATRAS = 12;

export interface ResultadoTerminal {
  lotes: number;
  faltantes: number;
  abiertas: number;
}

/**
 * Abre las solicitudes de estado de cuenta de terminal que falten.
 *
 * Devuelve cuántas se abrieron DE VERDAD (no cuántas faltaban): las que ya
 * existían no cuentan, porque avisar de nuevo por algo ya pedido es lo que
 * convierte los avisos en ruido.
 */
export async function pedirEstadosDeCuentaDeTerminal(
  companyId: string,
  hoy = new Date(),
): Promise<ResultadoTerminal> {
  const desde = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() - MESES_ATRAS, 1));

  // Sólo abonos: una liquidación de terminal es dinero que ENTRA. Filtrarlo en
  // Postgres evita traerse el mes entero de movimientos para descartarlo en JS.
  const movimientos = await prisma.bankTransaction.findMany({
    where: { companyId, fecha: { gte: desde }, monto: { gt: 0 } },
    select: { id: true, fecha: true, descripcion: true, monto: true },
    orderBy: { fecha: "desc" },
    take: 5000,
  });

  const lotes = lotesDeTerminal(movimientos.map((m) => ({ ...m, monto: Number(m.monto) })));
  if (lotes.length === 0) return { lotes: 0, faltantes: 0, abiertas: 0 };

  const resueltos = await llavesResueltas(companyId, PREFIJO_TERMINAL);
  const faltantes = faltantesDeTerminal(lotes, resueltos, hoy);

  let abiertas = 0;
  for (const f of faltantes) {
    const r = await abrirSolicitud({
      companyId,
      tipo: "estado_cuenta_terminal",
      dedupeKey: f.dedupeKey,
      periodo: f.periodo,
      refs: f.movimientos,
      origen: "motor",
      detalle: f.detalle,
    });
    if (r.nueva) abiertas++;
  }
  return { lotes: lotes.length, faltantes: faltantes.length, abiertas };
}
