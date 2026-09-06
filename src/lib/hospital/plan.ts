// ─────────────────────────────────────────────────────────────────────────────
// Plan de tratamiento (P3): cierra el ciclo consulta → plan → cotización →
// cirugía → cuenta.
//
// El plan es la propuesta económica y clínica para UN paciente: nace de un
// protocolo (partidas preciadas con el convenio del pagador —o el del
// paciente— vía `armarPartidas`, insumos al último costo, honorarios
// sugeridos) o de partidas explícitas, y guarda todo congelado en JSON:
// lo que se prometió no cambia porque cambie el tarifario después.
//
//   PROPUESTO ──▶ AUTORIZADO ──▶ EN_CURSO ──▶ CERRADO
//        └──────────┴──────────────┴──▶ CANCELADO
//
//   · AUTORIZADO exige `autorizacionPagador` cuando el pagador es ASEGURADORA
//     o EMPRESA (el número que dio la aseguradora).
//   · `cotizarPlan` crea la HospCotizacion (partidas + honorarios como
//     renglones HONORARIO, folio COT) y la liga: un plan, una cotización.
//   · `programarPlan` agenda el quirófano (HospCita, sin empalmes) y deja la
//     fecha en el plan; la cita lleva la referencia `plan:<id>` en sus notas
//     porque HospCita no tiene planId.
//   · Convertir la cotización (crearEpisodio) engancha el plan al episodio y
//     lo pone EN_CURSO; el alta lo CIERRA. Un plan CERRADO no se edita.
//   · Cancelar el plan cancela su cotización si sigue en BORRADOR/ENVIADA.
//   · `compararPlan` (pura) cruza la cuenta contra el plan: cargos ↔ partidas
//     por servicio, por médico (honorarios) o por categoría + descripción
//     normalizada; lo que no cuadra es «fuera de plan»; insumos planeados
//     contra aplicados (kardex del episodio).
// ─────────────────────────────────────────────────────────────────────────────

import { z } from "zod";
import type { HospCargoCategoria, HospCatalogoTipo, HospPagadorTipo, HospPlanEstado, Prisma, PrismaClient } from "@prisma/client";
import { HospitalError } from "./errores";
import { dinero, fechaSchema } from "./http";
import { nombreCompleto, r2 } from "./util";
import { resolverCie, type PacienteParaCie } from "./cie";
import { conFolioUnico, siguienteFolio } from "./folio";
import { incluyeCotizacion, partidaSchema } from "./cotizacion";
import { citaEmpalmada, describirEmpalme, incluyeCita, validarVinculosCita } from "./citas";
import {
  ROLES_HONORARIO,
  TIPOS_EPISODIO,
  costearInsumos,
  entradasDeProtocolo,
  preciarPartidas,
  type InsumoCosteado,
  type PartidaPreciada,
  type RolHonorario,
} from "./protocolo";
import { medicoResumen, pacienteResumen, pagadorResumen, recursoResumen } from "./serializar";

type Db = PrismaClient | Prisma.TransactionClient;
type Usuario = { id?: string | null; nombre: string } | null | undefined;

/** Arriba de esta desviación (en %) la cuenta «se salió del plan» (alerta del panel). */
export const DESVIACION_ALERTA_PCT = 15;
/** Duración de la cita de quirófano cuando ni el plan ni el protocolo la fijan. */
export const DURACION_DEFAULT_MINUTOS = 60;

// ── Lo que el plan guarda en JSON ────────────────────────────────────────────

export interface PlanPartida {
  orden: number;
  servicioId: string | null;
  categoria: HospCargoCategoria;
  descripcion: string;
  cantidad: number;
  precioUnitario: number;
  ivaTasa: number | null;
  /** cantidad × precio SIN IVA. */
  importe: number;
  opcional: boolean;
}

export interface PlanInsumo {
  insumoId: string;
  clave: string | null;
  nombre: string;
  unidad: string | null;
  cantidad: number;
  costoUnitario: number | null;
  opcional: boolean;
}

export interface PlanHonorario {
  medicoId: string | null;
  nombre: string;
  rol: RolHonorario;
  monto: number;
}

const aJson = (v: unknown) => v as Prisma.InputJsonValue;
const numero = (v: unknown, def = 0) => (v == null || v === "" || Number.isNaN(Number(v)) ? def : Number(v));

export function partidasDePlan(json: unknown): PlanPartida[] {
  if (!Array.isArray(json)) return [];
  return json.map((x, i) => {
    const p = (x ?? {}) as Record<string, unknown>;
    return {
      orden: numero(p.orden, i),
      servicioId: typeof p.servicioId === "string" ? p.servicioId : null,
      categoria: (p.categoria as HospCargoCategoria) ?? "OTRO",
      descripcion: String(p.descripcion ?? ""),
      cantidad: numero(p.cantidad, 1),
      precioUnitario: numero(p.precioUnitario),
      ivaTasa: p.ivaTasa == null ? null : Number(p.ivaTasa),
      importe: numero(p.importe),
      opcional: p.opcional === true,
    };
  });
}

export function insumosDePlan(json: unknown): PlanInsumo[] {
  if (!Array.isArray(json)) return [];
  return json.map((x) => {
    const p = (x ?? {}) as Record<string, unknown>;
    return {
      insumoId: String(p.insumoId ?? ""),
      clave: typeof p.clave === "string" ? p.clave : null,
      nombre: String(p.nombre ?? ""),
      unidad: typeof p.unidad === "string" ? p.unidad : null,
      cantidad: numero(p.cantidad),
      costoUnitario: p.costoUnitario == null ? null : Number(p.costoUnitario),
      opcional: p.opcional === true,
    };
  });
}

export function honorariosDePlan(json: unknown): PlanHonorario[] {
  if (!Array.isArray(json)) return [];
  return json.map((x) => {
    const p = (x ?? {}) as Record<string, unknown>;
    const rol = ROLES_HONORARIO.includes(p.rol as RolHonorario) ? (p.rol as RolHonorario) : "CIRUJANO";
    return { medicoId: typeof p.medicoId === "string" ? p.medicoId : null, nombre: String(p.nombre ?? ""), rol, monto: numero(p.monto) };
  });
}

// ── Esquemas ─────────────────────────────────────────────────────────────────

export const PLAN_ESTADOS = ["PROPUESTO", "AUTORIZADO", "EN_CURSO", "CERRADO", "CANCELADO"] as const;

