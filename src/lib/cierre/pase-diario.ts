// ─────────────────────────────────────────────────────────────────────────────
// EL PASE DIARIO — parte con base de datos. Para cada empresa con cierre
// guiado y cada periodo en juego: evalúa, compara con el snapshot anterior,
// ranquea los deltas y los reparte por canal:
//   · inbox (NotificationItem, categoría «cierre», dedupeKey sin fecha por
//     delta: el mismo delta no re-empuja; HECHO se respeta),
//   · chat del periodo (mensaje del asistente en la conversación modo=cierre),
//   · push sólo si merece interrumpir (vencimiento o bloqueo),
//   · WhatsApp: NO manda mensaje propio — deja el aviso en CierreAviso y el
//     digest matutino lo recoge (un mensaje al día, como hoy).
// Sin modelo: costo cero. Cada aviso queda en CierreAviso para medir precisión.
// ─────────────────────────────────────────────────────────────────────────────

import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { registrarBitacora } from "../audit";
import { fechaLocalMx, registrarYNotificar } from "../notificaciones";
import { usuariosConAccesoACompany } from "../push";
import { effectiveCierrePlan, planIncluyeCierreGuiado } from "../planes";
import { diffCierre, meritaPush, rankDeltas, type Delta } from "./avance";
import { cargarHechosCierre, sincronizarCierre } from "./evaluar";
import { etiquetaPeriodo, redactarAviso } from "./plantillas";
import { decidirPasos, periodoStr, periodosEnJuego, type PasoEvaluado } from "./workflow";

export const MAX_AVISOS_POR_PERIODO = 5;

export interface ResultadoAvanceEmpresa {
  companyId: string;
  periodos: { periodo: string; deltas: number; avisos: number; mejoras: number }[];
}

/** Empresas activas con el cierre guiado en su plan (propio o heredado). */
export async function empresasConCierreGuiado(): Promise<{ id: string; razonSocial: string }[]> {
  const rows = await prisma.company.findMany({
    where: { isActive: true },
    select: { id: true, razonSocial: true, tier: true, despacho: { select: { defaultTier: true } } },
  });
  return rows.filter((c) => planIncluyeCierreGuiado(effectiveCierrePlan(c))).map((c) => ({ id: c.id, razonSocial: c.razonSocial }));
}

/** A quién van los avisos: el responsable del cierre o, si nadie lo tomó, todos los miembros. */
async function destinatarios(companyId: string, responsableUserId: string | null): Promise<string[]> {
  if (responsableUserId) return [responsableUserId];
  return usuariosConAccesoACompany(companyId);
}

/** Dueño de la conversación del periodo: el responsable o el OWNER de la empresa. */
async function duenoConversacion(companyId: string, responsableUserId: string | null): Promise<string | null> {
  if (responsableUserId) return responsableUserId;
  const owner = await prisma.companyMember.findFirst({
    where: { companyId, role: "OWNER" },
    orderBy: { createdAt: "asc" },
    select: { userId: true },
  });
  if (owner) return owner.userId;
  const alguien = await prisma.companyMember.findFirst({ where: { companyId }, orderBy: { createdAt: "asc" }, select: { userId: true } });
  return alguien?.userId ?? null;
}

/** La conversación modo=cierre del periodo, creada perezosamente. */
export async function conversacionDelPeriodo(
  companyId: string,
  year: number,
  month: number,
  responsableUserId: string | null
): Promise<string | null> {
  const periodo = periodoStr(year, month);
  const cierre = await prisma.cierrePeriodo.findUnique({
    where: { companyId_year_month: { companyId, year, month } },
    select: { id: true, conversationId: true },
  });
  if (cierre?.conversationId) return cierre.conversationId;
  const userId = await duenoConversacion(companyId, responsableUserId);
  if (!userId) return null;
  const conv = await prisma.chatConversation.create({
    data: {
      companyId,
      userId,
      title: `Cierre de ${etiquetaPeriodo(year, month)}`,
      visibility: "COMPANY",
      modo: "cierre",
      periodo,
    },
    select: { id: true },
  });
  if (cierre) {
    await prisma.cierrePeriodo.update({ where: { id: cierre.id }, data: { conversationId: conv.id } });
  }
  return conv.id;
}

async function publicarEnChat(conversationId: string, d: Delta, aviso: { titulo: string; cuerpo: string }, url: string) {
  await prisma.chatMessage.create({
    data: {
      conversationId,
      role: "assistant",
      authorId: null,
      content: `**${aviso.titulo}**\n\n${aviso.cuerpo}\n\n[${d.cta.label}](${url})`,
      meta: { origen: "avance", cierre: { paso: d.paso, deltaKey: d.deltaKey } } as Prisma.InputJsonValue,
    },
  });
  await prisma.chatConversation.update({ where: { id: conversationId }, data: { updatedAt: new Date(), pasoActivo: d.paso } });
}

