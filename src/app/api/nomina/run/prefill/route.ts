import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, getEffectiveCompanyMembership, requireUser } from "@/lib/authz";
import { siguientePeriodo } from "@/lib/nomina/historia-import";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/nomina/run/prefill?companyId=xxx
//
// "Iniciar desde la quincena anterior": propone los datos de la SIGUIENTE
// corrida ordinaria a partir de la más reciente (incluidas las importadas del
// SAT — así el histórico recién importado alimenta la primera quincena en la
// app). Devuelve fechas del periodo avanzado según la periodicidad detectada
// (semanal/quincenal/mensual), los días pagados convencionales y la lista de
// empleados de la corrida anterior que siguen activos.
//
// SÓLO propone insumos: el cliente los manda a POST /api/nomina/run y el motor
// (calc-nomina) recalcula ISR/IMSS/INFONAVIT desde cero — nunca se copian
// impuestos ni incidencias puntuales (faltas, horas extra) de la corrida
// anterior.
// ─────────────────────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  let user;
  try {
    user = await requireUser(req);
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const companyId = new URL(req.url).searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  const member = await getEffectiveCompanyMembership(user.id, companyId);
  if (!member || member.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }

  // La corrida ordinaria más reciente por fecha de pago (APP o SAT).
  const anterior = await prisma.payrollRun.findFirst({
    where: { companyId, tipo: "ORDINARIA", status: { in: ["CALCULATED", "STAMPED", "PAID"] } },
    orderBy: [{ fechaPago: "desc" }, { createdAt: "desc" }],
    include: {
      items: { select: { employee: { select: { id: true, isActive: true } } } },
    },
  });

  if (!anterior) {
    return NextResponse.json(
      { error: "No hay una corrida ordinaria anterior de la cual partir" },
      { status: 404 }
    );
  }

  const [inicioStr, finStr] = anterior.periodo.split("/");
  const inicio = new Date(inicioStr);
  const fin = new Date(finStr);
  if (isNaN(inicio.getTime()) || isNaN(fin.getTime())) {
    return NextResponse.json({ error: "Periodo de la corrida anterior ilegible" }, { status: 422 });
  }

  const siguiente = siguientePeriodo({
    periodoInicio: inicio,
    periodoFin: fin,
    fechaPago: anterior.fechaPago,
  });

  // Empleados de la corrida anterior que siguen activos (las bajas se omiten;
  // los salarios y datos recurrentes viven en Employee y el motor los toma de
  // ahí al recalcular).
  const employeeIds = [
    ...new Set(anterior.items.filter((i) => i.employee.isActive).map((i) => i.employee.id)),
  ];
  const omitidosPorBaja = new Set(anterior.items.map((i) => i.employee.id)).size - employeeIds.length;

  return NextResponse.json({
    basadoEnRunId: anterior.id,
    basadoEnPeriodo: anterior.periodo,
    basadoEnOrigen: anterior.origen,
    tipo: "ORDINARIA",
    ...siguiente,
    employeeIds,
    omitidosPorBaja,
  });
}
