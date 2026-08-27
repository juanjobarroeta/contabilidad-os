import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership, requireUser, AuthzError } from "@/lib/authz";
import {
  checkInvoiceMatchGuard,
  checkSumaAsignada,
  mergePagosConciliados,
  type AdvertenciaSumaAsignada,
} from "@/lib/conciliacion";
import {
  campoMontoPorTipo,
  checkImpuestoMatchGuard,
  esTipoImpuestoConciliable,
  statusTrasDesconciliar,
} from "@/lib/conciliacion-impuestos";
import { registrarBitacora } from "@/lib/audit";
import { validarParDevolucion } from "@/lib/bancos/devoluciones";

type Params = { params: Promise<{ txId: string }> };

/**
 * DELETE /api/bancos/transactions/[txId]
 *
 * Borra UN movimiento — pensado para capturas manuales equivocadas (caja
 * chica / ingresos externos). Nunca destruye trabajo fiscal: se rechaza si el
 * movimiento está MATCHED o tiene cualquier vínculo (facturas múltiples,
 * declaración de impuestos, construcción, devolución vinculada) — primero
 * desconciliar/desvincular, luego borrar. Queda en bitácora.
 */
export async function DELETE(req: Request, { params }: Params) {
  let user;
  try {
    user = await requireUser(req);
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const { txId } = await params;
  const tx = await prisma.bankTransaction.findUnique({
    where: { id: txId },
    include: {
      conciliacionDetalles: { select: { id: true } },
      gastoPagado: { select: { id: true } },
      reembolsoPagado: { select: { id: true } },
      rayaPagada: { select: { id: true } },
      solicitudCompraPagada: { select: { id: true } },
      devolucionPor: { select: { id: true } },
    },
  });
  if (!tx) return NextResponse.json({ error: "Transacción no encontrada" }, { status: 404 });

  const member = await getEffectiveCompanyMembership(user.id, tx.companyId);
  if (!member || member.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }

  if (tx.status === "MATCHED" || tx.invoiceId || tx.taxDeclarationId || tx.conciliacionDetalles.length > 0) {
    return NextResponse.json(
      { error: "El movimiento está conciliado. Desconcílialo antes de borrarlo." },
      { status: 409 },
    );
  }
  if (tx.gastoPagado || tx.reembolsoPagado || tx.rayaPagada || tx.solicitudCompraPagada) {
    return NextResponse.json(
      { error: "El movimiento está vinculado a construcción. Desconcílialo primero." },
      { status: 409 },
    );
  }
  if (tx.devolucionDeId || tx.devolucionPor) {
    return NextResponse.json(
      { error: "El movimiento es parte de una devolución vinculada. Desvincúlala primero." },
      { status: 409 },
    );
  }

  // Sólo CAPTURAS MANUALES (caja chica / ingest externo, con externalRef).
  // Los renglones importados del estado de cuenta no se borran uno a uno:
  // se corrigen deshaciendo el lote — y borrarlos aquí sólo haría que la
  // detección de duplicados los reviva en la siguiente importación.
  if (!tx.externalRef) {
    return NextResponse.json(
      { error: "Sólo capturas manuales se pueden borrar. Un movimiento importado se corrige deshaciendo su lote." },
      { status: 409 },
    );
  }

  await prisma.bankTransaction.delete({ where: { id: txId } });
  registrarBitacora({
    companyId: tx.companyId,
    userId: user.id,
    actorEmail: user.email ?? null,
    accion: "bancos.delete-transaction",
    entidad: "BankTransaction",
    entidadId: txId,
    detalle: {
      monto: tx.monto,
      fecha: tx.fecha,
      descripcion: tx.descripcion,
      statusPrevio: tx.status,
      externalRef: tx.externalRef ?? null,
    },
    req,
  });
  return NextResponse.json({ ok: true });
}

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
 *   { action: "match-impuesto", taxDeclarationId }
 *                                                ← el egreso paga una declaración
 *                                                  (SIPARE / línea de captura):
 *                                                  movimiento → MATCHED y
 *                                                  declaración → PAID en una
 *                                                  sola transacción
 *   { action: "unmatch" }
 *   { action: "ignore", notes? }
 *   { action: "unignore" }
 *
 * For construcción, the FK lives on the entity side (Gasto.bankTxId etc.)
 * so we update both rows atomically.
 */
export async function PATCH(req: Request, { params }: Params) {
  let user;
  try {
    user = await requireUser(req);
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const { txId } = await params;
  const txRow = await prisma.bankTransaction.findUnique({
    where: { id: txId },
    include: {
      gastoPagado: { select: { id: true } },
      reembolsoPagado: { select: { id: true } },
      rayaPagada: { select: { id: true } },
      solicitudCompraPagada: { select: { id: true } },
      // Para revertir la declaración pagada al desconciliar/ignorar (los
      // campos de acuse deciden a qué estatus regresa — ver statusTrasDesconciliar).
      taxDeclaration: {
        select: { id: true, tipo: true, periodo: true, status: true, acuseUrl: true, acusePdfNombre: true, lineaCaptura: true },
      },
      // Devolución bancaria: para validar vincular/desvincular pares.
      devolucionPor: { select: { id: true } },
    },
  });
  if (!txRow) return NextResponse.json({ error: "Transacción no encontrada" }, { status: 404 });
  const tx = { ...txRow, monto: Number(txRow.monto) };

  const member = await getEffectiveCompanyMembership(user.id, tx.companyId);
  if (!member || member.role === "VIEWER") return NextResponse.json({ error: "Sin permisos" }, { status: 403 });

  const { action, invoiceId, gastoId, reembolsoId, rayaId, solicitudCompraId, taxDeclarationId, notes, asignaciones, origenId, fecha, descripcion, monto } = await req.json();

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
        mergePagosConciliados(
          inv.bankTransactions.map((t) => ({ ...t, monto: Number(t.monto) })),
          inv.conciliacionDetalles.map((d) => ({
            ...d,
            montoAsignado: Number(d.montoAsignado),
            bankTransaction: { ...d.bankTransaction, monto: Number(d.bankTransaction.monto) },
          })),
        ),
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
          mergePagosConciliados(
            factura.bankTransactions.map((t) => ({ ...t, monto: Number(t.monto) })),
            factura.conciliacionDetalles.map((d) => ({
              ...d,
              montoAsignado: Number(d.montoAsignado),
              bankTransaction: { ...d.bankTransaction, monto: Number(d.bankTransaction.monto) },
            })),
          ),
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
    case "match-impuesto": {
      // El egreso paga una declaración (SIPARE / línea de captura). Efecto en
      // UNA transacción: movimiento → MATCHED + taxDeclarationId; declaración →
      // PAID, fecha de pago = fecha del movimiento si estaba vacía y monto del
      // tipo actualizado a lo realmente cargado por el banco (espeja el
      // «Registrar pago» manual). v1: una declaración ↔ un movimiento.
      if (!taxDeclarationId || typeof taxDeclarationId !== "string") {
        return NextResponse.json({ error: "taxDeclarationId requerido para conciliar un pago de impuestos" }, { status: 400 });
      }
      const decl = await prisma.taxDeclaration.findFirst({
        where: { id: taxDeclarationId, companyId: tx.companyId },
        select: {
          id: true,
          tipo: true,
          periodo: true,
          status: true,
          ivaPagar: true,
          isrPagar: true,
          retencionesIsr: true,
          imssCuotas: true,
          fechaPresentacion: true,
          bankTransactions: { where: { status: "MATCHED" }, select: { id: true } },
        },
      });
      if (!decl) return NextResponse.json({ error: "Declaración inválida" }, { status: 400 });
      const guardImpuesto = checkImpuestoMatchGuard(decl, decl.bankTransactions, {
        id: txId,
        monto: tx.monto,
        status: tx.status,
      });
      if (!guardImpuesto.ok) {
        return NextResponse.json({ error: guardImpuesto.error }, { status: guardImpuesto.status });
      }
      // esTipoImpuestoConciliable ya lo garantizó el guard; el narrowing es para TS.
      if (!esTipoImpuestoConciliable(decl.tipo)) {
        return NextResponse.json({ error: "Tipo de declaración no conciliable" }, { status: 422 });
      }
      const montoPagado = Math.round(Math.abs(tx.monto) * 100) / 100;
      await prisma.$transaction([
        prisma.bankTransaction.update({
          where: { id: txId },
          data: { status: "MATCHED", invoiceId: null, taxDeclarationId: decl.id, notes: notes ?? null },
        }),
        prisma.taxDeclaration.update({
          where: { id: decl.id },
          data: {
            status: "PAID",
            [campoMontoPorTipo(decl.tipo)]: montoPagado,
            // Fecha de pago/presentación = fecha del movimiento sólo si estaba vacía.
            ...(decl.fechaPresentacion == null ? { fechaPresentacion: tx.fecha } : {}),
          },
        }),
      ]);
      detalleBitacora = {
        taxDeclarationId: decl.id,
        tipoDeclaracion: decl.tipo,
        periodo: decl.periodo,
        statusPrevio: decl.status,
        montoEsperado: guardImpuesto.montoEsperado,
        montoPagado,
      };
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
      // Si el movimiento pagaba una declaración, ésta regresa a su estatus
      // anterior sin guardar nada extra (regla determinista por evidencia):
      // PAID → FILED si hay acuse/línea de captura, si no → CALCULATED.
      // Ver statusTrasDesconciliar en lib/conciliacion-impuestos.
      const revertDecl: ReturnType<typeof prisma.taxDeclaration.update>[] = [];
      if (tx.taxDeclaration && tx.taxDeclaration.status === "PAID") {
        const statusRevert = statusTrasDesconciliar(tx.taxDeclaration);
        revertDecl.push(
          prisma.taxDeclaration.update({
            where: { id: tx.taxDeclaration.id },
            data: { status: statusRevert },
          })
        );
        detalleBitacora = {
          ...(detalleBitacora ?? {}),
          taxDeclarationId: tx.taxDeclaration.id,
          tipoDeclaracion: tx.taxDeclaration.tipo,
          periodo: tx.taxDeclaration.periodo,
          statusRevertido: statusRevert,
        };
      }
      await prisma.$transaction([
        prisma.conciliacionDetalle.deleteMany({ where: { bankTransactionId: txId } }),
        prisma.bankTransaction.update({
          where: { id: txId },
          data: { status: "UNMATCHED", invoiceId: null, taxDeclarationId: null, notes: null },
        }),
        ...revertDecl,
      ]);
      break;
    }
    case "ignore": {
      // Ignorar también limpia cualquier vínculo con facturas (legado y
      // múltiple) y con declaraciones de impuestos (misma reversa que unmatch).
      const revertDeclIgnore: ReturnType<typeof prisma.taxDeclaration.update>[] = [];
      if (tx.taxDeclaration && tx.taxDeclaration.status === "PAID") {
        revertDeclIgnore.push(
          prisma.taxDeclaration.update({
            where: { id: tx.taxDeclaration.id },
            data: { status: statusTrasDesconciliar(tx.taxDeclaration) },
          })
        );
      }
      await prisma.$transaction([
        prisma.conciliacionDetalle.deleteMany({ where: { bankTransactionId: txId } }),
        prisma.bankTransaction.update({
          where: { id: txId },
          data: { status: "IGNORED", invoiceId: null, taxDeclarationId: null, notes: notes ?? null },
        }),
        ...revertDeclIgnore,
      ]);
      break;
    }
    case "unignore":
      await prisma.bankTransaction.update({
        where: { id: txId },
        data: { status: "UNMATCHED", notes: null },
      });
      break;
    // ── Edición de captura manual (caja chica / ingresos externos) ───────────
    // Corrige fecha/descripción/monto de un movimiento SIN vínculos fiscales
    // (mismos guards que DELETE): lo conciliado se desconcilia primero.
    case "edit": {
      if (tx.status === "MATCHED" || tx.invoiceId || tx.taxDeclarationId) {
        return NextResponse.json(
          { error: "El movimiento está conciliado. Desconcílialo antes de editarlo." },
          { status: 409 },
        );
      }
      if (tx.gastoPagado || tx.reembolsoPagado || tx.rayaPagada || tx.solicitudCompraPagada) {
        return NextResponse.json(
          { error: "El movimiento está vinculado a construcción. Desconcílialo primero." },
          { status: 409 },
        );
      }
      if (tx.devolucionDeId || tx.devolucionPor) {
        return NextResponse.json(
          { error: "El movimiento es parte de una devolución vinculada. Desvincúlala primero." },
          { status: 409 },
        );
      }
      // Igual que DELETE: sólo capturas manuales — lo importado del banco es
      // el estado de cuenta real y no se reescribe a mano.
      if (!tx.externalRef) {
        return NextResponse.json(
          { error: "Sólo capturas manuales se pueden editar. Un movimiento importado refleja el estado de cuenta del banco." },
          { status: 409 },
        );
      }
      const cambios: { fecha?: Date; descripcion?: string; monto?: number } = {};
      if (fecha !== undefined) {
        const f = new Date(fecha);
        if (Number.isNaN(f.getTime())) {
          return NextResponse.json({ error: "Fecha inválida" }, { status: 400 });
        }
        cambios.fecha = f;
      }
      if (descripcion !== undefined) {
        const d = String(descripcion).trim();
        if (!d) return NextResponse.json({ error: "Descripción vacía" }, { status: 400 });
        cambios.descripcion = d.slice(0, 500);
      }
      if (monto !== undefined) {
        const n = Number(monto);
        if (!Number.isFinite(n) || n === 0) {
          return NextResponse.json({ error: "Monto inválido" }, { status: 400 });
        }
        cambios.monto = n;
      }
      if (Object.keys(cambios).length === 0) {
        return NextResponse.json({ error: "Nada que editar" }, { status: 400 });
      }
      await prisma.bankTransaction.update({ where: { id: txId }, data: cambios });
      detalleBitacora = {
        previo: { fecha: tx.fecha, descripcion: tx.descripcion, monto: tx.monto },
        cambios,
      };
      break;
    }
    // ── Devolución bancaria (pago rebotado) ───────────────────────────────────
    // txId = el movimiento de DEVOLUCIÓN; body.origenId = el pago original.
    // Ambos quedan IGNORED (se netean: fuera de KPIs y del motor de IVA) y el
    // vínculo conserva la historia. La conciliación del ORIGINAL se deshace en
    // la misma transacción: la factura vuelve a no-pagada y una declaración
    // PAID regresa a su estatus por evidencia — el pago nunca ocurrió (flujo).
    case "vincular-devolucion": {
      if (typeof origenId !== "string" || !origenId)
        return NextResponse.json({ error: "Falta origenId (el pago original)." }, { status: 400 });
      if (tx.devolucionDeId || tx.devolucionPor)
        return NextResponse.json({ error: "Este movimiento ya es parte de una devolución vinculada." }, { status: 409 });

      const origen = await prisma.bankTransaction.findFirst({
        where: { id: origenId, companyId: tx.companyId },
        include: {
          devolucionPor: { select: { id: true } },
          gastoPagado: { select: { id: true } },
          reembolsoPagado: { select: { id: true } },
          rayaPagada: { select: { id: true } },
          solicitudCompraPagada: { select: { id: true } },
          taxDeclaration: {
            select: { id: true, tipo: true, periodo: true, status: true, acuseUrl: true, acusePdfNombre: true, lineaCaptura: true },
          },
          conciliacionDetalles: { select: { invoiceId: true, montoAsignado: true } },
        },
      });
      if (!origen) return NextResponse.json({ error: "Pago original no encontrado." }, { status: 404 });
      if (origen.devolucionDeId || origen.devolucionPor)
        return NextResponse.json({ error: "El pago original ya tiene una devolución vinculada." }, { status: 409 });
      // Vínculos de construcción viven en la entidad (Gasto.bankTxId, etc.):
      // se piden desconciliar explícitamente primero, no se rompen en silencio.
      if (origen.gastoPagado || origen.reembolsoPagado || origen.rayaPagada || origen.solicitudCompraPagada)
        return NextResponse.json(
          { error: "El pago original está vinculado a construcción (gasto/raya/reembolso). Desconcílialo primero." },
          { status: 409 },
        );

      const motivo = validarParDevolucion(
        { id: tx.id, bankAccountId: tx.bankAccountId, fecha: tx.fecha, monto: tx.monto, descripcion: tx.descripcion, referencia: tx.referencia },
        { id: origen.id, bankAccountId: origen.bankAccountId, fecha: origen.fecha, monto: Number(origen.monto), descripcion: origen.descripcion, referencia: origen.referencia },
      );
      if (motivo) return NextResponse.json({ error: motivo }, { status: 422 });

      // Reversa de la declaración pagada por el original (misma regla que unmatch).
      const revertDeclDevol: ReturnType<typeof prisma.taxDeclaration.update>[] = [];
      if (origen.taxDeclaration && origen.taxDeclaration.status === "PAID") {
        revertDeclDevol.push(
          prisma.taxDeclaration.update({
            where: { id: origen.taxDeclaration.id },
            data: { status: statusTrasDesconciliar(origen.taxDeclaration) },
          }),
        );
      }
      await prisma.$transaction([
        prisma.conciliacionDetalle.deleteMany({ where: { bankTransactionId: origen.id } }),
        prisma.bankTransaction.update({
          where: { id: origen.id },
          data: { status: "IGNORED", invoiceId: null, taxDeclarationId: null },
        }),
        prisma.bankTransaction.update({
          where: { id: txId },
          data: { status: "IGNORED", invoiceId: null, taxDeclarationId: null, devolucionDeId: origen.id },
        }),
        ...revertDeclDevol,
      ]);
      detalleBitacora = {
        origenId: origen.id,
        montoOrigen: origen.monto,
        invoicePrevio: origen.invoiceId,
        asignacionesPrevias: origen.conciliacionDetalles.length || undefined,
        taxDeclarationPrevia: origen.taxDeclaration?.id,
      };
      break;
    }
    case "desvincular-devolucion": {
      // txId puede ser cualquiera de los dos lados del par.
      const origenDelPar = tx.devolucionDeId ?? tx.devolucionPor?.id ?? null;
      if (!origenDelPar)
        return NextResponse.json({ error: "Este movimiento no tiene una devolución vinculada." }, { status: 409 });
      const devolucionId = tx.devolucionDeId ? tx.id : tx.devolucionPor!.id;
      const origenIdPar = tx.devolucionDeId ?? tx.id;
      await prisma.$transaction([
        prisma.bankTransaction.update({
          where: { id: devolucionId },
          data: { devolucionDeId: null, status: "UNMATCHED" },
        }),
        prisma.bankTransaction.update({ where: { id: origenIdPar }, data: { status: "UNMATCHED" } }),
      ]);
      detalleBitacora = { devolucionId, origenId: origenIdPar };
      break;
    }
    default:
      return NextResponse.json({ error: `Acción desconocida: ${action}` }, { status: 400 });
  }

  // Bitácora de seguridad: conciliación manual (fire-and-forget). Sólo
  // match/match-multiple/match-impuesto/unmatch — ignore/unignore no mueven
  // dinero ni vínculos fiscales.
  if (
    action === "match" ||
    action === "match-multiple" ||
    action === "match-impuesto" ||
    action === "unmatch" ||
    action === "vincular-devolucion" ||
    action === "desvincular-devolucion" ||
    action === "edit"
  ) {
    registrarBitacora({
      companyId: tx.companyId,
      userId: user.id,
      actorEmail: user.email ?? null,
      accion:
        action === "unmatch"
          ? "conciliacion.unmatch"
          : action === "match-impuesto"
            ? "conciliacion.match-impuesto"
            : action === "vincular-devolucion"
              ? "conciliacion.devolucion"
              : action === "desvincular-devolucion"
                ? "conciliacion.devolucion-desvincular"
                : action === "edit"
                  ? "bancos.edit-transaction"
                  : "conciliacion.match",
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
      taxDeclaration: {
        select: { id: true, tipo: true, periodo: true, status: true, fechaLimitePago: true },
      },
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

  // Sugerencia de REP: si se acaba de conciliar un ABONO contra una factura
  // PPD de ingreso vigente, este cobro necesita complemento de pago (el IVA se
  // causa en el mes de la FechaPago y el plazo es el quinto día natural del mes
  // siguiente, RMF 2.7.1.32). La UI ofrece emitirlo de un toque con el monto y
  // la fecha del propio movimiento. Solo se sugiere; no se emite nada aquí.
  let repSugerido: { invoiceId: string; cliente: string; monto: number; fecha: Date } | null = null;
  if (action === "match" && invoiceId && tx.monto > 0) {
    const inv = await prisma.invoice.findFirst({
      where: { id: invoiceId, companyId: tx.companyId, tipo: "INGRESO", metodoPago: "PPD", status: "STAMPED", uuid: { not: null } },
      select: { id: true, customer: { select: { razonSocial: true } } },
    });
    if (inv) {
      repSugerido = { invoiceId: inv.id, cliente: inv.customer?.razonSocial ?? "—", monto: Math.abs(tx.monto), fecha: tx.fecha };
    }
  }

  return NextResponse.json({ ...updated, ...(advertencia ? { advertencia } : {}), ...(repSugerido ? { repSugerido } : {}) });
}
