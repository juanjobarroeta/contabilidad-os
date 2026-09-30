import { prisma } from "@/lib/prisma";
import { getPacProvider } from "@/lib/pac";
import { registrarBitacora } from "@/lib/audit";

// ─────────────────────────────────────────────────────────────────────────────
// Cancelar un CFDI ante el SAT — la regla, sin autorización. La usan
// DELETE /api/facturas/[id] (sesión del hub) y la puerta del hospital
// (/api/hospital/facturacion/facturas/[id]/cancelar). Cada caller decide
// QUIÉN puede; aquí se decide QUÉ pasa.
//
//   01 = comprobante emitido con errores CON relación (requiere sustituyeUuid)
//   02 = comprobante emitido con errores SIN relación
//   03 = no se llevó a cabo la operación
//   04 = operación nominativa relacionada en una factura global
//
// SEGURIDAD: sólo se marca CANCELLED si el SAT lo confirma. Una cancelación
// que queda «en proceso» (el receptor tiene 72 h para aceptarla) deja el CFDI
// VIGENTE y contando para IVA e ISR; el cron de vigencia la confirma después.
// ─────────────────────────────────────────────────────────────────────────────

export const MOTIVOS_CANCELACION = ["01", "02", "03", "04"] as const;
export type MotivoCancelacion = (typeof MOTIVOS_CANCELACION)[number];

export interface Resultado {
  status: number;
  body: unknown;
}

export async function cancelarCfdi(args: {
  invoiceId: string;
  motivo: string;
  sustituyeUuid?: string;
  actor: { id: string; email?: string | null };
  req: Request;
}): Promise<Resultado> {
  const motivo = args.motivo;
  const sustituyeUuid = args.sustituyeUuid ? args.sustituyeUuid.trim().toUpperCase() : undefined;
  if (!MOTIVOS_CANCELACION.includes(motivo as MotivoCancelacion)) {
    return { status: 400, body: { error: "Falta el motivo de cancelación (01, 02, 03 o 04)." } };
  }
  if (motivo === "01" && !sustituyeUuid) {
    return { status: 400, body: { error: "El motivo 01 requiere el UUID de la factura que la sustituye." } };
  }

  const invoice = await prisma.invoice.findUnique({ where: { id: args.invoiceId }, include: { company: true } });
  if (!invoice) return { status: 404, body: { error: "Factura no encontrada" } };
  if (invoice.status === "CANCELLED") return { status: 409, body: { error: "La factura ya está cancelada" } };
  if (motivo === "01" && sustituyeUuid === invoice.uuid?.toUpperCase()) {
    return { status: 400, body: { error: "La factura no se puede sustituir a sí misma." } };
  }

  // Cadena de cancelación: una factura con complementos de pago TIMBRADOS
  // dejaría REPs vivos apuntando a un CFDI cancelado — el SAT espera cancelar
  // primero la cadena. Se bloquea con la lista para cancelar los REP primero.
  if (invoice.uuid) {
    const repsVivos = await prisma.pagoDoctoRelacionado.findMany({
      where: { parentUuid: invoice.uuid, pagoInvoice: { companyId: invoice.companyId, tipo: "PAGO", status: "STAMPED" } },
      select: { pagoInvoice: { select: { serie: true, folio: true, uuid: true } } },
    });
    if (repsVivos.length > 0) {
      const folios = [...new Set(repsVivos.map((r) => {
        const p = r.pagoInvoice;
        return [p.serie, p.folio].filter(Boolean).join("-") || (p.uuid ?? "").slice(0, 8);
      }))];
      return {
        status: 409,
        body: {
          error:
            `Esta factura tiene ${folios.length} complemento${folios.length === 1 ? "" : "s"} de pago timbrado${folios.length === 1 ? "" : "s"} (${folios.join(", ")}). ` +
            "Cancela primero los complementos y después la factura — el SAT exige la cadena.",
          codigo: "REPS_VIVOS",
        },
      };
    }
  }

  // `consumada` distingue una cancelación REAL de una SOLICITADA que espera la
  // aceptación del receptor: en ese caso el SAT deja el comprobante VIGENTE.
  let consumada = true;
  let detallePac: string | null = null;
  if (invoice.facturapiId && invoice.company.facturapiApiKey) {
    const out = await getPacProvider().cancelCfdi(invoice.company.facturapiApiKey, invoice.facturapiId, motivo, sustituyeUuid);
    if (!out.ok) {
      // NO se marca CANCELLED — el CFDI sigue vivo en el SAT.
      return { status: out.status, body: { error: `No se pudo cancelar ante el SAT: ${out.message}`, kind: out.kind } };
    }
    consumada = out.data.estado === "cancelado";
    detallePac = out.data.detalle;
  } else if (invoice.status === "STAMPED") {
    // Timbrada pero sin llave de Facturapi: no se llega al SAT. No se finge.
    return { status: 422, body: { error: "No hay conexión con Facturapi para cancelar ante el SAT. Configúrala o cancela desde el portal." } };
  }
  // DRAFT / nunca timbrada → basta cancelarla localmente.

  const ahora = new Date();
  const updated = await prisma.invoice.update({
    where: { id: invoice.id },
    data: {
      ...(consumada ? { status: "CANCELLED" as const, canceladaAt: ahora } : {}),
      cancelSolicitadaAt: ahora,
      cancelEstadoSat: consumada ? "Cancelado" : "En proceso",
      cancelMotivo: motivo,
      cancelSustituyeUuid: sustituyeUuid ?? null,
    },
  });

  registrarBitacora({
    companyId: invoice.companyId,
    userId: args.actor.id,
    actorEmail: args.actor.email ?? null,
    accion: "factura.cancelar",
    entidad: "Invoice",
    entidadId: invoice.id,
    detalle: {
      uuid: invoice.uuid,
      total: invoice.total,
      motivo,
      sustituyeUuid: sustituyeUuid ?? null,
      // Si se canceló de verdad o sólo se SOLICITÓ, y qué contestó el PAC.
      resultado: consumada ? "cancelada" : "solicitada",
      pac: detallePac,
    },
    req: args.req,
  });

  return {
    status: 200,
    body: {
      ...updated,
      cancelacion: {
        consumada,
        mensaje: consumada
          ? "Cancelada ante el SAT."
          : "Cancelación SOLICITADA. El receptor tiene 72 horas para aceptarla; " +
            "mientras tanto el CFDI sigue VIGENTE y cuenta para IVA e ISR. " +
            "Lo confirmamos solos en cuanto el SAT lo resuelva.",
      },
    },
  };
}
