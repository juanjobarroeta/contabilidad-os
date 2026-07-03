import { prisma } from "./prisma";
import { registrarYNotificar } from "./notificaciones";
import { usuariosConAccesoACompany } from "./push";

// ─────────────────────────────────────────────────────────────────────────────
// Avisos de e.firma (FIEL): vencida/inválida y por vencer.
//
// Una FIEL vencida detiene la descarga masiva de CFDIs SIN que nadie se entere:
// el cron sat-sync acumula el error, responde 200 y `lastAutoSyncAt` deja de
// avanzar. Estos avisos hacen visible el problema a TODOS los que operan la
// empresa (miembros + despacho + operadores), persistidos en el inbox de
// Pendientes con push. La idempotencia es por (usuario, dedupeKey):
//
//   - fiel-invalida:<companyId>            — mientras siga rota, un re-disparo
//     de algo VISTO vuelve a NUEVO (state machine de notificaciones); HECHO y
//     POSPUESTO vigente se respetan, así que no hay spam.
//   - fiel-por-vencer:<companyId>:<YYYY-MM> — un recordatorio por mes mientras
//     se acerque el vencimiento.
//
// Best-effort: nunca deben romper el cron que los dispara.
// ─────────────────────────────────────────────────────────────────────────────

const fmtFecha = (d: Date) =>
  d.toLocaleDateString("es-MX", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "America/Mexico_City" });

async function datosEmpresa(companyId: string) {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { razonSocial: true, rfc: true },
  });
  return company ?? { razonSocial: "tu empresa", rfc: "" };
}

/**
 * La sincronización con el SAT falló porque la FIEL es inválida o está vencida.
 * Un item por usuario con acceso a la empresa; dedupeKey `fiel-invalida:<id>`.
 */
export async function notificarFielInvalida(companyId: string): Promise<{ notificados: number }> {
  const { razonSocial, rfc } = await datosEmpresa(companyId);
  const userIds = await usuariosConAccesoACompany(companyId);

  let notificados = 0;
  for (const userId of userIds) {
    try {
      await registrarYNotificar({
        recipientUserId: userId,
        companyId,
        categoria: "otro",
        severidad: "error",
        titulo: `e.firma vencida o inválida — ${razonSocial}`,
        cuerpo:
          `La sincronización automática de CFDIs con el SAT para ${razonSocial}` +
          `${rfc ? ` (RFC ${rfc})` : ""} está detenida porque la e.firma (FIEL) es inválida o está vencida. ` +
          "Renueva tu e.firma en el SAT y vuelve a subir los archivos .cer y .key en la sección Mi Empresa.",
        url: "/empresa",
        dedupeKey: `fiel-invalida:${companyId}`,
        categoriaPush: "sistema",
      });
      notificados++;
    } catch (e) {
      console.error(`[notify-fiel] aviso fiel-invalida a ${userId} falló:`, e);
    }
  }
  return { notificados };
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
