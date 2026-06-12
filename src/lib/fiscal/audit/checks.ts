// ─────────────────────────────────────────────────────────────────────────────
// Seed checks for the auditor. Each one pulls its threshold from the rules layer
// via getRule — never a hardcoded constant — and cites the rule it enforces.
// Adding a rule to the brain + a check here makes the contador catch that detail
// forever, for every company.
// ─────────────────────────────────────────────────────────────────────────────

import { getRule } from "../rules";
import type { CfdiNormalizado, FiscalCheck, Hallazgo } from "./types";

/** SAT c_FormaPago "01" = Efectivo. */
const EFECTIVO = "01";

/** Combustibles: ClaveProdServ familia 1510… o por descripción. */
function esCombustible(cfdi: CfdiNormalizado): boolean {
  const porClave = cfdi.items.some((i) => i.claveProdServ.startsWith("1510"));
  if (porClave) return true;
  return cfdi.items.some((i) =>
    /gasolina|di[ée]sel|combustible|magna|premium/i.test(i.descripcion ?? ""),
  );
}

const fmt = (n: number) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(n);

// ── Check 1: combustible pagado en efectivo ──────────────────────────────────
// El combustible exige medio de pago electrónico a CUALQUIER monto (Art. 27-III).
const combustibleEfectivo: FiscalCheck = {
  clave: "deduccion.combustible.efectivo",
  descripcion: "Combustible pagado en efectivo (exige medio electrónico a cualquier monto)",
  aplicabilidad: { regimenes: "*", actividades: "*", tipoPersona: "*" },
  severidad: "error",
  fundamento: { ley: "LISR", articulo: "27", fraccion: "III" },
  sugerencia:
    "Paga el combustible con medio electrónico (tarjeta/transferencia) o reclasifica el CFDI como no deducible.",
  evaluar(cfdis, ctx) {
    const regla = getRule<boolean>(
      "isr.deduccion.combustible.requiere_medio_electronico",
      ctx,
    );
    if (!regla || regla.valor !== true) return [];
    const hallazgos: Hallazgo[] = [];
    for (const c of cfdis) {
      if (c.direccion !== "RECIBIDA") continue;
      if (c.formaPago !== EFECTIVO) continue;
      if (!esCombustible(c)) continue;
      hallazgos.push({
        checkClave: this.clave,
        severidad: this.severidad,
        mensaje: `CFDI de combustible por ${fmt(c.total)} pagado en efectivo: no deducible (requiere medio electrónico).`,
        referencias: [c.id],
        fundamento: regla.fundamento,
        sugerencia: this.sugerencia,
      });
    }
    return hallazgos;
  },
};

// ── Check 2: pago en efectivo sobre el límite ────────────────────────────────
// Erogaciones > $2,000 en efectivo no son deducibles (Art. 27-III).
const efectivoSobreLimite: FiscalCheck = {
  clave: "deduccion.efectivo.limite",
  descripcion: "Pago en efectivo por encima del límite deducible",
  aplicabilidad: { regimenes: "*", actividades: "*", tipoPersona: "*" },
  severidad: "warn",
  fundamento: { ley: "LISR", articulo: "27", fraccion: "III" },
  sugerencia:
    "Liquida con transferencia, cheque nominativo o tarjeta para conservar la deducción.",
  evaluar(cfdis, ctx) {
    const regla = getRule<number>("isr.deduccion.limite_efectivo", ctx);
    if (!regla) return [];
    const limite = regla.valor;
    const hallazgos: Hallazgo[] = [];
    for (const c of cfdis) {
      if (c.direccion !== "RECIBIDA") continue;
      if (c.formaPago !== EFECTIVO) continue;
      if (c.total <= limite) continue;
      if (esCombustible(c)) continue; // ya lo marca el check de combustible
      hallazgos.push({
        checkClave: this.clave,
        severidad: this.severidad,
        mensaje: `Pago en efectivo por ${fmt(c.total)} excede el límite deducible de ${fmt(limite)}.`,
        referencias: [c.id],
        fundamento: regla.fundamento,
        sugerencia: this.sugerencia,
      });
    }
    return hallazgos;
  },
};