/**
 * Avanza el cierre de UNA empresa: evalúa cada periodo en juego, avisa los
 * deltas y guarda el snapshot como baseline de mañana.
 */
export async function avanzarCierreEmpresa(
  company: { id: string; razonSocial: string },
  hoy: Date = new Date()
): Promise<ResultadoAvanceEmpresa> {
  const abiertos = await prisma.cierrePeriodo.findMany({
    where: { companyId: company.id, cerradoAt: null },
    select: { year: true, month: true },
  });
  const periodos = periodosEnJuego(hoy, abiertos);
  const out: ResultadoAvanceEmpresa = { companyId: company.id, periodos: [] };

  for (const { year, month } of periodos) {
    const periodo = periodoStr(year, month);
    const hechos = await cargarHechosCierre(company.id, year, month, hoy);
    const evaluados = decidirPasos(hechos);
    const cierre = await sincronizarCierre(company.id, year, month, evaluados);
    const fila = await prisma.cierrePeriodo.findUniqueOrThrow({
      where: { companyId_year_month: { companyId: company.id, year, month } },
      select: { id: true, snapshotAvance: true, responsableUserId: true, cerradoAt: true },
    });
    if (fila.cerradoAt) {
      out.periodos.push({ periodo, deltas: 0, avisos: 0, mejoras: 0 });
      continue;
    }

    const prev = (fila.snapshotAvance as unknown as PasoEvaluado[] | null) ?? null;
    const deltas = diffCierre(prev, evaluados);
    const mejoras = deltas.filter((d) => d.direccion === "mejoro");
    const avisar = rankDeltas(deltas, { max: MAX_AVISOS_POR_PERIODO });

    // Lo que mejoró cierra los avisos anteriores de ese paso (precisión del pase).
    if (mejoras.length > 0) {
      await prisma.cierreAviso.updateMany({
        where: { companyId: company.id, periodo, paso: { in: mejoras.map((m) => m.paso) }, accionadoAt: null },
        data: { accionadoAt: hoy },
      });
    }

    let enviados = 0;
    if (avisar.length > 0) {
      const usuarios = await destinatarios(company.id, fila.responsableUserId);
      const conversationId = await conversacionDelPeriodo(company.id, year, month, fila.responsableUserId);
      for (const d of avisar) {
        const aviso = redactarAviso(d, { empresa: company.razonSocial, year, month });
        const url = `/cierre?y=${year}&m=${month}&paso=${d.paso}`;
        const canales: string[] = [];
        const push = meritaPush(d);
        for (const userId of usuarios) {
          try {
            const r = await registrarYNotificar(
              {
                recipientUserId: userId,
                companyId: company.id,
                categoria: "cierre",
                severidad: d.estadoAhora === "error" ? "error" : "warn",
                titulo: aviso.titulo,
                cuerpo: aviso.cuerpo,
                url,
                dedupeKey: `cierre:${company.id}:${periodo}:${d.deltaKey}`,
                categoriaPush: "declaraciones",
                abrirChat: false,
                sinPush: !push,
              },
              hoy
            );
            if (!canales.includes("inbox")) canales.push("inbox");
            if (r.pushSent && !canales.includes("push")) canales.push("push");
          } catch (e) {
            console.error("[cierre/avance] inbox falló:", company.id, userId, e instanceof Error ? e.message : e);
          }
        }
        if (conversationId) {
          try {
            await publicarEnChat(conversationId, d, aviso, url);
            canales.push("chat");
          } catch (e) {
            console.error("[cierre/avance] chat falló:", company.id, e instanceof Error ? e.message : e);
          }
        }
        canales.push("whatsapp"); // lo recoge el digest matutino
        await prisma.cierreAviso.create({
          data: {
            companyId: company.id,
            periodo,
            paso: d.paso,
            deltaKey: d.deltaKey,
            canales,
            plantilla: true,
            titulo: aviso.titulo,
            cuerpo: aviso.cuerpo,
            enviadoAt: hoy,
          },
        });
        enviados++;
      }
      registrarBitacora({
        companyId: company.id,
        accion: "cierre.aviso.enviar",
        entidad: "CierrePeriodo",
        entidadId: fila.id,
        detalle: { periodo, avisos: avisar.map((d) => d.deltaKey), destinatarios: usuarios.length },
      });
    }

    await prisma.cierrePeriodo.update({
      where: { id: fila.id },
      data: { snapshotAvance: evaluados as unknown as Prisma.InputJsonValue, ultimoAvanceAt: hoy },
    });
    void cierre;
    out.periodos.push({ periodo, deltas: deltas.length, avisos: enviados, mejoras: mejoras.length });
  }
  return out;
}

