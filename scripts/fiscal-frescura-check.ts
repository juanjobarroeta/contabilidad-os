// Reporte de frescura del cerebro. Run: npm run fiscal:frescura-check
//   --strict  → falla si hay atrasos (warn). Para el cron de cierre de ejercicio.

import { revisarFrescura } from "../src/lib/fiscal/frescura";

const strict = process.argv.includes("--strict");
let fallos = 0;
function check(nombre: string, cond: boolean, detalle?: string) {
  if (!cond) fallos++;
  console.log(`  ${cond ? "✓" : "✗"} ${nombre}${!cond && detalle ? ` — ${detalle}` : ""}`);
}

// Hoy (2026): el cerebro está al día — ISN/UMA/SM tienen valores 2026, INPC fresco.
const HOY = new Date("2026-06-12T00:00:00Z");
console.log("frescura — ejercicio en curso (2026)");
const hoy = revisarFrescura(HOY);
const warnsHoy = hoy.filter((h) => h.severidad === "warn");
const infosHoy = hoy.filter((h) => h.severidad === "info");
for (const h of hoy) console.log(`    [${h.severidad}] ${h.clave}: ${h.mensaje}`);
check("sin atrasos (warn) en 2026", warnsHoy.length === 0, `${warnsHoy.map((w) => w.clave).join(",")}`);
check("backlog de pendientes reportado (info)", infosHoy.length >= 3);
check("INPC no aparece como atrasado", !hoy.some((h) => h.clave === "INPC" && h.severidad === "warn"));

// Futuro (2027): sin valores del nuevo ejercicio → ISN/UMA/SM atrasados, INPC atrasado.
console.log("frescura — ejercicio nuevo sin actualizar (2027)");
const fut = revisarFrescura(new Date("2027-03-01T00:00:00Z"));
const clavesWarn = fut.filter((h) => h.severidad === "warn").map((h) => h.clave);
check("ISN marcado atrasado en 2027", clavesWarn.includes("ISN"));
check("UMA marcada atrasada en 2027", clavesWarn.includes("UMA"));
check("salario mínimo marcado atrasado en 2027", clavesWarn.includes("SALARIO-MINIMO"));
check("INPC marcado atrasado en 2027", clavesWarn.includes("INPC"));

// Enero tiene gracia: no marca las anuales como atrasadas todavía.
console.log("frescura — gracia de enero");
const ene = revisarFrescura(new Date("2027-01-15T00:00:00Z"));
check("en enero NO marca ISN atrasado (gracia)", !ene.some((h) => h.clave === "ISN" && h.severidad === "warn"));

console.log("");
if (strict && warnsHoy.length > 0) {
  console.error(`Cerebro desactualizado: ${warnsHoy.length} fuente(s) atrasada(s).`);
  process.exit(1);
}
if (fallos === 0) {
  console.log("All checks passed.");
  process.exit(0);
} else {
  console.error(`${fallos} check(s) FAILED.`);
  process.exit(1);
}
