import { prisma } from "@/lib/prisma";
import { calcularFiniquito } from "@/lib/nomina/finiquito";

// ─────────────────────────────────────────────────────────────────────────────
// Baja de un empleado — la regla, sin autorización. La usan POST
// /api/nomina/baja (sesión del hub) y la puerta del hospital
// (/api/hospital/nomina/empleados/[id]/baja).
//
//   1. Desactiva al empleado con su fecha de baja.
//   2. Crea el movimiento de BAJA al IMSS (pendiente de presentar en IDSE).
//   3. Calcula el finiquito (y la liquidación si el despido es injustificado).
//
// `preview` sólo calcula el finiquito: no toca al empleado ni al IMSS. El
// finiquito NO se paga aquí; se paga en una corrida (o fuera de nómina).
// ─────────────────────────────────────────────────────────────────────────────

export const MOTIVOS_BAJA = ["VOLUNTARIA", "JUSTIFICADA", "INJUSTIFICADA"] as const;
export type MotivoBaja = (typeof MOTIVOS_BAJA)[number];

export interface Resultado {
  status: number;
  body: unknown;
}

export async function darDeBaja(args: {
  companyId: string;
  employeeId: string;
  fechaBaja: string | Date;
  motivo: string;
  diasSalarioPendiente?: number | string | null;
  preview?: boolean;
}): Promise<Resultado> {
  const { companyId, employeeId, motivo } = args;
  if (!MOTIVOS_BAJA.includes(motivo as MotivoBaja)) {
    return { status: 400, body: { error: "motivo inválido: VOLUNTARIA, JUSTIFICADA o INJUSTIFICADA" } };
  }
  const fechaBajaDate = new Date(args.fechaBaja);
  if (Number.isNaN(fechaBajaDate.getTime())) return { status: 400, body: { error: "fechaBaja inválida" } };

  const employee = await prisma.employee.findFirst({
    where: { id: employeeId, companyId, isActive: true },
  });
  if (!employee) {
    return { status: 404, body: { error: "Empleado no encontrado o ya dado de baja" } };
  }
  if (fechaBajaDate < employee.fechaIngreso) {
    return { status: 400, body: { error: "La fecha de baja es anterior a la fecha de ingreso" } };
  }

  const finiquito = calcularFiniquito({
    salarioDiario: Number(employee.salarioDiario),
    salarioDiarioIntegrado: Number(employee.salarioDiarioIntegrado ?? employee.salarioDiario),
    fechaIngreso: employee.fechaIngreso,
    fechaBaja: fechaBajaDate,
    motivo: motivo as MotivoBaja,
    diasSalarioPendiente: args.diasSalarioPendiente ? Number(args.diasSalarioPendiente) : 0,
  });
  const empleado = { id: employee.id, nombre: `${employee.nombre} ${employee.apellidoPaterno}` };

  if (args.preview) {
    return { status: 200, body: { ok: true, preview: true, employee: empleado, finiquito: finiquito.desglose, aniosAntiguedad: finiquito.aniosAntiguedad } };
  }

  // Desactivar y avisar al IMSS van juntos: una baja sin su movimiento (o al
  // revés) descuadra el SUA.
  await prisma.$transaction([
    prisma.employee.update({
      where: { id: employeeId },
      data: { isActive: false, fechaBaja: fechaBajaDate },
    }),
    prisma.imssMovimiento.create({
      data: {
        companyId,
        employeeId,
        tipo: "BAJA",
        fechaMovimiento: fechaBajaDate,
        sbcAnterior: employee.salarioDiarioIntegrado ?? employee.salarioDiario,
        motivo: `Baja ${motivo.toLowerCase()}: ${employee.nombre} ${employee.apellidoPaterno}`,
      },
    }),
  ]);

  return {
    status: 200,
    body: {
      ok: true,
      employee: empleado,
      imssMovimiento: "BAJA creada (pendiente de presentar en IDSE)",
      finiquito: finiquito.desglose,
      aniosAntiguedad: finiquito.aniosAntiguedad,
    },
  };
}
