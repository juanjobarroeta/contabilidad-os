import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import {
  checkInvoiceMatchGuard,
  checkSumaAsignada,
  mergePagosConciliados,
  type AdvertenciaSumaAsignada,
} from "@/lib/conciliacion";
import { registrarBitacora } from "@/lib/audit";

type Params = { params: Promise<{ txId: string }> };

/**
 * PATCH /api/bancos/transactions/[txId]
 *
 * Body shapes:
 *   { action: "match", invoiceId }              ← legacy CFDI match
 *   { action: "match", gastoId }                ← link to construcción Gasto
 *   { action: "match", reembolsoId }            ← link to ReembolsoSemanal
 *   { action: "match", rayaId }                 ← link to RayaSemanal
 *   { action: "match", solicitudCompraId }      ← link to OC / Requisición
 *   { action: "match-multiple", asignaciones: [{ invoiceId, monto }, …] }
 *                                                ← un movimiento ↔ varias facturas
 *   { action: "unmatch" }
 *   { action: "ignore", notes? }
 *   { action: "unignore" }
 *
 * For construcción, the FK lives on the entity side (Gasto.bankTxId etc.)
 * so we update both rows atomically.
 */
export async function PATCH(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { txId } = await params;
  const tx = await prisma.bankTransaction.findUnique({
    where: { id: txId },
    include: {
      gastoPagado: { select: { id: true } },
      reembolsoPagado: { select: { id: true } },
      rayaPagada: { select: { id: true } },
      solicitudCompraPagada: { select: { id: true } },
    },
  });
  if (!tx) return NextResponse.json({ error: "Transacción no encontrada" }, { status: 404 });

  const member = await getEffectiveCompanyMembership(session.user.id, tx.companyId);
  if (!member || member.role === "VIEWER") return NextResponse.json({ error: "Sin permisos" }, { status: 403 });

  const { action, invoiceId, gastoId, reembolsoId, rayaId, solicitudCompraId, notes, asignaciones } = await req.json();

  // Aviso (no bloqueante) para conciliación múltiple: la suma asignada quedó
  // por debajo del movimiento más allá de la tolerancia. Se devuelve en la
  // respuesta para que la UI lo muestre; el match sí se aplica.
  let advertencia: AdvertenciaSumaAsignada | null = null;
  // Detalle extra para la bitácora en conciliación múltiple (match y unmatch).
  let detalleBitacora: Record<string, unknown> | null = null;

  async function clearConstruccionLinks() {
    if (tx?.gastoPagado) await prisma.gasto.update({ where: { id: tx.gastoPagado.id }, data: { bankTransactionId: null } });
    if (tx?.reembolsoPagado) await prisma.reembolsoSemanal.update({ where: { id: tx.reembolsoPagado.id }, data: { bankTransactionId: null } });
    if (tx?.rayaPagada) await prisma.rayaSemanal.update({ where: { id: tx.rayaPagada.id }, data: { bankTransactionId: null } });
    if (tx?.solicitudCompraPagada) await prisma.solicitudCompra.update({ where: { id: tx.solicitudCompraPagada.id }, data: { bankTransactionId: null } });
  }

  switch (action) {
    case "match": {
      if (gastoId) {
        const g = await prisma.gasto.findUnique({ where: { id: gastoId }, select: { id: true, companyId: true, bankTransactionId: true } });
        if (!g || g.companyId !== tx.companyId) return NextResponse.json({ error: "Gasto inválido" }, { status: 400 });
        if (g.bankTransactionId && g.bankTransactionId !== txId) return NextResponse.json({ error: "Ese gasto ya está vinculado a otra transacción" }, { status: 409 });
        await prisma.$transaction([
          prisma.gasto.update({ where: { id: gastoId }, data: { bankTransactionId: txId, estado: "PAGADO", pagadoAt: new Date() } }),
          prisma.bankTransaction.update({ where: { id: txId }, data: { status: "MATCHED", invoiceId: null, notes: notes ?? null } }),
        ]);
        break;
      }
      if (reembolsoId) {
        const r = await prisma.reembolsoSemanal.findUnique({ where: { id: reembolsoId }, select: { id: true, companyId: true, bankTransactionId: true } });
        if (!r || r.companyId !== tx.companyId) return NextResponse.json({ error: "Reembolso inválido" }, { status: 400 });
        if (r.bankTransactionId && r.bankTransactionId !== txId) return NextResponse.json({ error: "Ese reembolso ya está vinculado a otra transacción" }, { status: 409 });
        await prisma.$transaction([
          prisma.reembolsoSemanal.update({ where: { id: reembolsoId }, data: { bankTransactionId: txId, estado: "REEMBOLSADO", reembolsadoAt: new Date() } }),
          prisma.bankTransaction.update({ where: { id: txId }, data: { status: "MATCHED", invoiceId: null, notes: notes ?? null } }),
        ]);
        break;
      }
      if (solicitudCompraId) {
        const sc = await prisma.solicitudCompra.findUnique({
          where: { id: solicitudCompraId },
          select: { id: true, companyId: true, bankTransactionId: true, estado: true },
        });
        if (!sc || sc.companyId !== tx.companyId) {
          return NextResponse.json({ error: "Requisición inválida" }, { status: 400 });
        }
        if (sc.bankTransactionId && sc.bankTransactionId !== txId) {
          return NextResponse.json(
            { error: "Esa requisición ya está vinculada a otra transacción" },
            { status: 409 }
          );
        }
        if (sc.estado !== "APROBADA" && sc.estado !== "PAGADA") {
          return NextResponse.json(
            { error: `La requisición debe estar APROBADA (estado actual: ${sc.estado})` },
            { status: 422 }
          );
        }
        await prisma.$transaction([
          prisma.solicitudCompra.update({
            where: { id: solicitudCompraId },
            data: { bankTransactionId: txId, estado: "PAGADA", pagadaAt: new Date() },
          }),
          prisma.bankTransaction.update({
            where: { id: txId },
            data: { status: "MATCHED", invoiceId: null, notes: notes ?? null },
          }),
        ]);
        break;
      }
      if (rayaId) {
        const ry = await prisma.rayaSemanal.findUnique({ where: { id: rayaId }, select: { id: true, companyId: true, bankTransactionId: true } });
        if (!ry || ry.companyId !== tx.companyId) return NextResponse.json({ error: "Raya inválida" }, { status: 400 });
        if (ry.bankTransactionId && ry.bankTransactionId !== txId) return NextResponse.json({ error: "Esa raya ya está vinculada a otra transacción" }, { status: 409 });
        await prisma.$transaction([
          prisma.rayaSemanal.update({ where: { id: rayaId }, data: { bankTransactionId: txId, estado: "PAGADA", pagadaAt: new Date() } }),
          prisma.bankTransaction.update({ where: { id: txId }, data: { status: "MATCHED", invoiceId: null, notes: notes ?? null } }),
        ]);
        break;
      }
      // Legacy invoice path
      if (!invoiceId) return NextResponse.json({ error: "invoiceId / gastoId / reembolsoId / rayaId / solicitudCompraId requerido para conciliar" }, { status: 400 });
      // Guard: PUE ya conciliada con otro movimiento → 409; PPD permite
      // parcialidades pero el acumulado no debe exceder el total (ver
      // checkInvoiceMatchGuard en lib/conciliacion).
      const inv = await prisma.invoice.findFirst({
        where: { id: invoiceId, companyId: tx.companyId },
        select: {
          metodoPago: true,
          total: true,
          bankTransactions: {
            where: { status: "MATCHED" },
            select: { id: true, fecha: true, monto: true },
          },
          conciliacionDetalles: {
            select: {
              bankTransactionId: true,
              montoAsignado: true,
              bankTransaction: { select: { fecha: true, monto: true } },
            },
          },
        },
      });
      if (!inv) return NextResponse.json({ error: "Factura inválida" }, { status: 400 });
      const guard = checkInvoiceMatchGuard(
        inv,
        mergePagosConciliados(inv.bankTransactions, inv.conciliacionDetalles),
        { id: txId, monto: tx.monto }
      );
      if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: 409 });
      await clearConstruccionLinks();
      await prisma.bankTransaction.update({
        where: { id: txId },
        data: { status: "MATCHED", invoiceId, notes: notes ?? null },
      });
      break;
    }
    case "match-multiple": {
      // Un movimiento ↔ varias facturas (p. ej. una transferencia que cubre
      // varias facturas mensuales de un cliente). Las porciones se guardan en
      // ConciliacionDetalle; el vínculo legado invoiceId queda en NULL.
      if (tx.status !== "UNMATCHED") {
        return NextResponse.json(
          { error: "El movimiento ya está conciliado o ignorado. Desvincúlelo antes de conciliarlo de nuevo." },
          { status: 409 }
        );
      }
      if (!Array.isArray(asignaciones) || asignaciones.length === 0) {
        return NextResponse.json(
          { error: "asignaciones requerido: [{ invoiceId, monto }, …]" },
          { status: 400 }
        );
      }
      if (asignaciones.length < 2) {
        return NextResponse.json(
          { error: 'Para conciliar con una sola factura utilice action: "match" con invoiceId.' },
          { status: 400 }
        );
      }
      const parsed: { invoiceId: string; monto: number }[] = [];
      for (const a of asignaciones) {
        const monto = Number(a?.monto);
        if (!a?.invoiceId || typeof a.invoiceId !== "string" || !Number.isFinite(monto) || monto <= 0) {
          return NextResponse.json(
            { error: "Cada asignación requiere invoiceId y un monto mayor a cero." },
            { status: 400 }
          );
        }
        parsed.push({ invoiceId: a.invoiceId, monto });
      }
      if (new Set(parsed.map((p) => p.invoiceId)).size !== parsed.length) {
        return NextResponse.json({ error: "Hay facturas repetidas en las asignaciones." }, { status: 400 });
      }

      // Σ montos vs monto del movimiento (tolerancia 1%): por encima se
      // rechaza; por debajo se permite con advertencia (p. ej. comisión
      // descontada o cobro parcial) para que la UI lo muestre.
      const suma = checkSumaAsignada(tx.monto, parsed);
      if (!suma.ok) return NextResponse.json({ error: suma.error }, { status: 400 });
      advertencia = suma.advertencia;

      // Facturas: misma empresa, timbradas y coherentes con el sentido del
      // movimiento (depósito ↔ INGRESO; retiro ↔ EGRESO; NOMINA en ambos
      // sentidos, mismo criterio que el scoring de candidatos).
      const tiposValidos: string[] = tx.monto > 0 ? ["INGRESO", "NOMINA"] : ["EGRESO", "NOMINA"];
      const invoices = await prisma.invoice.findMany({
        where: { id: { in: parsed.map((p) => p.invoiceId) }, companyId: tx.companyId },
        select: {
          id: true,
          status: true,
          tipo: true,
          metodoPago: true,
          total: true,
          bankTransactions: {
            where: { status: "MATCHED" },
            select: { id: true, fecha: true, monto: true },
          },
          conciliacionDetalles: {
            select: {
              bankTransactionId: true,
              montoAsignado: true,
              bankTransaction: { select: { fecha: true, monto: true } },
            },
          },
        },
      });
      const invPorId = new Map(invoices.map((i) => [i.id, i]));
      for (const p of parsed) {
        const factura = invPorId.get(p.invoiceId);
        if (!factura) {
          return NextResponse.json({ error: "Alguna factura es inválida o pertenece a otra empresa." }, { status: 400 });
        }
        if (factura.status !== "STAMPED") {
          return NextResponse.json(
            { error: "Sólo se pueden conciliar facturas timbradas (STAMPED)." },
            { status: 422 }
          );
        }
        if (!tiposValidos.includes(factura.tipo)) {
          return NextResponse.json(
            {
              error:
                tx.monto > 0
                  ? "Un depósito sólo puede conciliarse con facturas de ingreso (o nómina recibida)."
                  : "Un retiro sólo puede conciliarse con facturas de egreso (o nómina emitida).",
            },
            { status: 422 }
          );
        }
        const guardMulti = checkInvoiceMatchGuard(
          factura,
          mergePagosConciliados(factura.bankTransactions, factura.conciliacionDetalles),
          { id: txId, monto: tx.monto, montoAsignado: p.monto }
        );
        if (!guardMulti.ok) return NextResponse.json({ error: guardMulti.error }, { status: 409 });
      }

      // Todo-o-nada: porciones + estado MATCHED (invoiceId legado en NULL).
      await prisma.$transaction([
        prisma.conciliacionDetalle.createMany({
          data: parsed.map((p) => ({ bankTransactionId: txId, invoiceId: p.invoiceId, montoAsignado: p.monto })),
        }),
        prisma.bankTransaction.update({
          where: { id: txId },
          data: { status: "MATCHED", invoiceId: null, notes: notes ?? null },
        }),
      ]);
      detalleBitacora = { facturas: parsed.length, asignaciones: parsed, ...(advertencia ? { advertencia } : {}) };
      break;
    }
    case "unmatch": {
      await clearConstruccionLinks();
      // Al desvincular también se eliminan las porciones de conciliación
      // múltiple; se registran en bitácora antes de borrarlas.
      const detallesPrevios = await prisma.conciliacionDetalle.findMany({
        where: { bankTransactionId: txId },
        select: { invoiceId: true, montoAsignado: true },
      });
      if (detallesPrevios.length > 0) {
        detalleBitacora = {
          facturas: detallesPrevios.length,
          asignaciones: detallesPrevios.map((d) => ({ invoiceId: d.invoiceId, monto: d.montoAsignado })),
        };
      }
      await prisma.$transaction([
        prisma.conciliacionDetalle.deleteMany({ where: { bankTransactionId: txId } }),
        prisma.bankTransaction.update({
          where: { id: txId },
          data: { status: "UNMATCHED", invoiceId: null, notes: null },
        }),
      ]);
      break;
    }
    case "ignore":
      // Ignorar también limpia cualquier vínculo con facturas (legado y múltiple).
      await prisma.$transaction([
        prisma.conciliacionDetalle.deleteMany({ where: { bankTransactionId: txId } }),
        prisma.bankTransaction.update({
          where: { id: txId },
          data: { status: "IGNORED", invoiceId: null, notes: notes ?? null },
        }),
      ]);
      break;
    case "unignore":
      await prisma.bankTransaction.update({
        where: { id: txId },
        data: { status: "UNMATCHED", notes: null },
      });
      break;
    default:
      return NextResponse.json({ error: `Acción desconocida: ${action}` }, { status: 400 });
  }

  // Bitácora de seguridad: conciliación manual (fire-and-forget). Sólo
  // match/match-multiple/unmatch — ignore/unignore no mueven dinero ni
  // vínculos fiscales.
  if (action === "match" || action === "match-multiple" || action === "unmatch") {
    registrarBitacora({
      companyId: tx.companyId,
      userId: session.user.id,
      actorEmail: session.user.email ?? null,
      accion: action === "unmatch" ? "conciliacion.unmatch" : "conciliacion.match",
      entidad: "BankTransaction",
      entidadId: txId,
      detalle: {
        monto: tx.monto,
        ...(action === "match"
          ? {
              invoiceId: invoiceId ?? null,
              gastoId: gastoId ?? null,
              reembolsoId: reembolsoId ?? null,
              rayaId: rayaId ?? null,
              solicitudCompraId: solicitudCompraId ?? null,
            }
          : {}),
        ...(detalleBitacora ?? {}),
      },
      req,
    });
  }

  const updated = await prisma.bankTransaction.findUnique({
    where: { id: txId },
    include: {
      invoice: { select: { id: true, uuid: true, total: true, customer: { select: { razonSocial: true } } } },
      conciliacionDetalles: {
        select: {
          id: true,
          montoAsignado: true,
          invoice: { select: { id: true, uuid: true, folio: true, serie: true, total: true, customer: { select: { razonSocial: true } } } },
        },
      },
      gastoPagado: {
        select: {
          id: true,
          beneficiarioNombre: true,
          importe: true,
          descripcion: true,
          proyecto: { select: { codigo: true } },
        },
      },
      reembolsoPagado: {
        select: {
          id: true,
          totalReembolso: true,
          semanaInicio: true,
          semanaFin: true,
          proyecto: { select: { codigo: true } },
        },
      },
      rayaPagada: {
        select: {
          id: true,
          totalDestajo: true,
          cuadrilla: { select: { nombre: true } },
          proyecto: { select: { codigo: true } },
        },
      },
      solicitudCompraPagada: {
        select: {
          id: true,
          folio: true,
          total: true,
          estado: true,
          supplier: { select: { razonSocial: true, rfc: true } },
          proyecto: { select: { codigo: true } },
          partidas: {
            select: {
              id: true,
              descripcion: true,
              cantidad: true,
              unidad: true,
              importe: true,
              presupuestoPartida: {
                select: {
                  id: true,
                  codigo: true,
                  concepto: { select: { descripcion: true } },
                },
              },
            },
          },
        },
      },
    },
  });

  return NextResponse.json(advertencia ? { ...updated, advertencia } : updated);
}
