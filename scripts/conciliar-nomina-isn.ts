// ─────────────────────────────────────────────────────────────────────────────
// CONCILIAR LA NÓMINA DEL CONTADOR (hoja de ISN) CONTRA LOS RECIBOS TIMBRADOS.
//
// Dos archivos, sin base de datos:
//   · la hoja «Calculo» que manda el contador para el impuesto sobre nómina
//     (una fila por empleado y periodo: sueldo, vacaciones, prima, aguinaldo,
//     asimilados; pie con totales, trabajadores, base ISN y tasa), y
//   · el Excel de la pantalla de Facturas filtrado a Nómina, cuya hoja
//     «Nómina» trae una fila por CFDI timbrado con su complemento parseado.
//
// Cruza por EMPLEADO (nombre normalizado: sin acentos, mayúsculas, un espacio)
// y QUINCENA (fecha final del periodo). Reporta lo que está en un lado y no
// en el otro, y lo que está en los dos con distinto importe. La cifra que se
// compara es el SUELDO (clave 001 en el CFDI, que incluye las vacaciones
// pagadas como sueldo) y el TOTAL de percepciones que entran a la base del
// ISN (sueldo + vacaciones + primas + aguinaldo + asimilados).
//
// Uso:
//   npx tsx scripts/conciliar-nomina-isn.ts "<hoja ISN.xlsx>" "<export facturas.xlsx>" [salida.xlsx]
// ─────────────────────────────────────────────────────────────────────────────

import * as XLSX from "xlsx";
import path from "node:path";

const [, , isnPath, exportPath, salidaArg] = process.argv;
if (!isnPath || !exportPath) {
  console.error('Uso: npx tsx scripts/conciliar-nomina-isn.ts "<hoja ISN.xlsx>" "<export facturas.xlsx>" [salida.xlsx]');
  process.exit(1);
}

const norm = (s: unknown) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const r2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => {
  const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
};
/** Serial de Excel o fecha → "YYYY-MM-DD". */
const fecha = (v: unknown): string | null => {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "number" && v > 20000 && v < 80000) return new Date(Date.UTC(1899, 11, 30) + v * 86400000).toISOString().slice(0, 10);
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  return null;
};

// ── Lado contador ───────────────────────────────────────────────────────────
interface FilaIsn {
  nombre: string;
  clave: string;
  fechaPago: string | null;
  periodoIni: string | null;
  periodoFin: string | null;
  sueldo: number;
  baseIsn: number; // suma de percepciones de la hoja
  fila: number;
}
const wbIsn = XLSX.readFile(isnPath, { cellDates: false });
const wsIsn = wbIsn.Sheets["Calculo"] ?? wbIsn.Sheets[wbIsn.SheetNames[0]];
const filasIsn = XLSX.utils.sheet_to_json<unknown[]>(wsIsn, { header: 1, defval: "" });
const H = filasIsn[0].map((h) => norm(h));
const col = (label: string) => H.findIndex((h) => h === norm(label));
const cNombre = col("Razon receptor"), cFechaPago = col("Fecha pago"), cIni = col("Fecha inicial pago"), cFin = col("Fecha final pago");
const cSueldo = col("Sueldo");
const colsBase = [
  "Vacaciones a tiempo", "Vacaciones reportadas", "Prima de vacaciones reportada", "Aguinaldo", "Sueldo",
  "Prima de vacaciones a tiempo", "Gratificación Anual (Aguinaldo)", "Prima vacacional", "Otros ingresos por salarios",
  "Ingresos asimilados a salarios",
].map(col).filter((i) => i >= 0);

const isn: FilaIsn[] = [];
const pie: Record<string, number> = {};
filasIsn.slice(1).forEach((r, i) => {
  const nombre = String(r[cNombre] ?? "").trim();
  if (!nombre) return;
  const fin = fecha(r[cFin]);
  // Pie de la hoja: etiqueta en la primera columna y el valor en la segunda.
  if (!fin && typeof r[1] === "number" && r[cSueldo] === "") { pie[norm(nombre)] = num(r[1]); return; }
  isn.push({
    nombre, clave: norm(nombre),
    fechaPago: fecha(r[cFechaPago]), periodoIni: fecha(r[cIni]), periodoFin: fin,
    sueldo: r2(num(r[cSueldo])),
    baseIsn: r2(colsBase.reduce((s, c) => s + num(r[c]), 0)),
    fila: i + 2,
  });
});