export interface ResultadoPaseDiario {
  empresas: number;
  procesadas: number;
  omitidasHoy: number;
  avisos: number;
  errores: number;
  resultados: (ResultadoAvanceEmpresa | { companyId: string; error: string })[];
}

/**
 * Corre el pase para todas las empresas con plan. Una vez al día por empresa
 * (día local de México): si `ultimoAvanceAt` ya es de hoy, se omite, salvo
 * `force`. `max` acota la corrida al maxDuration del handler; lo que quede
 * entra en el siguiente tick.
 */
export async function correrPaseDiario(opts: { hoy?: Date; force?: boolean; companyId?: string; max?: number } = {}): Promise<ResultadoPaseDiario> {
  const hoy = opts.hoy ?? new Date();
  const max = opts.max ?? 40;
  const todas = await empresasConCierreGuiado();
  const empresas = opts.companyId ? todas.filter((c) => c.id === opts.companyId) : todas;

  const hoyMx = fechaLocalMx(hoy);
  const ultimos = await prisma.cierrePeriodo.groupBy({
    by: ["companyId"],
    where: { companyId: { in: empresas.map((c) => c.id) } },
    _max: { ultimoAvanceAt: true },
  });
  const ultimoPor = new Map(ultimos.map((u) => [u.companyId, u._max.ultimoAvanceAt]));

  const r: ResultadoPaseDiario = { empresas: empresas.length, procesadas: 0, omitidasHoy: 0, avisos: 0, errores: 0, resultados: [] };
  for (const c of empresas) {
    if (r.procesadas >= max) break;
    const ultimo = ultimoPor.get(c.id);
    if (!opts.force && ultimo && fechaLocalMx(ultimo) === hoyMx) {
      r.omitidasHoy++;
      continue;
    }
    try {
      const res = await avanzarCierreEmpresa(c, hoy);
      r.procesadas++;
      r.avisos += res.periodos.reduce((s, p) => s + p.avisos, 0);
      r.resultados.push(res);
    } catch (e) {
      r.errores++;
      console.error("[cierre/avance] empresa falló:", c.id, e instanceof Error ? e.message : e);
      r.resultados.push({ companyId: c.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return r;
}

/**
 * Líneas para el digest de WhatsApp de un usuario: los avisos de HOY (día MX)
 * de sus empresas, los más urgentes primero, máximo `max`.
 */
export async function lineasCierreParaDigest(
  companyIds: string[],
  hoy: Date = new Date(),
  max = 3
): Promise<{ empresa: string; linea: string }[]> {
  if (companyIds.length === 0) return [];
  const desde = new Date(`${fechaLocalMx(hoy)}T00:00:00-06:00`);
  const avisos = await prisma.cierreAviso.findMany({
    where: { companyId: { in: companyIds }, enviadoAt: { gte: desde }, accionadoAt: null },
    orderBy: { enviadoAt: "desc" },
    take: 50,
    select: { titulo: true, deltaKey: true, companyId: true },
  });
  const empresas = await prisma.company.findMany({ where: { id: { in: companyIds } }, select: { id: true, razonSocial: true } });
  const nombre = new Map(empresas.map((e) => [e.id, e.razonSocial]));
  const peso = (k: string) => (k.endsWith(".vencio") ? 0 : k.endsWith(".por_vencer") ? 1 : 2);
  return avisos
    .sort((a, b) => peso(a.deltaKey) - peso(b.deltaKey))
    .slice(0, max)
    .map((a) => ({ empresa: nombre.get(a.companyId) ?? "", linea: a.titulo }));
}

/**
 * Un aviso del inbox marcado HECHO → su fila de CierreAviso queda accionada.
 * dedupeKey = `cierre:<companyId>:<periodo>:<paso>.<senal>.<direccion>`.
 * Fire-and-forget: nunca lanza.
 */
export async function marcarAvisoCierreAccionado(dedupeKey: string, now: Date = new Date()): Promise<void> {
  try {
    const m = dedupeKey.match(/^cierre:([^:]+):(\d{4}-\d{2}):([a-z_]+)\./);
    if (!m) return;
    await prisma.cierreAviso.updateMany({
      where: { companyId: m[1], periodo: m[2], paso: m[3], accionadoAt: null },
      data: { accionadoAt: now },
    });
  } catch (e) {
    console.error("[cierre] accionado del aviso falló:", e instanceof Error ? e.message : e);
  }
}
