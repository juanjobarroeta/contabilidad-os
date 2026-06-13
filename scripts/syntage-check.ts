// Verifica los mapeadores de Syntage (puro) y, si SYNTAGE_API_KEY está en el
// entorno, hace una prueba de auth en vivo (read-only). Run: npm run fiscal:syntage-check

import { mapTaxCompliance, mapTaxStatus, SyntageClient } from "../src/lib/fiscal/cumplimiento/syntage";

let fallos = 0;
function check(nombre: string, cond: boolean, detalle?: string) {
  if (!cond) fallos++;
  console.log(`  ${cond ? "✓" : "✗"} ${nombre}${!cond && detalle ? ` — ${detalle}` : ""}`);
}

console.log("map TaxComplianceCheck → OpinionResult");
const opPos = mapTaxCompliance({ result: "positive", internalIdentifier: "20NE1234567" });
check("positive → POSITIVA", opPos.resultado === "POSITIVA");
check("tipo SAT_OPINION", opPos.tipo === "SAT_OPINION");
check("folio en motivos", /20NE1234567/.test(opPos.motivos[0] ?? ""));
check("negative → NEGATIVA", mapTaxCompliance({ result: "negative" }).resultado === "NEGATIVA");
check("no_obligations → SIN_OBLIGACIONES", mapTaxCompliance({ result: "no_obligations" }).resultado === "SIN_OBLIGACIONES");
check("acuse desde file.resource", mapTaxCompliance({ result: "positive", file: { resource: "/tax-compliance-check/abc" } }).acuseUrl === "/tax-compliance-check/abc");

console.log("map TaxStatus → CsfResult");
const csf = mapTaxStatus({
  rfc: "ABC120101AAA",
  taxRegimes: [{ code: 601, name: "General" }, { code: 626, name: "RESICO" }],
  obligations: [{ description: "ISR mensual" }, { description: "Pago definitivo mensual de IVA." }],
  address: { postalCode: "44100" },
  status: "Activo",
});
check("rfc mapeado", csf.perfil.rfc === "ABC120101AAA");
check("regímenes desde taxRegimes[].code", csf.perfil.regimenes.join(",") === "601,626");
check("obligaciones desde obligations[].description", csf.perfil.obligaciones.length === 2 && /IVA/.test(csf.perfil.obligaciones[1]));
check("CP desde address.postalCode", csf.perfil.codigoPostal === "44100");
check("status 'Activo' → ACTIVO", csf.perfil.estatusPadron === "ACTIVO");
check("suspendido normalizado", mapTaxStatus({ rfc: "X", status: "Suspendido" }).perfil.estatusPadron === "SUSPENDIDO");

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