// ── Lado sistema (hoja «Nómina» del export) ─────────────────────────────────
interface FilaCfdi {
  uuid: string; nombre: string; clave: string; rfc: string; periodoIni: string | null; periodoFin: string | null;
  fechaPago: string | null; sueldo: number; totalPercepciones: number; neto: number; estado: string;
}
const wbEx = XLSX.readFile(exportPath, { cellDates: true });
const wsEx = wbEx.Sheets["Nómina"] ?? wbEx.Sheets["Nomina"];
if (!wsEx) {
  console.error(`El export no trae hoja «Nómina». Descárgalo desde Facturas con el filtro Nómina puesto. Hojas: ${wbEx.SheetNames.join(", ")}`);
  process.exit(1);
}
const ex = XLSX.utils.sheet_to_json<Record<string, unknown>>(wsEx, { defval: "" });
const cfdis: FilaCfdi[] = ex.map((r) => ({
  uuid: String(r["UUID"] ?? ""),
  nombre: String(r["Empleado"] ?? ""),
  clave: norm(r["Empleado"]),
  rfc: String(r["RFC"] ?? ""),
  periodoIni: fecha(r["Periodo inicio"]),
  periodoFin: fecha(r["Periodo fin"]),
  fechaPago: fecha(r["Fecha de pago"]),
  sueldo: r2(num(r["Sueldo (001)"])),
  totalPercepciones: r2(num(r["Total percepciones"])),
  neto: r2(num(r["Neto a pagar"])),
  estado: String(r["Estado"] ?? ""),
}));

// ── Cruce por empleado + quincena ───────────────────────────────────────────
const llave = (clave: string, fin: string | null) => `${clave}|${fin ?? "?"}`;
const porLlaveCfdi = new Map<string, FilaCfdi[]>();
for (const c of cfdis) { const k = llave(c.clave, c.periodoFin); porLlaveCfdi.set(k, [...(porLlaveCfdi.get(k) ?? []), c]); }
const porLlaveIsn = new Map<string, FilaIsn[]>();
for (const f of isn) { const k = llave(f.clave, f.periodoFin); porLlaveIsn.set(k, [...(porLlaveIsn.get(k) ?? []), f]); }

const TOL = 1.0; // pesos: residuos de redondeo entre hoja y CFDI
type Salida = { estado: string; empleado: string; periodoFin: string; sueldoHoja: number | null; sueldoCfdi: number | null; difSueldo: number | null; baseHoja: number | null; percepCfdi: number | null; difPercep: number | null; uuid: string; nota: string };
const out: Salida[] = [];
let cuadran = 0, difieren = 0, soloHoja = 0, soloCfdi = 0;

for (const [k, filas] of porLlaveIsn) {
  const cs = porLlaveCfdi.get(k) ?? [];
  const sHoja = r2(filas.reduce((s, f) => s + f.sueldo, 0));
  const bHoja = r2(filas.reduce((s, f) => s + f.baseIsn, 0));
  if (cs.length === 0) {
    soloHoja++;
    out.push({ estado: "SOLO EN HOJA", empleado: filas[0].nombre, periodoFin: filas[0].periodoFin ?? "", sueldoHoja: sHoja, sueldoCfdi: null, difSueldo: null, baseHoja: bHoja, percepCfdi: null, difPercep: null, uuid: "", nota: "no hay CFDI timbrado para este empleado y quincena" });
    continue;
  }
  const sCfdi = r2(cs.reduce((s, c) => s + c.sueldo, 0));
  const pCfdi = r2(cs.reduce((s, c) => s + c.totalPercepciones, 0));
  const dS = r2(sHoja - sCfdi), dP = r2(bHoja - pCfdi);
  const ok = Math.abs(dS) <= TOL && Math.abs(dP) <= TOL;
  if (ok) cuadran++; else difieren++;
  out.push({ estado: ok ? "CUADRA" : "DIFIERE", empleado: filas[0].nombre, periodoFin: filas[0].periodoFin ?? "", sueldoHoja: sHoja, sueldoCfdi: sCfdi, difSueldo: dS, baseHoja: bHoja, percepCfdi: pCfdi, difPercep: dP, uuid: cs.map((c) => c.uuid).join(" "), nota: cs.length > 1 ? `${cs.length} CFDI en la quincena` : "" });
}
for (const [k, cs] of porLlaveCfdi) {
  if (porLlaveIsn.has(k)) continue;
  soloCfdi++;
  out.push({ estado: "SOLO EN CFDI", empleado: cs[0].nombre, periodoFin: cs[0].periodoFin ?? "", sueldoHoja: null, sueldoCfdi: r2(cs.reduce((s, c) => s + c.sueldo, 0)), difSueldo: null, baseHoja: null, percepCfdi: r2(cs.reduce((s, c) => s + c.totalPercepciones, 0)), difPercep: null, uuid: cs.map((c) => c.uuid).join(" "), nota: "timbrado y no está en la hoja del contador" });
}
out.sort((a, b) => a.estado.localeCompare(b.estado) || a.empleado.localeCompare(b.empleado) || a.periodoFin.localeCompare(b.periodoFin));

