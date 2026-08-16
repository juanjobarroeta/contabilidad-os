// ─────────────────────────────────────────────────────────────────────────────
// Nombrar cuentas STUB del catálogo con nombres CONFIRMADOS por evidencia.
//
// importarBalanza (ce-import-apply.ts) da de alta las cuentas de detalle que la
// balanza usa y el catálogo no trae, con `nombre = numCta`, esperando que «el
// nombre real llegue cuando la empresa remande el catálogo». En MARGOM ese
// catálogo no va a llegar: el contador dejó de presentar el CT después de
// 2025-03 (las balanzas siguen hasta 2026-06), y los CT que sí presentó omiten
// cuentas EN USO — 9200-0007 y 6602-0001 traían saldo en la balanza 2025-03 y
// no aparecen en el CT de 2025-03. Verificado el 2026-08-16 descargando los
// seis CT de numeración nueva (2024-10 → 2025-03) de Syntage: NINGUNO trae los
// 16 códigos stub. La extracción electronic_accounting del 2026-08-08 cubrió
// 2015→2026-08 completa: no es hueco de extracción, no re-disparar.
//
// Cuando un stub se confirma por evidencia externa (p.ej. la familia 28 =
// TRAVELER, cuadrada al centavo contra el padrón vehicular), este módulo lo
// nombra siguiendo la CONVENCIÓN del propio contador. La aplicación es
// conservadora: sólo toca cuentas que SIGUEN siendo stub (nombre === código) —
// un nombre puesto a mano o por un catálogo remandado nunca se pisa.
//
// Parte pura (planNombrarStubs) separada de la aplicación con DB, como en
// ce-import.ts / ce-import-apply.ts. La aplica scripts/nombrar-stubs-margom.ts.
// ─────────────────────────────────────────────────────────────────────────────

export interface CuentaCatalogoExistente {
  id: string;
  cuentaSAT: string;
  subcuenta: string | null;
  nombre: string;
  naturaleza: string | null;
  nivel: number;
}

export interface NombreConfirmado {
  /** Código completo de la cuenta (NumCta de la balanza, p.ej. "1301-0028-0000"). */
  codigo: string;
  nombre: string;
  /** Sólo si el stub la derivó mal (p.ej. 4201-* es contra-ingreso: D). */
  naturaleza?: "D" | "A";
  /** Nivel que le daría importarCatalogo (los CT de MARGOM usan 2 para detalle). */
  nivel?: number;
  /** Por qué este nombre es seguro. Va al log del script, no a la base. */
  evidencia: string;
}

export interface ActualizacionStub {
  id: string;
  codigo: string;
  data: { nombre: string; naturaleza?: string; nivel?: number };
  evidencia: string;
}

export interface PlanNombrarStubs {
  actualizaciones: ActualizacionStub[];
  omitidas: { codigo: string; razon: "no existe" | "ya tiene nombre" }[];
}

/** El código canónico de una cuenta es su subcuenta si la tiene, si no el mayor. */
const codigoDe = (c: CuentaCatalogoExistente) => c.subcuenta ?? c.cuentaSAT;

/**
 * Decide qué stubs actualizar. Puro: no toca la base.
 *
 * Sólo propone cuentas cuyo nombre actual ES el código (siguen siendo stub);
 * lo demás se reporta como omitido con su razón. Idempotente por construcción:
 * tras aplicar el plan, un segundo plan sale vacío.
 */
export function planNombrarStubs(
  existentes: CuentaCatalogoExistente[],
  confirmados: NombreConfirmado[],
): PlanNombrarStubs {
  const porCodigo = new Map(existentes.map((c) => [codigoDe(c), c]));
  const plan: PlanNombrarStubs = { actualizaciones: [], omitidas: [] };

  for (const conf of confirmados) {
    const cuenta = porCodigo.get(conf.codigo);
    if (!cuenta) {
      plan.omitidas.push({ codigo: conf.codigo, razon: "no existe" });
      continue;
    }
    if (cuenta.nombre !== codigoDe(cuenta)) {
      plan.omitidas.push({ codigo: conf.codigo, razon: "ya tiene nombre" });
      continue;
    }
    const data: ActualizacionStub["data"] = { nombre: conf.nombre };
    if (conf.naturaleza !== undefined && conf.naturaleza !== cuenta.naturaleza) data.naturaleza = conf.naturaleza;
    if (conf.nivel !== undefined && conf.nivel !== cuenta.nivel) data.nivel = conf.nivel;
    plan.actualizaciones.push({ id: cuenta.id, codigo: conf.codigo, data, evidencia: conf.evidencia });
  }

  return plan;
}

export const COMPANY_MARGOM = "cmsjf1wna003kn70fb68bqhm4";

/**
 * Familia 28 de MARGOM = TRAVELER. Confirmada el 2026-08-16 cruzando las
 * balanzas presentadas (Syntage) contra el padrón vehicular:
 *
 *   • Ventas TRAVELER 2025 en el padrón: $6,049,258.62 = saldo acumulado de
 *     4101-0028-0000 en la balanza 2025-12 (-6,049,259), AL CENTAVO.
 *   • Primera compra TRAVELER: 2025-06-30 — exactamente cuando la familia 28
 *     aparece en las balanzas (ausente en 2025-06, presente en 2025-09).
 *   • Piso al 2026-06-30: 10 unidades / $6,811,207 vs 1301-0028 $6,983,187
 *     (la diferencia es flete/preparación capitalizados, como en toda familia).
 *
 * Los nombres siguen la plantilla del propio CT 2025-03 (familias 0001–0027):
 * «INVENTARIO VEHICULOS NUEVOS X» / «VENTA NUEVOS X» / «COSTO NUEVOS X» /
 * «DESCUENTO NUEVOS X». 4201-* es contra-ingreso: naturaleza D en el CT
 * (el stub la derivó A por el primer dígito). Nivel 2 = detalle, como sus
 * hermanas importadas del CT.
 */
export const NOMBRES_FAMILIA_28_MARGOM: NombreConfirmado[] = [
  {
    codigo: "1301-0028-0000",
    nombre: "INVENTARIO VEHICULOS NUEVOS TRAVELER",
    nivel: 2,
    evidencia: "piso TRAVELER 2026-06-30: 10 u / $6,811,207 vs saldo $6,983,187 (dif = costos capitalizados)",
  },
  {
    codigo: "4101-0028-0000",
    nombre: "VENTA NUEVOS TRAVELER",
    nivel: 2,
    evidencia: "ventas TRAVELER 2025 $6,049,258.62 = acumulado 4101-0028 en balanza 2025-12, al centavo",
  },
  {
    codigo: "5101-0028-0000",
    nombre: "COSTO NUEVOS TRAVELER",
    nivel: 2,
    evidencia: "costo padrón de vendidas 2025 $5,448,966 vs 5101-0028 $5,586,550 (dif = costos capitalizados)",
  },
  {
    codigo: "4201-0028-0000",
    nombre: "DESCUENTO NUEVOS TRAVELER",
    naturaleza: "D",
    nivel: 2,
    evidencia: "plantilla 4201-00XX «DESCUENTO NUEVOS <familia>»; Natur=D en CT 2025-03 (el stub decía A)",
  },
];
