// ─────────────────────────────────────────────────────────────────────────────
// Seguimiento comercial de las cotizaciones (el «CRM»): a quién hay que llamar
// hoy, cuánto está en juego por etapa, cuánto se cierra y por qué se pierde.
//
// Todo es puro: recibe las cotizaciones del periodo ya leídas y devuelve el
// tablero. La ruta GET /cotizaciones/crm sólo lee y llama a `tableroCrm`.
// ─────────────────────────────────────────────────────────────────────────────

import type { Prisma, PrismaClient } from "@prisma/client";
import { r2 } from "./util";

/** Quienes pueden ser responsables: los usuarios del hospital (sólo id y nombre). */
export async function equipoComercial(db: PrismaClient | Prisma.TransactionClient, companyId: string) {
  const miembros = await db.companyMember.findMany({ where: { companyId }, select: { user: { select: { id: true, name: true, email: true } } } });
  return miembros.map((m) => ({ userId: m.user.id, nombre: m.user.name || m.user.email })).sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
}

export const TIPOS_SEGUIMIENTO = ["LLAMADA", "WHATSAPP", "CORREO", "VISITA", "NOTA"] as const;
export const RESULTADOS_SEGUIMIENTO = ["CONTESTO", "NO_CONTESTO", "INTERESADO", "LO_PENSARA", "RECHAZO"] as const;
export const ORIGENES_COTIZACION = ["MEDICO", "TELEFONO", "WHATSAPP", "ASEGURADORA", "RECOMENDACION", "REDES", "OTRO"] as const;
export const MOTIVOS_PERDIDA = ["PRECIO", "OTRO_HOSPITAL", "POSPUSO", "ASEGURADORA", "SIN_RESPUESTA", "OTRO"] as const;

/** Estados que todavía piden seguimiento (la aceptada, para agendar e ingresar). */
export const ABIERTAS = ["BORRADOR", "ENVIADA", "ACEPTADA"] as const;
const esAbierta = (e: string) => (ABIERTAS as readonly string[]).includes(e);

/** Días después de enviar en que toca el primer seguimiento, si nadie puso fecha. */
export const DIAS_PRIMER_SEGUIMIENTO = 2;

export interface CotizacionCrm {
  id: string;
  folio: string;
  estado: string;
  procedimiento: string;
  total: number;
  createdAt: Date;
  enviadaAt: Date | null;
  cerradaAt: Date | null;
  vigenciaHasta: Date | null;
  proximoSeguimiento: Date | null;
  responsableUserId: string | null;
  medico: { id: string; nombre: string } | null;
  para: string;
  contactoTelefono: string | null;
  origen: string | null;
  motivoPerdida: string | null;
  perdidaContra: string | null;
  ultimoSeguimiento: Date | null;
}

const inicioDia = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const dias = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 86_400_000;

/** Vencida por fecha aunque el estado no se haya movido. */
export function estadoVigente(c: Pick<CotizacionCrm, "estado" | "vigenciaHasta">, hoy: Date): string {
  return (c.estado === "BORRADOR" || c.estado === "ENVIADA") && c.vigenciaHasta && c.vigenciaHasta < inicioDia(hoy) ? "VENCIDA" : c.estado;
}

export type Urgencia = "VENCIDO" | "HOY" | "SIN_FECHA" | "PROXIMO";

/** Qué tan urgente es volver a contactar; null si ya no está abierta. */
export function urgencia(c: CotizacionCrm, hoy: Date): Urgencia | null {
  if (!esAbierta(estadoVigente(c, hoy))) return null;
  if (!c.proximoSeguimiento) return c.estado === "BORRADOR" ? null : "SIN_FECHA";
  const d = inicioDia(c.proximoSeguimiento).getTime();
  const h = inicioDia(hoy).getTime();
  return d < h ? "VENCIDO" : d === h ? "HOY" : "PROXIMO";
}

interface Grupo { clave: string; nombre: string; n: number; ganadas: number; perdidas: number; monto: number; montoGanado: number }

