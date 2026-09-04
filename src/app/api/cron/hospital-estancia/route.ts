import { NextResponse } from "next/server";
import { withCronLock } from "@/lib/cron-lock";
import { prisma } from "@/lib/prisma";
import { asegurarCargosEstancia } from "@/lib/hospital/estancia";
import { r2 } from "@/lib/hospital/util";

// ─────────────────────────────────────────────────────────────────────────────
// POST (o GET) /api/cron/hospital-estancia[?companyId=…]
//
// «Cada noche de estancia se carga sola a la cuenta del paciente, con la
// tarifa de su pagador.» Corre a las 06:30 de la Ciudad de México: para cada
// empresa con HOSPITAL y cada episodio HOSPITALIZACION admitido con cama,
// asegura el cargo ESTANCIA de anoche (y de cualquier noche que faltara).
// Idempotente por (episodio, fecha de la noche): la lectura del expediente y
// de la cuenta hacen lo mismo, así que el cron sólo garantiza que la cuenta
// esté al día aunque nadie la abra.
//
// Auth: CRON_SECRET (Bearer o x-cron-secret), igual que los demás crons.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const TIME_BUDGET_MS = 240_000;

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization");
  if (auth && auth === `Bearer ${secret}`) return true;
  if (req.headers.get("x-cron-secret") === secret) return true;
  return false;
}

async function handle(req: Request) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const onlyCompanyId = url.searchParams.get("companyId");
  const startedAt = Date.now();
  const hoy = new Date();

  const modulos = await prisma.companyModule.findMany({
    where: { modulo: "HOSPITAL", habilitado: true, ...(onlyCompanyId ? { companyId: onlyCompanyId } : {}) },
    select: { companyId: true },
  });

  let empresas = 0;
  let episodios = 0;
  let cargos = 0;
  let importe = 0;
  let completado = true;
  const errores: Array<{ episodioId: string; error: string }> = [];

  for (const { companyId } of modulos) {
    empresas++;
    const activos = await prisma.hospEpisodio.findMany({
      where: {
        companyId,
        tipo: "HOSPITALIZACION",
        estado: { in: ["EN_VALORACION", "PREOPERATORIO", "EN_QUIROFANO", "POSTOPERATORIO", "HOSPITALIZADO"] },
        recursoId: { not: null },
      },
      select: { id: true },
    });
    for (const ep of activos) {
      if (Date.now() - startedAt >= TIME_BUDGET_MS) {
        completado = false;
        break;
      }
      episodios++;
      try {
        const r = await asegurarCargosEstancia(prisma, ep.id, hoy);
        cargos += r.creados;
        importe = r2(importe + r.importe);
      } catch (e) {
        // Un episodio roto no detiene a los demás: se reporta y sigue.
        errores.push({ episodioId: ep.id, error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (!completado) break;
  }

  const summary = { ok: errores.length === 0, empresas, episodios, cargos, importe, completado, errores, elapsedMs: Date.now() - startedAt };
  console.log("[cron/hospital-estancia] done:", JSON.stringify(summary));
  return NextResponse.json(summary);
}

export async function POST(req: Request) {
  return withCronLock("cron:hospital-estancia", () => handle(req));
}
export async function GET(req: Request) {
  return withCronLock("cron:hospital-estancia", () => handle(req));
}
