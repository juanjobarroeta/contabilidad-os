// ─────────────────────────────────────────────────────────────────────────────
// BÚSQUEDA DEL ARCHIVO — lo que `GET /api/bancos/[id]?q=` significa.
//
// El archivo (tab Movimientos) mira todos los meses de corrido, así que su
// búsqueda tiene que pegarle al servidor: buscar en la página ya cargada
// diría «sin resultados» sobre un movimiento que sí existe tres meses atrás.
//
// Vive aquí, y no dentro del handler, porque el predicado se aplica en cuatro
// lugares (la lista, su total, los conteos por estado y los conteos por
// etiqueta) y porque el parseo del importe merece prueba propia.
// ─────────────────────────────────────────────────────────────────────────────

import type { Prisma } from "@prisma/client";

/**
 * `q` → filtro de Prisma, o null si no hay nada que buscar.
 *
 * Texto: concepto, contraparte, RFC y referencia, sin distinguir mayúsculas.
 * Importe: EXACTO y en los dos signos — quien teclea 17,400 busca ese cargo o
 * ese abono, no un parecido. Se aceptan `$`, comas y espacios porque es lo que
 * trae un importe copiado del estado de cuenta.
 */
export function filtroBusquedaArchivo(q: string): Prisma.BankTransactionWhereInput | null {
  const texto = q.trim();
  if (!texto) return null;

  const or: Prisma.BankTransactionWhereInput[] = [
    { descripcion: { contains: texto, mode: "insensitive" } },
    { contraparteNombre: { contains: texto, mode: "insensitive" } },
    { contraparteRfc: { contains: texto, mode: "insensitive" } },
    { referencia: { contains: texto, mode: "insensitive" } },
  ];

  const monto = importeBuscado(texto);
  if (monto !== null) or.push({ monto: { in: [monto, -monto] } });

  return { OR: or };
}

/** El importe que se tecleó, o null si lo tecleado no es un importe. */
export function importeBuscado(q: string): number | null {
  // Sólo dígitos, separadores de miles, punto decimal y un signo: cualquier
  // letra lo descarta. `Number("")` es 0 y `Number("-")` es NaN — los dos
  // tienen que caer fuera, o toda búsqueda de texto arrastraría un monto.
  const limpio = q.replace(/[$,\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(limpio)) return null;
  const n = Number(limpio);
  if (!Number.isFinite(n) || n === 0) return null;
  return Math.abs(n);
}

/**
 * Los meses del selector, vengan del agregado de Postgres (sin búsqueda) o de
 * las fechas que casaron con ella. Del más reciente al más viejo.
 */
export function mesesDelSelector(
  filas: { mes: string; n: bigint }[] | { fecha: Date }[],
): { mes: string; count: number }[] {
  if (filas.length === 0) return [];
  if ("mes" in filas[0]) {
    return (filas as { mes: string; n: bigint }[]).map((m) => ({ mes: m.mes, count: Number(m.n) }));
  }
  const porMes = new Map<string, number>();
  for (const { fecha } of filas as { fecha: Date }[]) {
    // `fecha` se guarda como instante UTC: el mismo corte que usa el filtro
    // `mes=YYYY-MM` del handler (Date.UTC), para que el conteo del selector y
    // la lista que sale al elegirlo no discrepen en el renglón del día 1.
    const k = fecha.toISOString().slice(0, 7);
    porMes.set(k, (porMes.get(k) ?? 0) + 1);
  }
  return [...porMes.entries()]
    .map(([mes, count]) => ({ mes, count }))
    .sort((a, b) => b.mes.localeCompare(a.mes));
}
