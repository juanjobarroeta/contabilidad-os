// ─────────────────────────────────────────────────────────────────────────────
// Cargos que el banco explica solo: comisiones, su IVA, impuestos, traspasos.
//
// No necesitan factura que buscar —o la factura llega una vez al mes, junta— y
// por eso se clasifican al importar en vez de ocupar la mesa de conciliación.
// La decisión es PURA para poder probarla contra los renglones reales; el
// import sólo la aplica.
// ─────────────────────────────────────────────────────────────────────────────

/** Tag de `IGNORED` que le toca al cargo, o null si no es de éstos. */
export type TagCargo =
  | "IVA_COMISION"
  | "PENDING_MONTHLY_CFDI"
  | "TAX_PAYMENT"
  | "INTERNAL_TRANSFER"
  | "BANK_NOISE";

/**
 * EL IVA DE UNA COMISIÓN, en las formas que de verdad imprimen los bancos.
 *
 * Va PRIMERO que la comisión: su renglón también dice «comisión» y con el
 * orden inverso el IMPUESTO se registra como GASTO — se pierde el IVA
 * acreditable y se infla el gasto. Ya pasó una vez con la abreviatura
 * «IVA COM.»; estas dos formas seguían colándose:
 *
 *   · «I V A POR COMISION» — con el IVA deletreado, `\biva\b` no pega;
 *   · «COBRO IVA AFIL.-…» — el IVA de la tasa de descuento de la terminal,
 *     que el adquirente cobra en renglón aparte.
 */
export function esIvaDeComision(desc: string): boolean {
  return (
    /\biva\b[\s.]*(com\b|com\.|comisi)/i.test(desc) ||
    /\bi\s*\.?\s*v\s*\.?\s*a\b[\s.]*(por\s+)?comisi/i.test(desc) ||
    /\bcobro\s+iva\b/i.test(desc)
  );
}

/**
 * Comisiones bancarias y DEL ADQUIRENTE.
 *
 * «Tasa de descuento» y «renta terminal» son comisiones aunque nunca digan la
 * palabra: son lo que cobra la terminal por cada venta y por el aparato. Su
 * CFDI llega mensual y junto, de ahí PENDING_MONTHLY_CFDI.
 */
export function esComisionBancaria(desc: string): boolean {
  return (
    !esIvaDeComision(desc) &&
    (/comisi[oó]n/i.test(desc) ||
      /tasa\s+de\s+descuento/i.test(desc) ||
      /renta\s+terminal/i.test(desc))
  );
}

/** Clasifica un cargo por su descripción. PURA. null = no es de éstos. */
export function clasificarCargoBancario(desc: string, monto: number): TagCargo | null {
  if (esIvaDeComision(desc)) return "IVA_COMISION";
  if (esComisionBancaria(desc)) return "PENDING_MONTHLY_CFDI";
  if (/pago\s+de\s+impuestos|^impuesto|recaudaci[oó]n|\bsat\b|tesofe/i.test(desc)) return "TAX_PAYMENT";
  if (/traspaso\s+(entre|a)\s+cuentas?\s+propias?|transferencia\s+propia/i.test(desc)) return "INTERNAL_TRANSFER";
  if (/compensaci[oó]n\s+por\s+retraso/i.test(desc) || monto === 0) return "BANK_NOISE";
  return null;
}
