import { prisma } from "@/lib/prisma";
import { getPacProvider } from "@/lib/pac";
import { registrarBitacora } from "@/lib/audit";
import { variantesUuid } from "@/lib/fiscal/uuid";

// ─────────────────────────────────────────────────────────────────────────────
// Cancelar ante el SAT el CFDI de nómina de un PayrollItem y dejar al
// empleado LISTO PARA RETIMBRAR — la regla, sin autorización. La usan
// POST /api/nomina/recibos/cancelar (sesión del hub) y la puerta del hospital
// (/api/hospital/nomina/recibos/[id]/cancelar).
//
//   1. Cancela vía PAC (mismo contrato que facturas: sólo marcamos CANCELLED
//      si el SAT confirma — receptor empleado, sin paso de aceptación).
//   2. Limpia cfdiUuid/facturapiId del PayrollItem (el timbrado filtra por
//      !cfdiUuid, así que el empleado vuelve a ser timbrable).
//   3. Regresa la corrida STAMPED → CALCULATED para que "Timbrar" se rehabilite
//      (sólo emite los items sin cfdiUuid; no duplica a los demás).
//
// Sólo recibos EMITIDOS POR LA APP (facturapiId). Los importados del SAT se
// cancelan donde se emitieron.
// ─────────────────────────────────────────────────────────────────────────────

export const MOTIVOS_CANCELACION_NOMINA = ["01", "02", "03", "04"] as const;

export interface Resultado {
  status: number;
  body: unknown;
}

export async function cancelarReciboNomina(args: {
  companyId: string;
  payrollItemId: string;
  motivo: string;
  sustituyeUuid?: string | null;
  actor: { id: string; email?: string | null };
  req?: Request;
}): Promise<Resultado> {
  const { companyId, payrollItemId, motivo } = args;
  const sustituyeUuid = args.sustituyeUuid ? String(args.sustituyeUuid).trim() : null;

  if (!MOTIVOS_CANCELACION_NOMINA.includes(motivo as (typeof MOTIVOS_CANCELACION_NOMINA)[number])) {
    return { status: 400, body: { error: "Falta el motivo de cancelación (01, 02, 03 o 04)." } };
  }
  if (motivo === "01" && !sustituyeUuid) {
    return { status: 400, body: { error: "El motivo 01 requiere el UUID del recibo que lo sustituye." } };
  }

  const item = await prisma.payrollItem.findUnique({
    where: { id: payrollItemId },
    select: {
      id: true,
      cfdiUuid: true,
      payrollRunId: true,
      employee: { select: { nombre: true, apellidoPaterno: true } },
      payrollRun: { select: { id: true, companyId: true, status: true, extraData: true } },
    },
  });
  if (!item || item.payrollRun.companyId !== companyId) {
    return { status: 404, body: { error: "Recibo no encontrado" } };
  }
  if (!item.cfdiUuid) {
    return { status: 409, body: { error: "El recibo no está timbrado" } };
  }

  const [invoice, company] = await Promise.all([
    prisma.invoice.findFirst({
      where: { companyId, tipo: "NOMINA", uuid: { in: variantesUuid([item.cfdiUuid]) } },
      select: { id: true, uuid: true, facturapiId: true, status: true },
    }),
    prisma.company.findUnique({ where: { id: companyId }, select: { facturapiApiKey: true } }),
  ]);
  if (invoice?.status === "CANCELLED") {
    return { status: 409, body: { error: "El recibo ya está cancelado" } };
  }
  if (!invoice?.facturapiId || !company?.facturapiApiKey) {
    return {
      status: 422,
      body: {
        error:
          "Este recibo no se emitió desde la app (es historial importado del SAT); cancélalo en el sistema donde se timbró o desde el portal del SAT.",
      },
    };
  }

  // Cancelación real ante el SAT. Igual que facturas: si el PAC no confirma,
  // NO tocamos nada local — el CFDI sigue vigente.
  const out = await getPacProvider().cancelCfdi(
    company.facturapiApiKey,
    invoice.facturapiId,
    motivo,
    sustituyeUuid ?? undefined
  );
  if (!out.ok) {
    return { status: out.status, body: { error: `No se pudo cancelar ante el SAT: ${out.message}`, kind: out.kind } };
  }

  await prisma.$transaction(async (tx) => {
    await tx.invoice.update({
      where: { id: invoice.id },
      data: {
        status: "CANCELLED",
        canceladaAt: new Date(),
        cancelMotivo: motivo,
        cancelSustituyeUuid: sustituyeUuid,
      },
    });
    await tx.payrollItem.update({
      where: { id: item.id },
      data: { cfdiUuid: null, facturapiId: null },
    });
    // La corrida vuelve a CALCULATED para que el candado permita retimbrar al
    // empleado (el filtro !cfdiUuid protege a los demás de duplicarse). PAID
    // también se regresa: dejarlo bloquearía el retimbrado sin salida (el
    // candado exige CALCULATED); al terminar el retimbrado queda STAMPED y la
    // dispersión se re-registra si aplica.
    const timbradosRestantes = await tx.payrollItem.count({
      where: { payrollRunId: item.payrollRunId, cfdiUuid: { not: null } },
    });
    await tx.payrollRun.update({
      where: { id: item.payrollRunId },
      data: {
        ...(item.payrollRun.status === "STAMPED" || item.payrollRun.status === "PAID"
          ? { status: "CALCULATED" }
          : {}),
        extraData: {
          ...((item.payrollRun.extraData as Record<string, unknown>) ?? {}),
          stampedCount: timbradosRestantes,
        },
      },
    });
  });

  const empleado = `${item.employee.nombre} ${item.employee.apellidoPaterno}`;
  registrarBitacora({
    accion: "nomina.cancelar-timbre",
    userId: args.actor.id,
    actorEmail: args.actor.email ?? null,
    companyId,
    entidad: "Invoice",
    entidadId: invoice.id,
    detalle: {
      uuid: invoice.uuid,
      motivo,
      ...(sustituyeUuid ? { sustituyeUuid } : {}),
      empleado,
      payrollItemId: item.id,
    },
    req: args.req,
  });

  return { status: 200, body: { ok: true, uuid: invoice.uuid, empleado } };
}
