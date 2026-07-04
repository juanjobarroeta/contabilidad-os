import { registrarYNotificar, fechaLocalMx } from "./notificaciones";
import { empresasAccesiblesIds } from "./authz";
import { prisma } from "./prisma";
import { estadoPagosImss } from "./fiscal/imss-pagos";
import { formatCurrency } from "./utils";

// ─────────────────────────────────────────────────────────────────────────────
// Recordatorio del pago de cuotas IMSS (SIPARE). A partir de T-5 antes del
// vencimiento (día 17 del mes siguiente, LSS Art. 39) y mientras siga sin
// registrarse el pago, avisa por empresa con nómina TIMBRADA en el mes:
//
//   "Cuotas IMSS de [empresa]: $X estimado, vence el 17."
//
// Disciplina de dedupe: clave FECHADA `imss-pago:<companyId>:<periodo>:<fecha>`
// + pushSoloAlCrear — a lo más un push por día y por empresa; los re-corridos
// del cron el mismo día colapsan en silencio en el inbox. Incluye el bimestral
// (RCV + Infonavit) en el mismo aviso cuando el mes cierra bimestre.
// ─────────────────────────────────────────────────────────────────────────────

/** Ventana de aviso: desde T-5 antes del vencimiento (incluye ya vencida). */
const DIAS_ANTICIPACION = 5;

const MESES_ES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

function fmtFecha(iso: string): string {
  const [y, m, d] = iso.split("-").map((n) => parseInt(n));
  return `${d} de ${MESES_ES[m - 1]} de ${y}`;
}

/**
 * Recordatorios de pago IMSS para un usuario: revisa TODAS sus empresas
 * accesibles y, por cada una con nómina timbrada el mes pasado y pago IMSS sin
 * registrar dentro de la ventana T-5, registra un pendiente + push (dedupe
 * fechado por empresa y periodo). Devuelve conteos para el resumen del cron.
 */
export async function notifyImssPago(
  userId: string,
  hoy: Date = new Date()
): Promise<{ notified: number; empresas: number }> {
  const ids = await empresasAccesiblesIds(userId);
  if (ids.length === 0) return { notified: 0, empresas: 0 };

  // El periodo cuyo vencimiento está en curso es el MES ANTERIOR (sus cuotas
  // vencen el día 17 de este mes).
  const year = hoy.getMonth() === 0 ? hoy.getFullYear() - 1 : hoy.getFullYear();
  const month = hoy.getMonth() === 0 ? 12 : hoy.getMonth();

  let notified = 0;
  let empresas = 0;

  for (const companyId of ids) {
    try {
      const estado = await estadoPagosImss(companyId, year, month, hoy);
      // Sólo empresas con nómina TIMBRADA en el mes; sin nómina timbrada no hay
      // cuotas causadas que recordar (y el estimado sería 0).
      if (estado.nomina.timbradasDelMes === 0) continue;

      const mensualDebida = !estado.mensual.pagada && estado.mensual.diasRestantes <= DIAS_ANTICIPACION;
      const bimestralDebida =
        estado.bimestral != null &&
        !estado.bimestral.pagada &&
        estado.bimestral.diasRestantes <= DIAS_ANTICIPACION;
      if (!mensualDebida && !bimestralDebida) continue;

      const c = await prisma.company.findUnique({
        where: { id: companyId },
        select: { razonSocial: true, nombreComercial: true },
      });
      if (!c) continue;
      const nombre = c.nombreComercial || c.razonSocial;

      const m = estado.mensual;
      const vencida = m.vencida;
      const partes: string[] = [];
      if (mensualDebida) {
        partes.push(
          `cuotas del mes ${formatCurrency(m.estimado.total)} estimado` +
            (vencida
              ? ` — venció el ${fmtFecha(m.fechaLimite)}`
              : m.diasRestantes === 0
                ? ` — vence HOY (${fmtFecha(m.fechaLimite)})`
                : ` — vence el ${fmtFecha(m.fechaLimite)} (${m.diasRestantes} día(s))`)
        );
      }
      if (bimestralDebida && estado.bimestral) {
        const b = estado.bimestral;
        partes.push(
          `RCV e Infonavit del bimestre ${b.etiqueta} (estimado ${formatCurrency(b.estimado.total)})`
        );
      }

      const titulo = vencida
        ? `Cuotas IMSS de ${nombre} vencidas`
        : `Cuotas IMSS de ${nombre} por pagar`;
      const cuerpo =
        `IMSS (SIPARE) del periodo ${estado.periodo}: ${partes.join("; ")}. ` +
        `Registra el pago con tu línea de captura.`;

      const r = await registrarYNotificar({
        recipientUserId: userId,
        companyId,
        categoria: "nomina",
        severidad: vencida ? "error" : "warn",
        titulo,
        cuerpo,
        url: "/nomina",
        // Clave fechada por empresa y periodo + pushSoloAlCrear = a lo más un
        // push al día por empresa; los re-corridos del mismo día colapsan.
        dedupeKey: `imss-pago:${companyId}:${estado.periodo}:${fechaLocalMx(hoy)}`,
        categoriaPush: "declaraciones",
        pushSoloAlCrear: true,
      });
      empresas++;
      if (r.pushSent) notified++;
    } catch (e) {
      console.error(`[notify-imss] empresa ${companyId} falló:`, e);
    }
  }

  return { notified, empresas };
}
