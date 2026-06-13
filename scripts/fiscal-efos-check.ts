// Verifica el parser y la revisión 69-B/EFOS. Run: npm run fiscal:efos-check

import { parseEfosCsv, revisarEfos, revisarRfcs, type CfdiProveedor, type RfcEntrada } from "../src/lib/fiscal/efos";

let fallos = 0;
function check(nombre: string, cond: boolean, detalle?: string) {
  if (!cond) fallos++;
  console.log(`  ${cond ? "✓" : "✗"} ${nombre}${!cond && detalle ? ` — ${detalle}` : ""}`);
}

// CSV de muestra con el layout del SAT (filas de título + header + datos).
const CSV = [
  "Listado completo de contribuyentes Art. 69-B",
  "Fecha de corte: 2026-06-01",
  '"No.","RFC","Nombre del Contribuyente","Situación del contribuyente","Oficio"',
  '1,"EFD010101AAA","Empresa Definitiva SA","Definitivo","123/2025"',
  '2,"EFP020202BBB","Empresa Presunta SA","Presunto","124/2025"',
  '3,"EFV030303CCC","Empresa Desvirtuada SA","Desvirtuado","125/2025"',
  '4,"EFS040404DDD","Empresa con Sentencia SA","Sentencia Favorable","126/2025"',
].join("\n");

console.log("parseEfosCsv");
const lista = parseEfosCsv(CSV);
check("parsea 4 RFCs", lista.size === 4);
check("EFD…→ DEFINITIVO", lista.get("EFD010101AAA") === "DEFINITIVO");
check("EFP…→ PRESUNTO", lista.get("EFP020202BBB") === "PRESUNTO");
check("EFV…→ DESVIRTUADO", lista.get("EFV030303CCC") === "DESVIRTUADO");
check("EFS…→ SENTENCIA_FAVORABLE", lista.get("EFS040404DDD") === "SENTENCIA_FAVORABLE");
check("CSV sin header reconocible → vacío", parseEfosCsv("solo,texto\nsin,rfc").size === 0);

console.log("revisarEfos");
const recibidos: CfdiProveedor[] = [
  { id: "A1", emisorRfc: "EFD010101AAA", fecha: "2026-05-01", total: 100000 }, // definitivo
  { id: "A2", emisorRfc: "EFD010101AAA", fecha: "2026-05-15", total: 50000 }, // mismo definitivo
  { id: "B1", emisorRfc: "EFP020202BBB", fecha: "2026-05-10", total: 30000 }, // presunto
  { id: "C1", emisorRfc: "EFV030303CCC", fecha: "2026-05-10", total: 9000 }, // desvirtuado → ok
  { id: "D1", emisorRfc: "XAXX010101000", fecha: "2026-05-10", total: 500 }, // limpio
];
const h = revisarEfos(recibidos, lista);
const def = h.find((x) => x.checkClave === "efos.definitivo");
const pre = h.find((x) => x.checkClave === "efos.presunto");
check("detecta proveedor DEFINITIVO (error)", def?.severidad === "error");
check("agrupa los 2 CFDIs del definitivo", def?.referencias.length === 2 && def.referencias.includes("A1") && def.referencias.includes("A2"));
check("definitivo suma $150,000 en el mensaje", /\$150,000/.test(def?.mensaje ?? ""));
check("detecta PRESUNTO (warn)", pre?.severidad === "warn" && pre.referencias.includes("B1"));
check("desvirtuado NO marcado", !h.some((x) => x.referencias.includes("C1")));
check("proveedor limpio NO marcado", !h.some((x) => x.referencias.includes("D1")));
check("cita CFF 69-B", (def?.fundamento.articulo ?? "") === "69-B");
check("definitivo ordenado antes que presunto", h[0].severidad === "error");
check("lista vacía → sin hallazgos", revisarEfos(recibidos, new Map()).length === 0);

console.log("revisarRfcs (propio + contrapartes)");
const entradas: RfcEntrada[] = [
  { rfc: "EFD010101AAA", rol: "PROPIO" }, // tu RFC es EFOS definitivo
  { rfc: "EFP020202BBB", rol: "CONTRAPARTE", nombre: "Proveedor Presunto SA" },
  { rfc: "EFD010101AAA", rol: "CONTRAPARTE" }, // duplicado del propio → no se repite
  { rfc: "GOOD010101XXX", rol: "CONTRAPARTE", nombre: "Cliente Limpio" }, // limpio
];
const hr = revisarRfcs(entradas, lista);
check("RFC propio definitivo → error", hr.some((x) => x.checkClave === "efos.propio.definitivo" && x.severidad === "error"));
check("contraparte presunta → warn", hr.some((x) => x.checkClave === "efos.contraparte.presunto" && x.severidad === "warn"));
check("dedup por RFC (no repite EFD…)", hr.filter((x) => x.referencias.includes("EFD010101AAA")).length === 1);
check("RFC limpio NO marcado", !hr.some((x) => x.referencias.includes("GOOD010101XXX")));
check("error ordenado antes que warn", hr[0].severidad === "error");
check("sin entradas en lista → sin hallazgos", revisarRfcs([{ rfc: "GOOD010101XXX", rol: "PROPIO" }], lista).length === 0);

console.log("");
if (fallos === 0) {
  console.log("All checks passed.");
  process.exit(0);
} else {
  console.error(`${fallos} check(s) FAILED.`);
  process.exit(1);
}
