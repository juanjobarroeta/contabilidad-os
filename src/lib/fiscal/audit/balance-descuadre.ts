// ─────────────────────────────────────────────────────────────────────────────
// El balance no cuadra / falta el lado del efectivo.
//
// Salió de mirar producción. La empresa más grande del sistema tenía esto en su
// balance de 2025:
//
//   105.01 Clientes nacionales      $4,044,520,545
//   201.01 Proveedores nacionales   $3,916,506,942
//   208.01 IVA trasladado cobrado     $547,479,480
//   ...y NINGUNA cuenta de caja ni de bancos.
//
// Cuatro mil millones en clientes y cero pesos de efectivo: cada CFDI postea su
// cuenta por cobrar o por pagar, y el lado del dinero nunca entra porque los
// movimientos bancarios no están conciliados. Los saldos se acumulan y no se
// liquidan nunca.
//
// El daño no es cosmético: de esos saldos salen el balance general, el ajuste
// anual por inflación y la contabilidad electrónica que se manda al SAT. El
// ajuste ya aprendió a callar cuando el libro no cuadra — pero callar sin decir
// por qué deja al contador con un dato que desaparece sin explicación. Este
// hallazgo dice por qué.
// ─────────────────────────────────────────────────────────────────────────────

import { balanceGeneralDesdeBalanza } from "@/lib/contabilidad/libro";
import { balanza } from "@/lib/contabilidad/posting";
import { prisma } from "@/lib/prisma";
import type { Hallazgo } from "./types";

/** Descuadre tolerado (proporción del activo) antes de levantar la voz. */
export const TOLERANCIA_DESCUADRE = 0.01;

/** Cuentas de efectivo del código agrupador: caja y bancos. */
export const CUENTAS_EFECTIVO = ["101", "102"];

export interface BalanceDescuadre {
  companyId: string;
  /** Último periodo posteado; null si la empresa no tiene ninguno. */
  periodo: { year: number; month: number } | null;
  totalActivo: number;
  descuadre: number;
  /** Suma de saldos en caja y bancos al cierre del periodo. */
  saldoEfectivo: number;
  /** Saldo de clientes y deudores: lo que debería estar cobrándose. */
  saldoPorCobrar: number;
}

/** Lee el último periodo POSTEADO y saca de él la foto del balance. */
export async function cargarBalanceDescuadre(companyId: string): Promise<BalanceDescuadre> {
  const vacio: BalanceDescuadre = {
    companyId,
    periodo: null,
    totalActivo: 0,
    descuadre: 0,
    saldoEfectivo: 0,
    saldoPorCobrar: 0,
  };

  // El mes 13 es el cierre: la foto del balance se toma del último mes normal.
  const ultimo = await prisma.accountingPeriod.findFirst({
    where: { companyId, month: { lte: 12 }, status: { in: ["POSTED", "CLOSED"] } },
    select: { year: true, month: true },
    orderBy: [{ year: "desc" }, { month: "desc" }],
  });
  if (!ultimo) return vacio;

  const filas = await balanza(companyId, ultimo.year, ultimo.month);
  const bg = balanceGeneralDesdeBalanza(filas);

  // Sólo cuentas de DETALLE, como el balance general: sumar además las de
  // agrupación contaría cada peso dos veces.
  const detalle = filas.filter((f) => f.nivel >= 3);
  const sumaDe = (prefijos: string[]) =>
    detalle
      .filter((f) => prefijos.includes(f.cuentaSAT))
      .reduce((s, f) => s + f.saldoFinal, 0);

  return {
    companyId,
    periodo: { year: ultimo.year, month: ultimo.month },
    totalActivo: bg.totalActivo,
    descuadre: bg.descuadre,
    saldoEfectivo: sumaDe(CUENTAS_EFECTIVO),
    // Clientes, cuentas por cobrar y deudores diversos.
    saldoPorCobrar: sumaDe(["105", "106", "107"]),
  };
}

const fmt = (n: number) =>
  n.toLocaleString("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 });

/**
 * Dos hallazgos posibles sobre el mismo balance, del más específico al más
 * general — nunca los dos: si falta el lado del efectivo, ésa ES la causa del
 * descuadre y decir además "no cuadra" sólo hace ruido.
 */
export function auditarBalanceDescuadre(data: BalanceDescuadre): Hallazgo[] {
  if (!data.periodo) return [];
  const base = Math.abs(data.totalActivo);
  if (base <= 0) return [];

  const { year, month } = data.periodo;
  const periodoTxt = `${year}-${String(month).padStart(2, "0")}`;

  // Caso específico: hay cartera pero no hay dinero. No es un descuadre
  // cualquiera, es el lado del efectivo que nunca se posteó.
  if (data.saldoEfectivo === 0 && data.saldoPorCobrar > 0) {
    return [
      {
        checkClave: "contabilidad.sin_lado_efectivo",
        severidad: "error",
        mensaje:
          `Tu balance a ${periodoTxt} trae ${fmt(data.saldoPorCobrar)} por cobrar y CERO en caja y bancos: ` +
          `se está registrando la factura pero no el cobro, así que los saldos crecen y nunca se liquidan.`,
        referencias: [data.companyId],
        dedupeRef: "contabilidad.sin_lado_efectivo",
        fundamento: { ley: "CFF", articulo: "28" },
        sugerencia:
          "Sube los estados de cuenta en Bancos y concilia los movimientos: al conciliar se postea el lado del efectivo y los saldos de clientes y proveedores empiezan a bajar. De este balance salen el balance general, el ajuste anual por inflación y la contabilidad electrónica.",
      },
    ];
  }

  const relativo = Math.abs(data.descuadre) / base;
  if (relativo > TOLERANCIA_DESCUADRE) {
    return [
      {
        checkClave: "contabilidad.balance_descuadrado",
        severidad: "error",
        mensaje:
          `Tu balance a ${periodoTxt} no cuadra por ${fmt(Math.abs(data.descuadre))} ` +
          `(${(relativo * 100).toFixed(1)}% del activo): activo ≠ pasivo + capital.`,
        referencias: [data.companyId],
        dedupeRef: "contabilidad.balance_descuadrado",
        fundamento: { ley: "CFF", articulo: "28" },
        sugerencia:
          "Revisa los meses posteados en Contabilidad → Cierres: un periodo con asientos incompletos descuadra todo lo que viene después. Mientras no cuadre, el ajuste anual por inflación no se puede determinar.",
      },
    ];
  }

  return [];
}
