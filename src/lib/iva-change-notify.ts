import { prisma } from "./prisma";
import { computeTaxPosition } from "./impuestos";
import { sendWhatsappMessage, sendWhatsappTemplate } from "./whatsapp/twilio";
import { formatCurrency } from "./utils";

// ─────────────────────────────────────────────────────────────────────────────
// Post-sync IVA-change notice.
//
// Under the cash-basis (base-REP) engine, a newly imported complemento de pago
// (REP) moves the IVA of the period its payment falls in. When that period is
// still unfiled, the user wants to know — their número de IVA just changed
// because of something the SAT sync pulled in, not because they did anything.
//
// This runs at the end of the SAT sync cron, per company touched. It compares
// each unfiled, REP-touched period's current IVA trasladado against a baseline
// stored in IvaPeriodNotice:
//   - No baseline yet → record one silently (the user is assumed aware of the
//     pre-existing state; we never blast on first encounter).
//   - Baseline exists and IVA increased beyond tolerance → notify via WhatsApp
//     and advance the baseline so we don't re-notify an unchanged figure.
//
// Gated behind IVA_CHANGE_NOTICE_ENABLED so it stays dormant until explicitly
// turned on. Outbound messages only go to verified WhatsApp numbers currently
// scoped to this company.
// ─────────────────────────────────────────────────────────────────────────────

const TOL = 1; // peso — ignore sub-peso rounding drift
const MONTHS_BACK = 4; // how far back to watch for late-arriving REPs

const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

function periodoLabel(periodo: string): string {
  const [y, m] = periodo.split("-").map((n) => parseInt(n, 10));
  return `${MESES[m - 1] ?? periodo} ${y}`;
}

/** {year, month} for the last MONTHS_BACK months, newest first. */
function recentPeriods(now: Date): Array<{ year: number; month: number; periodo: string }> {
  const out: Array<{ year: number; month: number; periodo: string }> = [];
  for (let i = 0; i < MONTHS_BACK; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const year = d.getFullYear();
    const month = d.getMonth() + 1;
    out.push({ year, month, periodo: `${year}-${String(month).padStart(2, "0")}` });
  }
  return out;
}

export interface IvaNoticeResult {
  checked: number;
  notified: number;
}

/**
 * Detect IVA changes in unfiled periods caused by newly synced REPs and notify
 * the company's verified WhatsApp numbers. Safe to call after every sync — it
 * only sends when an unfiled period's IVA actually moved past a baseline.
 */
export async function notifyIvaChanges(
  companyId: string,
  now: Date = new Date()
): Promise<IvaNoticeResult> {
  if (process.env.IVA_CHANGE_NOTICE_ENABLED !== "true") {
    return { checked: 0, notified: 0 };
  }

  const periods = recentPeriods(now);
  const periodos = periods.map((p) => p.periodo);

  // Which of these periods have any REP payment landing in them? (Cheap filter
  // so we only recompute periods that could have changed.)
  const repMonths = new Set<string>();
  const repLinks = await prisma.pagoDoctoRelacionado.findMany({
    where: {
      fechaPago: { gte: new Date(periods[periods.length - 1].year, periods[periods.length - 1].month - 1, 1) },
      pagoInvoice: { companyId, tipo: "PAGO", status: "STAMPED" },
    },
    select: { fechaPago: true },
  });
  for (const l of repLinks) {
    if (!l.fechaPago) continue;
    repMonths.add(`${l.fechaPago.getFullYear()}-${String(l.fechaPago.getMonth() + 1).padStart(2, "0")}`);
  }

  // Periods already filed are out of scope — the number is locked.
  const filed = await prisma.taxDeclaration.findMany({
    where: { companyId, tipo: "IVA_MENSUAL", periodo: { in: periodos }, status: { in: ["FILED", "PAID"] } },
    select: { periodo: true },
  });
  const filedSet = new Set(filed.map((f) => f.periodo));

  const candidates = periods.filter((p) => repMonths.has(p.periodo) && !filedSet.has(p.periodo));
  if (candidates.length === 0) return { checked: 0, notified: 0 };

  // Verified numbers currently scoped to this company (opt-in recipients).
  const links = await prisma.whatsappLink.findMany({
    where: { activeCompanyId: companyId, verifiedAt: { not: null } },
    select: { phoneE164: true },
  });
  const recipients = links.map((l) => l.phoneE164);

  let checked = 0;
  let notified = 0;

  for (const p of candidates) {
    checked++;
    const pos = await computeTaxPosition(companyId, p.year, p.month);
    const current = Math.round(pos.iva.trasladado * 100) / 100;

    const existing = await prisma.ivaPeriodNotice.findUnique({
      where: { companyId_periodo: { companyId, periodo: p.periodo } },
    });

    if (!existing) {
      // First time we see this period — baseline silently.
      await prisma.ivaPeriodNotice.create({
        data: { companyId, periodo: p.periodo, ivaTrasladado: current },
      });
      continue;
    }

    const delta = current - Number(existing.ivaTrasladado);
    if (delta <= TOL) continue; // unchanged or decreased — nothing to announce

    // Only advance the baseline once we've actually reached someone; otherwise
    // leave it so a future run retries when a number gets linked.
    if (recipients.length === 0) continue;

    const periodo = periodoLabel(p.periodo);
    const ivaActual = formatCurrency(current);
    const ivaPrevio = formatCurrency(Number(existing.ivaTrasladado));

    const body =
      `💡 Llegó un complemento de pago que afecta tu IVA de ${periodo}. ` +
      `Tu IVA trasladado ahora es ${ivaActual} ` +
      `(antes ${ivaPrevio}). Revisa el cierre del mes.`;

    // Aviso proactivo iniciado por el negocio: fuera de la ventana de servicio de
    // 24h WhatsApp exige una plantilla de utilidad aprobada. Si está configurada
    // la usamos; si no, caemos a freeform (válido sólo en ventana/sandbox/dev).
    //
    // Orden de variables de la plantilla TWILIO_IVA_TEMPLATE_SID (construye la
    // plantilla en el Content Template Builder con este mismo orden):
    //   {{1}} = periodo (etiqueta del mes, p.ej. "marzo 2026")
    //   {{2}} = IVA trasladado actual (ya formateado como moneda)
    //   {{3}} = IVA trasladado previo (ya formateado como moneda)
    const ivaTemplateSid = process.env.TWILIO_IVA_TEMPLATE_SID;

    let sent = false;
    for (const to of recipients) {
      try {
        if (ivaTemplateSid) {
          await sendWhatsappTemplate(
            to,
            ivaTemplateSid,
            { "1": periodo, "2": ivaActual, "3": ivaPrevio },
            { companyId }
          );
        } else {
          await sendWhatsappMessage(to, body, { companyId });
        }
        sent = true;
      } catch (e) {
        console.error(`[iva-change-notify] send failed for ${companyId} ${p.periodo}:`, e);
      }
    }

    if (sent) {
      await prisma.ivaPeriodNotice.update({
        where: { companyId_periodo: { companyId, periodo: p.periodo } },
        data: { ivaTrasladado: current, lastNotifiedAt: now },
      });
      notified++;
    }
  }

  return { checked, notified };
}
