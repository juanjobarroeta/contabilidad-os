// Barrido UX completo: TODAS las rutas de (app) con la empresa demo activa.
// Por ruta: captura full-page + errores de consola + respuestas HTTP >= 400.
// Reporte JSON al final. Temporal — no se commitea.
import { chromium, type Page } from "playwright";
import { writeFileSync } from "node:fs";

const BASE = "http://localhost:3100";
const OUT = process.env.OUT_DIR ?? ".";
const CID = "cmtdfbvxm0000ond5or059n1d";
const CLIENTE = "cmtdfbvyu0061ond5i6lowzo7";
const EMP = "cmtdfbvz0006sond56n319tyt";
const DECL = "cmtdfbw1z00kyond5xkm3x73e";

const RUTAS: Array<[string, string]> = [
  ["inicio", "/"],
  ["pendientes", "/pendientes"],
  ["despacho-cartera", "/despacho"],
  ["dashboard", "/dashboard"],
  ["facturas", "/facturas"],
  ["facturas-nueva", "/facturas/nueva"],
  ["clientes", "/clientes"],
  ["cliente-estado-cuenta", `/clientes/${CLIENTE}/estado-cuenta`],
  ["proveedores", "/proveedores"],
  ["verificador", "/verificador"],
  ["bancos", "/bancos"],
  ["activos", "/activos"],
  ["nomina", "/nomina"],
  ["nomina-cockpit", "/nomina/cockpit"],
  ["nomina-ajuste-anual", "/nomina/ajuste-anual"],
  ["nomina-empleado", `/nomina/empleado/${EMP}`],
  ["impuestos", "/impuestos"],
  ["impuestos-papeles", "/impuestos/papeles"],
  ["declaraciones-historial", "/declaraciones/historial"],
  ["declaracion-acuse", `/declaraciones/acuse/${DECL}`],
  ["cumplimiento", "/cumplimiento"],
  ["opiniones", "/opiniones"],
  ["hallazgos", "/hallazgos"],
  ["contabilidad-cierre", "/contabilidad/cierre"],
  ["contabilidad-conciliacion", "/contabilidad/conciliacion"],
  ["contabilidad-divergencia", "/contabilidad/divergencia"],
  ["contabilidad-ajustes", "/contabilidad/ajustes"],
  ["contabilidad-entregables", "/contabilidad/entregables"],
  ["contabilidad-libro", "/contabilidad/libro"],
  ["contabilidad-balanza", "/contabilidad/balanza"],
  ["contabilidad-estado", "/contabilidad/estado"],
  ["contabilidad-balance", "/contabilidad/balance"],
  ["contabilidad-saldos", "/contabilidad/saldos"],
  ["contabilidad-activo-fijo", "/contabilidad/activo-fijo"],
  ["contabilidad-presentado", "/contabilidad/presentado"],
  ["contabilidad-catalogo", "/contabilidad/catalogo"],
  ["contabilidad-apertura", "/contabilidad/apertura"],
  ["contabilidad-polizas", "/contabilidad/polizas"],
  ["empresa", "/empresa"],
  ["empresa-apertura", "/empresa/apertura"],
  ["configuracion", "/configuracion"],
  ["config-cuenta", "/configuracion/cuenta"],
  ["config-empresas", "/configuracion/empresas"],
  ["config-empresa-detalle", `/configuracion/empresas/${CID}`],
  ["config-usuarios", "/configuracion/usuarios"],
  ["config-invitaciones", "/configuracion/invitaciones"],
  ["config-despacho", "/configuracion/despacho"],
  ["config-facturacion", "/configuracion/facturacion"],
  ["config-notificaciones", "/configuracion/notificaciones"],
  ["config-whatsapp", "/configuracion/whatsapp"],
  ["config-codigos", "/configuracion/codigos"],
  ["operador", "/operador"],
  ["rentabilidad", "/rentabilidad"],
  ["creditos", "/creditos"],
  ["legal-privacidad", "/legal/aviso-de-privacidad"],
  ["legal-terminos", "/legal/terminos"],
];

interface Registro { ruta: string; path: string; consola: string[]; http: string[]; fallo?: string }

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(`localStorage.setItem("activeCompanyId", "${CID}");`);
  const page: Page = await ctx.newPage();

  let consolaBuf: string[] = [];
  let httpBuf: string[] = [];
  page.on("pageerror", (e) => consolaBuf.push(`pageerror: ${e.message.slice(0, 160)}`));
  page.on("console", (m) => { if (m.type() === "error") consolaBuf.push(`console: ${m.text().slice(0, 160)}`); });
  page.on("response", (r) => {
    if (r.status() >= 400) httpBuf.push(`${r.status()} ${r.url().replace(BASE, "").slice(0, 110)}`);
  });

  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.fill('input[type="email"]', "revisor@demo.test");
  await page.fill('input[type="password"]', "demo-piloto-2026");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 20000 });
  await page.waitForTimeout(1200);

  const reporte: Registro[] = [];
  let n = 0;
  for (const [nombre, ruta] of RUTAS) {
    const tag = String(++n).padStart(2, "0");
    consolaBuf = []; httpBuf = [];
    const reg: Registro = { ruta: nombre, path: ruta, consola: [], http: [] };
    try {
      await page.goto(`${BASE}${ruta}`, { waitUntil: "networkidle", timeout: 30000 });
      await page.waitForTimeout(1100);
      await page.screenshot({ path: `${OUT}/${tag}-${nombre}.png`, fullPage: true });
    } catch (e) {
      reg.fallo = (e as Error).message.split("\n")[0].slice(0, 140);
      await page.screenshot({ path: `${OUT}/${tag}-${nombre}.png` }).catch(() => {});
    }
    reg.consola = [...new Set(consolaBuf)];
    reg.http = [...new Set(httpBuf)];
    reporte.push(reg);
    const marca = reg.fallo ? "FALLO" : reg.consola.length || reg.http.length ? "⚠" : "ok";
    console.log(`${marca} ${tag} ${nombre}${reg.http.length ? " | " + reg.http.join(" ; ") : ""}${reg.consola.length ? " | " + reg.consola[0] : ""}`);
  }
  writeFileSync(`${OUT}/reporte-ux.json`, JSON.stringify(reporte, null, 1));
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
