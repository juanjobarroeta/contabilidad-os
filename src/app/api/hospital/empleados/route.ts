import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/hospital/empleados?companyId=…[&incluirBajas=1]
//
// Roster ligero del hospital (enfermería, camilleros, administración) para los
// selects del satélite y la pantalla de nómina. La nómina completa —corridas,
// recibos, IMSS— vive en /api/nomina/* (ya bearer + CORS). Activos por
// default; `incluirBajas=1` trae también los dados de baja.
// ─────────────────────────────────────────────────────────────────────────────

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);

  const incluirBajas = searchParams.get("incluirBajas") === "1";
  const empleados = await prisma.employee.findMany({
    where: { companyId, ...(incluirBajas ? {} : { isActive: true }) },
    select: {
      id: true,
      nombre: true,
      apellidoPaterno: true,
      apellidoMaterno: true,
      puesto: true,
      departamento: true,
      isActive: true,
      fechaIngreso: true,
      fechaBaja: true,
      numEmpleado: true,
    },
    orderBy: [{ isActive: "desc" }, { apellidoPaterno: "asc" }, { nombre: "asc" }],
  });
  return NextResponse.json(empleados);
});
