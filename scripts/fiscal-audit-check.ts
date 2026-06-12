// Verification harness for the auditor (the 24/7 contador).
// Run: npm run fiscal:audit-check   (exits non-zero on any failed assertion)

import { construirContexto, type CompanyLike } from "../src/lib/fiscal/rules";
import { auditar, listChecks, toCfdiNormalizado, type CfdiNormalizado } from "../src/lib/fiscal/audit";

let fallos = 0;
function check(nombre: string, cond: boolean, detalle?: string) {
  if (!cond) fallos++;
  console.log(`  ${cond ? "✓" : "✗"} ${nombre}${!cond && detalle ? ` — ${detalle}` : ""}`);
}

const FECHA = "2026-06-11";

const pf: CompanyLike = {
  rfc: "GOMC8001011A2", // PF
  regimenFiscal: "612",
  actividadEconomica: "Servicios de consultoría",
};
const constructora: CompanyLike = {
  rfc: "ABC120101AAA", // PM
  regimenFiscal: "601",
  actividadEconomica: "Construcción de inmuebles para vivienda",
};

const ctxPF = construirContexto(pf, FECHA);
const ctxConstr = construirContexto(constructora, FECHA);

// ── Sample normalized CFDIs ───────────────────────────────────────────────────
const cfdis: CfdiNormalizado[] = [
  // gasolina pagada en efectivo → check combustible (error)
  { id: "C1", direccion: "RECIBIDA", fecha: FECHA, formaPago: "01", total: 800,
    items: [{ claveProdServ: "15101514", descripcion: "Gasolina Magna" }] },
  // pago en efectivo de $5,000 (no combustible) → check límite efectivo (warn)
  { id: "C2", direccion: "RECIBIDA", fecha: FECHA, formaPago: "01", total: 5000,
    items: [{ claveProdServ: "01010101", descripcion: "Papelería" }] },
  // pago en efectivo de $500 (bajo el límite) → sin hallazgo
  { id: "C3", direccion: "RECIBIDA", fecha: FECHA, formaPago: "01", total: 500,
    items: [{ claveProdServ: "01010101", descripcion: "Café" }] },
  // transferencia de $9,000 → sin hallazgo (no es efectivo)
  { id: "C4", direccion: "RECIBIDA", fecha: FECHA, formaPago: "03", total: 9000,
    items: [{ claveProdServ: "01010101", descripcion: "Servicios" }] },
  // CFDI en USD sin tipo de cambio válido (TC=1) → check FX (warn)
  { id: "C5", direccion: "RECIBIDA", fecha: FECHA, formaPago: "03", total: 1000, moneda: "USD", tipoCambio: 1,
    items: [{ claveProdServ: "01010101", descripcion: "Software" }] },
  // CFDI en USD con TC válido → sin hallazgo
  { id: "C6", direccion: "RECIBIDA", fecha: FECHA, formaPago: "03", total: 1000, moneda: "USD", tipoCambio: 18.5,
    items: [{ claveProdServ: "01010101", descripcion: "Software" }] },
];

console.log("Auditor — PF");
const hPF = auditar(cfdis, ctxPF);
const claves = hPF.map((h) => h.checkClave);
check("combustible en efectivo detectado (C1)", hPF.some((h) => h.checkClave === "deduccion.combustible.efectivo" && h.referencias.includes("C1")));
check("efectivo > límite detectado (C2)", hPF.some((h) => h.checkClave === "deduccion.efectivo.limite" && h.referencias.includes("C2")));
check("USD sin TC válido detectado (C5)", hPF.some((h) => h.checkClave === "cfdi.moneda_extranjera_sin_tc" && h.referencias.includes("C5")));
check("USD con TC válido NO marcado (C6)", !hPF.some((h) => h.referencias.includes("C6")));
check("pago bajo el límite NO marcado (C3)", !hPF.some((h) => h.referencias.includes("C3")));
check("transferencia NO marcada (C4)", !hPF.some((h) => h.referencias.includes("C4")));
check("combustible NO duplicado por el check de límite", !claves.filter((c) => c === "deduccion.efectivo.limite").length || !hPF.some((h) => h.checkClave === "deduccion.efectivo.limite" && h.referencias.includes("C1")));
check("hallazgos ordenados por severidad (error antes que warn)", hPF.length >= 2 && hPF[0].severidad === "error");
check("cada hallazgo trae fundamento citable", hPF.every((h) => h.fundamento.ley && h.fundamento.articulo));
check("cada hallazgo trae sugerencia", hPF.every((h) => h.sugerencia.length > 0));

console.log("Auditor — sector gating");
check("check de casa habitación NO corre para PF", !listChecks(ctxPF).some((c) => c.clave === "iva.casa_habitacion.trasladado"));
check("check de casa habitación SÍ corre para CONSTRUCCION", listChecks(ctxConstr).some((c) => c.clave === "iva.casa_habitacion.trasladado"));

const ventaVivienda: CfdiNormalizado[] = [
  { id: "V1", direccion: "EMITIDA", fecha: FECHA, formaPago: "03", total: 1160000, ivaTrasladado: 160000,
    items: [{ claveProdServ: "80131500", descripcion: "Venta de casa habitación" }] },
];
const hConstr = auditar(ventaVivienda, ctxConstr);
check("casa habitación con IVA trasladado detectada (V1)", hConstr.some((h) => h.checkClave === "iva.casa_habitacion.trasladado" && h.referencias.includes("V1")));
check("misma venta NO marcada para PF (no CONSTRUCCION)", !auditar(ventaVivienda, ctxPF).some((h) => h.checkClave === "iva.casa_habitacion.trasladado"));

console.log("Adapter — toCfdiNormalizado");
const norm = toCfdiNormalizado(
  { id: "I1", fecha: new Date("2026-06-11T12:00:00Z"), formaPago: "01", total: 800,
    items: [{ claveProdServ: "15101514", descripcion: null }] },
  "RECIBIDA",
);
check("adapter mapea fecha a ISO yyyy-mm-dd", norm.fecha === "2026-06-11");
check("adapter normaliza descripcion null → undefined", norm.items[0].descripcion === undefined);
check("adapter produce CFDI auditables", auditar([norm], ctxPF).some((h) => h.referencias.includes("I1")));

console.log("");
if (fallos === 0) {
  console.log("All checks passed.");
  process.exit(0);
} else {
  console.error(`${fallos} check(s) FAILED.`);
  process.exit(1);
}
