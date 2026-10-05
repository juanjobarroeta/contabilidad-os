import { NextResponse } from "next/server";
import { withCronLock } from "@/lib/cron-lock";
import { prisma } from "@/lib/prisma";
import { empresasElegibles } from "@/lib/agenda-sat/ejecutar";
import { SatGoClient, satGoConfigurado } from "@/lib/fiscal/cumplimiento/satgo/client";
import { ejerciciosPendientes, importarHistoricoDeclaraciones } from "@/lib/fiscal/cumplimiento/satgo/historico";
import { anualesPendientes } from "@/lib/fiscal/cumplimiento/satgo/anual";

// ─────────────────────────────────────────────────────────────────────────────
// POST (o GET) /api/cron/declaraciones-historico   [?companyId=&ejercicios=N]
//
// Historial de declaraciones mensuales desde SatGo, gap-driven: por empresa
// elegible (e.firma, plan con automatización, pago vigente), los ejercicios
// con meses sin fila, del más reciente al más viejo, un ZIP por ejercicio.
// Sustituye al declaraciones-backfill de Syntage. La agenda del SAT cubre los
// tres meses recientes; esto cubre lo anterior, hasta satBackfillYears.
//
// También trae la ANUAL de cada ejercicio cerrado (decanualfiel; físicas y
// morales, probado en vivo el 5-oct-2026) sin fila con PDF.
// Acotado por corrida (empresas × ejercicios) porque cada acuse que falta es
// un parseo con Claude. Si SatGo contesta 403 «la suscripción requiere
// actualización», se corta la corrida: es el proveedor, no la empresa, y
// seguir sólo repetiría el rechazo.
// Auth: CRON_SECRET.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_EMPRESAS = 3;
const MAX_EJERCICIOS = 2;
const TIME_BUDGET_MS = 230_000;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization");
  if (auth && auth === `Bearer ${secret}`) return true;
  return req.headers.get("x-cron-secret") === secret;
}

async function handle(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!satGoConfigurado()) return NextResponse.json({ ok: false, error: "SATGO_API_KEY no configurada" }, { status: 503 });
  const url = new URL(req.url);
  const onlyCompanyId = url.searchParams.get("companyId");
  const ejParam = parseInt(url.searchParams.get("ejercicios") ?? "", 10);
  const maxEjercicios = Number.isFinite(ejParam) ? Math.min(Math.max(ejParam, 1), 6) : MAX_EJERCICIOS;
  const startedAt = Date.now();

  const elegibles = await empresasElegibles();
  const candidatas = onlyCompanyId ? elegibles.filter((c) => c.id === onlyCompanyId) : elegibles;
  // Más atrasada primero: la recién dada de alta tiene todos los ejercicios pendientes.
  const conPendientes: Array<{ id: string; rfc: string; pendientes: number }> = [];
  for (const c of candidatas) {
    const p = await ejerciciosPendientes(c.id);
    const a = await anualesPendientes(c.id);
    if (p.length + a.length > 0) conPendientes.push({ id: c.id, rfc: c.rfc, pendientes: p.length + a.length });
  }
  conPendientes.sort((a, b) => b.pendientes - a.pendientes);

  const client = new SatGoClient();
  const resultados: Array<Record<string, unknown>> = [];
  let sinSuscripcion = false;
  for (const c of conPendientes.slice(0, onlyCompanyId ? 1 : MAX_EMPRESAS)) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) break;
    try {
      const r = await importarHistoricoDeclaraciones(c.id, { maxEjercicios, client });
      resultados.push({ rfc: c.rfc, pendientesAntes: r.pendientesAntes, ejercicios: r.ejercicios, anuales: r.anuales });
      if (r.sinSuscripcion) { sinSuscripcion = true; break; }
    } catch (e) {
      resultados.push({ rfc: c.rfc, error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
    }
  }
  const summary = {
    ok: !sinSuscripcion,
    empresasElegibles: elegibles.length,
    empresasConHuecos: conPendientes.length,
    atendidas: resultados.length,
    resultados,
    sinSuscripcion,
    nota: sinSuscripcion
      ? "SatGo rechazó con 403 «la suscripción requiere actualización de estado»: hay que renovar/activar el plan de SatGo. Hasta entonces no entra ninguna declaración."
      : "Gap-driven: cada corrida atiende a las empresas más atrasadas; vuelve a correr hasta que empresasConHuecos llegue a 0. La anual entra por decanualfiel en la misma corrida.",
    elapsedMs: Date.now() - startedAt,
  };
  console.log("[cron/declaraciones-historico] done:", JSON.stringify(summary).slice(0, 1500));
  // Rastro mínimo para el operador: se queda en el log; no hay tabla de corridas.
  void prisma;
  return NextResponse.json(summary, { status: sinSuscripcion ? 502 : 200 });
}

export async function POST(req: Request) {
  return withCronLock("cron:declaraciones-historico", () => handle(req));
}
export async function GET(req: Request) {
  return withCronLock("cron:declaraciones-historico", () => handle(req));
}
