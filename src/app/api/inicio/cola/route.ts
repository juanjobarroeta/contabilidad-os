import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, empresasAccesiblesIds, requireUser } from "@/lib/authz";
import { armarCola, type SenalesEmpresa } from "@/lib/inicio/cola";

// GET /api/inicio/cola — el lente despacho del nuevo Inicio (rediseño Piloto).
//
// Una fila por cosa-que-hacer en la cartera, UNA acción por fila, ordenadas
// por urgencia. Mismo presupuesto de queries que /api/despacho/cockpit:
// TODO batcheado, jamás computeTaxPosition ni la balanza sobre N empresas.

const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];
const MESES_CORTO = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

const TAGS_IGNORED = [
  "PENDING_MONTHLY_CFDI", "TAX_PAYMENT", "PAYROLL_NO_CFDI", "NON_DEDUCTIBLE",
  "INTERNAL_TRANSFER", "LOAN_RECEIVED", "LOAN_GIVEN", "CAPITAL_CONTRIBUTION",
];

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    const ids = await empresasAccesiblesIds(user.id);
    if (ids.length === 0) return NextResponse.json({ filas: [], resumen: null, agenda: [] });

    const now = new Date();
    // Periodo fiscal en juego = mes anterior; vence el 17 de este mes.
    const periodoDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const year = periodoDate.getFullYear();
    const month = periodoDate.getMonth() + 1;
    const periodo = `${year}-${String(month).padStart(2, "0")}`;
    const vencimiento = new Date(now.getFullYear(), now.getMonth(), 17, 23, 59, 59);
    const vencido = now > vencimiento;
    const periodoLabel = MESES[month - 1];
    const venceLabel = `17 ${MESES_CORTO[now.getMonth()]}`;

    const companies = await prisma.company.findMany({
      where: { id: { in: ids }, isActive: true },
      select: { id: true, rfc: true, razonSocial: true, registroPatronal: true, facturapiApiKey: true },
      orderBy: { razonSocial: "asc" },
    });
    const companyIds = companies.map((c) => c.id);

    const [decls, runsSinTimbrar, corridasMes, empleados, bancoPend, periodos, hallazgos] =
      await Promise.all([
        prisma.taxDeclaration.findMany({
          where: { companyId: { in: companyIds }, tipo: { in: ["IVA_MENSUAL", "ISR_PROVISIONAL"] }, periodo },
          select: { companyId: true, tipo: true, status: true, ivaPagar: true, isrPagar: true },
        }),
        prisma.payrollRun.findMany({
          where: { companyId: { in: companyIds }, status: "CALCULATED" },
          select: { companyId: true, totalNeto: true, _count: { select: { items: true } } },
        }),
        prisma.payrollRun.groupBy({
          by: ["companyId"],
          where: {
            companyId: { in: companyIds },
            fechaPago: { gte: new Date(now.getFullYear(), now.getMonth(), 1) },
          },
          _count: { id: true },
        }),
        prisma.employee.groupBy({
          by: ["companyId"],
          where: { companyId: { in: companyIds }, isActive: true },
          _count: { id: true },
        }),
        // Sin clasificar = UNMATCHED + IGNORED sin categoría — el criterio que
        // BLOQUEA el cierre en el motor de posteo, no sólo el UNMATCHED.
        prisma.bankTransaction.groupBy({
          by: ["companyId"],
          where: {
            companyId: { in: companyIds },
            OR: [
              { status: "UNMATCHED" },
              { status: "IGNORED", OR: [{ notes: null }, { notes: { notIn: TAGS_IGNORED } }] },
            ],
          },
          _count: { id: true },
        }),
        prisma.accountingPeriod.findMany({
          where: { companyId: { in: companyIds }, year, month },
          select: { companyId: true, status: true },
        }),
        prisma.fiscalHallazgo.groupBy({
          by: ["companyId"],
          where: {
            companyId: { in: companyIds },
            estado: "ABIERTO",
            severidad: "error",
            OR: [{ posponerHasta: null }, { posponerHasta: { lte: now } }],
          },
          _count: { id: true },
        }),
      ]);

    const declsBy = new Map<string, typeof decls>();
    for (const d of decls) {
      const arr = declsBy.get(d.companyId) ?? [];
      arr.push(d);
      declsBy.set(d.companyId, arr);
    }
    const runsBy = new Map<string, { totalNeto: number; empleados: number }[]>();
    for (const r of runsSinTimbrar) {
      const arr = runsBy.get(r.companyId) ?? [];
      arr.push({ totalNeto: Number(r.totalNeto), empleados: r._count.items });
      runsBy.set(r.companyId, arr);
    }
    const corridasBy = new Map(corridasMes.map((r) => [r.companyId, r._count.id]));
    const empleadosBy = new Map(empleados.map((r) => [r.companyId, r._count.id]));
    const bancoBy = new Map(bancoPend.map((r) => [r.companyId, r._count.id]));
    const periodoBy = new Map(periodos.map((p) => [p.companyId, p.status]));
    const criticosBy = new Map(hallazgos.map((h) => [h.companyId, h._count.id]));

    const FILED = ["FILED", "PAID"];
    const senales: SenalesEmpresa[] = companies.map((c) => {
      const ds = declsBy.get(c.id) ?? [];
      const iva = ds.find((d) => d.tipo === "IVA_MENSUAL");
      const isr = ds.find((d) => d.tipo === "ISR_PROVISIONAL");
      const algunaGuardada = ds.length > 0;
      const todasPresentadas = algunaGuardada && ds.every((d) => FILED.includes(d.status ?? ""));
      const estado = todasPresentadas
        ? ("presentada" as const)
        : algunaGuardada
          ? vencido ? ("vencida" as const) : ("calculada" as const)
          : vencido ? ("vencida" as const) : ("pendiente" as const);
      const aPagarRaw = Number(iva?.ivaPagar ?? 0) + Number(isr?.isrPagar ?? 0);
      return {
        companyId: c.id,
        razonSocial: c.razonSocial,
        rfc: c.rfc,
        declaracion: {
          estado,
          aPagar: algunaGuardada ? Math.round(aPagarRaw * 100) / 100 : null,
          periodoLabel,
          venceLabel,
        },
        nomina: {
          runsSinTimbrar: runsBy.get(c.id) ?? [],
          corridasDelMes: corridasBy.get(c.id) ?? 0,
          empleadosActivos: empleadosBy.get(c.id) ?? 0,
          setupCompleto: !!(c.registroPatronal && c.facturapiApiKey),
        },
        banco: { sinClasificar: bancoBy.get(c.id) ?? 0 },
        cierre: { mesAnteriorPosteado: (periodoBy.get(c.id) ?? "DRAFT") !== "DRAFT", label: periodoLabel },
        hallazgosCriticos: criticosBy.get(c.id) ?? 0,
      };
    });

    const { filas, resumen } = armarCola(senales, { diaDelMes: now.getDate() });

    // Agenda fiscal — próximos 30 días, fechas clave con alcance de cartera.
    const empresasActivas = companies.length;
    const en30 = (d: Date) => d > now && d.getTime() - now.getTime() < 30 * 86400000;
    const fecha = (dia: number, mesOffset: number) =>
      new Date(now.getFullYear(), now.getMonth() + mesOffset, dia);
    const candidatos = [
      { f: fecha(5, 0), label: "REP del mes", detalle: "complementos de cobros PPD" },
      { f: fecha(5, 1), label: "REP del mes", detalle: "complementos de cobros PPD" },
      { f: fecha(17, 0), label: `IVA + ISR ${periodoLabel}`, detalle: `${empresasActivas} empresa${empresasActivas === 1 ? "" : "s"}` },
      { f: fecha(17, 1), label: `IVA + ISR ${MESES[now.getMonth()]}`, detalle: `${empresasActivas} empresa${empresasActivas === 1 ? "" : "s"}` },
      { f: fecha(17, 0), label: "SIPARE", detalle: "cuotas IMSS del mes" },
      { f: fecha(17, 1), label: "SIPARE", detalle: "cuotas IMSS del mes" },
      { f: new Date(now.getFullYear(), now.getMonth() + 1, 0), label: "DIOT", detalle: "informativa · 54 campos, se genera sola" },
    ];
    const vistos = new Set<string>();
    const agenda = candidatos
      .filter((c) => en30(c.f))
      .filter((c) => (vistos.has(c.label) ? false : (vistos.add(c.label), true)))
      .sort((a, b) => a.f.getTime() - b.f.getTime())
      .map((c) => ({
        fecha: c.f.toISOString().slice(0, 10),
        fechaFmt: `${String(c.f.getDate()).padStart(2, "0")} ${MESES_CORTO[c.f.getMonth()].toUpperCase()}`,
        label: c.label,
        detalle: c.detalle,
      }));

    return NextResponse.json({ filas, resumen, agenda, empresas: empresasActivas });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Error armando la cola" },
      { status: 500 },
    );
  }
}