function agrupar(cs: CotizacionCrm[], clave: (c: CotizacionCrm) => { clave: string; nombre: string } | null, hoy: Date): Grupo[] {
  const m = new Map<string, Grupo>();
  for (const c of cs) {
    const k = clave(c);
    if (!k) continue;
    const g = m.get(k.clave) ?? { ...k, n: 0, ganadas: 0, perdidas: 0, monto: 0, montoGanado: 0 };
    const e = estadoVigente(c, hoy);
    g.n++;
    g.monto = r2(g.monto + c.total);
    if (e === "ACEPTADA" || e === "CONVERTIDA") { g.ganadas++; g.montoGanado = r2(g.montoGanado + c.total) }
    if (e === "PERDIDA" || e === "VENCIDA") g.perdidas++;
    m.set(k.clave, g);
  }
  return [...m.values()].sort((a, b) => b.n - a.n || b.monto - a.monto);
}

export function tableroCrm(cotizaciones: CotizacionCrm[], hoy = new Date()) {
  const cs = cotizaciones.map((c) => ({ ...c, estadoVigente: estadoVigente(c, hoy), urgencia: urgencia(c, hoy) }));
  const porEstado: Record<string, { n: number; monto: number }> = {};
  for (const c of cs) {
    const e = (porEstado[c.estadoVigente] ??= { n: 0, monto: 0 });
    e.n++;
    e.monto = r2(e.monto + c.total);
  }
  const ganadas = cs.filter((c) => c.estadoVigente === "ACEPTADA" || c.estadoVigente === "CONVERTIDA");
  const perdidas = cs.filter((c) => c.estadoVigente === "PERDIDA" || c.estadoVigente === "VENCIDA");
  // En juego: sin decidir. ACEPTADA ya cuenta como ganada (aunque se le siga dando seguimiento para agendar).
  const abiertas = cs.filter((c) => c.estadoVigente === "BORRADOR" || c.estadoVigente === "ENVIADA");
  const decididas = ganadas.length + perdidas.length;
  const cierres = ganadas.filter((c) => c.cerradaAt).map((c) => dias(c.enviadaAt ?? c.createdAt, c.cerradaAt!));
  const suma = (xs: typeof cs) => r2(xs.reduce((s, c) => s + c.total, 0));

  const motivos = new Map<string, number>();
  const contra = new Map<string, number>();
  for (const c of cs.filter((c) => c.estadoVigente === "PERDIDA")) {
    motivos.set(c.motivoPerdida ?? "SIN_MOTIVO", (motivos.get(c.motivoPerdida ?? "SIN_MOTIVO") ?? 0) + 1);
    if (c.perdidaContra?.trim()) contra.set(c.perdidaContra.trim(), (contra.get(c.perdidaContra.trim()) ?? 0) + 1);
  }
  const ordenar = (m: Map<string, number>) => [...m].map(([clave, n]) => ({ clave, n })).sort((a, b) => b.n - a.n);
  const orden: Record<Urgencia, number> = { VENCIDO: 0, HOY: 1, SIN_FECHA: 2, PROXIMO: 3 };

  return {
    kpis: {
      total: cs.length,
      abiertas: abiertas.length,
      montoAbierto: suma(abiertas),
      ganadas: ganadas.length,
      montoGanado: suma(ganadas),
      perdidas: perdidas.length,
      montoPerdido: suma(perdidas),
      /** Ganadas entre las ya decididas (ganadas + perdidas/vencidas); null sin decididas. */
      tasaCierre: decididas ? Math.round((ganadas.length / decididas) * 1000) / 10 : null,
      diasPromedioCierre: cierres.length ? Math.round((cierres.reduce((a, b) => a + b, 0) / cierres.length) * 10) / 10 : null,
      porSeguir: cs.filter((c) => c.urgencia === "VENCIDO" || c.urgencia === "HOY" || c.urgencia === "SIN_FECHA").length,
    },
    porEstado,
    porSeguir: cs
      .filter((c) => c.urgencia && c.urgencia !== "PROXIMO")
      .sort((a, b) => orden[a.urgencia!] - orden[b.urgencia!] || (a.proximoSeguimiento?.getTime() ?? 0) - (b.proximoSeguimiento?.getTime() ?? 0) || b.total - a.total),
    porMedico: agrupar(cs, (c) => (c.medico ? { clave: c.medico.id, nombre: c.medico.nombre } : null), hoy).slice(0, 15),
    porResponsable: agrupar(cs, (c) => ({ clave: c.responsableUserId ?? "SIN", nombre: c.responsableUserId ?? "Sin responsable" }), hoy),
    porOrigen: agrupar(cs, (c) => ({ clave: c.origen ?? "SIN", nombre: c.origen ?? "Sin origen" }), hoy),
    motivosPerdida: ordenar(motivos),
    perdidasContra: ordenar(contra),
    cotizaciones: cs,
  };
}
