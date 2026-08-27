// ─────────────────────────────────────────────────────────────────────────────
// Depósito bancario (CREDITO) sin CFDI de ingreso conciliado = posible ingreso
// no facturado / mezcla personal en la cuenta del negocio. Alto valor pero MUY
// sensible a falsos positivos, por eso se restringe con varios candados:
//   · sólo abonos (tipo CREDITO / monto > 0), status UNMATCHED y sin invoiceId;
//   · sólo si la empresa concilia banco (reconciliacionActiva), si no → [];
//   · excluye no-ingresos obvios por `descripcion` (traspasos entre cuentas
//     propias, devoluciones, reembolsos, préstamos/crédito, intereses…);
//   · sólo mes actual + mes anterior (reciente) y montos ≥ UMBRAL_MONTO.
// Emite UN hallazgo agregado ("N depósitos sin factura por $X en <periodo>"),
// no uno por movimiento — poco ruido; el detalle vive en Bancos.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import { reconciliacionActiva } from "@/lib/fiscal/conciliacion-pue";
import type { Hallazgo } from "./types";

/** Monto mínimo de un depósito para considerarlo revisable (corta ruido chico). */
export const UMBRAL_MONTO = 1000;

/**
 * Denylist conservadora de conceptos que NO son ingreso facturable: traspasos
 * entre cuentas propias, devoluciones/reembolsos, préstamos / disposición de
 * crédito e intereses. Si la descripción contiene cualquiera de éstos, se excluye.
 */
const CONCEPTOS_EXCLUIDOS = [
  "traspaso",
  "transferencia entre cuentas",
  "entre cuentas propias",
  "cuenta propia",
  "spei a cuenta propia",
  "devolucion",
  "devolución",
  "reembolso",
  "prestamo",
  "préstamo",
  "disposicion de credito",
  "disposición de crédito",
  "disposicion de crédito",
  "linea de credito",
  "línea de crédito",
  "interes",
  "interés",
  "intereses",
  "rendimiento",
];

const fmt = (n: number) =>
  "$" + n.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

/** Normaliza acentos/mayúsculas para comparar contra la denylist. */
function normalizar(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/** ¿La descripción cae en la denylist de no-ingresos? */
export function esConceptoExcluido(descripcion: string): boolean {
  const d = normalizar(descripcion);
  return CONCEPTOS_EXCLUIDOS.some((kw) => d.includes(normalizar(kw)));
}

export interface DepositoSinCfdi {
  id: string;
  monto: number;
  fecha: Date;
  descripcion: string;
}

export interface IngresoNoFacturado {
  depositos: DepositoSinCfdi[];
  /** Etiqueta legible del periodo cubierto (mes actual + anterior). */
  periodo: string;
}

/**
 * Depósitos sin CFDI del mes actual + anterior, gated a empresas que concilian.
 * Devuelve `{ depositos: [], periodo }` cuando no aplica (sin falsos positivos).
 */
export async function cargarIngresoNoFacturado(
  companyId: string,
  hoy: Date,
): Promise<IngresoNoFacturado> {
  // Inicio del mes anterior (UTC) → fin = ahora. "Reciente" = ~2 meses.
  const desde = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() - 1, 1));
  const periodo = `${MESES[desde.getUTCMonth()]}–${MESES[hoy.getUTCMonth()]} ${hoy.getUTCFullYear()}`;

  if (!(await reconciliacionActiva(companyId))) return { depositos: [], periodo };

  const rows = await prisma.bankTransaction.findMany({
    where: {
      companyId,
      tipo: "CREDITO",
      status: "UNMATCHED",
      invoiceId: null,
      monto: { gte: UMBRAL_MONTO },
      fecha: { gte: desde },
    },
    select: { id: true, monto: true, fecha: true, descripcion: true },
    orderBy: { fecha: "asc" },
  });

  const depositos = rows
    .filter((r) => !esConceptoExcluido(r.descripcion))
    .map((r) => ({ id: r.id, monto: Number(r.monto), fecha: r.fecha, descripcion: r.descripcion }));

  return { depositos, periodo };
}

/** Un único hallazgo agregado para todos los depósitos sin factura (vacío → sin hallazgo). */
export function auditarIngresoNoFacturado(data: IngresoNoFacturado): Hallazgo[] {
  const { depositos, periodo } = data;
  if (depositos.length === 0) return [];

  const total = depositos.reduce((s, d) => s + d.monto, 0);
  return [
    {
      checkClave: "banco.ingreso_no_facturado",
      // Hallazgo AGREGADO (uno por empresa): identidad estable como los demás
      // checks agregados. Sin esto la llave concatenaba los IDs de todos los
      // depósitos y con cientos de movimientos sin conciliar desbordaba el
      // índice btree de FiscalHallazgo — el hallazgo nunca se guardaba.
      dedupeRef: "banco.ingreso_no_facturado",
      severidad: "warn",
      mensaje: `${depositos.length} depósito(s) sin CFDI de ingreso por ${fmt(total)} en ${periodo}: posible ingreso no facturado o movimiento personal en la cuenta del negocio.`,
      referencias: depositos.map((d) => d.id),
      fundamento: { ley: "LISR", articulo: "102" },
      sugerencia:
        "Revisa cada depósito en Bancos: si es ingreso del negocio, emite el CFDI y declara el IVA/ISR; si es un movimiento personal (préstamo, traspaso entre cuentas propias), márcalo como conciliado/no fiscal para que no distorsione la base. La autoridad compara los depósitos del banco contra los ingresos declarados (discrepancia fiscal).",
    },
  ];
}
