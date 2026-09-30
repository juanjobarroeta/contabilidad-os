import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireWriter } from "@/lib/authz";
import { actualizarEmpleado, crearEmpleado, empleadoSchema } from "@/lib/nomina/empleados";

// GET /api/empleados?companyId=xxx
// Params opcionales (ADITIVOS — sin ellos la respuesta es idéntica a antes):
//   includeInactive=1  → incluye también las bajas (roster del hub / expediente)
//   withUltimoRecibo=1 → adjunta a cada empleado su último recibo (fechaPago,
//                        periodo, origen) para la columna «Último recibo».
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const companyId = url.searchParams.get("companyId");
    if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
    const includeInactive = url.searchParams.get("includeInactive") === "1";
    const withUltimoRecibo = url.searchParams.get("withUltimoRecibo") === "1";

    // Pasar `req` habilita el token de servicio (Bearer) además de la sesión
    // web, para que ZionX mapee empleados por RFC y timbre nómina.
    await requireMembership(companyId, undefined, req);

    const employees = await prisma.employee.findMany({
      where: { companyId, ...(includeInactive ? {} : { isActive: true }) },
      orderBy: [{ apellidoPaterno: "asc" }, { nombre: "asc" }],
    });

    if (!withUltimoRecibo) return NextResponse.json(employees);

    // Último recibo por empleado: primera fila por employeeId con las corridas
    // ordenadas por fecha de pago descendente (distinct de Prisma).
    const ultimos = await prisma.payrollItem.findMany({
      where: { employee: { companyId } },
      orderBy: { payrollRun: { fechaPago: "desc" } },
      distinct: ["employeeId"],
      select: {
        employeeId: true,
        payrollRun: { select: { fechaPago: true, periodo: true, origen: true } },
      },
    });
    const porEmpleado = new Map(ultimos.map((u) => [u.employeeId, u.payrollRun]));

    return NextResponse.json(
      employees.map((e) => ({ ...e, ultimoRecibo: porEmpleado.get(e.id) ?? null }))
    );
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

// POST /api/empleados — alta (regla en lib/nomina/empleados.ts)
export async function POST(req: Request) {
  try {
    const parsed = empleadoSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Datos inválidos" },
        { status: 400 }
      );
    }
    await requireWriter(parsed.data.companyId);
    const employee = await crearEmpleado(parsed.data);
    return NextResponse.json(employee, { status: 201 });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

// PATCH /api/empleados — update employee fields (regla en lib/nomina/empleados.ts)
export async function PATCH(req: Request) {
  try {
    const body = await req.json();
    const { employeeId, companyId, ...fields } = body;

    if (!employeeId || !companyId) {
      return NextResponse.json({ error: "employeeId y companyId requeridos" }, { status: 400 });
    }

    await requireWriter(companyId);
    const r = await actualizarEmpleado(companyId, employeeId, fields);
    return NextResponse.json(r.body, { status: r.status });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
