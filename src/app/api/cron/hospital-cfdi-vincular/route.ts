import { NextResponse } from "next/server";
import { withCronLock } from "@/lib/cron-lock";
import { prisma } from "@/lib/prisma";
import { empresasHospital, vincularCfdisVivos } from "@/lib/hospital/episodios-vivos-cfdi";

// ─────────────────────────────────────────────────────────────────────────────
// POST (o GET) /api/cron/hospital-cfdi-vincular[?companyId=…]
//
// Liga los cargos de los episodios VIVOS con el CFDI que los cobró, y los
// depósitos con su CFDI de anticipo (lib/hospital/episodios-vivos-cfdi). Sin
// esto un episodio facturado fuera del módulo dejaba su CFDI entero en «otros
// ingresos» y la reconstrucción histórica le fabricaba un episodio duplicado.
// Local, idempotente, encadenado tras sat-rawxml-backfill (el CFDI recién
// bajado se liga en minutos). Auth: CRON_SECRET.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization");
  if (auth && auth === `Bearer ${secret}`) return true;
  return req.headers.get("x-cron-secret") === secret;
}

async function handle(req: Request) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const only = new URL(req.url).searchParams.get("companyId");
  const empresas = only ? [only] : await empresasHospital(prisma);
  const resumen = { empresas: empresas.length, procesadas: 0, vinculados: 0, depositosLigados: 0, cfdisPendientes: 0, episodiosSinCfdi: 0, depositosSinAnticipo: 0, errores: [] as string[] };
  for (const companyId of empresas) {
    try {
      const r = await vincularCfdisVivos(prisma, companyId);
      resumen.procesadas++;
      resumen.vinculados += r.vinculados.length;
      resumen.depositosLigados += r.depositosLigados;
      resumen.cfdisPendientes += r.cfdisPendientes.length;
      resumen.episodiosSinCfdi += r.episodiosSinCfdi.length;
      resumen.depositosSinAnticipo += r.depositosSinAnticipo.length;
    } catch (e) {
      resumen.errores.push(`${companyId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (resumen.vinculados || resumen.depositosLigados || resumen.errores.length) {
    console.log("[cron/hospital-cfdi-vincular]", JSON.stringify(resumen));
  }
  return NextResponse.json({ ok: true, ...resumen });
}

export async function POST(req: Request) {
  return withCronLock("cron:hospital-cfdi-vincular", () => handle(req));
}
export async function GET(req: Request) {
  return withCronLock("cron:hospital-cfdi-vincular", () => handle(req));
}
