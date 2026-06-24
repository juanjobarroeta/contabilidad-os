// ─────────────────────────────────────────────────────────────────────────────
// Posibles CFDIs duplicados. Dos (o más) comprobantes de la misma dirección, a
// la misma contraparte, por el mismo importe y EL MISMO DÍA son sospechosos de
// duplicado (timbrado doble, doble carga, error de captura). No siempre es error
// —pueden ser dos operaciones reales idénticas el mismo día— por eso es WARN: el
// auditor lo levanta para que el humano confirme antes de declarar o cancelar.
// El día como ventana evita falsos positivos con recurrentes (renta mensual, etc).
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import type { Hallazgo } from "./types";

export interface GrupoDuplicado {
  ids: string[];
  direccion: "INGRESO" | "EGRESO";
  contraparte: string;
  total: number;
  fecha: string; // YYYY-MM-DD
}

const fmt = (n: number) =>
  "$" + n.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Agrupa CFDIs I/E vivos por (dirección, contraparte, importe, día). Grupos con
 * 2+ comprobantes son posibles duplicados. Sólo total > 0 (ignora REP/$0).
 */
export async function cargarPosiblesDuplicados(companyId: string): Promise<GrupoDuplicado[]> {
  const invoices = await prisma.invoice.findMany({
    where: {
      companyId,
      tipo: { in: ["INGRESO", "EGRESO"] },
      status: { not: "CANCELLED" },
      total: { gt: 0 },
    },
    select: {
      id: true,
      tipo: true,
      total: true,
      fecha: true,
      customer: { select: { razonSocial: true, rfc: true } },
    },
  });

  const grupos = new Map<string, { ids: string[]; tipo: "INGRESO" | "EGRESO"; contraparte: string; total: number; fecha: string }>();
  for (const inv of invoices) {
    const rfc = inv.customer?.rfc ?? "SIN_RFC";
    const fecha = inv.fecha.toISOString().slice(0, 10);
    const total = +inv.total.toFixed(2);
    const key = `${inv.tipo}|${rfc}|${total.toFixed(2)}|${fecha}`;
    const g = grupos.get(key);
    if (g) {
      g.ids.push(inv.id);
    } else {
      grupos.set(key, {
        ids: [inv.id],
        tipo: inv.tipo as "INGRESO" | "EGRESO",
        contraparte: inv.customer?.razonSocial ?? rfc,
        total,
        fecha,
      });
    }
  }

  return [...grupos.values()]
    .filter((g) => g.ids.length >= 2)
    .map((g) => ({ ids: g.ids, direccion: g.tipo, contraparte: g.contraparte, total: g.total, fecha: g.fecha }));
}

/** Un hallazgo por cada grupo de posibles duplicados. */
export function auditarDuplicados(grupos: GrupoDuplicado[]): Hallazgo[] {
  return grupos.map((g) => ({
    checkClave: "cfdi.posible_duplicado",
    severidad: "warn",
    mensaje: `${g.ids.length} CFDIs de ${g.direccion === "INGRESO" ? "ingreso" : "egreso"} casi idénticos a ${g.contraparte} por ${fmt(g.total)} el ${g.fecha} — posible duplicado.`,
    referencias: g.ids,
    fundamento: { ley: "CFF", articulo: "29-A" },
    sugerencia:
      g.direccion === "INGRESO"
        ? "Confirma con el cliente si son dos operaciones (y dos cobros) reales o un timbrado doble. Si es duplicado, cancela el de más (motivo 01/02) y, si ya se declaró, corrige el periodo; si son reales, déjalos."
        : "Verifica con el proveedor si son dos comprobantes legítimos o uno duplicado. Acreditar/deducir dos veces el mismo gasto es improcedente: si es duplicado, exclúyelo.",
  }));
}
