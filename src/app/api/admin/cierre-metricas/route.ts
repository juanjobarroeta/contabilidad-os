import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/cierre-metricas?desde=YYYY-MM-DD
//
// Precisión del pase diario del cierre guiado: avisos enviados vs accionados
// (a 7 días), por deltaKey; % plantilla; avisos por día y empresa. Es el
// número que decide si el pase se queda («lo que no mueve el número, no se
// queda»). Auth: CRON_SECRET, como copiloto-eval.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization");
  if (auth && auth === `Bearer ${secret}`) return true;
  return req.headers.get("x-cron-secret") === secret;
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const sp = new URL(req.url).searchParams;
  const desde = sp.get("desde") ? new Date(`${sp.get("desde")}T00:00:00-06:00`) : new Date(Date.now() - 30 * 86_400_000);
  const hasta = new Date();
  const avisos = await prisma.cierreAviso.findMany({
    where: { enviadoAt: { gte: desde, lte: hasta } },
    select: { companyId: true, deltaKey: true, plantilla: true, enviadoAt: true, accionadoAt: true },
  });
  const total = avisos.length;
  const accionados7d = avisos.filter(
    (a) => a.accionadoAt && a.accionadoAt.getTime() - a.enviadoAt.getTime() <= 7 * 86_400_000
  ).length;
  const porDelta = new Map<string, { enviados: number; accionados: number }>();
  for (const a of avisos) {
    const cur = porDelta.get(a.deltaKey) ?? { enviados: 0, accionados: 0 };
    cur.enviados++;
    if (a.accionadoAt) cur.accionados++;
    porDelta.set(a.deltaKey, cur);
  }
  const dias = Math.max(1, Math.round((hasta.getTime() - desde.getTime()) / 86_400_000));
  const empresas = new Set(avisos.map((a) => a.companyId)).size;
  return NextResponse.json({
    desde: desde.toISOString().slice(0, 10),
    hasta: hasta.toISOString().slice(0, 10),
    total,
    accionados7d,
    precision7d: total > 0 ? Math.round((accionados7d / total) * 100) / 100 : null,
    plantillaPct: total > 0 ? Math.round((avisos.filter((a) => a.plantilla).length / total) * 100) : null,
    avisosPorDiaYEmpresa: empresas > 0 ? Math.round((total / dias / empresas) * 100) / 100 : 0,
    porDelta: [...porDelta.entries()]
      .map(([deltaKey, v]) => ({ deltaKey, ...v, precision: Math.round((v.accionados / v.enviados) * 100) / 100 }))
      .sort((a, b) => b.enviados - a.enviados),
  });
}
