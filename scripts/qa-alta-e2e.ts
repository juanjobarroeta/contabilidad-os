/**
 * QA de punta a punta del ALTA de un cliente nuevo, contra un servidor local:
 *   landing → registro → login → alta guiada (hola, personaje, confianza,
 *   e.firma con contraseña mala y luego buena, recarga a media pantalla, CSF
 *   por SatGo o captura manual, crear empresa, recarga DURANTE la creación,
 *   historial, bancos, equipo) → dashboard → facturas.
 *
 * Requiere una base LOCAL vacía (Postgres.app + `prisma db push`), .env.local
 * con IN_APP_CRON=0 (para no tocar al SAT con la e.firma de prueba) y los
 * archivos de una e.firma real en QA_DIR: bartiz.cer, bartiz.key, bartiz.pass
 * (y opcionalmente bartiz-csf.pdf). Nunca contra producción: el RFC es único.
 *
 *   QA_DIR=/ruta BASE=http://localhost:3100 RECARGA_EN_CREACION=1 npx tsx scripts/qa-alta-e2e.ts
 */
import { chromium, type Page } from "playwright";
import * as fs from "node:fs";
const BASE = process.env.BASE ?? "http://localhost:3100";
const QA = process.env.QA_DIR!;
const email = `qa+${Date.now()}@contabilidad-os.test`;
const password = "Prueba-Alta-2026!";
const log: string[] = [];
const say = (s: string) => { const l = `${new Date().toISOString().slice(11, 19)} ${s}`; console.log(l); log.push(l); };
let n = 0;
async function shot(page: Page, name: string) { n++; await page.screenshot({ path: `${QA}/shots/${String(n).padStart(2, "0")}-${name}.png`, fullPage: false }).catch(() => {}); }
async function pasoActual(page: Page): Promise<string> {
  const r = await page.request.get(`${BASE}/api/onboarding/progreso`);
  const j = await r.json().catch(() => ({}));
  return `${j?.progreso?.paso ?? "?"} company=${j?.progreso?.companyId ? "sí" : "no"}`;
}
async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "es-MX" });
  const page = await ctx.newPage();
  page.setDefaultTimeout(120_000);
  page.setDefaultNavigationTimeout(120_000);
  const consola: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") consola.push(m.text().slice(0, 200)); });
  page.on("response", (r) => { if (r.status() >= 500) say(`HTTP ${r.status()} ${r.url()}`); });

  // 1. Landing
  await page.goto(`${BASE}/`);
  await shot(page, "landing");
  const aSignup = await page.locator('a[href="/signup"], a[href^="/signup"]').count();
  const aLogin = await page.locator('a[href="/login"], a[href^="/login"]').count();
  say(`landing: links a /signup=${aSignup} a /login=${aLogin} título=${JSON.stringify(await page.title())}`);

  // 2. Registro
  await page.goto(`${BASE}/signup`);
  await page.fill("#name", "QA Alta");
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.locator('input[type="checkbox"]').first().check();
  await shot(page, "signup");
  await Promise.all([page.waitForURL(/\/onboarding|\/dashboard|\/login/, { timeout: 120_000 }), page.locator('button[type="submit"]').first().click()]);
  say(`tras registro → ${page.url()}`);
  if (page.url().includes("/login")) {
    await page.fill("#email", email); await page.fill("#password", password);
    await Promise.all([page.waitForURL(/\/onboarding|\/dashboard/), page.locator('button[type="submit"]').first().click()]);
    say(`tras login → ${page.url()}`);
  }
  await page.waitForURL(/\/onboarding/);
  say(`progreso: ${await pasoActual(page)}`);

  // 3. hola → personaje → confianza
  await page.locator("button.ob-role").filter({ hasText: /empresa/i }).first().click();
  await shot(page, "personaje");
  await page.locator("button.ob-char").first().click().catch(() => {});
  await page.locator("button.ob-tone").first().click().catch(() => {});
  await page.locator("button.ob-btn.p").first().click();
  say(`progreso: ${await pasoActual(page)}`);
  await page.locator("button.ob-btn.p:not([disabled])").first().waitFor({ timeout: 60_000 });
  await shot(page, "confianza");
  await page.locator("button.ob-btn.p:not([disabled])").first().click();
  say(`progreso: ${await pasoActual(page)}`);

  // 4. e.firma — primero con contraseña MALA (reintento), luego la buena
  await page.locator('input[accept=".cer"]').setInputFiles(`${QA}/bartiz.cer`);
  await page.locator('input[accept=".key"]').setInputFiles(`${QA}/bartiz.key`);
  await page.locator('input[type="password"]').first().fill("clave-equivocada");
  await page.locator('input[type="checkbox"]').first().check();
  await shot(page, "fiel-archivos");
  await page.locator("button.ob-btn.p:not([disabled])").first().click();
  await page.waitForTimeout(6000);
  const errTxt = (await page.locator(".ob-err, [role=alert]").allTextContents()).join(" | ").slice(0, 200);
  say(`contraseña mala → error visible: ${errTxt ? "sí: " + errTxt : "NO"}`);
  await shot(page, "fiel-error");
  // Recarga a media pantalla: debe volver al paso fiel
  await page.reload();
  await page.waitForLoadState("networkidle");
  say(`tras recargar en fiel: ${await pasoActual(page)}`);
  await page.locator('input[accept=".cer"]').setInputFiles(`${QA}/bartiz.cer`);
  await page.locator('input[accept=".key"]').setInputFiles(`${QA}/bartiz.key`);
  await page.locator('input[type="password"]').first().fill(fs.readFileSync(`${QA}/bartiz.pass`, "utf8").trim());
  await page.locator('input[type="checkbox"]').first().check();
  await page.locator("button.ob-btn.p:not([disabled])").first().click();
  // Espera: validar (local) → CSF por SatGo (hoy 403) → pantalla «confirma»
  await page.locator('[aria-label="Régimen fiscal"], input[accept="application/pdf"]').first().waitFor({ timeout: 150_000 });
  await shot(page, "fiel-confirma");
  say(`CSF por SatGo no llegó (esperado con la suscripción en 403): pantalla de confirmación visible`);
  // Reintento: CSF manual (parse-csf con Claude)
  await page.locator('input[accept="application/pdf"]').setInputFiles(`${QA}/bartiz-csf.pdf`);
  await page.waitForFunction(() => { const i = document.querySelector('input[inputmode="numeric"], input[placeholder*="ostal"], input[name="codigoPostal"]') as HTMLInputElement | null; return !!i && /^\d{5}$/.test(i.value); }, null, { timeout: 150_000 }).catch(async () => { say("CP no se llenó solo desde la CSF; se captura a mano"); const cp = page.locator('input').filter({ has: page.locator(':scope') }).nth(0); void cp; });
  let cpVal = await page.evaluate(() => Array.from(document.querySelectorAll("input")).map((i) => i.value).find((v) => /^\d{5}$/.test(v)) ?? "");
  say(`CSF manual leída: CP=${cpVal || "vacío"} régimen=${await page.locator('[aria-label="Régimen fiscal"]').inputValue().catch(() => "?")}`);
  if (!cpVal) {
    // Claude sin crédito (prod y local hoy): la pantalla deja capturar a mano. Es el camino de respaldo real.
    await page.locator('input[placeholder="Código postal del domicilio fiscal"]').fill("72810");
    cpVal = "72810";
    say("CP capturado a mano: 72810 (régimen prellenado por el RFC de PM)");
  }
  await shot(page, "fiel-confirma-llena");
  const confirmar = page.locator("button.ob-btn.p:not([disabled])").last();
  await confirmar.click();
  if (process.env.RECARGA_EN_CREACION === "1") {
    // Simula al usuario que recarga justo cuando la empresa se está creando.
    await page.waitForResponse((r) => r.url().includes("/api/companies") && r.request().method() === "POST", { timeout: 120_000 });
    await page.reload();
    await page.waitForLoadState("networkidle");
    say(`recarga DURANTE la creación → ${await pasoActual(page)} url=${page.url()}`);
    await shot(page, "recarga-en-creacion");
  }
  // Creación → opinión (SatGo 403 → no disponible) → listo → historial
  // Espera REAL a que la empresa quede ligada al avance (sondeo desde Node; una
  // función async dentro de waitForFunction devuelve una promesa, que es «truthy»).
  for (let i = 0; i < 90; i++) {
    const j = await (await page.request.get(`${BASE}/api/onboarding/progreso`)).json().catch(() => ({}));
    if (j?.progreso?.companyId && j?.progreso?.paso !== "fiel") break;
    await page.waitForTimeout(2000);
  }
  say(`empresa creada: ${await pasoActual(page)}`);
  await shot(page, "historial");
  // Recarga tras crear: debe reanudar en historial con la empresa
  await page.reload();
  await page.waitForLoadState("networkidle");
  say(`tras recargar en historial: ${await pasoActual(page)}`);
  const prog = await (await page.request.get(`${BASE}/api/onboarding/progreso`)).json();
  const companyId = prog.progreso.companyId as string;
  const estado = await (await page.request.get(`${BASE}/api/onboarding/estado?companyId=${companyId}`)).json();
  say(`estado del alta: ${JSON.stringify({ anios: estado?.empresa?.anios, conFiel: estado?.empresa?.conFiel, etapas: (estado?.etapas ?? []).map((e: any) => `${e.clave}:${e.pct ?? "-"}`) })}`);
  // historial → bancos → equipo → dashboard
  await page.locator("button.ob-btn.p:not([disabled])").first().click();
  say(`progreso: ${await pasoActual(page)}`);
  await shot(page, "bancos");
  await page.locator("button.ob-btn:not([disabled])").last().click();
  say(`progreso: ${await pasoActual(page)}`);
  await shot(page, "equipo");
  await page.locator("button.ob-btn.g:not([disabled])").last().click();
  await page.waitForURL(/\/dashboard/, { timeout: 120_000 });
  await page.waitForLoadState("networkidle");
  await page.keyboard.press("Escape");
  await shot(page, "dashboard");
  const body = (await page.textContent("body")) ?? "";
  say(`dashboard: url=${page.url()} menciona BARTIZ=${/BARTIZ/i.test(body)} progreso=${await pasoActual(page)}`);
  const salud = await (await page.request.get(`${BASE}/api/sat/salud?companyId=${companyId}`)).json();
  say(`salud sync: ${JSON.stringify(salud)}`);
  // Recarga del dashboard y navegación a Facturas
  await page.reload(); await page.waitForLoadState("networkidle");
  await page.goto(`${BASE}/facturas`); await page.waitForLoadState("networkidle");
  await shot(page, "facturas");
  say(`facturas carga: ${page.url()}`);
  say(`errores de consola: ${consola.length}${consola.length ? " → " + consola.slice(0, 5).join(" || ") : ""}`);
  fs.writeFileSync(`${QA}/journey.log`, log.join("\n"));
  fs.writeFileSync(`${QA}/company.txt`, companyId);
  await browser.close();
}
main().catch(async (e) => { say(`FALLÓ: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`); fs.writeFileSync(`${QA}/journey.log`, log.join("\n")); process.exit(1); });
