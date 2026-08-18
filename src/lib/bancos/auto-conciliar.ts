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
// - Score >= 130
// - Ningún otro candidato a menos de 20 puntos del ganador (evita conciliar mal
//   cuando varias facturas tienen el mismo monto).
//
// OJO CON ESTE NÚMERO: monto exacto (100) + mismo día (30) = 130 clava el umbral
// justo. Es decir, sin señal de contraparte el sistema auto-concilia por MONTO Y
// FECHA, y lo único que lo protege de emparejar la factura equivocada es la
// regla de ambigüedad. Por eso la identidad de la contraparte no se suma como
// un puntito más: es lo que convierte "adivinar por monto" en "identificar por
// parte y confirmar por monto".
export const AUTO_MATCH_MIN_SCORE = 130;
export const AUTO_MATCH_AMBIGUITY_GAP = 20;

/** Señales de identidad, de más fuerte a más débil. */
export const PUNTOS_RFC_EXACTO = 120;
export const PUNTOS_CLABE_CONOCIDA = 80;
export const PUNTOS_RFC_EN_TEXTO = 25;
export const PUNTOS_NOMBRE = 40;

/** Normaliza para comparar nombres: sin acentos, sin puntuación, sin sufijos. */
export function normalizarNombre(s: string): string {
  return s
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(S\.?A\.?|S\.?\s*DE\s*R\.?L\.?|DE\s*C\.?V\.?|S\.?C\.?|A\.?C\.?|SAPI)\b/g, " ")
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * ¿El nombre de la contraparte y el de la factura son la misma persona?
 *
 * Se exige que uno contenga al otro DESPUÉS de normalizar, y que el más corto
 * tenga al menos 6 caracteres. Sin ese piso, "SA" o "GRUPO" empatarían con
 * media cartera — y un match de nombre mal dado concilia la factura equivocada,
 * que es más caro que no conciliar.
 */
export function mismoNombre(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normalizarNombre(a ?? "");
  const y = normalizarNombre(b ?? "");
  if (x.length < 6 || y.length < 6) return false;
  return x.includes(y) || y.includes(x);
}

export interface SenalesTx {
  fecha: Date;
  descripcion: string;
  /** Extraídos de la descripción por spei-descripcion.ts. */
  contraparteRfc?: string | null;
  contraparteNombre?: string | null;
  contraparteClabe?: string | null;
}

// Calcula el score de una factura candidata contra una transacción bancaria.
// Función pura: misma fórmula que el POST /api/bancos/[id]/match.
export function scoreCandidate(
  inv: {
    total: number;
    fecha: Date;
    customerRfc: string | null;
    customerNombre?: string | null;
    /** CLABEs ya vistas para este cliente/proveedor en movimientos conciliados. */
    clabesConocidas?: readonly string[];
  },
  tx: SenalesTx,
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

  const rfc = (inv.customerRfc ?? "").toUpperCase();

  // IDENTIDAD DE LA CONTRAPARTE ─────────────────────────────────────────────
  // El RFC extraído es igualdad de campo, no una búsqueda de subcadena en texto
  // libre: cuando empata, es la MISMA persona y el monto sólo confirma. Vale
  // más que el monto exacto a propósito — así una factura del cliente correcto
  // con monto aproximado le gana a una de otro cliente con monto clavado.
  const rfcTx = (tx.contraparteRfc ?? "").toUpperCase();
  if (rfc && rfcTx && rfc === rfcTx) {
    score += PUNTOS_RFC_EXACTO;
  } else if (rfc && tx.descripcion.toUpperCase().includes(rfc)) {
    // Respaldo histórico: el RFC suelto en la descripción, sin etiqueta.
    score += PUNTOS_RFC_EN_TEXTO;
  }

  // La CLABE identifica la cuenta, no a la persona; sube fuerte pero por debajo
  // del RFC, y sólo si YA se le vio a esta contraparte antes.
  if (tx.contraparteClabe && inv.clabesConocidas?.includes(tx.contraparteClabe)) {
    score += PUNTOS_CLABE_CONOCIDA;
  }

  // El nombre es la señal más floja: los bancos lo truncan y lo escriben a su
  // manera. Suma, pero no alcanza sola para cruzar el umbral.
  if (mismoNombre(tx.contraparteNombre, inv.customerNombre)) {
    score += PUNTOS_NOMBRE;
  }

  return score;
}

// Decide si el mejor candidato es auto-aplicable: alta confianza y sin ambigüedad.
export function isAutoApplicable(bestScore: number, secondBestScore: number | null): boolean {
  const unambiguous = secondBestScore == null || bestScore - secondBestScore >= AUTO_MATCH_AMBIGUITY_GAP;
  return bestScore >= AUTO_MATCH_MIN_SCORE && unambiguous;
}

/**
 * RFCs a los que esta CLABE ya se les vio, en movimientos YA CONCILIADOS.
 *
 * Es la memoria del sistema: la primera vez que se paga a un proveedor no hay
 * nada que recordar, pero de la segunda en adelante su CLABE lo identifica sin
 * ambigüedad. Sólo cuentan los conciliados — un movimiento sin conciliar no es
 * evidencia de nada, y usarlo propagaría un error de conciliación al siguiente
 * mes convertido en "conocimiento".
 */
async function clabesConocidasPorRfc(companyId: string, clabe: string): Promise<Set<string>> {
  const previos = await prisma.bankTransaction.findMany({
    where: { companyId, contraparteClabe: clabe, status: "MATCHED", invoiceId: { not: null } },
    select: { invoice: { select: { customer: { select: { rfc: true } } } } },
    take: 50,
  });
  const rfcs = new Set<string>();
  for (const p of previos) {
    const rfc = p.invoice?.customer?.rfc;
    if (rfc) rfcs.add(rfc);
  }
  return rfcs;
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
        // Que no esté ya conciliada con otra transacción bancaria: ni por el
        // vínculo legado 1:1 ni por porciones asignadas (ConciliacionDetalle).
        bankTransactions: { none: { status: "MATCHED" } },
        conciliacionDetalles: { none: {} },
      },
      include: { customer: { select: { rfc: true, razonSocial: true } } },
    });

    if (candidates.length === 0) continue;

    // ¿A qué CLABEs ya le habíamos pagado/cobrado a este cliente? Una CLABE que
    // ya se vio en un movimiento CONCILIADO con el mismo RFC identifica la
    // cuenta de esa contraparte. Se consulta sólo si el movimiento trae CLABE,
    // para no pagar la consulta en los que no la traen.
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

    const scored = candidates
      .map((inv) => ({
        inv,
        score: scoreCandidate(
          {
            total: inv.total,
            fecha: inv.fecha,
            customerRfc: inv.customer?.rfc ?? null,
            customerNombre: inv.customer?.razonSocial ?? null,
            clabesConocidas:
              inv.customer?.rfc && clabesPorRfc.has(inv.customer.rfc) && tx.contraparteClabe
                ? [tx.contraparteClabe]
                : [],
          },
          senales,
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