export const planPartidaSchema = partidaSchema.extend({ opcional: z.boolean().default(false) });
export const planInsumoSchema = z.object({
  insumoId: z.string().min(1),
  cantidad: z.number().positive().max(100000),
  opcional: z.boolean().default(false),
});
export const planHonorarioSchema = z.object({
  medicoId: z.string().nullable().optional(),
  nombre: z.string().max(200).nullable().optional(),
  rol: z.enum(ROLES_HONORARIO),
  monto: dinero,
});

export const planCamposSchema = z.object({
  pacienteId: z.string().min(1),
  protocoloId: z.string().nullable().optional(),
  /** undefined = el convenio del paciente; null = sin convenio (particular). */
  pagadorId: z.string().nullable().optional(),
  medicoId: z.string().nullable().optional(),
  anestesiologoId: z.string().nullable().optional(),
  recursoId: z.string().nullable().optional(),
  /** Obligatorio cuando no hay protocolo. */
  nombre: z.string().min(1).max(200).optional(),
  procedimientoCie9: z.string().max(10).nullable().optional(),
  diagnosticoCie10: z.string().max(10).nullable().optional(),
  tipoEpisodio: z.enum(TIPOS_EPISODIO).optional(),
  estanciaNoches: z.number().int().min(0).max(365).optional(),
  quirofanoMinutos: z.number().int().positive().max(1440).nullable().optional(),
  tipoAnestesia: z.number().int().min(1).max(6).nullable().optional(),
  fechaProgramada: fechaSchema.nullable().optional(),
  /** Sin partidas → las del protocolo preciadas con el convenio; explícitas mandan. */
  partidas: z.array(planPartidaSchema).max(200).optional(),
  insumos: z.array(planInsumoSchema).max(200).optional(),
  /** Sin honorarios → los del protocolo para los médicos dados. */
  honorarios: z.array(planHonorarioSchema).max(20).optional(),
  notas: z.string().max(4000).nullable().optional(),
  autorizacionPagador: z.string().max(80).nullable().optional(),
});
export type PlanCampos = z.infer<typeof planCamposSchema>;

export const planPatchSchema = planCamposSchema
  .omit({ pacienteId: true, protocoloId: true })
  .partial()
  .extend({
    /** EN_CURSO y CERRADO los ponen los flujos (convertir, alta), no el PATCH. */
    estado: z.enum(["PROPUESTO", "AUTORIZADO", "CANCELADO"]).optional(),
    /** Liga un episodio abierto sin cotización de por medio (pasa a EN_CURSO; CERRADO si ya es ALTA). */
    episodioId: z.string().nullable().optional(),
  });
export type PlanPatch = z.infer<typeof planPatchSchema>;

// ── Reglas puras ─────────────────────────────────────────────────────────────

export const ETIQUETA_ROL: Record<RolHonorario, string> = {
  CIRUJANO: "cirujano",
  ANESTESIOLOGO: "anestesiólogo",
  AYUDANTE: "ayudante",
};

/** Renglón con el que un honorario del plan viaja a la cotización y se reconoce en la cuenta. */
export function descripcionHonorario(h: { rol: RolHonorario; nombre: string }): string {
  return `Honorarios ${ETIQUETA_ROL[h.rol]} · ${h.nombre}`;
}

/**
 * Totales del plan: las partidas con su IVA por renglón (null = exento) más
 * los honorarios, exentos (Art. 15-XIV LIVA), en el subtotal — igual que la
 * cuenta, que los suma y luego los separa.
 */
export function totalesPlan(partidas: PlanPartida[], honorarios: PlanHonorario[]) {
  const subtotalPartidas = r2(partidas.reduce((s, p) => s + p.importe, 0));
  const iva = r2(partidas.reduce((s, p) => s + (p.ivaTasa == null ? 0 : r2(p.importe * p.ivaTasa)), 0));
  const honor = r2(honorarios.reduce((s, h) => s + h.monto, 0));
  const subtotal = r2(subtotalPartidas + honor);
  return { subtotal, iva, total: r2(subtotal + iva), honorarios: honor };
}

export const TRANSICIONES_PLAN: Record<HospPlanEstado, HospPlanEstado[]> = {
  PROPUESTO: ["AUTORIZADO", "CANCELADO"],
  AUTORIZADO: ["PROPUESTO", "CANCELADO"],
  EN_CURSO: ["CANCELADO"],
  CERRADO: [],
  CANCELADO: [],
};

/** Motivo por el que el plan ya no se edita, o null si sigue vivo. */
export function errorPlanInmutable(estado: HospPlanEstado): string | null {
  if (estado === "CERRADO") return "El plan está cerrado: la cuenta del episodio es la verdad y el plan ya no se edita";
  if (estado === "CANCELADO") return "El plan está cancelado";
  return null;
}

export function errorTransicionPlan(de: HospPlanEstado, a: HospPlanEstado): string | null {
  if (de === a) return null;
  if (TRANSICIONES_PLAN[de].includes(a)) return null;
  return `De ${de} no se pasa a ${a} (permitido: ${TRANSICIONES_PLAN[de].join(", ") || "ninguno"})`;
}

/** Aseguradoras y empresas autorizan por escrito; particulares y gobierno no. */
export function exigeAutorizacion(tipo: HospPagadorTipo | null | undefined): boolean {
  return tipo === "ASEGURADORA" || tipo === "EMPRESA";
}

export function faltaAutorizacion(tipo: HospPagadorTipo | null | undefined, autorizacion: string | null | undefined): boolean {
  return exigeAutorizacion(tipo) && !autorizacion?.trim();
}

/** Desviación de la cuenta contra el plan en %, positiva cuando la cuenta rebasa el plan; null sin plan. */
export function desviacionPct(planTotal: number, realTotal: number): number | null {
  if (!(planTotal > 0)) return null;
  return r2(((realTotal - planTotal) / planTotal) * 100);
}

/** Honorarios que el plan hereda del protocolo para los médicos que ya se asignaron. */
export function honorariosDefault(args: {
  protocolo: { honorarioCirujano: unknown; honorarioAnestesiologo: unknown } | null | undefined;
  medico: { id: string; nombre: string } | null | undefined;
  anestesiologo: { id: string; nombre: string } | null | undefined;
}): PlanHonorario[] {
  const out: PlanHonorario[] = [];
  const cirujano = args.protocolo?.honorarioCirujano == null ? 0 : Number(args.protocolo.honorarioCirujano);
  const anest = args.protocolo?.honorarioAnestesiologo == null ? 0 : Number(args.protocolo.honorarioAnestesiologo);
  if (args.medico && cirujano > 0) out.push({ medicoId: args.medico.id, nombre: args.medico.nombre, rol: "CIRUJANO", monto: r2(cirujano) });
  if (args.anestesiologo && anest > 0) out.push({ medicoId: args.anestesiologo.id, nombre: args.anestesiologo.nombre, rol: "ANESTESIOLOGO", monto: r2(anest) });
  return out;
}

