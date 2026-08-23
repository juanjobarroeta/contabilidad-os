import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, withAuthz } from "@/lib/authz";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/nomina/empleado?companyId=…[&incluirBajas=1]
//
// El ROSTER: la lista de empleados de la empresa, para surfacear la nómina en
// el satélite (AutomotrizPro no la tenía). El detalle por empleado ya vive en
// /api/nomina/empleado/[id]; faltaba la colección. Por default sólo activos —
// entrar a nómina es ver a quién le pagas hoy; las bajas se piden con bandera.
// ─────────────────────────────────────────────────────────────────────────────
export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  await requireMembership(companyId, undefined, req);

  const incluirBajas = searchParams.get("incluirBajas") === "1";
  const empleados = await prisma.employee.findMany({
    where: { companyId, ...(incluirBajas ? {} : { isActive: true }) },
    orderBy: [{ isActive: "desc" }, { apellidoPaterno: "asc" }],
    select: {
      id: true, numEmpleado: true, nombre: true, apellidoPaterno: true, apellidoMaterno: true,
      rfc: true, curp: true, puesto: true, departamento: true, tipoRegimen: true,
      periodicidadPago: true, salarioDiario: true, salarioDiarioIntegrado: true,
      fechaIngreso: true, fechaBaja: true, isActive: true,
    },
  });

  return NextResponse.json({
    total: empleados.length,
    activos: empleados.filter((e) => e.isActive).length,
    empleados: empleados.map((e) => ({
      ...e,
      nombreCompleto: `${e.nombre} ${e.apellidoPaterno} ${e.apellidoMaterno ?? ""}`.trim(),
    })),
  });
});
