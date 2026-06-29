import { prisma } from "@/lib/prisma";

// ─────────────────────────────────────────────────────────────────────────────
// Auto-conciliación bancaria de alta confianza (motor reutilizable)
//
// Extrae la lógica de auto-aplicación del POST /api/bancos/[id]/match para que
// pueda usarse tanto desde la ruta (un click del usuario) como desde el cron
// diario (toda la cartera). NO cambia el umbral ni el scoring.
//
// Idempotente: sólo toca transacciones UNMATCHED; nunca des-concilia ni toca
// las IGNORED. Best-effort.
// ─────────────────────────────────────────────────────────────────────────────

const WINDOW_DAYS = 14;
const TOLERANCE = 0.01; // 1%

// Umbral de auto-aplicación: muy alta confianza Y sin ambigüedad.
// - Score >= 130 (monto exacto + fecha dentro de 7 días)
// - Ningún otro candidato a menos de 20 puntos del ganador (evita conciliar mal
//   cuando varias facturas tienen el mismo monto).
export const AUTO_MATCH_MIN_SCORE = 130;
export const AUTO_MATCH_AMBIGUITY_GAP = 20;

// Calcula el score de una factura candidata contra una transacción bancaria.
// Función pura: misma fórmula que el POST /api/bancos/[id]/match.
export function scoreCandidate(
  inv: { total: number; fecha: Date; customerRfc: string | null },
  tx: { fecha: Date; descripcion: string },
  absAmount: number,
): number {
  let score = 0;
  const diff = Math.abs(Math.abs(inv.total) - absAmount);
  // Monto
  if (diff < 0.01) score += 100; // exacto
  else if (diff / absAmount < 0.005) score += 70; // <0.5%
  else if (diff / absAmount < TOLERANCE) score += 40; // <1%
  // Proximidad de fecha
  const daysDiff = Math.abs(inv.fecha.getTime() - tx.fecha.getTime()) / 86400000;
  if (daysDiff <= 1) score += 30;
  else if (daysDiff <= 3) score += 20;
  else if (daysDiff <= 7) score += 10;
  // RFC en la descripción
  const rfc = inv.customerRfc ?? "";
  if (rfc && tx.descripcion.toUpperCase().includes(rfc)) score += 25;
  return score;
}

// Decide si el mejor candidato es auto-aplicable: alta confianza y sin ambigüedad.
export function isAutoApplicable(bestScore: number, secondBestScore: number | null): boolean {
  const unambiguous = secondBestScore == null || bestScore - secondBestScore >= AUTO_MATCH_AMBIGUITY_GAP;
  return bestScore >= AUTO_MATCH_MIN_SCORE && unambiguous;
}

// Auto-concilia una cuenta bancaria: recorre sus transacciones UNMATCHED y
// aplica únicamente las coincidencias de alta confianza y sin ambigüedad.
// Devuelve cuántas concilió. Best-effort por transacción.
export async function autoConciliarCuenta(accountId: string): Promise<{ matched: number; total: number }> {
  const account = await prisma.bankAccount.findUnique({ where: { id: accountId } });
  if (!account) return { matched: 0, total: 0 };

  const companyId = account.companyId;
  const unmatched = await prisma.bankTransaction.findMany({
    where: { bankAccountId: accountId, status: "UNMATCHED" },
  });

  let matched = 0;

  for (const tx of unmatched) {
    const absAmount = Math.abs(tx.monto);
    const isCreditTx = tx.monto > 0;

    // CRÉDITOS (entra dinero) → facturas INGRESO (clientes nos pagan)
    // DÉBITOS  (sale dinero)  → facturas EGRESO  (pagamos a proveedores)
    const invoiceType = isCreditTx ? "INGRESO" : "EGRESO";

    const windowStart = new Date(tx.fecha.getTime() - WINDOW_DAYS * 86400000);
    const windowEnd = new Date(tx.fecha.getTime() + WINDOW_DAYS * 86400000);

    const candidates = await prisma.invoice.findMany({
      where: {
        companyId,
        tipo: invoiceType,
        status: "STAMPED",
        fecha: { gte: windowStart, lte: windowEnd },
        total: { gte: absAmount * (1 - TOLERANCE), lte: absAmount * (1 + TOLERANCE) },
        // Que no esté ya conciliada con otra transacción bancaria
        bankTransactions: { none: { status: "MATCHED" } },
      },
      include: { customer: { select: { rfc: true, razonSocial: true } } },
    });

    if (candidates.length === 0) continue;

    const scored = candidates
      .map((inv) => ({
        inv,
        score: scoreCandidate(
          { total: inv.total, fecha: inv.fecha, customerRfc: inv.customer?.rfc ?? null },
          { fecha: tx.fecha, descripcion: tx.descripcion },
          absAmount,
        ),
      }))
      .sort((a, b) => b.score - a.score);

    const best = scored[0];
    const secondBest = scored[1];

    if (isAutoApplicable(best.score, secondBest?.score ?? null)) {
      await prisma.bankTransaction.update({
        where: { id: tx.id },
        data: { status: "MATCHED", invoiceId: best.inv.id },
      });
      matched++;
    }
  }

  return { matched, total: unmatched.length };
}

// Auto-concilia todas las cuentas bancarias de una empresa. Best-effort: un
// error en una cuenta no detiene las demás.
export async function autoConciliarEmpresa(
  companyId: string,
): Promise<{ matched: number; accounts: number }> {
  const accounts = await prisma.bankAccount.findMany({
    where: { companyId },
    select: { id: true },
  });

  let matched = 0;
  for (const acc of accounts) {
    try {
      const res = await autoConciliarCuenta(acc.id);
      matched += res.matched;
    } catch {
      // best-effort: continuar con las demás cuentas
    }
  }

  return { matched, accounts: accounts.length };
}