// ── Totales ─────────────────────────────────────────────────────────────────
const tHojaSueldo = r2(isn.reduce((s, f) => s + f.sueldo, 0));
const tHojaBase = r2(isn.reduce((s, f) => s + f.baseIsn, 0));
const tCfdiSueldo = r2(cfdis.reduce((s, c) => s + c.sueldo, 0));
const tCfdiPercep = r2(cfdis.reduce((s, c) => s + c.totalPercepciones, 0));
const tCfdiNeto = r2(cfdis.reduce((s, c) => s + c.neto, 0));
const empHoja = new Set(isn.map((f) => f.clave)).size;
const empCfdi = new Set(cfdis.map((c) => c.clave)).size;
const fmt = (n: number) => n.toLocaleString("es-MX", { style: "currency", currency: "MXN" });

console.log(`\n══ NÓMINA vs HOJA DE ISN`);
console.log(`   hoja del contador : ${isn.length} filas · ${empHoja} empleados · sueldo ${fmt(tHojaSueldo)} · base ISN ${fmt(tHojaBase)}`);
if (pie["TOTAL DE TRABAJADORES"] != null) console.log(`   pie de la hoja    : trabajadores ${pie["TOTAL DE TRABAJADORES"]} · sueldo ${fmt(pie["SUELDO"] ?? 0)} · base ISN ${fmt(pie["BASE PARA IMPUESTO SOBRE NOMINA"] ?? 0)} · ISN ${fmt(pie["ISN A CARGO"] ?? 0)}`);
console.log(`   CFDI timbrados    : ${cfdis.length} recibos · ${empCfdi} empleados · sueldo(001) ${fmt(tCfdiSueldo)} · percepciones ${fmt(tCfdiPercep)} · neto ${fmt(tCfdiNeto)}`);
console.log(`   diferencia sueldo : ${fmt(r2(tHojaSueldo - tCfdiSueldo))}   diferencia base/percepciones: ${fmt(r2(tHojaBase - tCfdiPercep))}`);
console.log(`\n   cuadran ${cuadran} · difieren ${difieren} · sólo en hoja ${soloHoja} · sólo en CFDI ${soloCfdi}\n`);
for (const o of out.filter((x) => x.estado !== "CUADRA").slice(0, 60)) {
  console.log(`   ${o.estado.padEnd(13)} ${o.empleado.padEnd(38)} ${o.periodoFin}  hoja ${o.sueldoHoja ?? "—"}  cfdi ${o.sueldoCfdi ?? "—"}  Δsueldo ${o.difSueldo ?? "—"}  Δbase ${o.difPercep ?? "—"}  ${o.nota}`);
}
if (out.filter((x) => x.estado !== "CUADRA").length > 60) console.log("   … (el resto en el archivo de salida)");

const salida = salidaArg ?? path.join(path.dirname(exportPath), `conciliacion-nomina-isn-${new Date().toISOString().slice(0, 10)}.xlsx`);
const ws = XLSX.utils.json_to_sheet(out);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, "Cruce");
XLSX.writeFile(wb, salida);
console.log(`\n   resultado: ${salida}\n`);
