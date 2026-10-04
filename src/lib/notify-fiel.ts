import { prisma } from "./prisma";
import { registrarYNotificar } from "./notificaciones";
import { usuariosConAccesoACompany } from "./push";
import { sendWhatsappMessage, sendWhatsappTemplate } from "./whatsapp/twilio";

// ─────────────────────────────────────────────────────────────────────────────
// Avisos de e.firma (FIEL): vencida / revocada por el SAT, y por vencer.
//
// Una FIEL muerta detiene la descarga masiva de CFDIs SIN que nadie se entere:
// el cron sat-sync acumula el error, responde 200 y `lastAutoSyncAt` deja de
// avanzar. Estos avisos hacen visible el problema a quienes operan la empresa
// (miembros + despacho; operadores sólo con opt-in), persistidos en el inbox de
// Pendientes con push, y además por WhatsApp a quien tenga número verificado:
// el push sólo llega a quien se suscribió, y en producción eso fue UNA persona
// de cuatro (BAHJ, julio–octubre 2026: tres meses detenida con el aviso sin
// leer). La idempotencia es por (usuario, dedupeKey):
//
//   - fiel-invalida:<companyId>                 — el primer aviso; el push y
//     el WhatsApp salen al CREAR el item; re-disparos iguales no re-empujan.
//   - fiel-invalida:<companyId>:semana:<YYYY-Www> — recordatorio SEMANAL
//     mientras siga detenida (a partir de la segunda semana), también con
//     WhatsApp. Un problema que no se arregla no puede quedarse mudo.
//   - fiel-por-vencer:<companyId>:<YYYY-MM>     — un recordatorio por mes.
//
// Best-effort: nunca deben romper el cron que los dispara.
// ─────────────────────────────────────────────────────────────────────────────

const fmtFecha = (d: Date) =>
  d.toLocaleDateString("es-MX", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "America/Mexico_City" });

