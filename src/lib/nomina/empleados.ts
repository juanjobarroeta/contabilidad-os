import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { calcularFactorIntegracion } from "@/lib/nomina/prestaciones";
import { errorRegistroPatronal, normalizarRegistroPatronal } from "@/lib/nomina/registro-patronal";

// ─────────────────────────────────────────────────────────────────────────────
// Alta y edición de empleados — la regla, sin autorización. La usan
// /api/empleados (sesión del hub) y la puerta del hospital
// (/api/hospital/nomina/empleados). Cada caller decide QUIÉN puede; aquí se
// decide QUÉ se guarda: SDI por factor de integración, numEmpleado por
// default y, en un cambio de salario, el movimiento de modificación al IMSS.
// ─────────────────────────────────────────────────────────────────────────────

export interface Resultado {
  status: number;
  body: unknown;
}

export const empleadoSchema = z.object({
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
  // Registro patronal del centro de trabajo del empleado (empresas
  // multi-estado). Vacío/null = usa el de la empresa. Se valida con la misma
  // regla que el de la empresa (11 alfanuméricos).
  registroPatronal: z
    .string()
    .optional()
    .nullable()
    .refine((v) => errorRegistroPatronal(v) === null, {
      message: "Registro patronal inválido: son 11 caracteres alfanuméricos (Tarjeta de Identificación Patronal).",
    })
    .transform((v) => normalizarRegistroPatronal(v)),
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

export type EmpleadoInput = z.infer<typeof empleadoSchema>;

export async function crearEmpleado(input: EmpleadoInput) {
  const { companyId, ...data } = input;
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
      registroPatronal: data.registroPatronal ?? null,
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
  return employee;
}

/**
 * Edición parcial: sólo campos conocidos; un campo ausente no se toca. Un
 * cambio de salario recalcula el SDI y registra la modificación al IMSS salvo
 * `skipImssMovimiento` (corrección de captura, no aumento real).
 */
export async function actualizarEmpleado(
  companyId: string,
  employeeId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fields: Record<string, any>
): Promise<Resultado> {
  const employee = await prisma.employee.findFirst({
    where: { id: employeeId, companyId },
  });
  if (!employee) return { status: 404, body: { error: "Empleado no encontrado" } };

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
      return { status: 400, body: { error: "El CP fiscal debe tener 5 dígitos" } };
    }
    data.codigoPostal = cp || null;
  }
  if (fields.periodicidadPago) data.periodicidadPago = fields.periodicidadPago;
  if (fields.riesgoPuesto) data.riesgoPuesto = fields.riesgoPuesto;
  if (fields.claveEntFed) data.claveEntFed = fields.claveEntFed;
  if (fields.registroPatronal !== undefined) {
    const errorRp = errorRegistroPatronal(fields.registroPatronal);
    if (errorRp) return { status: 422, body: { error: errorRp } };
    data.registroPatronal = normalizarRegistroPatronal(fields.registroPatronal);
  }

  // El movimiento se registra junto con la edición, después de validar todo:
  // una CLABE inválida no deja un aviso al IMSS huérfano.
  let movimientoImss: Prisma.ImssMovimientoUncheckedCreateInput | null = null;

  // Salary change → triggers IMSS modificación UNLESS skipImssMovimiento is set
  // (use skipImssMovimiento: true for data corrections that don't represent a real raise)
  if (fields.salarioDiario != null && fields.salarioDiario !== employee.salarioDiario) {
    const newSalario = Number(fields.salarioDiario);
    data.salarioDiario = newSalario;
    data.salarioDiarioIntegrado = fields.salarioDiarioIntegrado
      ? Number(fields.salarioDiarioIntegrado)
      : +(newSalario * calcularFactorIntegracion(employee.fechaIngreso, new Date())).toFixed(2);

    if (!fields.skipImssMovimiento) {
      movimientoImss = {
        companyId,
        employeeId,
        tipo: "MODIFICACION_SALARIO",
        fechaMovimiento: new Date(),
        sbcAnterior: employee.salarioDiarioIntegrado ?? employee.salarioDiario,
        sbcNuevo: data.salarioDiarioIntegrado,
        motivo: `Cambio de salario: $${employee.salarioDiario} → $${newSalario}`,
      };
    }
  }

  // Datos bancarios para dispersión SPEI
  if (fields.clabe !== undefined) {
    const clabe = fields.clabe?.trim() || "";
    if (clabe && !/^\d{18}$/.test(clabe)) {
      return { status: 400, body: { error: "La CLABE debe tener 18 dígitos numéricos" } };
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
      return { status: 400, body: { error: "Tipo de pensión alimenticia inválido" } };
    }
    data.pensionAlimenticiaTipo = t;
  }
  if (fields.pensionAlimenticiaValor !== undefined) data.pensionAlimenticiaValor = fields.pensionAlimenticiaValor != null ? Number(fields.pensionAlimenticiaValor) : null;

  if (Object.keys(data).length === 0) {
    return { status: 400, body: { error: "No hay datos para actualizar" } };
  }

  const updated = await prisma.$transaction(async (tx) => {
    if (movimientoImss) await tx.imssMovimiento.create({ data: movimientoImss });
    return tx.employee.update({ where: { id: employeeId }, data });
  });
  return { status: 200, body: updated };
}
