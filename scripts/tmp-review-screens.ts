// Recorre las pantallas de la demo (ALTIPLANO local) y las captura para la
// revisión pre-demo. Reutilizable como esqueleto del video (Playwright graba
// video con el mismo flujo). Temporal: no se commitea.
import { chromium } from "playwright";

const BASE = "http://localhost:3100";
const OUT = process.env.OUT_DIR ?? ".";
const COMPANY_ID = "cmtddom840000onf0kymg3jd4";

const RUTAS: Array<[string, string]> = [
  ["inicio", "/"],
  ["hallazgos", "/hallazgos"],
  ["bancos", "/bancos"],
  ["facturas", "/facturas"],
  ["impuestos", "/impuestos"],
  ["nomina", "/nomina"],
  ["clientes", "/clientes"],
  ["contabilidad-estado", "/contabilidad/estado"],
  ["contabilidad-catalogo", "/contabilidad/catalogo"],
  ["contabilidad-saldos", "/contabilidad/saldos"],
  ["contabilidad-conciliacion", "/contabilidad/conciliacion"],
  ["contabilidad-balanza", "/contabilidad/balanza"],
  ["contabilidad-balance", "/contabilidad/balance"],
  ["contabilidad-libro", "/contabilidad/libro"],
  ["contabilidad-ajustes", "/contabilidad/ajustes"],
  ["contabilidad-activo-fijo", "/contabilidad/activo-fijo"],
  ["contabilidad-cierre", "/contabilidad/cierre"],
  ["contabilidad-divergencia", "/contabilidad/divergencia"],
  ["contabilidad-entregables", "/contabilidad/entregables"],
  ["contabilidad-presentado", "/contabilidad/presentado"],
  ["contabilidad-polizas", "/contabilidad/polizas"],
  ["empresa", "/empresa"],
];

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(`localStorage.setItem("activeCompanyId", "${COMPANY_ID}");`);
  const page = await ctx.newPage();
  const consolaErrores: string[] = [];
  page.on("pageerror", (e) => consolaErrores.push(`pageerror: ${e.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") consolaErrores.push(`console: ${msg.text().slice(0, 200)}`);
  });

  // Login por el formulario real.
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.screenshot({ path: `${OUT}/00-login.png` });
  await page.fill('input[type="email"], input[name="email"]', "revisor@demo.test");
  await page.fill('input[type="password"], input[name="password"]', "demo-piloto-2026");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 20000 });
  await page.waitForTimeout(1500);

  let n = 1;
  for (const [nombre, ruta] of RUTAS) {
    const tag = String(n++).padStart(2, "0");
    try {
      const antes = consolaErrores.length;
      await page.goto(`${BASE}${ruta}`, { waitUntil: "networkidle", timeout: 30000 });
      await page.waitForTimeout(1200); // datos client-side
      await page.screenshot({ path: `${OUT}/${tag}-${nombre}.png`, fullPage: true });
      const nuevos = consolaErrores.slice(antes);
      console.log(`ok ${tag} ${nombre}${nuevos.length ? ` ⚠ ${nuevos.length} error(es): ${nuevos[0].slice(0, 120)}` : ""}`);
    } catch (e) {
      console.log(`FALLO ${tag} ${nombre}: ${(e as Error).message.split("\n")[0]}`);
      await page.screenshot({ path: `${OUT}/${tag}-${nombre}-ERROR.png` }).catch(() => {});
    }
  }

  // Estado de cuenta del primer cliente con saldo.
  try {
    await page.goto(`${BASE}/clientes`, { waitUntil: "networkidle" });
    const link = page.locator('a[href*="/clientes/"]').first();
    if (await link.count()) {
      const href = await link.getAttribute("href");
      if (href) {
        const id = href.split("/clientes/")[1]?.split("/")[0];
        await page.goto(`${BASE}/clientes/${id}/estado-cuenta`, { waitUntil: "networkidle" });
        await page.waitForTimeout(1200);
        await page.screenshot({ path: `${OUT}/90-estado-cuenta-cliente.png`, fullPage: true });
        console.log("ok 90 estado-cuenta-cliente");
      }
    }
  } catch (e) {
    console.log(`FALLO estado-cuenta: ${(e as Error).message.split("\n")[0]}`);
  }

  if (consolaErrores.length > 0) {
    console.log(`\n── Errores de consola (${consolaErrores.length}):`);
    for (const err of [...new Set(consolaErrores)].slice(0, 20)) console.log("  " + err);
  } else {
    console.log("\nSin errores de consola.");
  }
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
