import { Prisma } from "@prisma/client";

/**
 * Conversión profunda Prisma.Decimal → number para resultados de Prisma.
 *
 * Contexto (docs/FLOAT-DECIMAL.md): las columnas de dinero migran de Float
 * (float8) a Decimal (NUMERIC) por olas. Postgres pasa a guardar y agregar
 * exacto; la app sigue operando con number — mismo contrato que hoy — porque
 * este convertidor corre sobre TODO resultado del cliente compartido
 * (src/lib/prisma.ts), incluidos aggregate/groupBy y $queryRaw.
 *
 * Mientras no haya columnas Decimal, es un no-op barato.
 */

// |x| > 2^53-1 pierde precisión entera al pasar a number. Con dinero real
// nunca se alcanza (9,007 billones MXN); si aparece, es un dato corrupto y
// queremos enterarnos, no truncar en silencio.
const MAGNITUD_SEGURA = 9007199254740991;

function convertir(d: Prisma.Decimal): number {
  const n = d.toNumber();
  if (!Number.isFinite(n) || Math.abs(n) > MAGNITUD_SEGURA) {
    console.error(
      `[prisma-decimal] valor fuera del rango seguro de number al convertir: ${d.toString()}`
    );
  }
  return n;
}

/**
 * Recorre el resultado y sustituye todo Prisma.Decimal por number, en el
 * mismo objeto (los resultados de Prisma son árboles frescos, sin ciclos).
 * Respeta Date, Uint8Array/Buffer y primitivos.
 */
export function decimalesANumero<T>(data: T): T {
  if (data === null || typeof data !== "object") return data;
  if (Prisma.Decimal.isDecimal(data)) {
    return convertir(data as unknown as Prisma.Decimal) as unknown as T;
  }
  if (data instanceof Date || data instanceof Uint8Array) return data;
  if (Array.isArray(data)) {
    for (let i = 0; i < data.length; i++) data[i] = decimalesANumero(data[i]);
    return data;
  }
  const obj = data as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    obj[k] = decimalesANumero(obj[k]);
  }
  return data;
}