/** Partidas de la cotización que nace del plan: las del plan (opcionales marcadas) + un renglón HONORARIO por médico. */
export function partidasParaCotizacion(partidas: PlanPartida[], honorarios: PlanHonorario[]) {
  const base = partidas.map((p, i) => ({
    orden: i,
    servicioId: p.servicioId,
    categoria: p.categoria,
    descripcion: p.opcional ? `${p.descripcion} (opcional)` : p.descripcion,
    cantidad: p.cantidad,
    precioUnitario: p.precioUnitario,
    ivaTasa: p.ivaTasa,
    importe: p.importe,
  }));
  const honor = honorarios.map((h, j) => ({
    orden: base.length + j,
    servicioId: null as string | null,
    categoria: "HONORARIO" as HospCargoCategoria,
    descripcion: descripcionHonorario(h),
    cantidad: 1,
    precioUnitario: h.monto,
    ivaTasa: null as number | null,
    importe: h.monto,
  }));
  return [...base, ...honor];
}

export function aPlanPartida(p: PartidaPreciada): PlanPartida {
  return {
    orden: p.orden,
    servicioId: p.servicioId,
    categoria: p.categoria,
    descripcion: p.descripcion,
    cantidad: p.cantidad,
    precioUnitario: p.precioUnitario,
    ivaTasa: p.ivaTasa,
    importe: p.importe,
    opcional: p.opcional,
  };
}

export function aPlanInsumo(x: InsumoCosteado): PlanInsumo {
  return { insumoId: x.insumoId, clave: x.clave, nombre: x.nombre, unidad: x.unidad, cantidad: x.cantidad, costoUnitario: x.costoUnitario, opcional: x.opcional };
}

// ── Comparativo plan ↔ cuenta (puro) ─────────────────────────────────────────

