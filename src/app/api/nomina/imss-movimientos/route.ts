import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";

// ─────────────────────────────────────────────────────────────────────────────
// IMSS Movimientos Afiliatorios
//
// GET  — list pending/all movimientos
// POST — auto-detect movimientos from recent employee changes
// GET  ?format=idse — export IDSE batch file
// ─────────────────────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  const format = searchParams.get("format");
  const status = searchParams.get("status"); // optional filter

  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  const where = {
    companyId,
    ...(status ? { status: status as "PENDING" | "EXPORTED" | "FILED" | "REJECTED" } : {}),
  };

  const movimientos = await prisma.imssMovimiento.findMany({
    where,
    include: {
      employee: {
        select: { nombre: true, apellidoPaterno: true, apellidoMaterno: true, nss: true, rfc: true, curp: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  // IDSE export format
  if (format === "idse") {
    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: { registroPatronal: true, rfc: true },
    });
    if (!company?.registroPatronal) {
      return NextResponse.json({ error: "Falta registro patronal" }, { status: 400 });
    }

    const pending = movimientos.filter((m) => m.status === "PENDING");
    if (pending.length === 0) {
      return NextResponse.json({ error: "No hay movimientos pendientes para exportar" }, { status: 400 });
    }

    // IDSE batch format: pipe-delimited
    // TIPO|REG_PATRONAL|NSS|APELLIDO_PAT|APELLIDO_MAT|NOMBRE|SBC|FECHA_MOV|CURP|TIPO_SALARIO|TIPO_JORNADA
    const lines = pending.map((m) => {
      const tipoCode = { ALTA: "08", BAJA: "02", MODIFICACION_SALARIO: "07", REINGRESO: "08" }[m.tipo];
      const fecha = m.fechaMovimiento.toISOString().slice(0, 10).replace(/-/g, "");
      return [
        tipoCode,
        company.registroPatronal,
        m.employee.nss,
        m.employee.apellidoPaterno.toUpperCase(),
        (m.employee.apellidoMaterno ?? "").toUpperCase(),
        m.employee.nombre.toUpperCase(),
        (m.sbcNuevo ?? 0).toFixed(2),
        fecha,
        m.employee.curp,
        "0", // tipo salario: 0=fijo
        "1", // tipo jornada: 1=completa
      ].join("|");
    });

    // Mark as exported
    await prisma.imssMovimiento.updateMany({
      where: { id: { in: pending.map((m) => m.id) } },
      data: { status: "EXPORTED" },
    });

    const content = lines.join("\r\n");
    const filename = `IDSE_${company.registroPatronal}_${new Date().toISOString().slice(0, 10)}.txt`;

    return new Response(content, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  }

  return NextResponse.json({ movimientos, total: movimientos.length });
}

// POST /api/nomina/imss-movimientos — auto-detect from employee changes
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { companyId, action } = body;

  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member || member.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }

  if (action === "detect") {
    // Auto-detect movimientos from employee data
    const employees = await prisma.employee.findMany({
      where: { companyId },
      select: {
        id: true, nombre: true, apellidoPaterno: true, nss: true,
        fechaIngreso: true, fechaBaja: true, salarioDiario: true,
        salarioDiarioIntegrado: true, isActive: true, createdAt: true, updatedAt: true,
      },
    });

    // Get existing movimientos to avoid duplicates
    const existing = await prisma.imssMovimiento.findMany({
      where: { companyId },
      select: { employeeId: true, tipo: true, fechaMovimiento: true },
    });
    const existingKey = new Set(
      existing.map((m) => `${m.employeeId}:${m.tipo}:${m.fechaMovimiento.toISOString().slice(0, 10)}`)
    );

    const created: string[] = [];

    for (const emp of employees) {
      const sdi = emp.salarioDiarioIntegrado ?? emp.salarioDiario;

      // Alta — new employee (created recently, no existing ALTA movimiento)
      const altaKey = `${emp.id}:ALTA:${emp.fechaIngreso.toISOString().slice(0, 10)}`;
      if (!existingKey.has(altaKey) && emp.isActive) {
        await prisma.imssMovimiento.create({
          data: {
            companyId, employeeId: emp.id,
            tipo: "ALTA",
            fechaMovimiento: emp.fechaIngreso,
            sbcNuevo: sdi,
            motivo: "Alta automática por registro de empleado",
          },
        });
        created.push(`Alta: ${emp.nombre} ${emp.apellidoPaterno}`);
      }

      // Baja — employee deactivated with fechaBaja
      if (emp.fechaBaja && !emp.isActive) {
        const bajaKey = `${emp.id}:BAJA:${emp.fechaBaja.toISOString().slice(0, 10)}`;
        if (!existingKey.has(bajaKey)) {
          await prisma.imssMovimiento.create({
            data: {
              companyId, employeeId: emp.id,
              tipo: "BAJA",
              fechaMovimiento: emp.fechaBaja,
              sbcAnterior: sdi,
              motivo: "Baja automática por desactivación de empleado",
            },
          });
          created.push(`Baja: ${emp.nombre} ${emp.apellidoPaterno}`);
        }
      }
    }

    return NextResponse.json({ ok: true, detected: created.length, movimientos: created });
  }

  // Manual movimiento creation
  if (action === "create") {
    const { employeeId, tipo, fechaMovimiento, sbcNuevo, sbcAnterior, motivo } = body;
    if (!employeeId || !tipo || !fechaMovimiento) {
      return NextResponse.json({ error: "employeeId, tipo y fechaMovimiento requeridos" }, { status: 400 });
    }

    const mov = await prisma.imssMovimiento.create({
      data: {
        companyId, employeeId, tipo,
        fechaMovimiento: new Date(fechaMovimiento),
        sbcNuevo: sbcNuevo ? Number(sbcNuevo) : null,
        sbcAnterior: sbcAnterior ? Number(sbcAnterior) : null,
        motivo,
      },
    });

    return NextResponse.json({ ok: true, movimiento: mov }, { status: 201 });
  }

  // Mark movimiento as filed
  if (action === "mark-filed") {
    const { movimientoIds, idseConfirmation } = body;
    if (!movimientoIds?.length) return NextResponse.json({ error: "movimientoIds requeridos" }, { status: 400 });

    await prisma.imssMovimiento.updateMany({
      where: { id: { in: movimientoIds }, companyId },
      data: { status: "FILED", filedAt: new Date(), idseConfirmation: idseConfirmation ?? null },
    });

    return NextResponse.json({ ok: true, count: movimientoIds.length });
  }

  return NextResponse.json({ error: "action inválido" }, { status: 400 });
}
