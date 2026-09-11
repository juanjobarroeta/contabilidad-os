// ─────────────────────────────────────────────────────────────────────────────
// UN SOLO `where` PARA LA PANTALLA DE FACTURAS.
//
// La lista (/api/facturas), las tarjetas (/api/facturas/resumen) y el Excel
// (/api/facturas/export) tenían cada uno su copia del filtro — y las copias
// divergían: el resumen sólo sabía de `periodo`, así que al filtrar por tipo
// o buscar, la tabla cambiaba y las tarjetas de arriba seguían diciendo lo
// del periodo entero. Lo que el usuario filtra es lo que las cifras deben
// sumar; para eso los tres tienen que construir el MISMO `where` de los
// MISMOS parámetros.
//
// Contrato de `tipo` (ya vigente en lista y export): "CANCELLED" es un valor
// especial que trae SÓLO canceladas; cualquier tipo real las EXCLUYE. Una
// cancelada no es «te pagaron» ni candidata de conciliación, y el chip de la
// pantalla ya la trata como categoría propia.
// ─────────────────────────────────────────────────────────────────────────────

import type { Prisma } from "@prisma/client";
import { whereBusquedaFacturas } from "./busqueda";

export const TIPOS_FACTURA = ["INGRESO", "EGRESO", "TRASLADO", "NOMINA", "PAGO"] as const;
export type TipoFactura = (typeof TIPOS_FACTURA)[number];

export interface FiltrosLista {
  where: Prisma.InvoiceWhereInput;
  /** Tipo pedido, "CANCELLED", o null cuando no se filtró por tipo. */
  tipo: TipoFactura | "CANCELLED" | null;
  q: string | null;
  customerId: string | null;
  /** Ventana de fechas explícita (from/to) si vino válida. */
  fecha: { gte?: Date; lte?: Date } | null;
  /** ¿Hay algún filtro más allá de la ventana de fechas? */
  filtrado: boolean;
}

function fechaValida(s: string | null): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Construye el `where` de la pantalla a partir de la query string, para que la
 * lista, el resumen y el export lean exactamente los mismos parámetros:
 * `tipo`, `q`, `customerId`, `from`, `to`. Los inválidos se ignoran, como antes.
 */
export function filtrosListaFacturas(searchParams: URLSearchParams, companyId: string): FiltrosLista {
  const where: Prisma.InvoiceWhereInput = { companyId };

  const tipoParam = searchParams.get("tipo");
  let tipo: FiltrosLista["tipo"] = null;
  if (tipoParam === "CANCELLED") {
    where.status = "CANCELLED";
    tipo = "CANCELLED";
  } else if (tipoParam && (TIPOS_FACTURA as readonly string[]).includes(tipoParam)) {
    where.tipo = tipoParam as TipoFactura;
    where.status = { not: "CANCELLED" };
    tipo = tipoParam as TipoFactura;
  }

  const customerId = searchParams.get("customerId")?.trim() || null;
  if (customerId) where.customerId = customerId;

  const gte = fechaValida(searchParams.get("from"));
  const lte = fechaValida(searchParams.get("to"));
  const fecha = gte || lte ? { ...(gte ? { gte } : {}), ...(lte ? { lte } : {}) } : null;
  if (fecha) where.fecha = fecha;

  // Por palabras, no por frase: «victor bilbao» encuentra a VICTOR JOSE BILBAO.
  const q = searchParams.get("q")?.trim() || null;
  const busqueda = whereBusquedaFacturas(q ?? undefined);
  if (busqueda) where.AND = busqueda.AND;

  return { where, tipo, q, customerId, fecha, filtrado: !!(tipo || q || customerId) };
}
