// Verification harness for the AGAPES exención. Run: npm run fiscal:agapes-check

import { construirContexto, type CompanyLike } from "../src/lib/fiscal/rules";
import { exencionAgapesAnual } from "../src/lib/fiscal/agapes";

let fallos = 0;
function check(nombre: string, cond: boolean, detalle?: string) {
  if (!cond) fallos++;
  console.log(`  ${cond ? "✓" : "✗"} ${nombre}${!cond && detalle ? ` — ${detalle}` : ""}`);
}

const FECHA = "2026-06-11"; // UMA anual 2026 = 42,794.64
const UMA_ANUAL = 42794.64;

// PF agricultor (RFC 13 → PF), forzamos actividad AGAPES.
const pf: CompanyLike = { rfc: "GOMC8001011A2", regimenFiscal: "612", actividadEconomica: "Agricultura" };
const ctxPF = construirContexto(pf, FECHA, { actividades: ["AGAPES"] });
// PM ganadera (RFC 12 → PM), régimen 622 ⇒ AGAPES inferido.
const pm: CompanyLike = { rfc: "ABC120101AAA", regimenFiscal: "622", actividadEconomica: "Ganadería" };
const ctxPM = construirContexto(pm, FECHA);

console.log("AGAPES exención — PF");
const ePF = exencionAgapesAnual(ctxPF);
check("PF resuelve exención", ePF !== null);
check("PF factor = 40 UMA", ePF?.factorUMA === 40, `got ${ePF?.factorUMA}`);
check("PF exención = 40 × UMA anual", ePF?.exencionMXN === Math.round(40 * UMA_ANUAL * 100) / 100, `got ${ePF?.exencionMXN}`);
check("PF cita Art. 74 LISR", ePF?.fundamento.ley === "LISR" && ePF?.fundamento.articulo === "74");
check("verificado:false (factor AGAPES sin cotejar)", ePF?.verificado === false);

console.log("AGAPES exención — PM");
const pm3 = exencionAgapesAnual(ctxPM, { socios: 3 });
check("PM régimen 622 ⇒ AGAPES, resuelve", pm3 !== null);
check("PM 3 socios → 60 UMA", pm3?.factorUMA === 60, `got ${pm3?.factorUMA}`);
check("PM 3 socios exención = 60 × UMA anual", pm3?.exencionMXN === Math.round(60 * UMA_ANUAL * 100) / 100, `got ${pm3?.exencionMXN}`);
const pm15 = exencionAgapesAnual(ctxPM, { socios: 15 });
check("PM 15 socios topado a 200 UMA (no 300)", pm15?.factorUMA === 200, `got ${pm15?.factorUMA}`);
check("PM default 1 socio cuando no se indica", exencionAgapesAnual(ctxPM)?.factorUMA === 20);

console.log("AGAPES — no aplica fuera del sector");
const noAgapes = construirContexto({ rfc: "ABC120101AAA", regimenFiscal: "601" }, FECHA);
check("empresa no-AGAPES → null", exencionAgapesAnual(noAgapes) === null);

console.log("");
if (fallos === 0) {
  console.log("All checks passed.");
  process.exit(0);
} else {
  console.error(`${fallos} check(s) FAILED.`);
  process.exit(1);
}
