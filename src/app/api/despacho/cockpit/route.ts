import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { empresasAccesiblesIds } from "@/lib/authz";
import { coberturaConCotejo } from "@/lib/fiscal/cobertura-con-cotejo";
import { resumenObligacionesPorEmpresa } from "@/lib/obligaciones-resumen";

// GET /api/despacho/cockpit
// Panel del despacho: una fila por empresa accesible con el estado del periodo
// en curso — declaración federal (presentada / por presentar / vencida), montos
// a pagar (de las declaraciones YA calculadas/guardadas, sin recomputar el motor
// para que escale a muchos RFC), nómina sin timbrar y empleados. Más una franja
// global de cobertura de datos fiscales. "Operar" salta a la empresa.
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const ids = await empresasAccesiblesIds(session.user.id);
  if (ids.length === 0) return NextResponse.json({ companies: [], cobertura: null });

  const now = new Date();
  // Periodo en curso a declarar = MES ANTERIOR (se declara el mes siguiente,
  // vence el 17). En enero, el periodo es diciembre del año previo.
  const periodoDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const year = periodoDate.getFullYear();
  const month = periodoDate.getMonth() + 1;
  const periodo = `${year}-${String(month).padStart(2, "0")}`;
  // Vence el día 17 del mes siguiente al periodo (= este mes).
  const vencimiento = new Date(now.getFullYear(), now.getMonth(), 17, 23, 59, 59);

  const companies = await prisma.company.findMany({
    where: { id: { in: ids }, isActive: true },
    select: { id: true, rfc: true, razonSocial: true, regimenFiscal: true },
    orderBy: { razonSocial: "asc" },
  });
  const companyIds = companies.map((c) => c.id);

  // Lecturas baratas (sin recomputar impuestos): declaraciones del periodo,
  // nómina sin timbrar y empleados activos — todo agregado.
  const [decls, sinTimbrar, empleados] = await Promise.all([
    prisma.taxDeclaration.findMany({
      where: {
        companyId: { in: companyIds },
        tipo: { in: ["IVA_MENSUAL", "ISR_PROVISIONAL"] },
        periodo,
      },
      select: { companyId: true, tipo: true, status: true, ivaPagar: true, isrPagar: true },
    }),
    prisma.payrollRun.groupBy({
      by: ["companyId"],
      where: { companyId: { in: companyIds }, status: "CALCULATED" },
      _count: { id: true },
    }),
    prisma.employee.groupBy({
      by: ["companyId"],
      where: { companyId: { in: companyIds }, isActive: true },
      _count: { id: true },
    }),
  ]);

  const declsBy = new Map<string, typeof decls>();
  for (const d of decls) {
    const arr = declsBy.get(d.companyId) ?? [];
    arr.push(d);
    declsBy.set(d.companyId, arr);
  }
  const sinTimbrarBy = new Map(sinTimbrar.map((r) => [r.companyId, r._count.id]));
  const empleadosBy = new Map(empleados.map((r) => [r.companyId, r._count.id]));

  // Obligaciones vencidas / por vencer del AÑO en curso, por empresa (mismo
  // criterio que el calendario de Cumplimiento). Así el cockpit muestra QUÉ
  // empresas están atrasadas, no sólo el estado de la declaración del periodo.
  const obligBy = await resumenObligacionesPorEmpresa(companyIds, now.getFullYear(), now);

  const FILED = ["FILED", "PAID"];
  const vencido = now > vencimiento;

  const rows = companies.map((c) => {
    const ds = declsBy.get(c.id) ?? [];
    const iva = ds.find((d) => d.tipo === "IVA_MENSUAL");
    const isr = ds.find((d) => d.tipo === "ISR_PROVISIONAL");
    const algunaGuardada = ds.length > 0;
    const todasPresentadas = algunaGuardada && ds.every((d) => FILED.includes(d.status ?? ""));

    // Estado de la declaración federal del periodo.
    let estado: "presentada" | "calculada" | "pendiente" | "vencida";
    if (todasPresentadas) estado = "presentada";
    else if (algunaGuardada) estado = vencido ? "vencida" : "calculada";
    else estado = vencido ? "vencida" : "pendiente";

    const aPagar = Math.round(((iva?.ivaPagar ?? 0) + (isr?.isrPagar ?? 0)) * 100) / 100;

    return {
      id: c.id,
      rfc: c.rfc,
      razonSocial: c.razonSocial,
      regimenFiscal: c.regimenFiscal,
      periodo,
      estadoDeclaracion: estado,
      aPagar: algunaGuardada ? aPagar : null,
      nominaSinTimbrar: sinTimbrarBy.get(c.id) ?? 0,
      empleadosActivos: empleadosBy.get(c.id) ?? 0,
      obligacionesVencidas: obligBy.get(c.id)?.vencidas ?? 0,
      obligacionesPorVencer: obligBy.get(c.id)?.porVencer ?? 0,
    };
  });

  const totalAPagar = rows.reduce((s, r) => s + (r.aPagar ?? 0), 0);
  const conPendientes = rows.filter((r) => r.estadoDeclaracion !== "presentada").length;
  const empresasConVencidas = rows.filter((r) => r.obligacionesVencidas > 0).length;
  const totalVencidas = rows.reduce((s, r) => s + r.obligacionesVencidas, 0);

  return NextResponse.json({
    periodo,
    vencimiento: vencimiento.toISOString(),
    vencido,
    companies: rows,
    resumen: {
      empresas: rows.length,
      conPendientes,
      totalAPagar: Math.round(totalAPagar * 100) / 100,
      empresasConVencidas,
      totalVencidas,
    },
    // Franja global: frescura de los datos fiscales del país (no por empresa).
    cobertura: (await coberturaConCotejo(now)).resumen,
  });
}
