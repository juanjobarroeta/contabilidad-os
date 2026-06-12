// Verifies the INPC series + actualización helpers.
// Run: npm run fiscal:inpc-check          (correctness only; freshness warns)
//      npm run fiscal:inpc-check -- --strict   (freshness stale ⇒ fail; for cron)

import {
  INPC,
  actualizar,
  factorActualizacion,
  inpc,
  mesesAtrasado,
  ultimoPeriodo,
} from "../src/lib/fiscal/inpc";

const strict = process.argv.includes("--strict");
let fallos = 0;
function check(nombre: string, cond: boolean, detalle?: string) {
  if (!cond) fallos++;
  console.log(`  ${cond ? "✓" : "✗"} ${nombre}${!cond && detalle ? ` — ${detalle}` : ""}`);
}

console.log("serie INPC");
const periodos = Object.keys(INPC).sort();
check("hay serie", periodos.length > 0);
check("valores positivos", Object.values(INPC).every((v) => v > 0));
// Sin huecos: cada mes consecutivo desde el primero hasta el último.
let sinHuecos = true;
for (let i = 1; i < periodos.length; i++) {
  const [y0, m0] = periodos[i - 1].split("-").map(Number);
  const [y1, m1] = periodos[i].split("-").map(Number);
  if ((y1 - y0) * 12 + (m1 - m0) !== 1) sinHuecos = false;
}
check("serie mensual sin huecos", sinHuecos);
check("inpc('2025-12') = 143.042", inpc("2025-12") === 143.042, `got ${inpc("2025-12")}`);
check("inpc desconocido → null", inpc("1999-01") === null);

console.log("factor de actualización (Art. 17-A CFF)");
check("factor dic2024→dic2025 = 1.0369", factorActualizacion("2024-12", "2025-12") === 1.0369, `got ${factorActualizacion("2024-12", "2025-12")}`);
check("factor con periodo faltante → null", factorActualizacion("2024-12", "1990-01") === null);
check("actualizar 100,000 dic2024→dic2025 = 103,690", actualizar(100000, "2024-12", "2025-12") === 103690, `got ${actualizar(100000, "2024-12", "2025-12")}`);

console.log("frescura");
const atraso = mesesAtrasado();
console.log(`    último periodo: ${ultimoPeriodo()} · atraso: ${atraso} mes(es)`);
if (strict) {
  check(`serie al día (atraso ≤ 2 meses)`, atraso <= 2, `atraso de ${atraso} meses — agrega el INPC faltante por PR`);
} else if (atraso > 2) {
  console.log(`  ⚠ serie atrasada ${atraso} meses (no falla sin --strict)`);
}

console.log("");
if (fallos === 0) {
  console.log(`All checks passed. (${periodos.length} meses, ${periodos[0]}…${ultimoPeriodo()})`);
  process.exit(0);
} else {
  console.error(`${fallos} check(s) FAILED.`);
  process.exit(1);
}