/** «Habitación Estándar · 13 y 14 ago» → «habitacion estandar · 13 y 14 ago». */
export function normalizarDescripcion(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** El cargo «es» la partida si lleva su descripción y luego un calificador (« · lote», «(opcional)»…). */
function empiezaCon(cargoNorm: string, partidaNorm: string): boolean {
  if (!partidaNorm || !cargoNorm.startsWith(partidaNorm)) return false;
  const resto = cargoNorm.slice(partidaNorm.length);
  return resto === "" || /^\s*[·(\-–—,:]/.test(resto);
}

export interface CargoComparable {
  id: string;
  fecha: Date | string;
  categoria: HospCargoCategoria;
  descripcion: string;
  cantidad: number;
  /** Sin IVA. */
  importe: number;
  ivaTasa: number | null;
  servicioId?: string | null;
  medicoId?: string | null;
  origen: string;
  cancelado?: boolean;
}

/** Movimiento del kardex del episodio: SALIDA_APLICACION negativa, DEVOLUCION positiva. */
export interface MovimientoComparable {
  insumoId: string;
  nombre: string;
  clave?: string | null;
  unidad?: string | null;
  cantidad: number;
  costoUnitario: number | null;
}

export interface FilaComparativo {
  tipo: "PARTIDA" | "HONORARIO";
  servicioId: string | null;
  medicoId: string | null;
  categoria: HospCargoCategoria;
  descripcion: string;
  opcional: boolean;
  planCantidad: number;
  planImporte: number;
  realCantidad: number;
  realImporte: number;
  /** realImporte − planImporte (sin IVA). */
  desviacion: number;
  cargos: string[];
}

export interface CargoFueraDePlan {
  id: string;
  fecha: Date | string;
  categoria: HospCargoCategoria;
  descripcion: string;
  cantidad: number;
  importe: number;
  iva: number;
  total: number;
  origen: string;
  medicoId: string | null;
}

export interface Comparativo {
  partidas: FilaComparativo[];
  fueraDePlan: CargoFueraDePlan[];
  porCategoria: Array<{ categoria: HospCargoCategoria; planImporte: number; realImporte: number; desviacion: number }>;
  resumen: {
    planSubtotal: number;
    planTotal: number;
    realSubtotal: number;
    realTotal: number;
    /** realTotal − planTotal (con IVA). */
    desviacion: number;
    desviacionPct: number | null;
    /** Σ importe (sin IVA) de los cargos sin partida planeada. */
    fueraDePlan: number;
    /** Σ planImporte de las partidas que aún no tienen cargo. */
    sinAplicar: number;
    cargos: number;
  };
  insumos: {
    planeados: Array<PlanInsumo & { costo: number; aplicado: number; costoAplicado: number; desviacion: number }>;
    aplicados: Array<{ insumoId: string; nombre: string; clave: string | null; unidad: string | null; cantidad: number; costo: number; planeado: boolean }>;
    resumen: { costoPlaneado: number; costoAplicado: number; noPlaneados: number };
  };
}

type FilaInterna = FilaComparativo & { clave: string; descNorm: string };

const r4 = (n: number) => Math.round(n * 10000) / 10000;

export function compararPlan(args: {
  plan: { partidas: PlanPartida[]; honorarios: PlanHonorario[]; insumos: PlanInsumo[]; subtotal: number; total: number };
  cargos: CargoComparable[];
  movimientos: MovimientoComparable[];
}): Comparativo {
  const filas: FilaInterna[] = [];
  const porClave = new Map<string, FilaInterna>();
  const agregar = (clave: string, base: Omit<FilaInterna, "clave" | "realCantidad" | "realImporte" | "desviacion" | "cargos">) => {
    const previa = porClave.get(clave);
    if (previa) {
      previa.planCantidad += base.planCantidad;
      previa.planImporte += base.planImporte;
      previa.opcional = previa.opcional && base.opcional;
      return;
    }
    const fila: FilaInterna = { ...base, clave, realCantidad: 0, realImporte: 0, desviacion: 0, cargos: [] };
    porClave.set(clave, fila);
    filas.push(fila);
  };
  for (const p of args.plan.partidas) {
    const descNorm = normalizarDescripcion(p.descripcion);
    agregar(p.servicioId ? `servicio:${p.servicioId}` : `desc:${p.categoria}|${descNorm}`, {
      tipo: "PARTIDA",
      servicioId: p.servicioId,
      medicoId: null,
      categoria: p.categoria,
      descripcion: p.descripcion,
      descNorm,
      opcional: p.opcional,
      planCantidad: p.cantidad,
      planImporte: p.importe,
    });
  }
  for (const h of args.plan.honorarios) {
    const descripcion = descripcionHonorario(h);
    const descNorm = normalizarDescripcion(descripcion);
    agregar(h.medicoId ? `medico:${h.medicoId}` : `desc:HONORARIO|${descNorm}`, {
      tipo: "HONORARIO",
      servicioId: null,
      medicoId: h.medicoId,
      categoria: "HONORARIO",
      descripcion,
      descNorm,
      opcional: false,
      planCantidad: 1,
      planImporte: h.monto,
    });
  }
  const porServicio = new Map(filas.filter((f) => f.servicioId).map((f) => [f.servicioId!, f]));
  const porMedico = new Map(filas.filter((f) => f.medicoId).map((f) => [f.medicoId!, f]));
  const porDesc = new Map(filas.map((f) => [`${f.categoria}|${f.descNorm}`, f]));

  const fueraDePlan: CargoFueraDePlan[] = [];
  let realSubtotal = 0;
  let realTotal = 0;
  let cargosVivos = 0;
  for (const c of args.cargos) {
    if (c.cancelado) continue;
    cargosVivos++;
    const importe = r2(Number(c.importe));
    const iva = c.ivaTasa == null ? 0 : r2(importe * Number(c.ivaTasa));
    const total = r2(importe + iva);
    realSubtotal += importe;
    realTotal += total;

    const norm = normalizarDescripcion(c.descripcion);
    let fila: FilaInterna | undefined;
    if (c.categoria === "HONORARIO" && c.medicoId) fila = porMedico.get(c.medicoId);
    if (!fila && c.servicioId) fila = porServicio.get(c.servicioId);
    if (!fila) fila = porDesc.get(`${c.categoria}|${norm}`);
    if (!fila) fila = filas.find((f) => f.categoria === c.categoria && empiezaCon(norm, f.descNorm));
    if (fila) {
      fila.realCantidad += Number(c.cantidad);
      fila.realImporte += importe;
      fila.cargos.push(c.id);
    } else {
      fueraDePlan.push({
        id: c.id,
        fecha: c.fecha,
        categoria: c.categoria,
        descripcion: c.descripcion,
        cantidad: Number(c.cantidad),
        importe,
        iva,
        total,
        origen: c.origen,
        medicoId: c.medicoId ?? null,
      });
    }
  }

  const partidas: FilaComparativo[] = filas.map(({ clave: _c, descNorm: _d, ...f }) => ({
    ...f,
    planCantidad: r4(f.planCantidad),
    planImporte: r2(f.planImporte),
    realCantidad: r4(f.realCantidad),
    realImporte: r2(f.realImporte),
    desviacion: r2(f.realImporte - f.planImporte),
  }));

  const categorias = new Map<HospCargoCategoria, { planImporte: number; realImporte: number }>();
  const acumular = (categoria: HospCargoCategoria, plan: number, real: number) => {
    const c = categorias.get(categoria) ?? { planImporte: 0, realImporte: 0 };
    c.planImporte += plan;
    c.realImporte += real;
    categorias.set(categoria, c);
  };
  for (const f of partidas) acumular(f.categoria, f.planImporte, f.realImporte);
  for (const c of fueraDePlan) acumular(c.categoria, 0, c.importe);
  const porCategoria = [...categorias.entries()].map(([categoria, c]) => ({
    categoria,
    planImporte: r2(c.planImporte),
    realImporte: r2(c.realImporte),
    desviacion: r2(c.realImporte - c.planImporte),
  }));

  const planTotal = r2(args.plan.total);
  realSubtotal = r2(realSubtotal);
  realTotal = r2(realTotal);

  // Insumos: lo aplicado sale del kardex (salidas negativas, devoluciones positivas).
  const aplicadoPor = new Map<string, Comparativo["insumos"]["aplicados"][number]>();
  for (const m of args.movimientos) {
    const salida = -Number(m.cantidad);
    const a = aplicadoPor.get(m.insumoId) ?? { insumoId: m.insumoId, nombre: m.nombre, clave: m.clave ?? null, unidad: m.unidad ?? null, cantidad: 0, costo: 0, planeado: false };
    a.cantidad += salida;
    a.costo += salida * (m.costoUnitario ?? 0);
    aplicadoPor.set(m.insumoId, a);
  }
  const planeadosIds = new Set(args.plan.insumos.map((i) => i.insumoId));
  const planeados = args.plan.insumos.map((i) => {
    const a = aplicadoPor.get(i.insumoId);
    const aplicado = r4(a?.cantidad ?? 0);
    return {
      ...i,
      costo: r2(i.cantidad * (i.costoUnitario ?? 0)),
      aplicado,
      costoAplicado: r2(a?.costo ?? 0),
      desviacion: r4(aplicado - i.cantidad),
    };
  });
  const aplicados = [...aplicadoPor.values()]
    .filter((a) => a.cantidad !== 0)
    .map((a) => ({ ...a, cantidad: r4(a.cantidad), costo: r2(a.costo), planeado: planeadosIds.has(a.insumoId) }));

  return {
    partidas,
    fueraDePlan,
    porCategoria,
    resumen: {
      planSubtotal: r2(args.plan.subtotal),
      planTotal,
      realSubtotal,
      realTotal,
      desviacion: r2(realTotal - planTotal),
      desviacionPct: desviacionPct(planTotal, realTotal),
      fueraDePlan: r2(fueraDePlan.reduce((s, c) => s + c.importe, 0)),
      sinAplicar: r2(partidas.filter((f) => f.realCantidad === 0).reduce((s, f) => s + f.planImporte, 0)),
      cargos: cargosVivos,
    },
    insumos: {
      planeados,
      aplicados,
      resumen: {
        costoPlaneado: r2(planeados.reduce((s, i) => s + i.costo, 0)),
        costoAplicado: r2(aplicados.reduce((s, a) => s + a.costo, 0)),
        noPlaneados: aplicados.filter((a) => !a.planeado).length,
      },
    },
  };
}

// ── Forma de respuesta ───────────────────────────────────────────────────────

export const incluyePlan = {
  paciente: { select: { id: true, nombre: true, apellidoPaterno: true, apellidoMaterno: true, fechaNacimiento: true, sexo: true, curp: true, telefono: true } },
  protocolo: { select: { id: true, clave: true, nombre: true, version: true, activo: true } },
  medico: { select: { id: true, nombre: true, especialidad: true } },
  anestesiologo: { select: { id: true, nombre: true, especialidad: true } },
  pagador: { select: { id: true, nombre: true, tipo: true, tabulador: true, deducible: true, coaseguroPct: true, plazoDias: true, topeAutorizacion: true } },
  recurso: { select: { id: true, tipo: true, area: true, nombre: true, estado: true } },
  cotizacion: { select: { id: true, folio: true, estado: true, total: true } },
  episodio: { select: { id: true, folio: true, estado: true, fechaIngreso: true, fechaAlta: true } },
} as const;

export type PlanConRelaciones = Prisma.HospPlanTratamientoGetPayload<{ include: typeof incluyePlan }>;

export function serializarPlan(p: PlanConRelaciones, hoy: Date = new Date()) {
  const { paciente, protocolo, medico, anestesiologo, pagador, recurso, cotizacion, episodio, partidas, insumos, honorarios, ...datos } = p;
  return {
    ...datos,
    subtotal: Number(p.subtotal),
    iva: Number(p.iva),
    total: Number(p.total),
    partidas: partidasDePlan(partidas).map((x) => {
      const iva = x.ivaTasa == null ? 0 : r2(x.importe * x.ivaTasa);
      return { ...x, iva, total: r2(x.importe + iva) };
    }),
    insumos: insumosDePlan(insumos),
    honorarios: honorariosDePlan(honorarios),
    paciente: pacienteResumen(paciente, hoy),
    protocolo,
    medico: medicoResumen(medico),
    anestesiologo: medicoResumen(anestesiologo),
    pagador: pagadorResumen(pagador),
    recurso: recursoResumen(recurso),
    cotizacion: cotizacion ? { ...cotizacion, total: Number(cotizacion.total) } : null,
    episodio,
  };
}

// ── Validación de vínculos ───────────────────────────────────────────────────

async function validarPagador(db: Db, companyId: string, pagadorId: string | null | undefined) {
  if (!pagadorId) return null;
  const p = await db.hospPagador.findUnique({ where: { id: pagadorId }, select: { id: true, companyId: true, nombre: true, tipo: true } });
  if (!p || p.companyId !== companyId) throw new HospitalError(400, "pagadorId inválido");
  return p;
}

async function validarMedico(db: Db, companyId: string, medicoId: string | null | undefined, campo: string) {
  if (!medicoId) return null;
  const m = await db.hospMedico.findUnique({ where: { id: medicoId }, select: { id: true, companyId: true, nombre: true } });
  if (!m || m.companyId !== companyId) throw new HospitalError(400, `${campo} inválido`);
  return m;
}

async function validarRecursoAgendable(db: Db, companyId: string, recursoId: string | null | undefined) {
  if (!recursoId) return null;
  const r = await db.hospRecurso.findUnique({ where: { id: recursoId }, select: { id: true, companyId: true, tipo: true, nombre: true, activo: true } });
  if (!r || r.companyId !== companyId) throw new HospitalError(400, "recursoId inválido");
  if (!r.activo) throw new HospitalError(409, `${r.nombre} está dado de baja`);
  if (r.tipo === "CAMA") throw new HospitalError(400, "El plan se programa en un quirófano, sala o consultorio, no en una cama");
  return r;
}

async function resolverHonorarios(db: Db, companyId: string, entradas: z.infer<typeof planHonorarioSchema>[]): Promise<PlanHonorario[]> {
  const ids = [...new Set(entradas.map((h) => h.medicoId).filter(Boolean))] as string[];
  const medicos = ids.length ? await db.hospMedico.findMany({ where: { id: { in: ids }, companyId }, select: { id: true, nombre: true } }) : [];
  const porId = new Map(medicos.map((m) => [m.id, m]));
  return entradas.map((h, i) => {
    const medico = h.medicoId ? porId.get(h.medicoId) : null;
    if (h.medicoId && !medico) throw new HospitalError(400, `medicoId inválido en el honorario ${i + 1}`);
    const nombre = h.nombre?.trim() || medico?.nombre;
    if (!nombre) throw new HospitalError(400, `El honorario ${i + 1} necesita medicoId o nombre`);
    return { medicoId: medico?.id ?? null, nombre, rol: h.rol, monto: r2(h.monto) };
  });
}

/** Código del plan en su forma clínica, cruzado con el paciente; null si no hay. */
async function resolverCodigoPlan(db: Db, tipo: HospCatalogoTipo, codigo: string | null | undefined, etiqueta: string, paciente: PacienteParaCie, hoy: Date) {
  if (!codigo?.trim()) return null;
  return (await resolverCie(db, tipo, codigo, { etiqueta, paciente, hoy })).codigo;
}

const COTIZACION_VIVA = new Set(["BORRADOR", "ENVIADA", "ACEPTADA"]);

// ── Crear ────────────────────────────────────────────────────────────────────

export type CrearPlanArgs = PlanCampos & { companyId: string; usuario?: Usuario; hoy?: Date };

export async function crearPlan(db: PrismaClient, args: CrearPlanArgs) {
  const hoy = args.hoy ?? new Date();
  const paciente = await db.hospPaciente.findUnique({
    where: { id: args.pacienteId },
    select: { id: true, companyId: true, pagadorId: true, sexo: true, fechaNacimiento: true, activo: true },
  });
  if (!paciente || paciente.companyId !== args.companyId) throw new HospitalError(404, "Paciente no encontrado");

  const protocolo = args.protocoloId
    ? await db.hospProtocolo.findUnique({ where: { id: args.protocoloId }, include: { partidas: { orderBy: { orden: "asc" } }, insumos: true } })
    : null;
  if (args.protocoloId && (!protocolo || protocolo.companyId !== args.companyId)) throw new HospitalError(404, "Protocolo no encontrado");
  if (protocolo && !protocolo.activo) throw new HospitalError(409, `El protocolo ${protocolo.clave} está dado de baja`);

  const pagadorId = args.pagadorId === undefined ? paciente.pagadorId : args.pagadorId;
  const pagador = await validarPagador(db, args.companyId, pagadorId);
  const medico = await validarMedico(db, args.companyId, args.medicoId, "medicoId");
  const anestesiologo = await validarMedico(db, args.companyId, args.anestesiologoId, "anestesiologoId");
  const recurso = await validarRecursoAgendable(db, args.companyId, args.recursoId);

  const nombre = args.nombre?.trim() || protocolo?.nombre;
  if (!nombre) throw new HospitalError(400, "nombre requerido cuando el plan no nace de un protocolo");
  const tipoEpisodio = args.tipoEpisodio ?? protocolo?.tipoEpisodio;
  if (!tipoEpisodio) throw new HospitalError(400, "tipoEpisodio requerido cuando el plan no nace de un protocolo");

  const procedimientoCie9 = await resolverCodigoPlan(
    db,
    "CIE9MC",
    args.procedimientoCie9 === undefined ? protocolo?.procedimientoCie9 : args.procedimientoCie9,
    "El procedimiento",
    paciente,
    hoy
  );
  const diagnosticoCie10 = await resolverCodigoPlan(
    db,
    "CIE10",
    args.diagnosticoCie10 === undefined ? protocolo?.diagnosticoCie10 : args.diagnosticoCie10,
    "El diagnóstico",
    paciente,
    hoy
  );

  const entradas = args.partidas ?? (protocolo ? entradasDeProtocolo(protocolo.partidas) : []);
  if (!entradas.length) throw new HospitalError(400, "El plan necesita partidas (o un protocolo que las traiga)");
  const preciado = await preciarPartidas(db, args.companyId, pagador?.id ?? null, entradas);
  const partidas = preciado.partidas.map(aPlanPartida);

  const entradasInsumos = args.insumos ?? protocolo?.insumos.map((x) => ({ insumoId: x.insumoId, cantidad: Number(x.cantidad), opcional: x.opcional })) ?? [];
  const insumos = (await costearInsumos(db, args.companyId, entradasInsumos)).map(aPlanInsumo);

  const honorarios = args.honorarios ? await resolverHonorarios(db, args.companyId, args.honorarios) : honorariosDefault({ protocolo, medico, anestesiologo });
  const totales = totalesPlan(partidas, honorarios);

  return db.hospPlanTratamiento.create({
    data: {
      companyId: args.companyId,
      pacienteId: paciente.id,
      protocoloId: protocolo?.id ?? null,
      pagadorId: pagador?.id ?? null,
      medicoId: medico?.id ?? null,
      anestesiologoId: anestesiologo?.id ?? null,
      recursoId: recurso?.id ?? null,
      nombre,
      procedimientoCie9,
      diagnosticoCie10,
      tipoEpisodio,
      estanciaNoches: args.estanciaNoches ?? protocolo?.estanciaNoches ?? 0,
      quirofanoMinutos: args.quirofanoMinutos === undefined ? (protocolo?.quirofanoMinutos ?? null) : args.quirofanoMinutos,
      tipoAnestesia: args.tipoAnestesia === undefined ? (protocolo?.tipoAnestesia ?? null) : args.tipoAnestesia,
      fechaProgramada: args.fechaProgramada ? new Date(args.fechaProgramada) : null,
      estado: "PROPUESTO",
      autorizacionPagador: args.autorizacionPagador?.trim() || null,
      partidas: aJson(partidas),
      insumos: aJson(insumos),
      honorarios: aJson(honorarios),
      subtotal: totales.subtotal,
      iva: totales.iva,
      total: totales.total,
      notas: args.notas?.trim() || null,
      creadoPorUserId: args.usuario?.id ?? null,
    },
    include: incluyePlan,
  });
}

// ── Actualizar ───────────────────────────────────────────────────────────────

export async function actualizarPlan(db: PrismaClient, args: { planId: string; cambios: PlanPatch; usuario?: Usuario; hoy?: Date }) {
  const hoy = args.hoy ?? new Date();
  const c = args.cambios;
  const plan = await db.hospPlanTratamiento.findUnique({
    where: { id: args.planId },
    include: {
      pagador: { select: { id: true, nombre: true, tipo: true } },
      cotizacion: { select: { id: true, folio: true, estado: true } },
      paciente: { select: { id: true, sexo: true, fechaNacimiento: true } },
    },
  });
  if (!plan) throw new HospitalError(404, "Plan no encontrado");
  const inmutable = errorPlanInmutable(plan.estado);
  if (inmutable) throw new HospitalError(409, inmutable);

  const tocaEconomia = c.partidas !== undefined || c.honorarios !== undefined || c.insumos !== undefined || c.pagadorId !== undefined;
  if (tocaEconomia && plan.cotizacion && COTIZACION_VIVA.has(plan.cotizacion.estado)) {
    throw new HospitalError(
      409,
      `El plan ya se cotizó (${plan.cotizacion.folio}, ${plan.cotizacion.estado}): edita o cancela la cotización antes de cambiar partidas, honorarios o convenio`
    );
  }

  const data: Prisma.HospPlanTratamientoUncheckedUpdateInput = {};
  const cambios: string[] = [];
  const marcar = (campo: string) => cambios.push(campo);

  let pagador = plan.pagador;
  if (c.pagadorId !== undefined) {
    pagador = await validarPagador(db, plan.companyId, c.pagadorId);
    data.pagadorId = pagador?.id ?? null;
    marcar("pagadorId");
  }
  if (c.medicoId !== undefined) {
    data.medicoId = (await validarMedico(db, plan.companyId, c.medicoId, "medicoId"))?.id ?? null;
    marcar("medicoId");
  }
  if (c.anestesiologoId !== undefined) {
    data.anestesiologoId = (await validarMedico(db, plan.companyId, c.anestesiologoId, "anestesiologoId"))?.id ?? null;
    marcar("anestesiologoId");
  }
  if (c.recursoId !== undefined) {
    data.recursoId = (await validarRecursoAgendable(db, plan.companyId, c.recursoId))?.id ?? null;
    marcar("recursoId");
  }
  if (c.nombre !== undefined) (data.nombre = c.nombre.trim()), marcar("nombre");
  if (c.tipoEpisodio !== undefined) (data.tipoEpisodio = c.tipoEpisodio), marcar("tipoEpisodio");
  if (c.estanciaNoches !== undefined) (data.estanciaNoches = c.estanciaNoches), marcar("estanciaNoches");
  if (c.quirofanoMinutos !== undefined) (data.quirofanoMinutos = c.quirofanoMinutos), marcar("quirofanoMinutos");
  if (c.tipoAnestesia !== undefined) (data.tipoAnestesia = c.tipoAnestesia), marcar("tipoAnestesia");
  if (c.fechaProgramada !== undefined) (data.fechaProgramada = c.fechaProgramada ? new Date(c.fechaProgramada) : null), marcar("fechaProgramada");
  if (c.notas !== undefined) (data.notas = c.notas?.trim() || null), marcar("notas");
  if (c.autorizacionPagador !== undefined) (data.autorizacionPagador = c.autorizacionPagador?.trim() || null), marcar("autorizacionPagador");
  if (c.procedimientoCie9 !== undefined) {
    data.procedimientoCie9 = await resolverCodigoPlan(db, "CIE9MC", c.procedimientoCie9, "El procedimiento", plan.paciente, hoy);
    marcar("procedimientoCie9");
  }
  if (c.diagnosticoCie10 !== undefined) {
    data.diagnosticoCie10 = await resolverCodigoPlan(db, "CIE10", c.diagnosticoCie10, "El diagnóstico", plan.paciente, hoy);
    marcar("diagnosticoCie10");
  }

  let partidas = partidasDePlan(plan.partidas);
  let honorarios = honorariosDePlan(plan.honorarios);
  if (c.partidas !== undefined) {
    if (!c.partidas.length) throw new HospitalError(400, "El plan necesita al menos una partida");
    const pagadorId = c.pagadorId !== undefined ? c.pagadorId : plan.pagadorId;
    partidas = (await preciarPartidas(db, plan.companyId, pagadorId, c.partidas)).partidas.map(aPlanPartida);
    data.partidas = aJson(partidas);
    marcar("partidas");
  }
  if (c.honorarios !== undefined) {
    honorarios = await resolverHonorarios(db, plan.companyId, c.honorarios);
    data.honorarios = aJson(honorarios);
    marcar("honorarios");
  }
  if (c.insumos !== undefined) {
    data.insumos = aJson((await costearInsumos(db, plan.companyId, c.insumos)).map(aPlanInsumo));
    marcar("insumos");
  }
  if (c.partidas !== undefined || c.honorarios !== undefined) {
    const t = totalesPlan(partidas, honorarios);
    data.subtotal = t.subtotal;
    data.iva = t.iva;
    data.total = t.total;
  }

  let estadoNuevo: HospPlanEstado | null = null;
  if (c.episodioId !== undefined) {
    if (!c.episodioId) throw new HospitalError(400, "El plan no se desliga del episodio; cancélalo si ya no aplica");
    const ep = await db.hospEpisodio.findUnique({
      where: { id: c.episodioId },
      select: { id: true, companyId: true, folio: true, pacienteId: true, estado: true, plan: { select: { id: true } } },
    });
    if (!ep || ep.companyId !== plan.companyId) throw new HospitalError(400, "episodioId inválido");
    if (ep.pacienteId !== plan.pacienteId) throw new HospitalError(409, `El episodio ${ep.folio} es de otro paciente`);
    if (ep.plan && ep.plan.id !== plan.id) throw new HospitalError(409, `El episodio ${ep.folio} ya tiene un plan de tratamiento`);
    if (plan.episodioId && plan.episodioId !== ep.id) throw new HospitalError(409, "El plan ya está ligado a otro episodio");
    if (ep.estado === "CANCELADO") throw new HospitalError(409, `El episodio ${ep.folio} está cancelado`);
    data.episodioId = ep.id;
    marcar("episodioId");
    estadoNuevo = ep.estado === "ALTA" ? "CERRADO" : "EN_CURSO";
    if (c.estado) throw new HospitalError(400, `Al ligar el episodio el plan pasa a ${estadoNuevo}: no mandes estado`);
  } else if (c.estado !== undefined && c.estado !== plan.estado) {
    const err = errorTransicionPlan(plan.estado, c.estado);
    if (err) throw new HospitalError(409, err);
    estadoNuevo = c.estado;
  }
  if (estadoNuevo === "AUTORIZADO") {
    const autorizacion = c.autorizacionPagador !== undefined ? c.autorizacionPagador : plan.autorizacionPagador;
    if (faltaAutorizacion(pagador?.tipo, autorizacion)) {
      throw new HospitalError(409, `El convenio ${pagador!.nombre} (${pagador!.tipo}) exige el número de autorización (autorizacionPagador) para autorizar el plan`);
    }
    data.autorizadoAt = hoy;
  }
  if (estadoNuevo === "PROPUESTO") data.autorizadoAt = null;
  if (estadoNuevo) {
    data.estado = estadoNuevo;
    marcar("estado");
  }

  const cotizacionACancelar =
    estadoNuevo === "CANCELADO" && plan.cotizacion && (plan.cotizacion.estado === "BORRADOR" || plan.cotizacion.estado === "ENVIADA") ? plan.cotizacion : null;

  const actualizado = await db.$transaction(async (tx) => {
    if (cotizacionACancelar) await tx.hospCotizacion.update({ where: { id: cotizacionACancelar.id }, data: { estado: "CANCELADA" } });
    return tx.hospPlanTratamiento.update({ where: { id: plan.id }, data, include: incluyePlan });
  });
  return { plan: actualizado, cambios, estadoAntes: plan.estado, cotizacionCancelada: cotizacionACancelar?.folio ?? null };
}

// ── Cotizar ──────────────────────────────────────────────────────────────────

export async function cotizarPlan(db: PrismaClient, args: { planId: string; usuario?: Usuario; hoy?: Date }) {
  const hoy = args.hoy ?? new Date();
  const plan = await db.hospPlanTratamiento.findUnique({
    where: { id: args.planId },
    include: {
      cotizacion: { select: { id: true, folio: true, estado: true } },
      episodio: { select: { id: true, folio: true } },
      paciente: { select: { nombre: true, apellidoPaterno: true, apellidoMaterno: true } },
    },
  });
  if (!plan) throw new HospitalError(404, "Plan no encontrado");
  const inmutable = errorPlanInmutable(plan.estado);
  if (inmutable) throw new HospitalError(409, inmutable);
  if (plan.episodio) throw new HospitalError(409, `El plan ya está en curso en el episodio ${plan.episodio.folio}: la cuenta vive ahí`);
  if (plan.cotizacion && plan.cotizacion.estado !== "CANCELADA" && plan.cotizacion.estado !== "VENCIDA") {
    throw new HospitalError(409, `El plan ya tiene la cotización ${plan.cotizacion.folio} (${plan.cotizacion.estado})`);
  }

  const partidas = partidasParaCotizacion(partidasDePlan(plan.partidas), honorariosDePlan(plan.honorarios));
  if (!partidas.length) throw new HospitalError(409, "El plan no tiene partidas que cotizar");
  const subtotal = r2(partidas.reduce((s, p) => s + p.importe, 0));
  const iva = r2(partidas.reduce((s, p) => s + (p.ivaTasa == null ? 0 : r2(p.importe * p.ivaTasa)), 0));

  return conFolioUnico(() =>
    db.$transaction(async (tx) => {
      const folio = await siguienteFolio(tx, plan.companyId, "cotizacion", hoy);
      const cotizacion = await tx.hospCotizacion.create({
        data: {
          companyId: plan.companyId,
          folio,
          pacienteId: plan.pacienteId,
          pacienteNombre: nombreCompleto(plan.paciente),
          pagadorId: plan.pagadorId,
          procedimiento: plan.nombre,
          estado: "BORRADOR",
          subtotal,
          iva,
          total: r2(subtotal + iva),
          notas: plan.notas,
          creadoPorUserId: args.usuario?.id ?? null,
          partidas: { create: partidas },
        },
        include: incluyeCotizacion,
      });
      await tx.hospPlanTratamiento.update({ where: { id: plan.id }, data: { cotizacionId: cotizacion.id } });
      return cotizacion;
    })
  );
}

// ── Programar ────────────────────────────────────────────────────────────────

/** Marca con la que la cita de quirófano recuerda a su plan (HospCita no tiene planId). */
export function referenciaCitaPlan(planId: string): string {
  return `plan:${planId}`;
}

export async function programarPlan(
  db: PrismaClient,
  args: { planId: string; fechaProgramada: Date; recursoId: string; medicoId?: string | null; duracionMinutos?: number | null; usuario?: Usuario }
) {
  const plan = await db.hospPlanTratamiento.findUnique({
    where: { id: args.planId },
    include: { protocolo: { select: { quirofanoMinutos: true } } },
  });
  if (!plan) throw new HospitalError(404, "Plan no encontrado");
  const inmutable = errorPlanInmutable(plan.estado);
  if (inmutable) throw new HospitalError(409, inmutable);
  if (Number.isNaN(args.fechaProgramada.getTime())) throw new HospitalError(400, "fechaProgramada inválida");

  const medicoId = args.medicoId === undefined ? plan.medicoId : args.medicoId;
  const v = await validarVinculosCita(db, plan.companyId, { recursoId: args.recursoId, pacienteId: plan.pacienteId, medicoId });
  if (v.error != null) throw new HospitalError(400, v.error);
  if (!v.recurso || v.recurso.tipo === "CAMA") throw new HospitalError(400, "El plan se programa en un quirófano, sala o consultorio, no en una cama");

  const inicio = args.fechaProgramada;
  const minutos = args.duracionMinutos ?? plan.quirofanoMinutos ?? plan.protocolo?.quirofanoMinutos ?? DURACION_DEFAULT_MINUTOS;
  const fin = new Date(inicio.getTime() + minutos * 60_000);
  const referencia = referenciaCitaPlan(plan.id);

  // Reprogramación: la cita viva anterior del plan se cancela (y no cuenta como empalme).
  const previa = await db.hospCita.findFirst({
    where: { companyId: plan.companyId, pacienteId: plan.pacienteId, notas: { contains: referencia }, estado: { in: ["PROGRAMADA", "CONFIRMADA"] } },
    select: { id: true },
  });
  const choque = await citaEmpalmada(db, { recursoId: args.recursoId, inicio, fin, excluirId: previa?.id ?? null });
  if (choque) throw new HospitalError(409, describirEmpalme(choque));

  const tipo = v.recurso.tipo === "QUIROFANO" ? "CIRUGIA" : "PROCEDIMIENTO";
  return db.$transaction(async (tx) => {
    if (previa) await tx.hospCita.update({ where: { id: previa.id }, data: { estado: "CANCELADA" } });
    const cita = await tx.hospCita.create({
      data: {
        companyId: plan.companyId,
        recursoId: args.recursoId,
        tipo,
        titulo: plan.nombre,
        inicio,
        fin,
        estado: "PROGRAMADA",
        pacienteId: plan.pacienteId,
        pacienteNombre: v.pacienteNombre,
        medicoId: medicoId ?? null,
        episodioId: plan.episodioId,
        cotizacionId: plan.cotizacionId,
        notas: `Plan de tratamiento (${referencia})`,
      },
      include: incluyeCita,
    });
    const actualizado = await tx.hospPlanTratamiento.update({
      where: { id: plan.id },
      data: { fechaProgramada: inicio, recursoId: args.recursoId, ...(args.medicoId !== undefined ? { medicoId: args.medicoId } : {}) },
      include: incluyePlan,
    });
    return { plan: actualizado, cita, citaCanceladaId: previa?.id ?? null };
  });
}

// ── Comparativo con la cuenta ────────────────────────────────────────────────

export async function compararPlanConCuenta(db: Db, episodioId: string) {
  const plan = await db.hospPlanTratamiento.findUnique({ where: { episodioId }, include: incluyePlan });
  if (!plan) return null;
  const [cargos, movimientos] = await Promise.all([
    db.hospCargo.findMany({
      where: { episodioId, cancelado: false },
      select: { id: true, fecha: true, categoria: true, descripcion: true, cantidad: true, importe: true, ivaTasa: true, servicioId: true, medicoId: true, origen: true },
      orderBy: [{ fecha: "asc" }, { createdAt: "asc" }],
    }),
    db.hospMovimientoInsumo.findMany({
      where: { episodioId, tipo: { in: ["SALIDA_APLICACION", "DEVOLUCION"] } },
      select: { insumoId: true, cantidad: true, costoUnitario: true, insumo: { select: { nombre: true, clave: true, unidad: true } } },
    }),
  ]);
  const comparativo = compararPlan({
    plan: {
      partidas: partidasDePlan(plan.partidas),
      honorarios: honorariosDePlan(plan.honorarios),
      insumos: insumosDePlan(plan.insumos),
      subtotal: Number(plan.subtotal),
      total: Number(plan.total),
    },
    cargos: cargos.map((c) => ({
      ...c,
      cantidad: Number(c.cantidad),
      importe: Number(c.importe),
      ivaTasa: c.ivaTasa == null ? null : Number(c.ivaTasa),
    })),
    movimientos: movimientos.map((m) => ({
      insumoId: m.insumoId,
      nombre: m.insumo.nombre,
      clave: m.insumo.clave,
      unidad: m.insumo.unidad,
      cantidad: Number(m.cantidad),
      costoUnitario: m.costoUnitario == null ? null : Number(m.costoUnitario),
    })),
  });
  return { plan: serializarPlan(plan), comparativo };
}

// ── Ganchos de los flujos existentes ─────────────────────────────────────────

/** El alta cierra el plan del episodio (si lo hay). Devuelve cuántos cerró. */
export async function cerrarPlanDeEpisodio(db: Db, episodioId: string): Promise<number> {
  const r = await db.hospPlanTratamiento.updateMany({
    where: { episodioId, estado: { in: ["PROPUESTO", "AUTORIZADO", "EN_CURSO"] } },
    data: { estado: "CERRADO" },
  });
  return r.count;
}

/** Cancelar el episodio cancela el plan que lo seguía. */
export async function cancelarPlanDeEpisodio(db: Db, episodioId: string): Promise<number> {
  const r = await db.hospPlanTratamiento.updateMany({
    where: { episodioId, estado: { in: ["PROPUESTO", "AUTORIZADO", "EN_CURSO"] } },
    data: { estado: "CANCELADO" },
  });
  return r.count;
}
