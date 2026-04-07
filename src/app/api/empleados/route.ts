import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireWriter } from "@/lib/authz";

// GET /api/empleados?companyId=xxx
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const companyId = url.searchParams.get("companyId");
    if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

    await requireMembership(companyId);

    const employees = await prisma.employee.findMany({
      where: { companyId, isActive: true },
      orderBy: [{ apellidoPaterno: "asc" }, { nombre: "asc" }],
    });

    return NextResponse.json(employees);
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

// POST /api/empleados
const createSchema = z.object({
  companyId: z.string().min(1),
  nombre: z.string().trim().min(1),
  apellidoPaterno: z.string().trim().min(1),
  apellidoMaterno: z.string().trim().optional(),
  rfc: z.string().trim().toUpperCase().regex(/^[A-Z&Ñ]{3,4}[0-9]{6}[A-Z0-9]{3}$/, "RFC inválido"),
  curp: z.string().trim().toUpperCase().length(18, "CURP debe tener 18 caracteres"),
  nss: z.string().trim().regex(/^\d{11}$/, "NSS debe tener 11 dígitos"),
  email: z.string().email().optional().or(z.literal("")),
  fechaIngreso: z.string().min(1),
  tipoContrato: z.string().default("01"),
  tipoJornada: z.string().default("01"),
  tipoRegimen: z.string().default("02"),
  salarioDiario: z.number().positive(),
  salarioDiarioIntegrado: z.number().positive().optional(),
  periodicidadPago: z.string().default("04"),
  numEmpleado: z.string().optional(),
  departamento: z.string().optional(),
  puesto: z.string().optional(),
  riesgoPuesto: z.string().default("1"),
  claveEntFed: z.string().default("PUE"),
});

export async function POST(req: Request) {
  try {
    const parsed = createSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Datos inválidos" },
        { status: 400 }
      );
    }
    const { companyId, ...data } = parsed.data;
    await requireWriter(companyId);

    // SDI defaults to SBC × 1.0452 (factor de integración minimum)
    const sdi = data.salarioDiarioIntegrado ?? +(data.salarioDiario * 1.0452).toFixed(2);

    const employee = await prisma.employee.create({
      data: {
        companyId,
        nombre: data.nombre,
        apellidoPaterno: data.apellidoPaterno,
        apellidoMaterno: data.apellidoMaterno || null,
        rfc: data.rfc,
        curp: data.curp,
        nss: data.nss,
        email: data.email || null,
        fechaIngreso: new Date(data.fechaIngreso),
        tipoContrato: data.tipoContrato,
        tipoJornada: data.tipoJornada,
        tipoRegimen: data.tipoRegimen,
        salarioDiario: data.salarioDiario,
        salarioDiarioIntegrado: sdi,
        periodicidadPago: data.periodicidadPago,
        numEmpleado: data.numEmpleado || null,
        departamento: data.departamento || null,
        puesto: data.puesto || null,
        riesgoPuesto: data.riesgoPuesto,
        claveEntFed: data.claveEntFed,
      },
    });

    // Backfill numEmpleado if not provided (uses last 6 chars of id)
    if (!employee.numEmpleado) {
      await prisma.employee.update({
        where: { id: employee.id },
        data: { numEmpleado: employee.id.slice(-6).toUpperCase() },
      });
    }

    return NextResponse.json(employee, { status: 201 });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
