import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";

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

  const { action, invoiceId, gastoId, reembolsoId, rayaId, solicitudCompraId, notes } = await req.json();

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
      await clearConstruccionLinks();
      await prisma.bankTransaction.update({
        where: { id: txId },
        data: { status: "MATCHED", invoiceId, notes: notes ?? null },
      });
      break;
    }
    case "unmatch":
      await clearConstruccionLinks();
      await prisma.bankTransaction.update({
        where: { id: txId },
        data: { status: "UNMATCHED", invoiceId: null, notes: null },
      });
      break;
    case "ignore":
      await prisma.bankTransaction.update({
        where: { id: txId },
        data: { status: "IGNORED", invoiceId: null, notes: notes ?? null },
      });
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

  const updated = await prisma.bankTransaction.findUnique({
    where: { id: txId },
    include: {
      invoice: { select: { id: true, uuid: true, total: true, customer: { select: { razonSocial: true } } } },
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

  return NextResponse.json(updated);
}
