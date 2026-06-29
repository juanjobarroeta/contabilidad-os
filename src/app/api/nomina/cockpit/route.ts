import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { empresasAccesiblesIds } from "@/lib/authz";
import { SALARIO_MINIMO_GENERAL } from "@/lib/nomina/constants";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/nomina/cockpit — panel multi-RFC para el despacho de outsourcing.
//
// Para TODAS las empresas a las que el usuario tiene acceso (mismas dos vías
// que /api/companies: CompanyMember directo ∪ empresas del despacho, con
// scoping por miembro), agrega el estado de nómina de cada una en una sola
// respuesta: equipo, masa salarial, última corrida, actividad del mes,
// pendientes de timbrar y focos rojos (salarios bajo el mínimo, setup
// incompleto). Todo en consultas agregadas (groupBy/distinct) — no N+1.
// ─────────────────────────────────────────────────────────────────────────────

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Empresas accesibles (membresía directa ∪ despacho con scoping).
  const ids = await empresasAccesiblesIds(session.user.id);

  const companies = await prisma.company.findMany({
    where: { id: { in: ids }, isActive: true },
    select: {
      id: true,
      rfc: true,
      razonSocial: true,
      regimenFiscal: true,
      registroPatronal: true,
      facturapiApiKey: true, // sólo para derivar el booleano de setup — no se expone
    },
    orderBy: { razonSocial: "asc" },
  });
  const companyIds = companies.map((c) => c.id);
  if (companyIds.length === 0) return NextResponse.json({ companies: [] });

  const now = new Date();
  const monthFrom = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthTo = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  // ── Agregados por empresa (una consulta por métrica, no por empresa) ──────
  const [equipo, bajoMinimo, mes, sinTimbrar, ultimas] = await Promise.all([
    prisma.employee.groupBy({
      by: ["companyId"],
      where: { companyId: { in: companyIds }, isActive: true },
      _count: { id: true },
      _sum: { salarioDiario: true },
    }),
    prisma.employee.groupBy({
      by: ["companyId"],
      where: {
        companyId: { in: companyIds },
        isActive: true,
        salarioDiario: { lt: SALARIO_MINIMO_GENERAL },
      },
      _count: { id: true },
    }),
    prisma.payrollRun.groupBy({
      by: ["companyId"],
      where: { companyId: { in: companyIds }, fechaPago: { gte: monthFrom, lt: monthTo } },
      _count: { id: true },
      _sum: { totalNeto: true },
    }),
    // Corridas calculadas pero sin timbrar — el pendiente operativo típico.
    // Se traen los ids + totales (no sólo el conteo) para que el cockpit pueda
    // armar la SELECCIÓN EXPLÍCITA del timbrado en lote sin un segundo fetch:
    // el timbrado emite CFDIs reales ante el SAT, así que la lista de corridas a
    // timbrar se construye con ids concretos, no con un "timbrar todo".
    prisma.payrollRun.findMany({
      where: { companyId: { in: companyIds }, status: "CALCULATED" },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        companyId: true,
        periodo: true,
        tipo: true,
        totalNeto: true,
        _count: { select: { items: true } },
      },
    }),
    // Última corrida por empresa: distinct + orderBy desc = primera de cada una.
    prisma.payrollRun.findMany({
      where: { companyId: { in: companyIds } },
      orderBy: { createdAt: "desc" },
      distinct: ["companyId"],
      select: {
        companyId: true,
        periodo: true,
        tipo: true,
        status: true,
        fechaPago: true,
        totalNeto: true,
      },
    }),
  ]);

  const byId = <T extends { companyId: string }>(rows: T[]) =>
    new Map(rows.map((r) => [r.companyId, r]));
  const equipoBy = byId(equipo);
  const bajoBy = byId(bajoMinimo);
  const mesBy = byId(mes);
  const ultimaBy = byId(ultimas);

  // Corridas CALCULATED agrupadas por empresa: la lista concreta de corridas
  // timbrables (id, periodo, empleados, neto) que alimenta el timbrado en lote.
  const sinTimbrarBy = new Map<
    string,
    { id: string; periodo: string; tipo: string; empleados: number; totalNeto: number }[]
  >();
  for (const run of sinTimbrar) {
    const arr = sinTimbrarBy.get(run.companyId) ?? [];
    arr.push({
      id: run.id,
      periodo: run.periodo,
      tipo: run.tipo,
      empleados: run._count.items,
      totalNeto: run.totalNeto,
    });
    sinTimbrarBy.set(run.companyId, arr);
  }

  const r2 = (n: number) => Math.round(n * 100) / 100;

  return NextResponse.json({
    salarioMinimoGeneral: SALARIO_MINIMO_GENERAL,
    periodo: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`,
    companies: companies.map((c) => {
      const eq = equipoBy.get(c.id);
      const ult = ultimaBy.get(c.id);
      const runsSinTimbrar = sinTimbrarBy.get(c.id) ?? [];
      return {
        id: c.id,
        rfc: c.rfc,
        razonSocial: c.razonSocial,
        regimenFiscal: c.regimenFiscal,
        empleadosActivos: eq?._count.id ?? 0,
        masaSalarialDiaria: r2(eq?._sum.salarioDiario ?? 0),
        bajoMinimo: bajoBy.get(c.id)?._count.id ?? 0,
        corridasDelMes: mesBy.get(c.id)?._count.id ?? 0,
        netoDelMes: r2(mesBy.get(c.id)?._sum.totalNeto ?? 0),
        corridasSinTimbrar: runsSinTimbrar.length,
        // Lista explícita de corridas CALCULATED a timbrar (ids concretos +
        // totales) para construir la selección del timbrado en lote.
        runsSinTimbrar: runsSinTimbrar.map((r) => ({
          ...r,
          totalNeto: r2(r.totalNeto),
        })),
        ultimaCorrida: ult
          ? {
              periodo: ult.periodo,
              tipo: ult.tipo,
              status: ult.status,
              fechaPago: ult.fechaPago,
              totalNeto: ult.totalNeto,
            }
          : null,
        // Setup para poder timbrar nómina: registro patronal + clave Facturapi.
        setupCompleto: !!c.registroPatronal && !!c.facturapiApiKey,
      };
    }),
  });
}
