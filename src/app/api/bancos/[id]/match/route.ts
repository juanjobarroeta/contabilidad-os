import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership, requireUser, AuthzError } from "@/lib/authz";
import { autoConciliarCuenta } from "@/lib/bancos/auto-conciliar";
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

  const tx = await prisma.bankTransaction.findUnique({ where: { id: txId } });
  if (!tx) return NextResponse.json({ error: "Transacción no encontrada" }, { status: 404 });

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
      total: { gte: absAmount * (1 - TOLERANCE), lte: absAmount * (1 + TOLERANCE) },
      // Exclude PUE invoices already matched to another bank tx — either via
      // the legacy 1:1 link or via assigned portions (ConciliacionDetalle).
      // Keep PPD invoices visible — they can have multiple partial payments.
      OR: [
        { metodoPago: "PPD" },
        {
          bankTransactions: { none: { status: "MATCHED" } },
          conciliacionDetalles: { none: {} },
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
    orderBy: { fecha: "desc" },
    take: 10,
  });

  const scored = candidates.map(inv => {
    let score = 0;
    const diff = Math.abs(Math.abs(inv.total) - absAmount);
    if (diff < 0.01)                          score += 100;
    else if (diff / absAmount < 0.005)         score += 70;
    else if (diff / absAmount < 0.01)          score += 40;
    else if (diff / absAmount < TOLERANCE)     score += 20;
    const daysDiff = Math.abs(inv.fecha.getTime() - tx.fecha.getTime()) / 86400000;
    if (daysDiff <= 1)       score += 30;
    else if (daysDiff <= 3)  score += 20;
    else if (daysDiff <= 7)  score += 10;
    const rfc = inv.customer?.rfc ?? "";
    if (rfc && tx.descripcion.toUpperCase().includes(rfc)) score += 25;
    const alreadyMatched = inv.bankTransactions.length > 0 || inv.conciliacionDetalles.length > 0;
    // Neto firmado: un reembolso (cargo) resta de lo cobrado. Las porciones
    // asignadas (conciliación múltiple) suman por su monto asignado.
    const matchedAmount =
      Math.abs(inv.bankTransactions.reduce((s, t) => s + t.monto, 0)) +
      inv.conciliacionDetalles.reduce((s, d) => s + Math.abs(d.montoAsignado), 0);
    return {
      id:          inv.id,
      uuid:        inv.uuid,
      fecha:       inv.fecha,
      folio:       inv.folio,
      serie:       inv.serie,
      metodoPago:  inv.metodoPago,
      total:       inv.total,
      cliente:     inv.customer?.razonSocial ?? "—",
      rfc:         inv.customer?.rfc ?? "—",
      score,
      confidence:  score >= 100 ? "alta" : score >= 50 ? "media" : "baja",
      alreadyMatched,
      matchedAmount: Math.round(matchedAmount * 100) / 100,
      remainingBalance: Math.round((inv.total - matchedAmount) * 100) / 100,
    };
  }).sort((a, b) => b.score - a.score);

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
      },
    });
    impuestos = filtrarCandidatosImpuesto(decls)
      .map((d) => {
        const montoEsperado = montoEsperadoDeclaracion(d);
        const score = scoreCandidatoImpuesto(
          { montoEsperado, fechaLimitePago: d.fechaLimitePago },
          { monto: tx.monto, fecha: tx.fecha }
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
