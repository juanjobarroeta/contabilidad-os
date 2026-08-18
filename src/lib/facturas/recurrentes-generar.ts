// ─────────────────────────────────────────────────────────────────────────────
// Generación de prefacturas a partir de las series recurrentes.
//
// Lo corre el cron diario. Para cada serie vencida crea UNA prefactura —el
// mismo FacturaBorrador que produce el alta manual— y adelanta la serie un
// periodo. No timbra: ver la nota en recurrentes.ts.
//
// La decisión de CUÁNDO vive en recurrentes.ts (puro y probado); aquí sólo se
// orquesta la escritura.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "../prisma";
import { createDraftInvoice, type StampInput } from "./stamp";
import { avanzar, debeGenerar, type Periodicidad } from "./recurrentes";

export type ResultadoSerie = {
  recurrenteId: string;
  nombre: string;
  companyId: string;
  ok: boolean;
  borradorId?: string;
  error?: string;
};

export type ResultadoGeneracion = {
  evaluadas: number;
  generadas: number;
  errores: number;
  resultados: ResultadoSerie[];
};

/**
 * Genera las prefacturas vencidas al día `hoy`.
 *
 * `soloCompanyId` acota la corrida a una empresa (útil para depurar sin tocar
 * la cartera entera).
 */
export async function generarRecurrentesPendientes(
  hoy: Date = new Date(),
  soloCompanyId?: string
): Promise<ResultadoGeneracion> {
  // El índice (activa, proximaEmision) sirve exactamente a esta consulta: sólo
  // bajan las series que YA vencieron, no la tabla entera.
  const series = await prisma.facturaRecurrente.findMany({
    where: {
      activa: true,
      proximaEmision: { lte: hoy },
      ...(soloCompanyId ? { companyId: soloCompanyId } : {}),
      // Una empresa desactivada no debe seguir generando papel.
      company: { isActive: true },
    },
    select: {
      id: true,
      nombre: true,
      companyId: true,
      customerId: true,
      payload: true,
      total: true,
      periodicidad: true,
      diaMes: true,
      proximaEmision: true,
      fin: true,
      activa: true,
    },
  });

  const resultados: ResultadoSerie[] = [];
  let generadas = 0;
  let errores = 0;

  for (const s of series) {
    const base = { recurrenteId: s.id, nombre: s.nombre, companyId: s.companyId };

    // Re-verifica con la misma función pura que usa la UI: la consulta filtra
    // por fecha, pero el corte por `fin` es de la lógica, no del índice.
    if (!debeGenerar({ activa: s.activa, proximaEmision: s.proximaEmision, fin: s.fin }, hoy)) {
      // Serie vencida cuyo `fin` ya pasó: se apaga para dejar de mirarla.
      await prisma.facturaRecurrente.update({
        where: { id: s.id },
        data: { activa: false },
      });
      continue;
    }

    const periodicidad = s.periodicidad as Periodicidad;
    const siguiente = avanzar(
      { activa: s.activa, proximaEmision: s.proximaEmision, fin: s.fin },
      periodicidad,
      s.diaMes
    );

    try {
      const input = s.payload as unknown as StampInput;
      const draft = await createDraftInvoice(input);
      if (!draft.ok) {
        // El PAC rechazó (cliente sin sincronizar, CSD vencido…). La serie NO
        // avanza: se reintenta mañana, y mientras tanto el error queda visible
        // en la respuesta del cron en vez de perderse.
        errores++;
        resultados.push({ ...base, ok: false, error: draft.error });
        continue;
      }

      // Crear el borrador y adelantar la serie van JUNTOS: si sólo se creara el
      // borrador, la siguiente corrida volvería a verla vencida y generaría un
      // duplicado del mismo periodo.
      const borrador = await prisma.$transaction(async (tx) => {
        const b = await tx.facturaBorrador.create({
          data: {
            companyId: s.companyId,
            customerId: s.customerId,
            draftId: draft.draftId,
            payload: s.payload as object,
            total: s.total,
          },
        });
        await tx.facturaRecurrente.update({
          where: { id: s.id },
          data: {
            proximaEmision: siguiente,
            ultimaEmision: hoy,
            generadas: { increment: 1 },
          },
        });
        return b;
      });

      generadas++;
      resultados.push({ ...base, ok: true, borradorId: borrador.id });
    } catch (e) {
      // Si la transacción falla DESPUÉS de crear el draft en el PAC, queda un
      // borrador huérfano allá y la serie sin avanzar: mañana se regenera. Es
      // el lado seguro del trato — un draft de más no consume timbre ni existe
      // ante el SAT, mientras que avanzar sin crear nada saltaría un periodo.
      errores++;
      resultados.push({ ...base, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return { evaluadas: series.length, generadas, errores, resultados };
}
