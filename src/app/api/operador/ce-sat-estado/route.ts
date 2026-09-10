import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isOperador } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { planIncluyeSyntage } from "@/lib/planes";

export const dynamic = "force-dynamic";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/operador/ce-sat-estado
//
// «¿Cómo se está portando la descarga de CE del SAT?» — el worker Playwright
// (servicio `ce-worker` en Railway, cron mensual) corre sin la Mac y sus logs
// son efímeros. Esta vista lee lo que el worker DEJÓ REGISTRADO por empresa
// (Company.ceSatSync*) + la cobertura real en CeBalanzaMes, para el operador.
// Sólo lectura, sin secretos.
// ─────────────────────────────────────────────────────────────────────────────
export async function GET() {
  const session = await auth();
  if (!session?.user?.id || !(await isOperador(session.user.id))) {
    return NextResponse.json({ error: "Sólo disponible para operador de plataforma" }, { status: 403 });
  }

  const empresas = await prisma.company.findMany({
    where: { isActive: true, fielCer: { not: null }, fielKey: { not: null }, fielPassword: { not: null } },
    select: {
      id: true,
      rfc: true,
      razonSocial: true,
      tier: true,
      ceSatSyncEn: true,
      ceSatSyncOk: true,
      ceSatSyncNuevos: true,
      ceSatSyncInfo: true,
    },
    orderBy: { rfc: "asc" },
  });
  const elegibles = empresas.filter((c) => planIncluyeSyntage(c.tier));

  // Cobertura real en CeBalanzaMes (una sola consulta): períodos y último mes.
  const ids = elegibles.map((c) => c.id);
  const grupos = ids.length
    ? await prisma.ceBalanzaMes.groupBy({ by: ["companyId", "anio", "mes"], where: { companyId: { in: ids } } })
    : [];
  const cobertura = new Map<string, { periodos: number; ultimo: string }>();
  for (const g of grupos) {
    const prev = cobertura.get(g.companyId) ?? { periodos: 0, ultimo: "" };
    const per = `${g.anio}-${String(g.mes).padStart(2, "0")}`;
    cobertura.set(g.companyId, { periodos: prev.periodos + 1, ultimo: per > prev.ultimo ? per : prev.ultimo });
  }

  const filas = elegibles.map((c) => {
    const cob = cobertura.get(c.id) ?? { periodos: 0, ultimo: "" };
    return {
      rfc: c.rfc,
      razonSocial: c.razonSocial,
      tier: c.tier,
      syncEn: c.ceSatSyncEn,
      syncOk: c.ceSatSyncOk,
      syncNuevos: c.ceSatSyncNuevos,
      syncInfo: c.ceSatSyncInfo,
      periodos: cob.periodos,
      ultimoPeriodo: cob.ultimo || null,
    };
  });

  const resumen = {
    total: filas.length,
    ok: filas.filter((f) => f.syncOk === true).length,
    sinBuzon: filas.filter((f) => f.syncOk === false && /sinBuzón/i.test(f.syncInfo ?? "")).length,
    error: filas.filter((f) => f.syncOk === false && /^error| error/i.test(f.syncInfo ?? "")).length,
    nuncaCorrio: filas.filter((f) => f.syncEn == null).length,
    conDatos: filas.filter((f) => f.periodos > 0).length,
  };

  return NextResponse.json({ resumen, empresas: filas });
}
