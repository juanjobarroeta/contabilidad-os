// Verifica los mapeadores de Syntage (puro) y, si SYNTAGE_API_KEY está en el
// entorno, hace una prueba de auth en vivo (read-only). Run: npm run fiscal:syntage-check

import { mapTaxCompliance, mapTaxStatus, SyntageClient } from "../src/lib/fiscal/cumplimiento/syntage";

let fallos = 0;
function check(nombre: string, cond: boolean, detalle?: string) {
  if (!cond) fallos++;
  console.log(`  ${cond ? "✓" : "✗"} ${nombre}${!cond && detalle ? ` — ${detalle}` : ""}`);
}

console.log("map tax_compliance → OpinionResult");
const opPos = mapTaxCompliance({ result: { opinion: "Positiva" } });
check("Positiva → POSITIVA", opPos.resultado === "POSITIVA");
check("tipo SAT_OPINION", opPos.tipo === "SAT_OPINION");
const opNeg = mapTaxCompliance({ opinion: "Negativa", obligaciones: ["ISR mayo 2026 omitida", "IVA abril 2026 omitida"] });
check("Negativa → NEGATIVA", opNeg.resultado === "NEGATIVA");
check("motivos mapeados", opNeg.motivos.length === 2 && /ISR mayo/.test(opNeg.motivos[0]));
check("motivos como objetos {descripcion}", mapTaxCompliance({ opinion: "negativa", obligations: [{ descripcion: "X" }] }).motivos[0] === "X");

console.log("map tax_status → CsfResult");
const csf = mapTaxStatus({
  result: {
    rfc: "ABC120101AAA",
    regimenes: ["601", "626"],
    obligaciones: ["ISR mensual", "IVA mensual"],
    domicilio: { codigoPostal: "44100" },
    estatus: "ACTIVO",
  },
});
check("rfc mapeado", csf.perfil.rfc === "ABC120101AAA");
check("regímenes mapeados", csf.perfil.regimenes.length === 2);
check("CP desde domicilio anidado", csf.perfil.codigoPostal === "44100");
check("estatus ACTIVO", csf.perfil.estatusPadron === "ACTIVO");
check("suspendido normalizado", mapTaxStatus({ rfc: "X", estatus: "Suspendido ante el RFC" }).perfil.estatusPadron === "SUSPENDIDO");

console.log("auth en vivo (solo si SYNTAGE_API_KEY)");
async function pruebaViva() {
  if (!process.env.SYNTAGE_API_KEY) {
    console.log("  · SYNTAGE_API_KEY no configurada — se omite la prueba en vivo.");
    return;
  }
  try {
    const client = new SyntageClient();
    const entities = await client.listEntities();
    console.log(`  ✓ auth OK — ${entities.length} entidad(es) en la cuenta.`);
  } catch (e) {
    fallos++;
    console.log(`  ✗ auth/list falló — ${e instanceof Error ? e.message : String(e)}`);
  }
}

pruebaViva().then(() => {
  console.log("");
  if (fallos === 0) {
    console.log("All checks passed.");
    process.exit(0);
  } else {
    console.error(`${fallos} check(s) FAILED.`);
    process.exit(1);
  }
});
