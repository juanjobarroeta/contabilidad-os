import { NextResponse } from "next/server";
import { AuthzError, requireMembership, requireOwner } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { kickCron } from "@/lib/cron-scheduler";
import { evaluarEtapas } from "@/lib/onboarding/estado";
import { mesesHistorial, resumirHistorial, type SolicitudMes } from "@/lib/onboarding/historial";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/onboarding/estado?companyId= — la pantalla 05 (Historial) y el chip
// / anillo que la sigue por la app. Todo sale de la base, nada se simula:
//   · meses   ← SatSyncRequest (EMITIDOS/RECIBIDOS) + facturas por mes
//   · capas   ← TaxDeclaration mensual presentada · CeBalanzaMes
//   · etapas  ← src/lib/onboarding/estado.ts (las 5 por factura)
//   · conteos ← CFDI, clientes (RFC distintos en INGRESO), proveedores (EGRESO)
//   · opinión ← último ComplianceSnapshot SAT_OPINION
//   · catálogo ← último CT de la CE aplicado (CeArchivo) · empleados activos
// La UI lo lee cada 5 s mientras está en la pantalla.
//
// POST { companyId, anios: 1|3|5 } — «¿Cuántos años?»: ajusta satBackfillYears
// (el mismo ajuste que lee cron/sat-backfill) y le da un empujón.
// ─────────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";

const ANIOS_VALIDOS = [1, 3, 5];

function error(e: unknown) {
  if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
  throw e;
}

export async function GET(req: Request) {
  try {
    const companyId = new URL(req.url).searchParams.get("companyId") ?? "";
    if (!companyId) return NextResponse.json({ error: "Falta companyId" }, { status: 400 });
    await requireMembership(companyId, undefined, req);

    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: {
        rfc: true,
        razonSocial: true,
        satBackfillYears: true,
        fechaInicioOperaciones: true,
        satBackfillCompletedAt: true,
        fielCer: true,
      },
    });
    if (!company) return NextResponse.json({ error: "Empresa no encontrada" }, { status: 404 });

    const hoy = new Date();
    const anios = Math.max(1, company.satBackfillYears);
    const anioMin = hoy.getUTCFullYear() - anios - 1;

    const [solicitudes, facturas, contrapartes, declaraciones, balanzas, total, conXml, conImpuestos, conContraparte, conVigencia, opinion, catalogo, cuentas, empleados] =
      await Promise.all([
        prisma.satSyncRequest.findMany({
          where: { companyId, tipo: { in: ["EMITIDOS", "RECIBIDOS"] }, year: { gte: anioMin } },
          select: { year: true, month: true, tipo: true, status: true, cfdisFound: true, errorMessage: true, desde: true, hasta: true, createdAt: true },
        }),
        prisma.$queryRaw<Array<{ year: number; month: number; n: bigint }>>`
          SELECT EXTRACT(YEAR FROM "fecha")::int AS year,
                 EXTRACT(MONTH FROM "fecha")::int AS month,
                 COUNT(*) AS n
          FROM "Invoice"
          WHERE "companyId" = ${companyId}
          GROUP BY 1, 2
        `,
        prisma.$queryRaw<Array<{ clientes: bigint; proveedores: bigint }>>`
          SELECT COUNT(DISTINCT "contraparteRfc") FILTER (WHERE "tipo" = 'INGRESO') AS clientes,
                 COUNT(DISTINCT "contraparteRfc") FILTER (WHERE "tipo" = 'EGRESO') AS proveedores
          FROM "Invoice"
          WHERE "companyId" = ${companyId} AND "contraparteRfc" IS NOT NULL
        `,
        prisma.taxDeclaration.findMany({
          where: { companyId, tipo: { in: ["IVA_MENSUAL", "ISR_PROVISIONAL"] }, status: { in: ["FILED", "PAID"] } },
          select: { periodo: true },
          distinct: ["periodo"],
        }),
        prisma.ceBalanzaMes.groupBy({ by: ["anio", "mes"], where: { companyId } }),
        prisma.invoice.count({ where: { companyId } }),
        prisma.invoice.count({ where: { companyId, rawXml: { not: null } } }),
        prisma.invoice.count({ where: { companyId, taxes: { some: {} } } }),
        prisma.invoice.count({ where: { companyId, contraparteNombre: { not: null } } }),
        prisma.invoice.count({ where: { companyId, vigenciaCheckedAt: { not: null } } }),
        prisma.complianceSnapshot.findFirst({
          where: { companyId, tipo: "SAT_OPINION" },
          orderBy: { fetchedAt: "desc" },
          select: { resultado: true, fetchedAt: true },
        }),
        // El catálogo de cuentas presentado al SAT (CE), ya aplicado.
        prisma.ceArchivo.findFirst({
          where: { companyId, tipo: "CT", importadoEn: { not: null } },
          orderBy: [{ anio: "desc" }, { mes: "desc" }],
          select: { anio: true, mes: true },
        }),
        prisma.chartAccount.count({ where: { companyId, isActive: true } }),
        // Empleados (los crea la importación de los recibos de nómina timbrados).
        prisma.employee.count({ where: { companyId, isActive: true } }),
      ]);

    const meses = mesesHistorial({
      hoy,
      anios,
      inicio: company.fechaInicioOperaciones,
      solicitudes: solicitudes as SolicitudMes[],
      facturas: new Map(facturas.map((r) => [`${r.year}-${r.month}`, Number(r.n)])),
      declaraciones: new Set(declaraciones.map((d) => d.periodo).filter((p) => /^\d{4}-\d{2}$/.test(p))),
      balanzas: new Set(balanzas.map((b) => `${b.anio}-${b.mes}`)),
    });

    const etapas = evaluarEtapas({
      companyId,
      total,
      conXml,
      conImpuestos,
      conContraparte,
      conVigencia,
      backfillCompleto: company.satBackfillCompletedAt != null,
    });

    return NextResponse.json({
      empresa: { rfc: company.rfc, razonSocial: company.razonSocial, anios: company.satBackfillYears, conFiel: !!company.fielCer },
      meses,
      resumen: resumirHistorial(meses),
      conteos: {
        cfdis: total,
        clientes: Number(contrapartes[0]?.clientes ?? 0),
        proveedores: Number(contrapartes[0]?.proveedores ?? 0),
      },
      etapas: etapas.map((e) => ({ clave: e.clave, etiqueta: e.etiqueta, hechos: e.hechos, total: e.total, pct: e.pct, completa: e.completa })),
      opinion: opinion ? { resultado: opinion.resultado, fetchedAt: opinion.fetchedAt.toISOString() } : null,
      catalogo: catalogo ? { anio: catalogo.anio, mes: catalogo.mes, cuentas } : null,
      empleados,
    });
  } catch (e) {
    return error(e);
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as { companyId?: string; anios?: number } | null;
    const companyId = typeof body?.companyId === "string" ? body.companyId : "";
    if (!companyId) return NextResponse.json({ error: "Falta companyId" }, { status: 400 });
    if (!ANIOS_VALIDOS.includes(body?.anios as number)) return NextResponse.json({ error: "Años inválidos" }, { status: 400 });
    await requireOwner(companyId, req);
    await prisma.company.update({
      where: { id: companyId },
      // Subir los años reabre el backfill: el cron decide por los meses que faltan.
      data: { satBackfillYears: body!.anios, satBackfillCompletedAt: null },
    });
    kickCron("sat-backfill");
    return NextResponse.json({ ok: true, anios: body!.anios });
  } catch (e) {
    return error(e);
  }
}
