import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, getEffectiveCompanyMembership, requireUser } from "@/lib/authz";
import { gateEscritura } from "@/lib/subscription";
import { registrarBitacora } from "@/lib/audit";

// GET /api/nomina/dispersion?runId=xxx
//
// Generates a bank-compatible payment file (CSV) for SPEI batch transfers.
// Compatible with BBVA, Banorte, Santander, Banamex standard CSV layouts.
// Los datos bancarios (CLABE/Banco) se toman del empleado cuando están capturados.

export async function GET(req: Request) {
  let user;
  try {
    user = await requireUser(req);
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

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

  const member = await getEffectiveCompanyMembership(user.id, run.companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });
  // El archivo de dispersión expone CLABE, banco, RFC y neto de todos los
  // empleados: sólo roles con permiso de escritura pueden exportarlo.
  if (member.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos para exportar la dispersión" }, { status: 403 });
  }

  // Gating de suscripción (bandera SUBSCRIPTION_ENFORCEMENT_ENABLED). Aunque es
  // un GET, el archivo SPEI es el ENTREGABLE monetizable de la nómina: se trata
  // como export de valor, no como lectura pasiva.
  const gate = await gateEscritura(user.id);
  if (gate) return gate;

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

  // Bitácora de seguridad: exportar la dispersión ES un evento (el archivo
  // expone CLABE/RFC/neto de toda la plantilla). Fire-and-forget.
  registrarBitacora({
    companyId: run.companyId,
    userId: user.id,
    actorEmail: user.email ?? null,
    accion: "nomina.dispersion-export",
    entidad: "PayrollRun",
    entidadId: run.id,
    detalle: {
      periodo: run.periodo,
      empresaRfc: run.company.rfc,
      empleados: run.items.length,
    },
    req,
  });

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
