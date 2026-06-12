// Verification harness for the ISN (per-entidad, sucursales-aware) module.
// Run: npm run fiscal:isn-check   (exits non-zero on any failed assertion)

import { construirContexto, type CompanyLike } from "../src/lib/fiscal/rules";
import {
  auditarIsn,
  calcularIsnPorEntidad,
  empleadoNominaDesde,
  type EmpleadoNomina,
} from "../src/lib/fiscal/isn";

let fallos = 0;
function check(nombre: string, cond: boolean, detalle?: string) {
  if (!cond) fallos++;
  console.log(`  ${cond ? "✓" : "✗"} ${nombre}${!cond && detalle ? ` — ${detalle}` : ""}`);
}

const FECHA = "2026-06-11";
const company: CompanyLike = { rfc: "ABC120101AAA", regimenFiscal: "601", codigoPostal: "44100" };
const ctx = construirContexto(company, FECHA);

// JAL (3%), CMX (4%), one inactive (excluded), one with invalid entidad.
const empleados: EmpleadoNomina[] = [
  { id: "e1", entidad: "JAL", baseMensual: 100000, activo: true },
  { id: "e2", entidad: "JAL", baseMensual: 50000, activo: true },
  { id: "e3", entidad: "CMX", baseMensual: 80000, activo: true },
  { id: "e4", entidad: undefined, baseMensual: 40000, activo: true },
  { id: "e5", entidad: "JAL", baseMensual: 99999, activo: false },
];

console.log("calcularIsnPorEntidad — sucursales");
const resumen = calcularIsnPorEntidad(empleados, ctx);
const jal = resumen.porEntidad.find((r) => r.entidad === "JAL");
const cmx = resumen.porEntidad.find((r) => r.entidad === "CMX");
check("dos entidades con nómina (sucursales)", resumen.numEntidades === 2);
check("JAL agrupa 2 empleados activos", jal?.numEmpleados === 2);
check("JAL base = 150,000", jal?.baseMensual === 150000, `got ${jal?.baseMensual}`);
check("JAL ISN = 4,500 (3%)", jal?.isn === 4500, `got ${jal?.isn}`);
check("CMX ISN = 3,200 (4%)", cmx?.isn === 3200, `got ${cmx?.isn}`);
check("empleado inactivo excluido (no 250k base)", (jal?.baseMensual ?? 0) === 150000);
check("1 empleado sin entidad válida", resumen.empleadosSinEntidad === 1);
check("ISN total = 7,700", resumen.isnTotal === 7700, `got ${resumen.isnTotal}`);
check("ordenado por ISN desc (JAL antes que CMX)", resumen.porEntidad[0].entidad === "JAL");
check("tasa ISN marcada verificado:false", jal?.verificado === false);

console.log("auditarIsn — Hallazgos");
const h = auditarIsn(empleados, ctx);
const claves = h.map((x) => x.checkClave);
check("obligación ISN por estado (JAL y CMX)", h.filter((x) => x.checkClave === "isn.obligacion").length === 2);
check("alerta multi-estado (sucursales)", claves.includes("isn.multiestado"));
check("multi-estado severidad warn", h.find((x) => x.checkClave === "isn.multiestado")?.severidad === "warn");
check("alerta empleados sin entidad", claves.includes("isn.empleados_sin_entidad"));
check("cada Hallazgo trae sugerencia", h.every((x) => x.sugerencia.length > 0));

console.log("auditarIsn — una sola entidad (sin sucursales)");
const soloJAL = auditarIsn([{ id: "x", entidad: "JAL", baseMensual: 30000, activo: true }], ctx);
check("sin alerta multi-estado cuando hay un solo estado", !soloJAL.some((x) => x.checkClave === "isn.multiestado"));
check("sí emite obligación ISN del estado único", soloJAL.some((x) => x.checkClave === "isn.obligacion"));

console.log("adapter — empleadoNominaDesde");
const a1 = empleadoNominaDesde({ id: "p1", salarioDiario: 1000, claveEntFed: "JAL", isActive: true });
check("claveEntFed válida → entidad", a1.entidad === "JAL");
check("base mensual = salarioDiario × 30.4", a1.baseMensual === 30400, `got ${a1.baseMensual}`);
const a2 = empleadoNominaDesde({ id: "p2", salarioDiario: 1000, claveEntFed: "ZZZ", isActive: true });
check("claveEntFed inválida → entidad undefined", a2.entidad === undefined);

console.log("");
if (fallos === 0) {
  console.log("All checks passed.");
  process.exit(0);
} else {
  console.error(`${fallos} check(s) FAILED.`);
  process.exit(1);
}
