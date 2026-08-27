import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership, requireUser, AuthzError } from "@/lib/authz";
import { autoConciliarCuenta, clabesConocidasPorRfc, scoreCandidate } from "@/lib/bancos/auto-conciliar";
import {
  TIPOS_IMPUESTO_CONCILIABLES,
  confianzaImpuesto,
  etiquetaImpuesto,
  filtrarCandidatosImpuesto,
  montoEsperadoDeclaracion,
  periodosRecientes,
  scoreCandidatoImpuesto,
} from "@/lib/conciliacion-impuestos";

type Params = { params: Promise<{ id: string }> };

// POST /api/bancos/[id]/match — run auto-matching engine
// La lógica de auto-aplicación de alta confianza vive en
// @/lib/bancos/auto-conciliar (reutilizada por el cron diario). El umbral y el
// scoring son idénticos — esta ruta sólo añade la verificación de permisos.
export async function POST(req: Request, { params }: Params) {
  let user;
  try {
    user = await requireUser(req);
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const { id: bankAccountId } = await params;
  const account = await prisma.bankAccount.findUnique({ where: { id: bankAccountId } });
  if (!account) return NextResponse.json({ error: "Cuenta no encontrada" }, { status: 404 });

  const member = await getEffectiveCompanyMembership(user.id, account.companyId);
  if (!member || member.role === "VIEWER") return NextResponse.json({ error: "Sin permisos" }, { status: 403 });

  const { matched: autoMatched, total } = await autoConciliarCuenta(bankAccountId);

  return NextResponse.json({ ok: true, autoMatched, total });
}

// GET /api/bancos/[id]/match?txId=xxx — get match candidates for a specific transaction
export async function GET(req: Request, { params }: Params) {
  let user;
  try {
    user = await requireUser(req);
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const { id: bankAccountId } = await params;
  const txId = new URL(req.url).searchParams.get("txId");
  if (!txId) return NextResponse.json({ error: "txId requerido" }, { status: 400 });

  const account = await prisma.bankAccount.findUnique({ where: { id: bankAccountId } });
  if (!account) return NextResponse.json({ error: "Cuenta no encontrada" }, { status: 404 });

  const member = await getEffectiveCompanyMembership(user.id, account.companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  const txRow = await prisma.bankTransaction.findUnique({ where: { id: txId } });
  if (!txRow) return NextResponse.json({ error: "Transacción no encontrada" }, { status: 404 });
  const tx = { ...txRow, monto: Number(txRow.monto) };

  const companyId   = account.companyId;
  const absAmount   = Math.abs(tx.monto);
  const isCreditTx  = tx.monto > 0;
  const invoiceType = isCreditTx ? "INGRESO" : "EGRESO";
  const WINDOW_DAYS = 30;
  const TOLERANCE   = 0.05; // 5% for suggestions (wider than auto-match)

  const candidates = await prisma.invoice.findMany({
    where: {
      companyId,
      tipo:   invoiceType,
      status: "STAMPED",
      fecha:  {
        gte: new Date(tx.fecha.getTime() - WINDOW_DAYS * 86400000),
        lte: new Date(tx.fecha.getTime() + WINDOW_DAYS * 86400000),
      },
      AND: [
        {
          // El total del CFDI ya no tiene que ser el del movimiento. Con el
          // filtro viejo (total a ±5%) los dos flujos que la mesa promete eran
          // inalcanzables: un depósito agrupado (Stripe/PayPal pagan en lote y
          // netos de comisión) se cuadra con VARIOS CFDIs menores que él, y un
          // abono parcial paga un PPD MAYOR que él. Entra todo lo que cabe en
          // el movimiento, más los PPD más grandes; el ranking por score y la
          // tolerancia del scoring deciden el orden — el auto-match conserva
          // su propio query estricto, aquí sólo se SUGIERE a un humano.
          OR: [
            { total: { lte: absAmount * (1 + TOLERANCE) } },
            { metodoPago: "PPD", total: { gt: absAmount } },
          ],
        },
        {
          // Exclude PUE invoices already matched to another bank tx — either
          // via the legacy 1:1 link or via assigned portions
          // (ConciliacionDetalle). Keep PPD invoices visible — they can have
          // multiple partial payments.
          OR: [
            { metodoPago: "PPD" },
            {
              bankTransactions: { none: { status: "MATCHED" } },
              conciliacionDetalles: { none: {} },
            },
          ],
        },
      ],
    },
    include: {
      customer: { select: { rfc: true, razonSocial: true } },
      bankTransactions: {
        where: { status: "MATCHED" },
        select: { id: true, fecha: true, monto: true },
      },
      conciliacionDetalles: { select: { montoAsignado: true } },
    },
    // Acotado por si el filtro ancho trae mucho; el corte fino (top 15) se
    // hace DESPUÉS de puntuar — cortar aquí por fecha tiraría a los mejores.
    orderBy: { fecha: "desc" },
    take: 300,
  });

  // Memoria de CLABEs: sólo se consulta si el movimiento trae CLABE extraída.
  const clabesPorRfc = tx.contraparteClabe
    ? await clabesConocidasPorRfc(companyId, tx.contraparteClabe)
    : new Set<string>();
  const senales = {
    fecha: tx.fecha,
    descripcion: tx.descripcion,
    contraparteRfc: tx.contraparteRfc,
    contraparteNombre: tx.contraparteNombre,
    contraparteClabe: tx.contraparteClabe,
  };

  const scored = candidates.map(inv => {
    // MISMA fórmula que la auto-conciliación (antes era una copia que divergió:
    // esta ruta no conocía las señales de identidad). Identidad efectiva: el
    // Customer si existe; si no, la contraparte del propio CFDI — los EGRESO
    // sincronizados del SAT casi nunca tienen Customer.
    const rfcFactura = inv.customer?.rfc ?? inv.contraparteRfc ?? null;
    const nombreFactura = inv.customer?.razonSocial ?? inv.contraparteNombre ?? null;
    const total = Number(inv.total);
    let score = scoreCandidate(
      {
        total,
        fecha: inv.fecha,
        customerRfc: rfcFactura,
        customerNombre: nombreFactura,
        clabesConocidas:
          rfcFactura && clabesPorRfc.has(rfcFactura) && tx.contraparteClabe
            ? [tx.contraparteClabe]
            : [],
      },
      senales,
      absAmount,
    );
    // Banda ancha PROPIA de las sugerencias (no existe en el auto-match): un
    // monto a 1–5% todavía se ofrece al humano, sólo que con poco puntaje.
    const diff = Math.abs(Math.abs(total) - absAmount);
    if (diff / absAmount >= 0.01 && diff / absAmount < TOLERANCE) score += 20;
    const alreadyMatched = inv.bankTransactions.length > 0 || inv.conciliacionDetalles.length > 0;
    // Neto firmado: un reembolso (cargo) resta de lo cobrado. Las porciones
    // asignadas (conciliación múltiple) suman por su monto asignado.
    const matchedAmount =
      Math.abs(inv.bankTransactions.reduce((s, t) => s + Number(t.monto), 0)) +
      inv.conciliacionDetalles.reduce((s, d) => s + Math.abs(Number(d.montoAsignado)), 0);
    return {
      id:          inv.id,
      uuid:        inv.uuid,
      fecha:       inv.fecha,
      folio:       inv.folio,
      serie:       inv.serie,
      metodoPago:  inv.metodoPago,
      total,
      cliente:     inv.customer?.razonSocial ?? inv.contraparteNombre ?? "—",
      rfc:         inv.customer?.rfc ?? inv.contraparteRfc ?? "—",
      score,
      confidence:  score >= 100 ? "alta" : score >= 50 ? "media" : "baja",
      alreadyMatched,
      matchedAmount: Math.round(matchedAmount * 100) / 100,
      remainingBalance: Math.round((total - matchedAmount) * 100) / 100,
    };
  })
    // Un PPD ya cobrado por completo no es candidato de nada: sin saldo no hay
    // porción que asignar (los PUE en ese estado ya los excluyó el query).
    .filter((c) => !c.alreadyMatched || c.remainingBalance > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 15);

  // ── Pagos de impuestos pendientes ──────────────────────────────────────────
  // Sólo para egresos: declaraciones no pagadas (SIPARE / línea de captura) de
  // periodos recientes (ventana acotada), aún sin movimiento vinculado. El
  // scoring (monto/fecha límite) y el filtro son puros — ver
  // lib/conciliacion-impuestos. Un tap en «Conciliar» llama al PATCH con
  // action "match-impuesto".
  let impuestos: Array<{
    id: string;
    tipo: string;
    periodo: string;
    etiqueta: string;
    montoEsperado: number | null;
    fechaLimitePago: Date | null;
    score: number;
    confidence: "alta" | "media" | "baja";
  }> = [];
  if (tx.monto < 0) {
    const decls = await prisma.taxDeclaration.findMany({
      where: {
        companyId,
        tipo: { in: [...TIPOS_IMPUESTO_CONCILIABLES] },
        periodo: { in: periodosRecientes(tx.fecha) },
        status: { not: "PAID" },
        // v1: una declaración ↔ un movimiento; las ya vinculadas no son candidatas.
        bankTransactions: { none: { status: "MATCHED" } },
      },
      select: {
        id: true,
        tipo: true,
        periodo: true,
        status: true,
        ivaPagar: true,
        isrPagar: true,
        retencionesIsr: true,
        imssCuotas: true,
        fechaLimitePago: true,
        // La línea de captura del acuse: si el movimiento trae la misma, ese
        // cargo pagó ESTA declaración y no hay nada que inferir.
        lineaCaptura: true,
      },
    });
    impuestos = filtrarCandidatosImpuesto(decls)
      .map((d) => {
        const montoEsperado = montoEsperadoDeclaracion(d);
        const score = scoreCandidatoImpuesto(
          { montoEsperado, fechaLimitePago: d.fechaLimitePago, lineaCaptura: d.lineaCaptura },
          { monto: tx.monto, fecha: tx.fecha, lineaCaptura: tx.lineaCaptura }
        );
        return {
          id: d.id,
          tipo: d.tipo,
          periodo: d.periodo,
          etiqueta: etiquetaImpuesto(d.tipo, d.periodo),
          montoEsperado,
          fechaLimitePago: d.fechaLimitePago,
          score,
          confidence: confianzaImpuesto(score),
        };
      })
      .sort((a, b) => b.score - a.score);
  }

  return NextResponse.json({ transaction: tx, candidates: scored, impuestos });
}