/** «2026-W40»: semana ISO, para el recordatorio semanal. */
export function semanaIso(d: Date): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dia = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dia);
  const inicioAnio = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const semana = Math.ceil(((t.getTime() - inicioAnio.getTime()) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(semana).padStart(2, "0")}`;
}

async function datosEmpresa(companyId: string) {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { razonSocial: true, rfc: true, fielVigencia: true },
  });
  return company ?? { razonSocial: "tu empresa", rfc: "", fielVigencia: null };
}

/**
 * WhatsApp a los números VERIFICADOS de esos usuarios. Con plantilla
 * (TWILIO_DIGEST_TEMPLATE_SID, una línea en {{1}}) llega a números «fríos»;
 * sin ella, freeform sólo dentro de la ventana de 24 h. Devuelve cuántos salieron.
 */
async function whatsappA(userIds: string[], linea: string, companyId: string): Promise<number> {
  if (userIds.length === 0 || !process.env.TWILIO_WHATSAPP_FROM) return 0;
  const links = await prisma.whatsappLink.findMany({
    // Quien recibe el resumen matutino lo ve ahí (una sola línea por empresa,
    // en un solo mensaje); el aviso suelto sólo va a quien lo apagó.
    where: { userId: { in: userIds }, verifiedAt: { not: null }, digestOptOut: true },
    select: { phoneE164: true },
  });
  const sid = process.env.TWILIO_DIGEST_TEMPLATE_SID;
  let enviados = 0;
  for (const { phoneE164 } of links) {
    try {
      if (sid) await sendWhatsappTemplate(phoneE164, sid, { "1": linea }, { companyId });
      else await sendWhatsappMessage(phoneE164, linea, { companyId });
      enviados++;
    } catch (e) {
      console.error(`[notify-fiel] WhatsApp a ${phoneE164} falló:`, e instanceof Error ? e.message : e);
    }
  }
  return enviados;
}

export type MotivoFiel = "vencida" | "revocada";

export interface AvisoFielResult {
  notificados: number;
  whatsapp: number;
}

/**
 * La sincronización con el SAT falló porque la e.firma está vencida o el SAT
 * la rechaza como revocada (código 304). Un item por usuario con acceso a la
 * empresa (dedupeKey `fiel-invalida:<id>`), WhatsApp al crearlo, y un
 * recordatorio semanal mientras siga detenida.
 */
export async function notificarFielInvalida(
  companyId: string,
  opts: { motivo?: MotivoFiel; now?: Date } = {},
): Promise<AvisoFielResult> {
  const now = opts.now ?? new Date();
  const motivo = opts.motivo ?? "vencida";
  const { razonSocial, rfc, fielVigencia } = await datosEmpresa(companyId);
  const userIds = await usuariosConAccesoACompany(companyId);
  const empresa = `${razonSocial}${rfc ? ` (RFC ${rfc})` : ""}`;
  const causa =
    motivo === "revocada"
      ? "el SAT rechaza la e.firma (FIEL) como revocada o caduca (código 304). Suele pasar cuando se tramitó una e.firma nueva: sube los archivos .cer y .key vigentes en Mi Empresa."
      : `la e.firma (FIEL) ${fielVigencia ? `venció el ${fmtFecha(fielVigencia)}` : "es inválida o está vencida"}. Renueva tu e.firma en el SAT y vuelve a subir los archivos .cer y .key en la sección Mi Empresa.`;
  const titulo = `e.firma ${motivo === "revocada" ? "revocada por el SAT" : "vencida"} — ${razonSocial}`;
  const cuerpo = `La sincronización automática de CFDIs con el SAT para ${empresa} está detenida porque ${causa}`;
  // Va en {{1}} de la plantilla del resumen («…de Contabilidad OS: {{1}}. Responde…»):
  // sin prefijo de marca ni punto final, que la plantilla ya los pone.
  const linea = `la sincronización con el SAT de ${razonSocial} está detenida (e.firma ${motivo}); sube la e.firma vigente en Mi Empresa`;

  let notificados = 0;
  const nuevos: string[] = [];
  for (const userId of userIds) {
    try {
      const primera = await prisma.notificationItem.findUnique({
        where: { recipientUserId_dedupeKey: { recipientUserId: userId, dedupeKey: `fiel-invalida:${companyId}` } },
        select: { createdAt: true },
      });
      // Primer aviso, o recordatorio semanal a partir de la segunda semana.
      const semanal = primera != null && now.getTime() - primera.createdAt.getTime() >= 7 * 86_400_000;
      const dedupeKey = semanal ? `fiel-invalida:${companyId}:semana:${semanaIso(now)}` : `fiel-invalida:${companyId}`;
      const existia = semanal
        ? await prisma.notificationItem.findUnique({ where: { recipientUserId_dedupeKey: { recipientUserId: userId, dedupeKey } }, select: { id: true } })
        : primera;
      await registrarYNotificar({
        recipientUserId: userId,
        companyId,
        categoria: "otro",
        severidad: "error",
        titulo: semanal ? `Sigue detenida la sincronización con el SAT — ${razonSocial}` : titulo,
        cuerpo,
        url: "/empresa",
        dedupeKey,
        categoriaPush: "sistema",
      });
      notificados++;
      if (!existia) nuevos.push(userId);
    } catch (e) {
      console.error(`[notify-fiel] aviso fiel-invalida a ${userId} falló:`, e);
    }
  }
  const whatsapp = await whatsappA(nuevos, linea, companyId);
  return { notificados, whatsapp };
}

/**
 * La FIEL vence pronto (≤30 días). Un recordatorio por mes calendario por
 * usuario; dedupeKey `fiel-por-vencer:<id>:<YYYY-MM>`.
 */
export async function notificarFielPorVencer(
  companyId: string,
  validoHasta: Date,
  now: Date = new Date(),
): Promise<{ notificados: number }> {
  const { razonSocial, rfc } = await datosEmpresa(companyId);
  const userIds = await usuariosConAccesoACompany(companyId);
  const mes = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  let notificados = 0;
  for (const userId of userIds) {
    try {
      await registrarYNotificar({
        recipientUserId: userId,
        companyId,
        categoria: "otro",
        severidad: "warn",
        titulo: `e.firma por vencer — ${razonSocial}`,
        cuerpo:
          `La e.firma (FIEL) de ${razonSocial}${rfc ? ` (RFC ${rfc})` : ""} vence el ${fmtFecha(validoHasta)}. ` +
          "Renuévala en el SAT y actualiza los archivos .cer y .key en la sección Mi Empresa " +
          "para que la sincronización de CFDIs no se interrumpa.",
        url: "/empresa",
        dedupeKey: `fiel-por-vencer:${companyId}:${mes}`,
        categoriaPush: "sistema",
      });
      notificados++;
    } catch (e) {
      console.error(`[notify-fiel] aviso fiel-por-vencer a ${userId} falló:`, e);
    }
  }
  return { notificados };
}
