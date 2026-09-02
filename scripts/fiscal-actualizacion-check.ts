// Verifies the generic actualización layer + INPC freshness.
// Run: npm run fiscal:actualizacion-check            (freshness warns)
//      npm run fiscal:actualizacion-check -- --strict  (stale ⇒ fail; for cron)

import {
  actualizar,
  factorActualizacion,
  inpcPeriodo,
  mesesAtrasadoInpc,
} from "../src/lib/fiscal/actualizacion";
import { coberturaInpc } from "../src/lib/fiscal/inpc";

const strict = process.argv.includes("--strict");
let fallos = 0;
function check(nombre: string, cond: boolean, detalle?: string) {
  if (!cond) fallos++;
  console.log(`  ${cond ? "✓" : "✗"} ${nombre}${!cond && detalle ? ` — ${detalle}` : ""}`);
}

console.log("INPC por periodo");
check("inpc '2024-01' (serie base) = 133.555", inpcPeriodo("2024-01") === 133.555, `got ${inpcPeriodo("2024-01")}`);
check("inpc '2025-12' (suplemento) = 143.042", inpcPeriodo("2025-12") === 143.042, `got ${inpcPeriodo("2025-12")}`);
check("periodo mal formado → null", inpcPeriodo("2025/12") === null);
// Un periodo FUERA de la cobertura (la serie empieza en 2016): usar un mes que
// algún día se cargue (pasó con 2023-12) convierte este check en un rojo falso
// que enmascara al de frescura — el workflow estuvo rojo por ESTO mientras el
// atraso real crecía sin que nadie lo viera.
check("mes no cargado → null", inpcPeriodo("2015-01") === null);

console.log("factor de actualización (Art. 17-A CFF)");
check("dic2024→dic2025 = 1.0369", factorActualizacion("2024-12", "2025-12") === 1.0369, `got ${factorActualizacion("2024-12", "2025-12")}`);
check("actualizar 100,000 dic24→dic25 = 103,690", actualizar(100000, "2024-12", "2025-12") === 103690, `got ${actualizar(100000, "2024-12", "2025-12")}`);
check("factor con periodo faltante → null", factorActualizacion("2024-12", "2015-01") === null);

console.log("frescura INPC");
const atraso = mesesAtrasadoInpc();
const cob = coberturaInpc();
console.log(`    cobertura ./inpc: ${cob?.year}-${String(cob?.month).padStart(2, "0")} · atraso: ${atraso} mes(es)`);
if (strict) {
  check("serie al día (atraso ≤ 2 meses)", atraso <= 2, `atraso de ${atraso} meses — actualiza la serie INPC`);
} else if (atraso > 2) {
  console.log(`  ⚠ serie atrasada ${atraso} meses (no falla sin --strict)`);
}

console.log("");
if (fallos === 0) {
  console.log("All checks passed.");
  process.exit(0);
} else {
  console.error(`${fallos} check(s) FAILED.`);
  process.exit(1);
}
