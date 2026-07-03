// ─────────────────────────────────────────────────────────────────────────────
// Briefing matutino — el "narrador" del contador AI. Una vez al día, por usuario,
// agrega TODO lo que importa de sus empresas (vencimientos próximos, hallazgos
// abiertos por severidad, estado de cuenta sin subir) en UN push priorizado y
// accionable (deep link), como si el contador te buscara en la mañana.
//
// Esta es la capa de DATOS (prisma/authz/push). La composición del mensaje es
// PURA y vive en `matutino-format.ts` (testeable sin DB). No usa LLM (costo ~0).
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import { empresasAccesiblesIds } from "@/lib/authz";
import { registrarYNotificar, fechaLocalMx } from "@/lib/notificaciones";
import {
  construirBriefing,
  construirRecordatorioEstadoCuenta,
  empresasConEstadoCuentaVencido,
  proximoVencimientoMensual,
  diasEntre,
  type EmpresaBriefing,
} from "./matutino-format";

export type { EmpresaBriefing, BriefingPush } from "./matutino-format";
export {
  construirBriefing,
  construirRecordatorioEstadoCuenta,
  empresasConEstadoCuentaVencido,
  proximoVencimientoMensual,
} from "./matutino-format";

/** Reúne los hechos por empresa accesible del usuario. */
export async function computeEmpresasBriefing(userId: string, hoy = new Date()): Promise<EmpresaBriefing[]> {
  const ids = await empresasAccesiblesIds(userId);
  if (ids.length === 0) return [];

  const [companies, hallazgos, bancos, ultimoMov] = await Promise.all([
    prisma.company.findMany({
      where: { id: { in: ids }, isActive: true },
      select: { id: true, razonSocial: true, regimenFiscal: true },
    }),
    prisma.fiscalHallazgo.groupBy({
      by: ["companyId", "severidad"],
      where: {
        companyId: { in: ids },
        estado: "ABIERTO",
        OR: [{ posponerHasta: null }, { posponerHasta: { lte: hoy } }],
      },
      _count: true,
    }),
    prisma.bankAccount.groupBy({ by: ["companyId"], where: { companyId: { in: ids } }, _count: true }),
    prisma.bankTransaction.groupBy({
      by: ["companyId"],
      where: { companyId: { in: ids } },
      _max: { fecha: true },
    }),
  ]);

  const hallazgosPorEmpresa = new Map<string, { abiertos: number; criticos: number }>();
  for (const g of hallazgos) {
    const cur = hallazgosPorEmpresa.get(g.companyId) ?? { abiertos: 0, criticos: 0 };
    cur.abiertos += g._count;
    if (g.severidad === "error") cur.criticos += g._count;
    hallazgosPorEmpresa.set(g.companyId, cur);
  }
  const conBanco = new Set(bancos.map((b) => b.companyId));
  const ultMov = new Map(ultimoMov.map((t) => [t.companyId, t._max.fecha]));

  return companies.map((c) => {
    const h = hallazgosPorEmpresa.get(c.id) ?? { abiertos: 0, criticos: 0 };
    const fecha = ultMov.get(c.id) ?? null;
    return {
      companyId: c.id,
      razonSocial: c.razonSocial,
      hallazgosAbiertos: h.abiertos,
      hallazgosCriticos: h.criticos,
      proxDeadline: proximoVencimientoMensual(c.regimenFiscal, hoy),
      tieneBanco: conBanco.has(c.id),
      diasSinMovimiento: fecha ? Math.max(0, diasEntre(hoy, fecha)) : null,
    };
  });
}

/** Envía el briefing + el recordatorio de estado de cuenta a un usuario. */
export async function enviarBriefingUsuario(
  userId: string,
  hoy = new Date()
): Promise<{ briefing: boolean; recordatorio: boolean }> {
  const empresas = await computeEmpresasBriefing(userId, hoy);

  const brief = construirBriefing(empresas);
  const rec = construirRecordatorioEstadoCuenta(empresasConEstadoCuentaVencido(empresas));

  // Digest DIARIO intencional: el dedupeKey va fechado (día local de México) y
  // el push se reserva a la creación (`pushSoloAlCrear`). Así el briefing empuja
  // EXACTAMENTE una vez al día aunque el contenido no cambie entre días (con la
  // clave estática de antes, la regla "sin novedad → sin push" lo silenciaría),
  // y un re-corrido del cron el mismo día sólo refresca el item, sin re-push.
  const dia = fechaLocalMx(hoy);

  let briefing = false;
  let recordatorio = false;
  if (brief) {
    // Pendiente a nivel cartera (agrega varias empresas): sin companyId único.
    const r = await registrarYNotificar({
      recipientUserId: userId,
      categoria: "briefing",
      severidad: "info",
      titulo: brief.title,
      cuerpo: brief.body,
      url: brief.url,
      dedupeKey: `briefing-matutino:${dia}`,
      categoriaPush: "revision",
      pushSoloAlCrear: true,
    });
    briefing = r.pushSent;
  }
  if (rec) {
    const r = await registrarYNotificar({
      recipientUserId: userId,
      categoria: "estado_cuenta",
      severidad: "warn",
      titulo: rec.title,
      cuerpo: rec.body,
      url: rec.url,
      dedupeKey: `estado-cuenta:${dia}`,
      categoriaPush: "revision",
      pushSoloAlCrear: true,
    });
    recordatorio = r.pushSent;
  }
  return { briefing, recordatorio };
}

/** Corre el briefing para todos los usuarios con suscripción push. Best-effort. */
export async function enviarBriefingTodos(): Promise<{ usuarios: number; briefings: number; recordatorios: number }> {
  const subs = await prisma.pushSubscription.findMany({ select: { userId: true }, distinct: ["userId"] });
  let briefings = 0;
  let recordatorios = 0;
  for (const { userId } of subs) {
    try {
      const r = await enviarBriefingUsuario(userId);
      if (r.briefing) briefings++;
      if (r.recordatorio) recordatorios++;
    } catch {
      // no romper el lote por un usuario
    }
  }
  return { usuarios: subs.length, briefings, recordatorios };
}
