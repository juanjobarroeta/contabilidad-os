// ─────────────────────────────────────────────────────────────────────────────
// Seed checks for the auditor. Each one pulls its threshold from the rules layer
// via getRule — never a hardcoded constant — and cites the rule it enforces.
// Adding a rule to the brain + a check here makes the contador catch that detail
// forever, for every company.
// ─────────────────────────────────────────────────────────────────────────────

import { getRule } from "../rules";
import type { CfdiNormalizado, FiscalCheck } from "./types";

/** SAT c_FormaPago "01" = Efectivo. */
const EFECTIVO = "01";

/** Combustibles: ClaveProdServ familia 1510… (señal confiable) o, en su defecto,
 *  por descripción inequívoca. Se omiten "magna/premium" como texto suelto: son
 *  grados de gasolina pero también aparecen fuera de combustible (falsos positivos);
 *  el ClaveProdServ 1510 ya cubre la estación de servicio real. */
function esCombustible(cfdi: CfdiNormalizado): boolean {
  const porClave = cfdi.items.some((i) => i.claveProdServ.startsWith("1510"));
  if (porClave) return true;
  return cfdi.items.some((i) =>
    /gasolina|di[ée]sel|combustible/i.test(i.descripcion ?? ""),
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
    const afectados = cfdis.filter(
      (c) => c.direccion === "RECIBIDA" && c.formaPago === EFECTIVO && esCombustible(c),
    );
    if (afectados.length === 0) return [];
    const n = afectados.length;
    const total = afectados.reduce((s, c) => s + c.total, 0);
    return [
      {
        checkClave: this.clave,
        severidad: this.severidad,
        mensaje:
          n === 1
            ? `CFDI de combustible por ${fmt(total)} pagado en efectivo: no deducible (requiere medio electrónico).`
            : `${n} CFDIs de combustible pagados en efectivo por ${fmt(total)} en total: no deducibles (requieren medio electrónico).`,
        referencias: afectados.map((c) => c.id),
        dedupeRef: this.clave,
        fundamento: regla.fundamento,
        sugerencia: this.sugerencia,
      },
    ];
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
    const afectados = cfdis.filter(
      (c) =>
        c.direccion === "RECIBIDA" &&
        c.formaPago === EFECTIVO &&
        c.total > limite &&
        !esCombustible(c), // el combustible ya lo marca su propio check
    );
    if (afectados.length === 0) return [];
    const n = afectados.length;
    const total = afectados.reduce((s, c) => s + c.total, 0);
    return [
      {
        checkClave: this.clave,
        severidad: this.severidad,
        mensaje:
          n === 1
            ? `Pago en efectivo por ${fmt(total)} excede el límite deducible de ${fmt(limite)}.`
            : `${n} pagos en efectivo por ${fmt(total)} en total exceden el límite deducible de ${fmt(limite)} por operación.`,
        referencias: afectados.map((c) => c.id),
        dedupeRef: this.clave,
        fundamento: regla.fundamento,
        sugerencia: this.sugerencia,
      },
    ];
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
    const afectados = cfdis.filter(
      (c) =>
        c.direccion === "EMITIDA" &&
        !!c.ivaTrasladado &&
        c.ivaTrasladado > 0 &&
        c.items.some((i) => /casa habitaci|vivienda/i.test(i.descripcion ?? "")),
    );
    if (afectados.length === 0) return [];
    const n = afectados.length;
    const iva = afectados.reduce((s, c) => s + (c.ivaTrasladado ?? 0), 0);
    return [
      {
        checkClave: this.clave,
        severidad: this.severidad,
        mensaje:
          n === 1
            ? `CFDI emitido de casa habitación con IVA trasladado de ${fmt(iva)}: la operación podría ser exenta.`
            : `${n} CFDIs emitidos de casa habitación con IVA trasladado por ${fmt(iva)} en total: la operación podría ser exenta.`,
        referencias: afectados.map((c) => c.id),
        dedupeRef: this.clave,
        fundamento: exenta.fundamento,
        sugerencia: this.sugerencia,
      },
    ];
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
    const afectados = cfdis.filter((c) => {
      const moneda = (c.moneda ?? "MXN").toUpperCase();
      if (moneda === "MXN" || moneda === "XXX") return false;
      return !(c.tipoCambio !== undefined && c.tipoCambio > 1);
    });
    if (afectados.length === 0) return [];
    const n = afectados.length;
    const total = afectados.reduce((s, c) => s + c.total, 0);
    return [
      {
        checkClave: this.clave,
        severidad: this.severidad,
        mensaje:
          n === 1
            ? `CFDI en moneda extranjera por ${fmt(total)} sin tipo de cambio válido.`
            : `${n} CFDIs en moneda extranjera por ${fmt(total)} en total sin tipo de cambio válido.`,
        referencias: afectados.map((c) => c.id),
        dedupeRef: this.clave,
        fundamento: this.fundamento,
        sugerencia: this.sugerencia,
      },
    ];
  },
};

/** Full check registry. */
export const CHECKS: FiscalCheck[] = [
  combustibleEfectivo,
  efectivoSobreLimite,
  casaHabitacionConIva,
  monedaExtranjeraSinTC,
];
