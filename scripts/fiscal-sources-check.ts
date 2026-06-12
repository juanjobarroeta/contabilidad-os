// Validates the fiscal sources registry. Run: npm run fiscal:sources-check

import {
  FUENTES,
  fuentesAuto,
  fuentesPendientes,
  fuentesPorCadencia,
} from "../src/lib/fiscal/sources";

let fallos = 0;
function check(nombre: string, cond: boolean, detalle?: string) {
  if (!cond) fallos++;
  console.log(`  ${cond ? "✓" : "✗"} ${nombre}${!cond && detalle ? ` — ${detalle}` : ""}`);
}

const CADENCIAS = ["diaria", "mensual", "anual", "por-publicacion"];
const CAPAS = ["narrativa", "reglas"];
const METODOS = ["auto", "semiauto", "manual"];
const ESTADOS = ["activo", "pendiente"];

console.log("registro de fuentes");
check("hay fuentes", FUENTES.length > 0);
check("claves únicas", new Set(FUENTES.map((f) => f.clave)).size === FUENTES.length);
check("cadencias válidas", FUENTES.every((f) => CADENCIAS.includes(f.cadencia)));
check("capas válidas", FUENTES.every((f) => CAPAS.includes(f.capa)));
check("métodos válidos", FUENTES.every((f) => METODOS.includes(f.metodo)));
check("estados válidos", FUENTES.every((f) => ESTADOS.includes(f.estado)));
check("todas traen refresco y autoridad", FUENTES.every((f) => f.refresco.length > 0 && f.autoridad.length > 0));

console.log("helpers");
check("fuentesAuto() solo auto+activo", fuentesAuto().every((f) => f.metodo === "auto" && f.estado === "activo"));
check("fuentesAuto incluye LISR/LIVA/CFF/LIEPS", ["LISR", "LIVA", "CFF", "LIEPS"].every((c) => fuentesAuto().some((f) => f.clave === c)));
check("ISN es anual y de capa reglas", fuentesPorCadencia("anual").some((f) => f.clave === "ISN" && f.capa === "reglas"));
check("INPC es mensual", fuentesPorCadencia("mensual").some((f) => f.clave === "INPC"));
check("hay pendientes en el backlog", fuentesPendientes().length > 0);

console.log("");
if (fallos === 0) {
  console.log(`All checks passed. (${FUENTES.length} fuentes, ${fuentesAuto().length} auto, ${fuentesPendientes().length} pendientes)`);
  process.exit(0);
} else {
  console.error(`${fallos} check(s) FAILED.`);
  process.exit(1);
}
