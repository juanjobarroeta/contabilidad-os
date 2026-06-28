// ─────────────────────────────────────────────────────────────────────────────
// Movimientos bancarios desactualizados. Una cuenta con actividad histórica
// cuyo último movimiento es viejo = falta el estado de cuenta del periodo (no se
// subió, o la conexión bancaria se cayó). Sin esos movimientos, la conciliación
// y el IVA de flujo quedan incompletos. Cubre el caso "me faltan los movimientos
// de la semana pasada". Sólo cuentas con historial (≥1 tx) — evita ruido con
// cuentas recién creadas o sin usar.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import type { Hallazgo } from "./types";

/** Días sin movimientos a partir de los cuales una cuenta activa se marca atrasada. */
export const UMBRAL_DIAS = 14;

const DIA_MS = 24 * 60 * 60 * 1000;

export interface CuentaDesactualizada {
  accountId: string;
  etiqueta: string;
  ultimaFecha: string; // YYYY-MM-DD
  dias: number;
}

/** Cuentas con ≥1 movimiento cuyo último movimiento tiene > UMBRAL_DIAS. */
export async function cargarBancoDesactualizado(
  companyId: string,
  hoy: Date,
): Promise<CuentaDesactualizada[]> {
  const cuentas = await prisma.bankAccount.findMany({
    where: { companyId },
    select: { id: true, banco: true, nombre: true, numeroCuenta: true },
  });
  if (cuentas.length === 0) return [];

  const maxByAccount = await prisma.bankTransaction.groupBy({
    by: ["bankAccountId"],
    where: { bankAccountId: { in: cuentas.map((c) => c.id) } },
    _max: { fecha: true },
  });
  const ultimaPorCuenta = new Map(maxByAccount.map((m) => [m.bankAccountId, m._max.fecha]));

  const items: CuentaDesactualizada[] = [];
  for (const c of cuentas) {
    const ultima = ultimaPorCuenta.get(c.id);
    if (!ultima) continue; // sin historial → no es "se atrasó", es "nunca se usó"
    const dias = Math.floor((hoy.getTime() - ultima.getTime()) / DIA_MS);
    if (dias <= UMBRAL_DIAS) continue;
    const last4 = c.numeroCuenta.slice(-4);
    items.push({
      accountId: c.id,
      etiqueta: `${c.banco} ${c.nombre} ••${last4}`,
      ultimaFecha: ultima.toISOString().slice(0, 10),
      dias,
    });
  }
  return items;
}

/** Un hallazgo por cuenta atrasada. */
export function auditarBancoDesactualizado(items: CuentaDesactualizada[]): Hallazgo[] {
  return items.map((i) => ({
    checkClave: "banco.movimientos_desactualizados",
    severidad: "warn",
    mensaje: `La cuenta ${i.etiqueta} no registra movimientos desde hace ${i.dias} días (último: ${i.ultimaFecha}). Puede faltar el estado de cuenta del periodo.`,
    referencias: [i.accountId],
    fundamento: { ley: "CFF", articulo: "28" },
    sugerencia:
      "Sube el estado de cuenta más reciente en Bancos (o revisa la conexión bancaria). Sin los movimientos al día, la conciliación y el IVA de flujo (cobrado/pagado) quedan incompletos.",
  }));
}
