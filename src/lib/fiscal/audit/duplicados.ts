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

/**
 * UN caso por empresa: N grupos de posibles duplicados son UNA revisión, no N
 * renglones (un hallazgo = algo que se atiende, no una instancia). El dedupeRef
 * estable hace que el conteo cambie entre corridas sin abrir/cerrar el caso,
 * preservando el posponer/resolver del usuario — mismo patrón que rep-faltante
 * y los checks de banco.
 */
export function auditarDuplicados(grupos: GrupoDuplicado[]): Hallazgo[] {
  if (grupos.length === 0) return [];
  const g0 = grupos[0];
  if (grupos.length === 1) {
    return [{
      checkClave: "cfdi.posible_duplicado",
      severidad: "warn",
      mensaje: `${g0.ids.length} CFDIs de ${g0.direccion === "INGRESO" ? "ingreso" : "egreso"} casi idénticos a ${g0.contraparte} por ${fmt(g0.total)} el ${g0.fecha} — posible duplicado.`,
      referencias: [...g0.ids].sort(),
      dedupeRef: "cfdi.posible_duplicado",
      fundamento: { ley: "CFF", articulo: "29-A" },
      sugerencia: SUGERENCIA[g0.direccion],
    }];
  }
  const cfdis = grupos.reduce((s, g) => s + g.ids.length, 0);
  const monto = grupos.reduce((s, g) => s + g.total, 0);
  const ing = grupos.filter((g) => g.direccion === "INGRESO").length;
  const egr = grupos.length - ing;
  const partes = [ing > 0 ? `${ing} de ingreso` : null, egr > 0 ? `${egr} de egreso` : null]
    .filter(Boolean)
    .join(" y ");
  return [{
    checkClave: "cfdi.posible_duplicado",
    severidad: "warn",
    mensaje:
      `${cfdis} CFDIs casi idénticos en ${grupos.length} grupos (${partes}) por ${fmt(monto)} — posibles duplicados. ` +
      `P. ej. ${g0.contraparte} por ${fmt(g0.total)} el ${g0.fecha}.`,
    referencias: grupos.flatMap((g) => g.ids).sort(),
    dedupeRef: "cfdi.posible_duplicado",
    fundamento: { ley: "CFF", articulo: "29-A" },
    sugerencia:
      "Revisa cada grupo: si son operaciones reales idénticas, déjalas; si es timbrado doble, cancela el sobrante (motivo 01/02) y corrige el periodo si ya se declaró. En egresos, deducir dos veces el mismo gasto es improcedente.",
  }];
}

const SUGERENCIA: Record<"INGRESO" | "EGRESO", string> = {
  INGRESO:
    "Confirma con el cliente si son dos operaciones (y dos cobros) reales o un timbrado doble. Si es duplicado, cancela el de más (motivo 01/02) y, si ya se declaró, corrige el periodo; si son reales, déjalos.",
  EGRESO:
    "Verifica con el proveedor si son dos comprobantes legítimos o uno duplicado. Acreditar/deducir dos veces el mismo gasto es improcedente: si es duplicado, exclúyelo.",
};
