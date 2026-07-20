import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireWriter } from "@/lib/authz";
import { calcularFactorIntegracion } from "@/lib/nomina/prestaciones";

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

// POST /api/empleados
const createSchema = z.object({
  companyId: z.string().min(1),
  nombre: z.string().trim().min(1),
  apellidoPaterno: z.string().trim().min(1),
  apellidoMaterno: z.string().trim().optional(),
  rfc: z.string().trim().toUpperCase().regex(/^[A-Z&Ñ]{3,4}[0-9]{6}[A-Z0-9]{3}$/, "RFC inválido"),
  curp: z.string().trim().toUpperCase().length(18, "CURP debe tener 18 caracteres"),
  nss: z.string().trim().regex(/^\d{11}$/, "NSS debe tener 11 dígitos"),
  // CP fiscal del empleado (su CSF): DomicilioFiscalReceptor del CFDI de
  // nómina. Opcional — sin él, el timbrado cae al CP de la empresa (que el
  // SAT puede rechazar si no coincide con el RFC del empleado).
  codigoPostal: z.string().trim().regex(/^\d{5}$/, "CP de 5 dígitos").optional().or(z.literal("")),
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
  creditoInfonavit: z.string().optional(),
  tipoDescuentoInfonavit: z.enum(["PCT_SBC", "VSM", "PESOS"]).optional(),
  descuentoInfonavit: z.number().optional(),
  // FONACOT: número de crédito + retención MENSUAL (cédula Fonacot).
  creditoFonacot: z.string().trim().optional().or(z.literal("")),
  descuentoFonacot: z.number().nonnegative().optional(),
  // Pensión alimenticia (resolución judicial): % o monto mensual.
  pensionAlimenticiaTipo: z.enum(["PCT_TOTAL", "PCT_NETO", "PESOS"]).optional(),
  pensionAlimenticiaValor: z.number().nonnegative().optional(),
  clabe: z
    .string()
    .trim()
    .regex(/^\d{18}$/, "La CLABE debe tener 18 dígitos numéricos")
    .optional()
    .or(z.literal("")),
  banco: z.string().trim().optional().or(z.literal("")),
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

    // SDI default: salario × factor de integración real por antigüedad
    // (reforma de vacaciones 2023: año 1 = 12 días → 1.0493; NO el 1.0452
    // pre-reforma, que subestimaba el SBC ante el IMSS).
    const sdi =
      data.salarioDiarioIntegrado ??
      +(data.salarioDiario * calcularFactorIntegracion(new Date(data.fechaIngreso), new Date())).toFixed(2);

    const employee = await prisma.employee.create({
      data: {
        companyId,
        nombre: data.nombre,
        apellidoPaterno: data.apellidoPaterno,
        apellidoMaterno: data.apellidoMaterno || null,
        rfc: data.rfc,
        curp: data.curp,
        nss: data.nss,
        codigoPostal: data.codigoPostal || null,
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
        creditoInfonavit: data.creditoInfonavit || null,
        tipoDescuentoInfonavit: data.tipoDescuentoInfonavit || null,
        descuentoInfonavit: data.descuentoInfonavit ?? null,
        creditoFonacot: data.creditoFonacot || null,
        descuentoFonacot: data.descuentoFonacot ?? null,
        pensionAlimenticiaTipo: data.pensionAlimenticiaTipo || null,
        pensionAlimenticiaValor: data.pensionAlimenticiaValor ?? null,
        clabe: data.clabe || null,
        banco: data.banco || null,
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

// PATCH /api/empleados — update employee fields
export async function PATCH(req: Request) {
  try {
    const body = await req.json();
    const { employeeId, companyId, ...fields } = body;

    if (!employeeId || !companyId) {
      return NextResponse.json({ error: "employeeId y companyId requeridos" }, { status: 400 });
    }

    await requireWriter(companyId);

    const employee = await prisma.employee.findFirst({
      where: { id: employeeId, companyId },
    });
    if (!employee) return NextResponse.json({ error: "Empleado no encontrado" }, { status: 404 });

    // Build update data — only accept known fields, ignore nullish
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: Record<string, any> = {};
    if (fields.nombre?.trim()) data.nombre = fields.nombre.trim();
    if (fields.apellidoPaterno?.trim()) data.apellidoPaterno = fields.apellidoPaterno.trim();
    if (fields.apellidoMaterno !== undefined) data.apellidoMaterno = fields.apellidoMaterno?.trim() || null;
    if (fields.puesto !== undefined) data.puesto = fields.puesto?.trim() || null;
    if (fields.departamento !== undefined) data.departamento = fields.departamento?.trim() || null;
    if (fields.email !== undefined) data.email = fields.email?.trim() || null;
    // CP fiscal del empleado (CSF) — DomicilioFiscalReceptor del recibo de
    // nómina; CFDI 4.0 lo valida contra el RFC del receptor.
    if (fields.codigoPostal !== undefined) {
      const cp = String(fields.codigoPostal ?? "").trim();
      if (cp && !/^\d{5}$/.test(cp)) {
        return NextResponse.json({ error: "El CP fiscal debe tener 5 dígitos" }, { status: 400 });
      }
      data.codigoPostal = cp || null;
    }
    if (fields.periodicidadPago) data.periodicidadPago = fields.periodicidadPago;
    if (fields.riesgoPuesto) data.riesgoPuesto = fields.riesgoPuesto;
    if (fields.claveEntFed) data.claveEntFed = fields.claveEntFed;

    // Salary change → triggers IMSS modificación UNLESS skipImssMovimiento is set
    // (use skipImssMovimiento: true for data corrections that don't represent a real raise)
    if (fields.salarioDiario != null && fields.salarioDiario !== employee.salarioDiario) {
      const newSalario = Number(fields.salarioDiario);
      data.salarioDiario = newSalario;
      data.salarioDiarioIntegrado = fields.salarioDiarioIntegrado
        ? Number(fields.salarioDiarioIntegrado)
        : +(newSalario * calcularFactorIntegracion(employee.fechaIngreso, new Date())).toFixed(2);

      if (!fields.skipImssMovimiento) {
        await prisma.imssMovimiento.create({
          data: {
            companyId,
            employeeId,
            tipo: "MODIFICACION_SALARIO",
            fechaMovimiento: new Date(),
            sbcAnterior: employee.salarioDiarioIntegrado ?? employee.salarioDiario,
            sbcNuevo: data.salarioDiarioIntegrado,
            motivo: `Cambio de salario: $${employee.salarioDiario} → $${newSalario}`,
          },
        });
      }
    }

    // Datos bancarios para dispersión SPEI
    if (fields.clabe !== undefined) {
      const clabe = fields.clabe?.trim() || "";
      if (clabe && !/^\d{18}$/.test(clabe)) {
        return NextResponse.json({ error: "La CLABE debe tener 18 dígitos numéricos" }, { status: 400 });
      }
      data.clabe = clabe || null;
    }
    if (fields.banco !== undefined) data.banco = fields.banco?.trim() || null;

    // Infonavit
    if (fields.creditoInfonavit !== undefined) data.creditoInfonavit = fields.creditoInfonavit?.trim() || null;
    if (fields.tipoDescuentoInfonavit !== undefined) data.tipoDescuentoInfonavit = fields.tipoDescuentoInfonavit || null;
    if (fields.descuentoInfonavit !== undefined) data.descuentoInfonavit = fields.descuentoInfonavit != null ? Number(fields.descuentoInfonavit) : null;

    // FONACOT (retención mensual de la cédula)
    if (fields.creditoFonacot !== undefined) data.creditoFonacot = fields.creditoFonacot?.trim() || null;
    if (fields.descuentoFonacot !== undefined) data.descuentoFonacot = fields.descuentoFonacot != null ? Number(fields.descuentoFonacot) : null;

    // Pensión alimenticia (resolución judicial)
    if (fields.pensionAlimenticiaTipo !== undefined) {
      const t = fields.pensionAlimenticiaTipo || null;
      if (t && !["PCT_TOTAL", "PCT_NETO", "PESOS"].includes(t)) {
        return NextResponse.json({ error: "Tipo de pensión alimenticia inválido" }, { status: 400 });
      }
      data.pensionAlimenticiaTipo = t;
    }
    if (fields.pensionAlimenticiaValor !== undefined) data.pensionAlimenticiaValor = fields.pensionAlimenticiaValor != null ? Number(fields.pensionAlimenticiaValor) : null;

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: "No hay datos para actualizar" }, { status: 400 });
    }

    const updated = await prisma.employee.update({
      where: { id: employeeId },
      data,
    });

    return NextResponse.json(updated);
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
