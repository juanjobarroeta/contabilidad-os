import { prisma } from "../prisma";

/**
 * FASE 2h — la SERIE del folio como decisión del contador.
 *
 * Hay ingreso que ningún documento clasifica solo. El back-end de una agencia
 * —comisión por colocar el financiamiento, GAP, garantía extendida, incentivos
 * de la planta— sale por CFDIs que no amparan unidad ni orden de taller, y el
 * concepto no basta: el mismo clave de producto sirve para un anticipo y para
 * una comisión.
 *
 * Lo que SÍ lo dice es la serie del folio, porque el DMS la usa para separar
 * justo eso. Medido en MARGOM sobre 2025, sin tocar nada más:
 *
 *   notas de cargo (serie NCA*)   $35,416,547  ·  CE 4501 declarado  $35,249,323
 *   seminuevos     (serie SM*)    $44,700,000  ·  CE 4291 declarado  $44,500,000
 *
 * 99.4% y 99.6%. Pero una serie es una convención de CADA empresa, no una regla
 * del SAT: «NCA» no significa nada fuera de este DMS. Por eso no vive en el
 * código sino como DECISIÓN, en la misma tabla de overrides del contador, con
 * el prefijo `serie:` — `serie:NCA` → 4501-0008. Una empresa sin reglas se
 * comporta exactamente como hoy.
 *
 * La regla se aplica SÓLO donde el motor ya se rindió: después de la unidad
 * (familia) y del taller. Así una decisión mal escrita no puede desviar una
 * venta que hoy resuelve bien; a lo más, llena el fallback.
 */
export const PREFIJO_REGLA_SERIE = "serie:";

export interface ReglaSerie {
  /** Prefijo de la serie del folio, en mayúsculas: "NCA", "SM". */
  prefijo: string;
  cuenta: { id: string; cuentaSAT: string; nombre: string; subcuenta?: string | null; tipo?: string };
}

/** Extrae el prefijo de un codigoMotor con forma `serie:XXX`; null si no lo es. */
export function prefijoDeCodigo(codigoMotor: string): string | null {
  if (!codigoMotor.startsWith(PREFIJO_REGLA_SERIE)) return null;
  const p = codigoMotor.slice(PREFIJO_REGLA_SERIE.length).trim().toUpperCase();
  return p.length > 0 ? p : null;
}

/**
 * La regla que aplica a una serie. Gana el prefijo MÁS LARGO: si el contador
 * definió `NCA` y también `NCAZ`, la sucursal Z manda sobre la regla general.
 */
export function reglaDeSerie(serie: string | null | undefined, reglas: ReglaSerie[]): ReglaSerie | null {
  const s = (serie ?? "").trim().toUpperCase();
  if (!s) return null;
  let mejor: ReglaSerie | null = null;
  for (const r of reglas) {
    if (!s.startsWith(r.prefijo)) continue;
    if (!mejor || r.prefijo.length > mejor.prefijo.length) mejor = r;
  }
  return mejor;
}


/** Las reglas de serie de la empresa (una consulta). Sin reglas → lista vacía. */
export async function cargarReglasSerie(companyId: string): Promise<ReglaSerie[]> {
  const filas = await prisma.postingCuentaOverride.findMany({
    where: { companyId, codigoMotor: { startsWith: PREFIJO_REGLA_SERIE } },
    include: {
      cuenta: { select: { id: true, cuentaSAT: true, nombre: true, subcuenta: true, tipo: true, isActive: true } },
    },
  });
  const out: ReglaSerie[] = [];
  for (const f of filas) {
    const prefijo = prefijoDeCodigo(f.codigoMotor);
    if (!prefijo || !f.cuenta.isActive) continue;
    out.push({ prefijo, cuenta: f.cuenta });
  }
  return out;
}
