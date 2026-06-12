// Verification harness for the structured fiscal rules layer.
// Run: npm run fiscal:rules-check   (exits non-zero on any failed assertion)
//
// No test runner is configured in this repo; this mirrors the existing fiscal:*
// ts-node scripts and gives the rules layer an auditable, runnable check.

import {
  construirContexto,
  estadoDesdeCP,
  getRule,
  inferSectores,
  inferTipoPersona,
  listRules,
  type CompanyLike,
  type Sector,
  type Tabla,
} from "../src/lib/fiscal/rules";

let fallos = 0;
function check(nombre: string, cond: boolean, detalle?: string) {
  const ok = cond ? "✓" : "✗";
  if (!cond) fallos++;
  console.log(`  ${ok} ${nombre}${!cond && detalle ? ` — ${detalle}` : ""}`);
}

const FECHA = "2026-06-11";

// ── Sector inference ──────────────────────────────────────────────────────────
console.log("Sector inference");
const constructora: CompanyLike = {
  rfc: "ABC120101AAA", // 12 chars → PM
  regimenFiscal: "601",
  actividadEconomica: "Construcción de inmuebles para vivienda",
};
const agroPM: CompanyLike = { rfc: "XYZ100101BBB", regimenFiscal: "622", actividadEconomica: null };
const personaFisica: CompanyLike = {
  rfc: "GOMC8001011A2", // 13 chars → PF
  regimenFiscal: "626",
  actividadEconomica: "Servicios de consultoría",
};

check("PM RFC (12) → PM", inferTipoPersona(constructora.rfc) === "PM");
check("PF RFC (13) → PF", inferTipoPersona(personaFisica.rfc) === "PF");
check(
  "actividadEconomica 'Construcción…' → CONSTRUCCION",
  inferSectores(constructora).includes("CONSTRUCCION"),
);
check("régimen 622 → AGAPES", inferSectores(agroPM).includes("AGAPES"));
check("régimen 626 consultoría → sin sector especial", inferSectores(personaFisica).length === 0);

// ── getRule: universal rule ───────────────────────────────────────────────────
console.log("getRule — universal");
const ctxPF = construirContexto(personaFisica, FECHA);
const iva = getRule<number>("iva.tasa.general", ctxPF);
check("IVA general resuelve", iva !== null);
check("IVA general = 0.16", iva?.valor === 0.16, `got ${iva?.valor}`);
check("IVA general cita LIVA art. 1", iva?.fundamento.ley === "LIVA" && iva?.fundamento.articulo === "1");
check("IVA general verificado", iva?.verificado === true);

const tope = getRule<number>("isr.deduccion.auto.tope_moi", ctxPF);
check("tope auto = 175000", tope?.valor === 175000, `got ${tope?.valor}`);

// ── getRule: sector-gated rule ────────────────────────────────────────────────
console.log("getRule — sector-gated");
const ctxConstr = construirContexto(constructora, FECHA);
const exencion = getRule<boolean>("iva.exencion.casa_habitacion", ctxConstr);
check("casa habitación exenta aplica a CONSTRUCCION", exencion?.valor === true);
check(
  "casa habitación NO aplica a PF consultoría",
  getRule("iva.exencion.casa_habitacion", ctxPF) === null,
);

// ── getRule: null contract ────────────────────────────────────────────────────
console.log("getRule — null contract");
check("clave inexistente → null", getRule("no.existe", ctxPF) === null);

// ── vigencia / time-travel ────────────────────────────────────────────────────
console.log("vigencia");
const ctxAntiguo = construirContexto(personaFisica, "2010-01-01");
check(
  "IVA general no existe antes de su vigencia (2014)",
  getRule("iva.tasa.general", ctxAntiguo) === null,
);

// ── DEPRECIATION table + verificado propagation ───────────────────────────────
console.log("tablas / verificado");
const dep = getRule<Tabla>("isr.depreciacion.tasas", ctxPF);
check("tabla depreciación resuelve", dep !== null);
check("equipo_transporte = 0.25", dep?.valor.equipo_transporte === 0.25, `got ${dep?.valor.equipo_transporte}`);
check("tabla depreciación marcada verificado:false", dep?.verificado === false);

// ── listRules ─────────────────────────────────────────────────────────────────
console.log("listRules");
const universales = listRules(ctxPF).map((r) => r.clave);
check("listRules(PF) no incluye reglas de CONSTRUCCION", !universales.includes("iva.exencion.casa_habitacion"));
const construccion = listRules(ctxConstr).map((r) => r.clave);
check("listRules(CONSTRUCCION) incluye exención casa habitación", construccion.includes("iva.exencion.casa_habitacion"));
const soloRates: Sector[] = [];
void soloRates;
check(
  "listRules filtro tipo=RATE sólo devuelve RATE",
  listRules(ctxPF, { tipo: "RATE" }).every((r) => r.tipo === "RATE"),
);
check("listRules dedup por clave (sin claves repetidas)", new Set(universales).size === universales.length);

// ── Entidad / jurisdicción (ISN) ──────────────────────────────────────────────
console.log("entidad / ISN");
check("CP 44100 → JAL", estadoDesdeCP("44100") === "JAL");
check("CP 64000 → NLE", estadoDesdeCP("64000") === "NLE");
check("CP 06700 → CMX", estadoDesdeCP("06700") === "CMX");
check("CP inválido → undefined", estadoDesdeCP("abc") === undefined);

const empJAL = construirContexto(
  { rfc: "ABC120101AAA", regimenFiscal: "601", codigoPostal: "44100" },
  FECHA,
);
const empNLE = construirContexto(
  { rfc: "ABC120101AAA", regimenFiscal: "601", codigoPostal: "64000" },
  FECHA,
);
const empCMX = construirContexto(
  { rfc: "ABC120101AAA", regimenFiscal: "601", codigoPostal: "06700" },
  FECHA,
);
const isnJAL = getRule<number>("isn.tasa", empJAL);
const isnNLE = getRule<number>("isn.tasa", empNLE);
const isnCMX = getRule<number>("isn.tasa", empCMX);
check("ISN Jalisco = 0.03", isnJAL?.valor === 0.03, `got ${isnJAL?.valor}`);
check("ISN Nuevo León = 0.03", isnNLE?.valor === 0.03, `got ${isnNLE?.valor}`);
check("ISN CDMX = 0.04 (subió de 3%)", isnCMX?.valor === 0.04, `got ${isnCMX?.valor}`);
check("ISN marcado verificado:false", isnJAL?.verificado === false);
check("ISN trae nota de matiz cuando aplica", (isnJAL?.nota ?? "").length > 0);
check("ISN cita ley estatal", (isnJAL?.fundamento.ley ?? "").includes("Jalisco"));
check(
  "ISN no resuelve sin entidad conocida",
  getRule("isn.tasa", construirContexto({ rfc: "ABC120101AAA", regimenFiscal: "601" }, FECHA)) === null,
);
check("regla federal (IVA) sigue resolviendo con entidad presente", getRule("iva.tasa.general", empJAL)?.valor === 0.16);

// ── Result ────────────────────────────────────────────────────────────────────
console.log("");
if (fallos === 0) {
  console.log("All checks passed.");
  process.exit(0);
} else {
  console.error(`${fallos} check(s) FAILED.`);
  process.exit(1);
}