// ── Check 3: casa habitación con IVA trasladado (sector CONSTRUCCION) ─────────
// La enajenación/construcción de casa habitación es exenta de IVA; trasladar 16%
// suele ser un error. Sector-gated: sólo corre para CONSTRUCCION.
const casaHabitacionConIva: FiscalCheck = {
  clave: "iva.casa_habitacion.trasladado",
  descripcion: "CFDI de casa habitación con IVA trasladado (probable exención no aplicada)",
  aplicabilidad: { regimenes: "*", actividades: ["CONSTRUCCION"], tipoPersona: "*" },
  severidad: "warn",
  fundamento: { ley: "LIVA", articulo: "9", fraccion: "II" },
  sugerencia:
    "Verifica si el inmueble es casa habitación: de serlo, la operación es exenta y no debe trasladarse IVA.",
  evaluar(cfdis, ctx) {
    const exenta = getRule<boolean>("iva.exencion.casa_habitacion", ctx);
    if (!exenta || exenta.valor !== true) return [];
    const hallazgos: Hallazgo[] = [];
    for (const c of cfdis) {
      if (c.direccion !== "EMITIDA") continue;
      if (!c.ivaTrasladado || c.ivaTrasladado <= 0) continue;
      const esVivienda = c.items.some((i) =>
        /casa habitaci|vivienda/i.test(i.descripcion ?? ""),
      );
      if (!esVivienda) continue;
      hallazgos.push({
        checkClave: this.clave,
        severidad: this.severidad,
        mensaje: `CFDI emitido de casa habitación con IVA trasladado de ${fmt(c.ivaTrasladado)}: la operación podría ser exenta.`,
        referencias: [c.id],
        fundamento: exenta.fundamento,
        sugerencia: this.sugerencia,
      });
    }
    return hallazgos;
  },
};

// ── Check 4: CFDI en moneda extranjera sin tipo de cambio válido ─────────────
// CFF Art. 20: las contribuciones se pagan en MXN; un CFDI en moneda extranjera
// debe traer el TipoCambio (al MXN). Un TC ausente o = 1 en un CFDI no-MXN suele
// ser un error de captura/importación que distorsiona ingresos/deducciones.
const monedaExtranjeraSinTC: FiscalCheck = {
  clave: "cfdi.moneda_extranjera_sin_tc",
  descripcion: "CFDI en moneda extranjera sin tipo de cambio válido",
  aplicabilidad: { regimenes: "*", actividades: "*", tipoPersona: "*" },
  severidad: "warn",
  fundamento: { ley: "CFF", articulo: "20" },
  sugerencia:
    "Captura el tipo de cambio del DOF (día anterior) en el CFDI; sin él, el monto en MXN queda mal valuado.",
  evaluar(cfdis) {
    const hallazgos: Hallazgo[] = [];
    for (const c of cfdis) {
      const moneda = (c.moneda ?? "MXN").toUpperCase();
      if (moneda === "MXN" || moneda === "XXX") continue;
      if (c.tipoCambio !== undefined && c.tipoCambio > 1) continue;
      hallazgos.push({
        checkClave: this.clave,
        severidad: this.severidad,
        mensaje: `CFDI en ${moneda} por ${fmt(c.total)} sin tipo de cambio válido (TC = ${c.tipoCambio ?? "n/d"}).`,
        referencias: [c.id],
        fundamento: this.fundamento,
        sugerencia: this.sugerencia,
      });
    }
    return hallazgos;
  },
};

/** Full check registry. */
export const CHECKS: FiscalCheck[] = [
  combustibleEfectivo,
  efectivoSobreLimite,
  casaHabitacionConIva,
  monedaExtranjeraSinTC,
];
