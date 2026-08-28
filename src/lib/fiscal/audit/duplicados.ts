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

/** Fila mínima para el agrupador — pura, sin Prisma. */
export interface CfdiParaDuplicados {
  id: string;
  tipo: "INGRESO" | "EGRESO";
  total: number;
  fecha: string; // YYYY-MM-DD
  rfc: string | null;
  nombre: string | null;
}

/** RFC genérico de público en general (venta mostrador). */
const RFC_PUBLICO_GENERAL = "XAXX010101000";

// ── Perillas de precisión ────────────────────────────────────────────────────
// Un duplicado ACCIDENTAL real (doble timbrado por timeout del PAC, doble
// facturación del proveedor) tiene forma de PAR aislado; las operaciones
// recurrentes idénticas (combustible de flotilla, cuota estándar de servicio)
// tienen forma de patrón. Los datos de prod lo confirmaron: sin estos filtros,
// una automotriz acumulaba 7,335 "grupos" que eran su operación diaria.
/** Máximo de CFDIs idénticos en un día para sospechar duplicado (4+ = patrón). */
const MAX_TAMANO_GRUPO = 3;
/** Si (contraparte, importe) se repite en 3+ días distintos, es un precio de
 *  lista/cuota recurrente, no un accidente. */
const MAX_DIAS_RECURRENCIA = 2;
/** Importe mínimo del comprobante para levantar el caso (eco del umbral de
 *  deducción en efectivo, LISR 27-III). Un par de tickets chicos no amerita
 *  la llamada al proveedor. */
const MIN_TOTAL_MXN = 2000;

/**
 * Agrupa CFDIs I/E vivos por (dirección, contraparte, importe, día). La señal
 * exige la forma de un duplicado accidental:
 *  - Contraparte IDENTIFICADA: sin RFC no hay grupo (una cubeta "desconocidos"
 *    fabricaba duplicados falsos entre proveedores distintos — el 99% de los
 *    13,916 hallazgos en prod), y XAXX010101000 (público en general) tampoco:
 *    tickets idénticos el mismo día son operación normal de mostrador.
 *  - PAR aislado, no patrón: 2–3 comprobantes el mismo día, con un importe que
 *    NO se repite en 3+ días del historial, y por monto material (≥ $2,000).
 * Costo del filtro: una doble facturación sistemática (misma cuota cada día)
 * no se levanta aquí — ese es un problema de conciliación, no de timbrado.
 */
export function agruparPosiblesDuplicados(cfdis: CfdiParaDuplicados[]): GrupoDuplicado[] {
  const grupos = new Map<string, { ids: string[]; tipo: "INGRESO" | "EGRESO"; contraparte: string; total: number; fecha: string }>();
  const diasPorPrecio = new Map<string, Set<string>>();
  for (const inv of cfdis) {
    if (!inv.rfc || inv.rfc === RFC_PUBLICO_GENERAL) continue;
    const total = +inv.total.toFixed(2);
    const clavePrecio = `${inv.tipo}|${inv.rfc}|${total.toFixed(2)}`;
    const dias = diasPorPrecio.get(clavePrecio) ?? new Set<string>();
    dias.add(inv.fecha);
    diasPorPrecio.set(clavePrecio, dias);

    const key = `${clavePrecio}|${inv.fecha}`;
    const g = grupos.get(key);
    if (g) {
      g.ids.push(inv.id);
    } else {
      grupos.set(key, {
        ids: [inv.id],
        tipo: inv.tipo,
        contraparte: inv.nombre ?? inv.rfc,
        total,
        fecha: inv.fecha,
      });
    }
  }

  return [...grupos.entries()]
    .filter(([key, g]) => {
      if (g.ids.length < 2 || g.ids.length > MAX_TAMANO_GRUPO) return false;
      if (g.total < MIN_TOTAL_MXN) return false;
      const clavePrecio = key.slice(0, key.lastIndexOf("|"));
      return (diasPorPrecio.get(clavePrecio)?.size ?? 0) <= MAX_DIAS_RECURRENCIA;
    })
    .map(([, g]) => ({ ids: g.ids, direccion: g.tipo, contraparte: g.contraparte, total: g.total, fecha: g.fecha }));
}

/** Sólo total > 0 (ignora REP/$0). La contraparte sale de `customer` o, en su
 *  defecto, de los datos del comprobante (contraparteRfc — típico en EGRESOS,
 *  que no tienen Customer ligado). */
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
      contraparteRfc: true,
      contraparteNombre: true,
      customer: { select: { razonSocial: true, rfc: true } },
    },
  });

  return agruparPosiblesDuplicados(
    invoices.map((inv) => ({
      id: inv.id,
      tipo: inv.tipo as "INGRESO" | "EGRESO",
      total: Number(inv.total),
      fecha: inv.fecha.toISOString().slice(0, 10),
      rfc: inv.customer?.rfc ?? inv.contraparteRfc,
      nombre: inv.customer?.razonSocial ?? inv.contraparteNombre,
    })),
  );
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
