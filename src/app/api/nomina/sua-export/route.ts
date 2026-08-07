import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { registroPatronalEfectivo } from "@/lib/nomina/registro-patronal";

// GET /api/nomina/sua-export?companyId=xxx&bimestre=3&year=2026
//
// Generates a SUA-compatible text file for IMSS bimonthly payment.
// SUA import format: fixed-width pipe-delimited records with employee
// data, SBC, and days worked per bimester.
//
// Bimestres: 1=Ene-Feb, 2=Mar-Abr, 3=May-Jun, 4=Jul-Ago, 5=Sep-Oct, 6=Nov-Dic

const BIMESTRE_MONTHS: Record<number, [number, number]> = {
  1: [1, 2], 2: [3, 4], 3: [5, 6], 4: [7, 8], 5: [9, 10], 6: [11, 12],
};

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  const bimestre = parseInt(searchParams.get("bimestre") ?? "0");
  const year = parseInt(searchParams.get("year") ?? "0");

  if (!companyId || !bimestre || !year || bimestre < 1 || bimestre > 6) {
    return NextResponse.json({ error: "companyId, bimestre (1-6) y year requeridos" }, { status: 400 });
  }

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });
  // El archivo SUA expone NSS, CURP, RFC y SDI de todos los empleados:
  // sólo roles con permiso de escritura pueden exportarlo.
  if (member.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos para exportar el archivo SUA" }, { status: 403 });
  }

  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { rfc: true, registroPatronal: true, razonSocial: true },
  });
  if (!company) return NextResponse.json({ error: "Empresa no encontrada" }, { status: 404 });
  if (!company.registroPatronal) {
    return NextResponse.json({ error: "Falta el Registro Patronal (configúralo en /empresa)" }, { status: 400 });
  }

  // Fetch active employees
  const employees = await prisma.employee.findMany({
    where: { companyId, isActive: true },
    orderBy: { apellidoPaterno: "asc" },
  });

  const [mes1, mes2] = BIMESTRE_MONTHS[bimestre];

  // For each employee, find payroll items in this bimester to get days worked
  const periodoStart = `${year}-${String(mes1).padStart(2, "0")}`;
  const periodoEnd = `${year}-${String(mes2).padStart(2, "0")}`;

  const payrollItems = await prisma.payrollItem.findMany({
    where: {
      employee: { companyId },
      payrollRun: {
        companyId,
        tipo: "ORDINARIA",
        periodo: { gte: periodoStart, lte: `${periodoEnd}-31` },
        status: { in: ["CALCULATED", "STAMPED", "PAID"] },
      },
    },
    select: {
      employeeId: true,
      totalPercepciones: true,
      imssObrero: true,
      imssPatronal: true,
    },
  });

  // Aggregate per employee
  const itemsByEmployee = new Map<string, { totalPerc: number; imssObrero: number; imssPatronal: number }>();
  for (const item of payrollItems) {
    const existing = itemsByEmployee.get(item.employeeId) ?? { totalPerc: 0, imssObrero: 0, imssPatronal: 0 };
    existing.totalPerc += item.totalPercepciones;
    existing.imssObrero += item.imssObrero;
    existing.imssPatronal += item.imssPatronal;
    itemsByEmployee.set(item.employeeId, existing);
  }

  // Build SUA format lines
  // Format per line: REG_PATRONAL|NSS|APELLIDO_PAT|APELLIDO_MAT|NOMBRE|SBC|DIAS|AUSENTISMO|INCAPACIDAD
  const lines: string[] = [];

  // Header line
  lines.push(`H|${company.registroPatronal}|${company.rfc}|${company.razonSocial}|${bimestre}|${year}`);

  for (const emp of employees) {
    const sdi = emp.salarioDiarioIntegrado ?? emp.salarioDiario;
    // Estimate days in bimester (default 61 for most, 59-60 for bim 1)
    const daysInBimester = bimestre === 1
      ? (year % 4 === 0 ? 60 : 59) // Jan+Feb
      : mes1 <= 6 ? 61 : (mes1 === 7 ? 62 : (mes1 === 9 ? 61 : (mes1 === 11 ? 61 : 61)));
    const diasCotizados = daysInBimester; // Full bimester by default
    const ausentismos = 0; // TODO: deduct from incidencias when we have them
    const incapacidades = 0;

    lines.push([
      "D", // Detail record
      // Registro EFECTIVO por empleado: en una empresa multi-estado cada
      // centro de trabajo cotiza bajo su propio registro patronal.
      registroPatronalEfectivo(emp, company) ?? company.registroPatronal,
      emp.nss,
      emp.apellidoPaterno.toUpperCase(),
      (emp.apellidoMaterno ?? "").toUpperCase(),
      emp.nombre.toUpperCase(),
      sdi.toFixed(2),
      String(diasCotizados),
      String(ausentismos),
      String(incapacidades),
      emp.riesgoPuesto,
      emp.curp,
      emp.rfc.toUpperCase(),
    ].join("|"));
  }

  // Trailer
  lines.push(`T|${employees.length}`);

  const content = lines.join("\r\n");
  const filename = `SUA_${company.registroPatronal}_B${bimestre}_${year}.txt`;

  return new Response(content, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
