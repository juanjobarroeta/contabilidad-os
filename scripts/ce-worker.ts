/**
 * Worker de descarga de Contabilidad Electrónica del SAT para toda la cartera
 * elegible. Diseñado para correr REMOTO y solo (GitHub Actions o un servicio
 * worker de Railway) — nunca depende de una máquina en particular.
 *
 * SECUENCIAL (concurrencia 1) a propósito: respeta el rate-limit del SAT (los
 * 503 que vimos venían de ráfagas). Un 403 (buzón no habilitado) o un error de
 * una empresa se registra y NO detiene a las demás.
 *
 * Env: DATABASE_URL, CREDENTIALS_ENCRYPTION_KEY (+ Chromium instalado).
 * Opcionales: RFC | COMPANY_ID (una sola empresa, salta el gating de plan),
 * ANIOS=2026,2025, FORCE=1, LIMIT=n, PAUSA_MS (espaciado entre empresas, 3000).
 *
 * AGENDA (default; AGENDA=0 vuelve al barrido completo). El barrido bajaba los
 * 5 años de CADA empresa en cada corrida, aunque ya los tuviera: horas de
 * buzón y ráfagas al SAT para no traer nada. Ahora el worker sólo va por:
 *   - las balanzas que la agenda del SAT (tabla AgendaSat, lib/agenda-sat)
 *     va a revisar en las próximas AGENDA_HORAS (24) o ya debía revisar —
 *     sólo los años de esos periodos; y
 *   - el bootstrap: empresas elegibles SIN ninguna balanza en la base, todos
 *     los años.
 * La revisión (cron agenda-sat) pregunta después si la balanza ya está en la
 * base y decide la siguiente fecha; el worker sólo descarga.
 */
import { PrismaClient } from "@prisma/client";
import { importarSerieBalanzasSat } from "../src/lib/contabilidad/ce-serie-sat";
import { BuzonAccesoError } from "../src/lib/sat-portal/buzon-playwright";
import { planIncluyeSyntage } from "../src/lib/planes";

const prisma = new PrismaClient();

async function main() {
  const soloRfc = process.env.RFC;
  const soloId = process.env.COMPANY_ID;
  const anios = process.env.ANIOS?.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
  const force = process.env.FORCE === "1";
  const limit = process.env.LIMIT ? Number(process.env.LIMIT) : undefined;
  const pausaMs = process.env.PAUSA_MS ? Number(process.env.PAUSA_MS) : 3000;

  const empresas = await prisma.company.findMany({
    where: {
      isActive: true,
      fielCer: { not: null },
      fielKey: { not: null },
      fielPassword: { not: null },
      ...(soloId ? { id: soloId } : {}),
      ...(soloRfc ? { rfc: soloRfc } : {}),
    },
    select: { id: true, rfc: true, tier: true },
    orderBy: { rfc: "asc" },
    ...(limit ? { take: limit } : {}),
  });
  // Barrido de cartera: sólo planes con automatización. Una empresa puntual
  // (RFC/COMPANY_ID) salta el gating — sirve para onboarding.
  const dirigido = Boolean(soloRfc || soloId);
  let elegibles = dirigido ? empresas : empresas.filter((c) => planIncluyeSyntage(c.tier));

  // Años a bajar por empresa en modo agenda (undefined = los de ANIOS o el default).
  const aniosPorEmpresa = new Map<string, number[] | undefined>();
  const agenda = !dirigido && !force && process.env.AGENDA !== "0";
  if (agenda) {
    const horas = process.env.AGENDA_HORAS ? Number(process.env.AGENDA_HORAS) : 24;
    const filas = await prisma.agendaSat.findMany({
      where: {
        entregable: "BALANZA_CE",
        estado: { in: ["PENDIENTE", "TARDE"] },
        proximaRevision: { lte: new Date(Date.now() + horas * 3600_000) },
      },
      select: { companyId: true, periodo: true },
    });
    for (const f of filas) {
      const anio = Number(f.periodo.slice(0, 4));
      const a = aniosPorEmpresa.get(f.companyId) ?? [];
      if (!a.includes(anio)) a.push(anio);
      aniosPorEmpresa.set(f.companyId, a);
    }
    const conHistoria = new Set(
      (await prisma.ceBalanzaMes.groupBy({ by: ["companyId"], where: { companyId: { in: elegibles.map((c) => c.id) } } })).map(
        (g) => g.companyId,
      ),
    );
    for (const c of elegibles) if (!conHistoria.has(c.id)) aniosPorEmpresa.set(c.id, anios?.length ? anios : undefined);
    elegibles = elegibles.filter((c) => aniosPorEmpresa.has(c.id));
    console.log(`CE-worker (agenda, ${horas} h): ${filas.length} balanza(s) por revisar · ${[...aniosPorEmpresa.values()].filter((a) => a === undefined).length} bootstrap`);
  }

  console.log(`CE-worker: ${elegibles.length} empresa(s)${anios?.length ? ` · años ${anios.join(",")}` : ""}${force ? " · FORCE" : ""}`);
  const resumen = { ok: 0, importados: 0, sinBuzon: 0, error: 0 };
  for (let i = 0; i < elegibles.length; i++) {
    const c = elegibles[i];
    const t0 = Date.now();
    let ok = false;
    let nuevos = 0;
    let info = "";
    try {
      const res = await importarSerieBalanzasSat(c.id, {
        anios: agenda ? aniosPorEmpresa.get(c.id) : anios?.length ? anios : undefined,
        force,
        log: () => {},
      });
      ok = true;
      nuevos = res.importados;
      info = `${res.importados} nuevos · ${res.balanzas} balanzas · ${res.periodos.length} períodos vistos`;
      resumen.ok++;
      resumen.importados += res.importados;
      console.log(`[${i + 1}/${elegibles.length}] ${c.rfc} ✅ ${res.importados} períodos nuevos (${Date.now() - t0}ms)`);
    } catch (e) {
      if (e instanceof BuzonAccesoError) {
        resumen.sinBuzon++;
        info = `sinBuzón — ${e.message.slice(0, 130)}`;
        console.log(`[${i + 1}/${elegibles.length}] ${c.rfc} ⛔ ${e.message.slice(0, 90)}`);
      } else {
        resumen.error++;
        info = `error — ${String(e).slice(0, 130)}`;
        console.error(`[${i + 1}/${elegibles.length}] ${c.rfc} ❌ ${String(e).slice(0, 140)}`);
      }
    }
    // Registrar el resultado para la vista operador (best-effort).
    await prisma.company
      .update({
        where: { id: c.id },
        data: { ceSatSyncEn: new Date(), ceSatSyncOk: ok, ceSatSyncNuevos: nuevos, ceSatSyncInfo: info.slice(0, 200) },
      })
      .catch(() => {});
    if (i < elegibles.length - 1) await new Promise((r) => setTimeout(r, pausaMs));
  }
  console.log(`\nRESUMEN · ok=${resumen.ok} · períodos=${resumen.importados} · sinBuzón=${resumen.sinBuzon} · error=${resumen.error}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
