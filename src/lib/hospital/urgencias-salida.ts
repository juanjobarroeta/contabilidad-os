// ─────────────────────────────────────────────────────────────────────────────
// Salir de Urgencias con la cuenta cerrada.
//
// Urgencias se cobra aparte: antes de trasladar al paciente a otra área
// (hospitalización, terapia, quirófano…) lo que deba de urgencias se cobra.
// «Cerrada» = la parte del paciente (todo, si no hay convenio; deducible y
// coaseguro, si lo hay) menos sus depósitos vigentes llega a cero. Entre
// camas de Urgencias se traslada libre.
// ─────────────────────────────────────────────────────────────────────────────

import type { HospArea, PrismaClient } from "@prisma/client";
import { calcularCuenta } from "./cuenta";
import { resumenDepositos } from "./depositos";
import { asegurarCargosEstancia } from "./estancia";
import { cargoParaCuenta, pagadorResumen } from "./serializar";
import { r2 } from "./util";

const TOLERANCIA = 0.009;

/** ¿Este traslado sale de Urgencias? (de una cama de Urgencias, o de un ingreso de urgencias sin cama, a otra área). */
export function saleDeUrgencias(a: { tipoEpisodio: string; areaOrigen: HospArea | null | undefined; areaDestino: HospArea }): boolean {
  const enUrgencias = a.areaOrigen ? a.areaOrigen === "URGENCIAS" : a.tipoEpisodio === "URGENCIAS";
  return enUrgencias && a.areaDestino !== "URGENCIAS";
}

/** Lo que el paciente todavía debe del episodio: su parte de la cuenta menos depósitos recibidos o aplicados. */
export async function saldoPacienteEpisodio(db: PrismaClient, episodioId: string, ahora = new Date()): Promise<number> {
  await asegurarCargosEstancia(db, episodioId, ahora);
  const ep = await db.hospEpisodio.findUniqueOrThrow({
    where: { id: episodioId },
    include: { pagador: true, cargos: true, depositos: { select: { estado: true, monto: true } } },
  });
  const cuenta = calcularCuenta({ cargos: ep.cargos.map(cargoParaCuenta), pagador: pagadorResumen(ep.pagador) });
  const partePaciente = ep.pagador ? cuenta.reparto.paciente : cuenta.totales.total;
  return r2(partePaciente - resumenDepositos(ep.depositos).vigentes);
}

export function mensajeCuentaUrgencias(folio: string, saldo: number): string {
  return `Antes de trasladar fuera de Urgencias cierra la cuenta de ${folio}: el paciente debe $${saldo.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}. Cóbralo en la cuenta (depósito o cobro en caja) y vuelve a trasladar.`;
}

export const debePagarAntes = (saldo: number) => saldo > TOLERANCIA;
