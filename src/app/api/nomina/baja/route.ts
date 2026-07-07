import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { calcularFiniquito } from "@/lib/nomina/finiquito";
import { createPayrollRun, type PayrollRunResult } from "@/lib/nomina/payroll-run";

// POST /api/nomina/baja
// Da de baja al empleado, crea el movimiento IMSS de Baja, calcula el
// finiquito/liquidación y, opcionalmente, crea la corrida FINIQUITO (un
// PayrollRun individual con el desglose del cálculo) lista para timbrar el
// CFDI de separación desde la pestaña de corridas — el timbrado NO ocurre
// aquí, sigue el flujo normal (candado incluido).
//
// Body: {
//   companyId, employeeId, fechaBaja, motivo, diasSalarioPendiente?,
//   crearCorridaFiniquito?, fechaPagoFiniquito?
// }
// motivo: "VOLUNTARIA" | "JUSTIFICADA" | "INJUSTIFICADA"

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { companyId, employeeId, fechaBaja, motivo, diasSalarioPendiente } = body;

  if (!companyId || !employeeId || !fechaBaja || !motivo) {
    return NextResponse.json({ error: "companyId, employeeId, fechaBaja y motivo requeridos" }, { status: 400 });
  }

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member || member.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }

  const employee = await prisma.employee.findFirst({
    where: { id: employeeId, companyId, isActive: true },
  });
  if (!employee) {
    return NextResponse.json({ error: "Empleado no encontrado o ya dado de baja" }, { status: 404 });
  }

  const fechaBajaDate = new Date(fechaBaja);

  // 1. Deactivate employee
  await prisma.employee.update({
    where: { id: employeeId },
    data: { isActive: false, fechaBaja: fechaBajaDate },
  });

  // 2. Create IMSS Baja movement
  await prisma.imssMovimiento.create({
    data: {
      companyId,
      employeeId,
      tipo: "BAJA",
      fechaMovimiento: fechaBajaDate,
      sbcAnterior: employee.salarioDiarioIntegrado ?? employee.salarioDiario,
      motivo: `Baja ${motivo.toLowerCase()}: ${employee.nombre} ${employee.apellidoPaterno}`,
    },
  });

  // 3. Calculate finiquito/liquidación
  const finiquito = calcularFiniquito({
    salarioDiario: employee.salarioDiario,
    salarioDiarioIntegrado: employee.salarioDiarioIntegrado ?? employee.salarioDiario,
    fechaIngreso: employee.fechaIngreso,
    fechaBaja: fechaBajaDate,
    motivo: motivo as "VOLUNTARIA" | "JUSTIFICADA" | "INJUSTIFICADA",
    diasSalarioPendiente: diasSalarioPendiente ? Number(diasSalarioPendiente) : 0,
  });

  // 4. Corrida FINIQUITO opcional: PayrollRun individual (tipo FINIQUITO) con
  // un PayrollItem armado desde el mismo cálculo (calcularFiniquito vía
  // calcularNomina) — percepciones con las exenciones de los Arts. 93
  // fraccs. XIII y XIV LISR e ISR retenido del motor. Queda en estado
  // CALCULATED; el CFDI de separación se timbra después por la vía normal de
  // corridas (stampPayrollRun, con candado), como las demás extraordinarias.
  let finiquitoRun: PayrollRunResult | null = null;
  if (body.crearCorridaFiniquito) {
    finiquitoRun = await createPayrollRun({
      companyId,
      tipo: "FINIQUITO",
      periodoInicio: fechaBajaDate,
      periodoFin: fechaBajaDate,
      fechaPago: body.fechaPagoFiniquito ? new Date(body.fechaPagoFiniquito) : fechaBajaDate,
      // Sin días de cotización IMSS: la baja corta la relación laboral y las
      // percepciones de separación no cotizan como salario del periodo.
      diasPagados: 0,
      employeeIds: [employeeId],
      finiquito: {
        motivo: motivo as "VOLUNTARIA" | "JUSTIFICADA" | "INJUSTIFICADA",
        fechaBaja: fechaBajaDate,
        diasSalarioPendiente: diasSalarioPendiente ? Number(diasSalarioPendiente) : 0,
      },
    });
  }

  return NextResponse.json({
    ok: true,
    employee: {
      id: employee.id,
      nombre: `${employee.nombre} ${employee.apellidoPaterno}`,
    },
    imssMovimiento: "BAJA creada (pendiente de presentar en IDSE)",
    finiquito: finiquito.desglose,
    aniosAntiguedad: finiquito.aniosAntiguedad,
    finiquitoRun,
  });
}
