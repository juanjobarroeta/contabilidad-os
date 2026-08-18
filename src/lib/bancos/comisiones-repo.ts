import { prisma } from "@/lib/prisma";
import { vincularComisiones, type MovimientoComision } from "./comisiones";

// ─────────────────────────────────────────────────────────────────────────────
// Aplica los vínculos comisión → transferencia sobre una cuenta.
//
// Vive aparte del motor puro porque toca la base; el motor decide, esto
// escribe. Lo usan DOS caminos: el import (al terminar de meter un estado de
// cuenta) y el backfill (para las comisiones que ya estaban guardadas).
//
// Idempotente: sólo toca comisiones que aún no tienen vínculo, y nunca
// desvincula. Best-effort: un fallo aquí no debe tumbar una importación —
// quedarse sin el vínculo es cosmético, perder el estado de cuenta no.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ventana de búsqueda hacia atrás. El banco cobra la comisión el mismo día o
 * en el corte, así que un mes cubre de sobra sin arrastrar la cuenta entera.
 */
export const DIAS_VENTANA_BUSQUEDA = 31;

export async function vincularComisionesDeCuenta(
  bankAccountId: string,
  opts: { desde?: Date } = {}
): Promise<{ vinculadas: number }> {
  const desde =
    opts.desde ?? new Date(Date.now() - DIAS_VENTANA_BUSQUEDA * 86_400_000);

  const movs = await prisma.bankTransaction.findMany({
    where: {
      bankAccountId,
      // Sólo egresos: una comisión no cuelga de un depósito, y traer los
      // abonos sólo agranda el conjunto que el motor va a descartar.
      monto: { lt: 0 },
      fecha: { gte: desde },
    },
    select: {
      id: true,
      fecha: true,
      monto: true,
      descripcion: true,
      claveRastreo: true,
      referencia: true,
      comisionDeId: true,
    },
    take: 5_000,
  });
  if (movs.length === 0) return { vinculadas: 0 };

  const yaVinculadas = new Set(movs.filter((m) => m.comisionDeId).map((m) => m.id));
  const entrada: MovimientoComision[] = movs.map((m) => ({
    id: m.id,
    fecha: m.fecha,
    monto: m.monto,
    descripcion: m.descripcion,
    claveRastreo: m.claveRastreo,
    referencia: m.referencia,
  }));

  const vinculos = vincularComisiones(entrada).filter((v) => !yaVinculadas.has(v.comisionId));

  let vinculadas = 0;
  for (const v of vinculos) {
    try {
      await prisma.bankTransaction.update({
        where: { id: v.comisionId },
        data: { comisionDeId: v.transferenciaId },
      });
      vinculadas++;
    } catch {
      // best-effort por fila
    }
  }
  return { vinculadas };
}
