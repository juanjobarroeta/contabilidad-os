import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/automotriz/empleados?companyId=… — roster ligero para los selects
// del vertical (asesor/técnico en órdenes, vendedor en pedidos). El expediente
// completo de nómina vive en /api/empleados (fuera del matcher CORS del
// satélite); aquí sólo lo necesario para asignar.
// ─────────────────────────────────────────────────────────────────────────────

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "AUTOMOTRIZ", req);

  const empleados = await prisma.employee.findMany({
    where: { companyId, isActive: true },
    select: { id: true, nombre: true, apellidoPaterno: true, puesto: true, departamento: true },
    orderBy: [{ apellidoPaterno: "asc" }, { nombre: "asc" }],
  });
  return NextResponse.json(empleados);
});
