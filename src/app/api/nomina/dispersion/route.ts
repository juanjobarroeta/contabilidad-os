import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";

// GET /api/nomina/dispersion?runId=xxx
//
// Generates a bank-compatible payment file (CSV) for SPEI batch transfers.
// Compatible with BBVA, Banorte, Santander, Banamex standard CSV layouts.
// Los datos bancarios (CLABE/Banco) se toman del empleado cuando están capturados.

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const runId = searchParams.get("runId");
  if (!runId) return NextResponse.json({ error: "runId requerido" }, { status: 400 });

  const run = await prisma.payrollRun.findUnique({
    where: { id: runId },
    include: {
      items: {
        include: {
          employee: {
            select: {
              nombre: true, apellidoPaterno: true, apellidoMaterno: true,
              rfc: true, numEmpleado: true, clabe: true, banco: true,
            },
          },
        },
      },
      company: { select: { razonSocial: true, rfc: true } },
    },
  });

  if (!run) return NextResponse.json({ error: "Corrida no encontrada" }, { status: 404 });

  const member = await getEffectiveCompanyMembership(session.user.id, run.companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  if (!["CALCULATED", "STAMPED", "PAID"].includes(run.status)) {
    return NextResponse.json({ error: "La corrida debe estar calculada o timbrada" }, { status: 400 });
  }

  // Build CSV: standard SPEI batch layout
  const header = "Num Empleado,Nombre,RFC,CLABE,Banco,Neto a Pagar,Concepto,Referencia";
  const lines = run.items.map((item) => {
    const nombre = `${item.employee.apellidoPaterno} ${item.employee.apellidoMaterno ?? ""} ${item.employee.nombre}`.trim();
    const numEmp = item.employee.numEmpleado ?? item.employeeId.slice(-6);
    const clabe = item.employee.clabe ?? "";
    const banco = item.employee.banco ?? "";
    const concepto = `Nomina ${run.periodo}`;
    const referencia = run.id.slice(-8);

    return [
      numEmp,
      `"${nombre}"`,
      item.employee.rfc,
      clabe,
      `"${banco}"`,
      item.netoAPagar.toFixed(2),
      `"${concepto}"`,
      referencia,
    ].join(",");
  });

  const csv = [header, ...lines].join("\r\n");
  const filename = `Dispersion_${run.company.rfc}_${run.periodo.replace(/\//g, "_")}.csv`;

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
