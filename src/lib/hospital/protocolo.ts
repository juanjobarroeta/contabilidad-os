// ─────────────────────────────────────────────────────────────────────────────
// Protocolos de tratamiento (P3): la receta reutilizable de un procedimiento
// —partidas del tarifario, insumos que se consumen, noches de estancia,
// minutos de quirófano, anestesia y honorarios sugeridos— de la que nace el
// plan de tratamiento de un paciente (plan.ts).
//
// El protocolo NO guarda precios: al simularlo o al abrir un plan se precia
// con `armarPartidas` (cotizacion.ts) —HospTarifa del pagador o precio de
// lista—, exactamente como una cotización. Una partida sin servicio del
// tarifario no tiene precio: queda en 0 (`origenPrecio: "SIN_TARIFA"`) hasta
// que el piso lo capture en el plan. Los insumos se costean al `ultimoCosto`.
// Los códigos CIE del protocolo se validan contra el catálogo sin paciente;
// el cruce con sexo/edad se hace al abrir el plan.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from "zod";
import type { HospCargoCategoria, HospEpisodioTipo, Prisma, PrismaClient } from "@prisma/client";
import { HospitalError } from "./errores";
import { dinero } from "./http";
import { r2 } from "./util";
import { CATEGORIAS_CARGO } from "./servicio-schema";
import { armarPartidas, type PartidaArmada, type PartidaEntrada } from "./cotizacion";
import { resolverCie } from "./cie";

type Db = PrismaClient | Prisma.TransactionClient;

export const TIPOS_EPISODIO = ["HOSPITALIZACION", "AMBULATORIO", "URGENCIAS", "CONSULTA"] as const;
export const ROLES_HONORARIO = ["CIRUJANO", "ANESTESIOLOGO", "AYUDANTE"] as const;
export type RolHonorario = (typeof ROLES_HONORARIO)[number];

/** Tipo de anestesia SAEH: 1 general · 2 regional · 3 local · 4 sedación · 5 combinada · 6 no usó. */
export const TIPOS_ANESTESIA = [1, 2, 3, 4, 5, 6] as const;

// ── Esquemas ─────────────────────────────────────────────────────────────────

export const protocoloPartidaSchema = z.object({
  orden: z.number().int().min(0).max(10000).optional(),
  servicioId: z.string().nullable().optional(),
  categoria: z.enum(CATEGORIAS_CARGO).optional(),
  descripcion: z.string().min(1).max(300).optional(),
  cantidad: z.number().positive().max(100000).default(1),
  opcional: z.boolean().default(false),
});
export type ProtocoloPartidaEntrada = z.infer<typeof protocoloPartidaSchema>;

export const protocoloInsumoSchema = z.object({
  insumoId: z.string().min(1),
  cantidad: z.number().positive().max(100000),
  opcional: z.boolean().default(false),
});
export type ProtocoloInsumoEntrada = z.infer<typeof protocoloInsumoSchema>;

export const protocoloCamposSchema = z.object({
  clave: z.string().min(1).max(40),
  nombre: z.string().min(1).max(200),
  descripcion: z.string().max(2000).nullable().optional(),
  tipoEpisodio: z.enum(TIPOS_EPISODIO).default("AMBULATORIO"),
  procedimientoCie9: z.string().max(10).nullable().optional(),
  diagnosticoCie10: z.string().max(10).nullable().optional(),
  especialidad: z.string().max(120).nullable().optional(),
  estanciaNoches: z.number().int().min(0).max(365).default(0),
  quirofanoMinutos: z.number().int().positive().max(1440).nullable().optional(),
  tipoAnestesia: z.number().int().min(1).max(6).nullable().optional(),
  requiereAnestesiologo: z.boolean().default(false),
  honorarioCirujano: dinero.nullable().optional(),
  honorarioAnestesiologo: dinero.nullable().optional(),
  activo: z.boolean().optional(),
  partidas: z.array(protocoloPartidaSchema).max(200).default([]),
  insumos: z.array(protocoloInsumoSchema).max(200).default([]),
});
export type ProtocoloCampos = z.infer<typeof protocoloCamposSchema>;

/** PATCH: todo opcional; `partidas`/`insumos` presentes REEMPLAZAN la lista. */
export const protocoloPatchSchema = protocoloCamposSchema.partial();
export type ProtocoloPatch = z.infer<typeof protocoloPatchSchema>;

// ── Forma de respuesta ───────────────────────────────────────────────────────

export const incluyeProtocolo = {
  partidas: {
    orderBy: { orden: "asc" as const },
    include: { servicio: { select: { id: true, clave: true, nombre: true, categoria: true, unidad: true, precioLista: true, ivaTasa: true, activo: true } } },
  },
  insumos: {
    include: { insumo: { select: { id: true, clave: true, nombre: true, unidad: true, presentacion: true, ultimoCosto: true, activo: true } } },
  },
  _count: { select: { planes: true } },
} as const;

export type ProtocoloConRelaciones = Prisma.HospProtocoloGetPayload<{ include: typeof incluyeProtocolo }>;

export function serializarProtocolo(p: ProtocoloConRelaciones) {
  const { partidas, insumos, _count, ...datos } = p;
  return {
    ...datos,
    honorarioCirujano: p.honorarioCirujano == null ? null : Number(p.honorarioCirujano),
    honorarioAnestesiologo: p.honorarioAnestesiologo == null ? null : Number(p.honorarioAnestesiologo),
    partidas: partidas.map((x) => ({
      id: x.id,
      orden: x.orden,
      servicioId: x.servicioId,
      categoria: x.categoria,
      descripcion: x.descripcion,
      cantidad: Number(x.cantidad),
      opcional: x.opcional,
      servicio: x.servicio
        ? {
            id: x.servicio.id,
            clave: x.servicio.clave,
            nombre: x.servicio.nombre,
            categoria: x.servicio.categoria,
            unidad: x.servicio.unidad,
            precioLista: Number(x.servicio.precioLista),
            ivaTasa: x.servicio.ivaTasa == null ? null : Number(x.servicio.ivaTasa),
            activo: x.servicio.activo,
          }
        : null,
    })),
    insumos: insumos.map((x) => ({
      id: x.id,
      insumoId: x.insumoId,
      clave: x.insumo.clave,
      nombre: x.insumo.nombre,
      unidad: x.insumo.unidad,
      presentacion: x.insumo.presentacion,
      cantidad: Number(x.cantidad),
      opcional: x.opcional,
      ultimoCosto: x.insumo.ultimoCosto == null ? null : Number(x.insumo.ultimoCosto),
      activo: x.insumo.activo,
    })),
    usos: _count.planes,
  };
}

// ── Armado para guardar ──────────────────────────────────────────────────────

export interface ProtocoloPartidaArmada {
  orden: number;
  servicioId: string | null;
  categoria: HospCargoCategoria;
  descripcion: string;
  cantidad: number;
  opcional: boolean;
}

/**
 * Partidas del protocolo listas para HospProtocoloPartida: con servicio, la
 * categoría y la descripción se toman del tarifario cuando no vienen; sin
 * servicio, las dos son obligatorias.
 */
export async function armarPartidasProtocolo(db: Db, companyId: string, entradas: ProtocoloPartidaEntrada[]): Promise<ProtocoloPartidaArmada[]> {
  const ids = [...new Set(entradas.map((p) => p.servicioId).filter(Boolean))] as string[];
  const servicios = ids.length
    ? await db.hospServicio.findMany({ where: { id: { in: ids }, companyId }, select: { id: true, nombre: true, categoria: true } })
    : [];
  const porId = new Map(servicios.map((s) => [s.id, s]));
  return entradas.map((p, i) => {
    const servicio = p.servicioId ? porId.get(p.servicioId) : null;
    if (p.servicioId && !servicio) throw new HospitalError(400, `servicioId inválido en la partida ${i + 1}`);
    const categoria = p.categoria ?? servicio?.categoria;
    const descripcion = p.descripcion?.trim() || servicio?.nombre;
    if (!categoria || !descripcion) throw new HospitalError(400, `La partida ${i + 1} necesita servicioId o (categoria, descripcion)`);
    return { orden: p.orden ?? i, servicioId: servicio?.id ?? null, categoria, descripcion, cantidad: p.cantidad, opcional: p.opcional };
  });
}

/** Insumos del protocolo validados (de la empresa, sin repetir). */
export async function armarInsumosProtocolo(db: Db, companyId: string, entradas: ProtocoloInsumoEntrada[]): Promise<ProtocoloInsumoEntrada[]> {
  const ids = entradas.map((x) => x.insumoId);
  if (new Set(ids).size !== ids.length) throw new HospitalError(400, "Hay insumos repetidos en el protocolo: junta las cantidades en una sola línea");
  if (!ids.length) return [];
  const insumos = await db.hospInsumo.findMany({ where: { id: { in: ids }, companyId }, select: { id: true } });
  const existentes = new Set(insumos.map((x) => x.id));
  entradas.forEach((x, i) => {
    if (!existentes.has(x.insumoId)) throw new HospitalError(400, `insumoId inválido en el insumo ${i + 1}`);
  });
  return entradas.map((x) => ({ insumoId: x.insumoId, cantidad: x.cantidad, opcional: x.opcional }));
}

/**
 * Códigos CIE del protocolo en su forma clínica, validados contra el catálogo
 * (existen y son codificables). Sin paciente: el cruce con sexo y edad se
 * hace al abrir el plan. `undefined` = no se tocó; `null`/"" = sin código.
 */
export async function resolverCiesProtocolo(
  db: Db,
  codigos: { procedimientoCie9?: string | null; diagnosticoCie10?: string | null }
): Promise<{ procedimientoCie9?: string | null; diagnosticoCie10?: string | null }> {
  const out: { procedimientoCie9?: string | null; diagnosticoCie10?: string | null } = {};
  if (codigos.procedimientoCie9 !== undefined) {
    out.procedimientoCie9 = codigos.procedimientoCie9?.trim()
      ? (await resolverCie(db, "CIE9MC", codigos.procedimientoCie9, { etiqueta: "El procedimiento" })).codigo
      : null;
  }
  if (codigos.diagnosticoCie10 !== undefined) {
    out.diagnosticoCie10 = codigos.diagnosticoCie10?.trim()
      ? (await resolverCie(db, "CIE10", codigos.diagnosticoCie10, { etiqueta: "El diagnóstico" })).codigo
      : null;
  }
  return out;
}

// ── Preciado (compartido con el plan) ────────────────────────────────────────

export type OrigenPrecio = "CONVENIO" | "LISTA" | "MANUAL" | "SIN_TARIFA";

export interface PartidaPreciada extends PartidaArmada {
  opcional: boolean;
  iva: number;
  total: number;
  origenPrecio: OrigenPrecio;
}

export type EntradaPreciable = PartidaEntrada & { opcional?: boolean };

/**
 * Partidas guardadas en un protocolo → entradas de `armarPartidas`. La
 * categoría y la descripción del protocolo mandan sobre las del servicio;
 * sin servicio no hay tarifa: precio 0 hasta que el piso lo capture.
 */
export function entradasDeProtocolo(
  partidas: Array<{ servicioId: string | null; categoria: HospCargoCategoria; descripcion: string; cantidad: unknown; opcional: boolean }>
): EntradaPreciable[] {
  return partidas.map((p) => ({
    servicioId: p.servicioId,
    categoria: p.categoria,
    descripcion: p.descripcion,
    cantidad: Number(p.cantidad),
    ...(p.servicioId ? {} : { precioUnitario: 0 }),
    opcional: p.opcional,
  }));
}

/**
 * Precia con el tarifario del pagador (HospTarifa) o el precio de lista —la
 * MISMA regla de la cotización, `armarPartidas`— y dice de dónde salió cada
 * precio. Conserva la bandera `opcional` de cada entrada.
 */
export async function preciarPartidas(
  db: Db,
  companyId: string,
  pagadorId: string | null | undefined,
  entradas: EntradaPreciable[]
): Promise<{ partidas: PartidaPreciada[]; subtotal: number; iva: number; total: number }> {
  const armado = await armarPartidas(db, companyId, pagadorId, entradas);
  const conConvenio = new Set<string>();
  if (pagadorId) {
    const ids = [...new Set(entradas.map((p) => p.servicioId).filter(Boolean))] as string[];
    if (ids.length) {
      const tarifas = await db.hospTarifa.findMany({ where: { pagadorId, servicioId: { in: ids } }, select: { servicioId: true } });
      for (const t of tarifas) conConvenio.add(t.servicioId);
    }
  }
  const partidas = armado.partidas.map((p, i) => {
    const entrada = entradas[i];
    const iva = p.ivaTasa == null ? 0 : r2(p.importe * p.ivaTasa);
    const origenPrecio: OrigenPrecio =
      entrada.precioUnitario != null
        ? entrada.servicioId || entrada.precioUnitario > 0
          ? "MANUAL"
          : "SIN_TARIFA"
        : p.servicioId && conConvenio.has(p.servicioId)
          ? "CONVENIO"
          : "LISTA";
    return { ...p, opcional: entrada.opcional ?? false, iva, total: r2(p.importe + iva), origenPrecio };
  });
  return { partidas, subtotal: armado.subtotal, iva: armado.iva, total: armado.total };
}

export interface InsumoCosteado {
  insumoId: string;
  clave: string;
  nombre: string;
  unidad: string;
  presentacion: string | null;
  cantidad: number;
  opcional: boolean;
  /** `ultimoCosto` del insumo; null = nunca ha entrado con costo. */
  costoUnitario: number | null;
  costo: number;
}

/** Insumos con su último costo (cantidad × ultimoCosto). 400 si alguno no es de la empresa. */
export async function costearInsumos(
  db: Db,
  companyId: string,
  entradas: Array<{ insumoId: string; cantidad: number; opcional?: boolean }>
): Promise<InsumoCosteado[]> {
  const ids = [...new Set(entradas.map((x) => x.insumoId))];
  const insumos = ids.length
    ? await db.hospInsumo.findMany({
        where: { id: { in: ids }, companyId },
        select: { id: true, clave: true, nombre: true, unidad: true, presentacion: true, ultimoCosto: true },
      })
    : [];
  const porId = new Map(insumos.map((x) => [x.id, x]));
  return entradas.map((x, i) => {
    const insumo = porId.get(x.insumoId);
    if (!insumo) throw new HospitalError(400, `insumoId inválido en el insumo ${i + 1}`);
    const costoUnitario = insumo.ultimoCosto == null ? null : Number(insumo.ultimoCosto);
    return {
      insumoId: insumo.id,
      clave: insumo.clave,
      nombre: insumo.nombre,
      unidad: insumo.unidad,
      presentacion: insumo.presentacion,
      cantidad: Number(x.cantidad),
      opcional: x.opcional ?? false,
      costoUnitario,
      costo: r2(Number(x.cantidad) * (costoUnitario ?? 0)),
    };
  });
}

// ── Simulación ───────────────────────────────────────────────────────────────

export interface HonorarioSugerido {
  rol: RolHonorario;
  monto: number;
}

/** Honorarios que el protocolo sugiere: cirujano y, si tiene monto, anestesiólogo. */
export function honorariosSugeridos(p: { honorarioCirujano: unknown; honorarioAnestesiologo: unknown; requiereAnestesiologo: boolean }): HonorarioSugerido[] {
  const out: HonorarioSugerido[] = [];
  const cirujano = p.honorarioCirujano == null ? 0 : Number(p.honorarioCirujano);
  const anestesiologo = p.honorarioAnestesiologo == null ? 0 : Number(p.honorarioAnestesiologo);
  if (cirujano > 0) out.push({ rol: "CIRUJANO", monto: r2(cirujano) });
  if (anestesiologo > 0 || p.requiereAnestesiologo) out.push({ rol: "ANESTESIOLOGO", monto: r2(anestesiologo) });
  return out;
}

export interface TotalesSimulacion {
  subtotal: number;
  iva: number;
  total: number;
  honorarios: number;
  totalConHonorarios: number;
  costoInsumos: number;
  /** Lo mismo sin las partidas e insumos opcionales. */
  sinOpcionales: { subtotal: number; iva: number; total: number; totalConHonorarios: number; costoInsumos: number };
}

/** Totales de la simulación: partidas (con y sin opcionales), honorarios exentos y costo de insumos. */
export function totalesSimulacion(partidas: PartidaPreciada[], honorarios: HonorarioSugerido[], insumos: InsumoCosteado[]): TotalesSimulacion {
  const sumar = (rows: PartidaPreciada[]) => {
    const subtotal = r2(rows.reduce((s, p) => s + p.importe, 0));
    const iva = r2(rows.reduce((s, p) => s + p.iva, 0));
    return { subtotal, iva, total: r2(subtotal + iva) };
  };
  const todas = sumar(partidas);
  const base = sumar(partidas.filter((p) => !p.opcional));
  const honor = r2(honorarios.reduce((s, h) => s + h.monto, 0));
  const costoInsumos = r2(insumos.reduce((s, x) => s + x.costo, 0));
  const costoBase = r2(insumos.filter((x) => !x.opcional).reduce((s, x) => s + x.costo, 0));
  return {
    ...todas,
    honorarios: honor,
    totalConHonorarios: r2(todas.total + honor),
    costoInsumos,
    sinOpcionales: { ...base, totalConHonorarios: r2(base.total + honor), costoInsumos: costoBase },
  };
}

export interface Simulacion {
  protocolo: {
    id: string;
    clave: string;
    nombre: string;
    version: number;
    tipoEpisodio: HospEpisodioTipo;
    estanciaNoches: number;
    quirofanoMinutos: number | null;
    tipoAnestesia: number | null;
    requiereAnestesiologo: boolean;
  };
  pagador: { id: string; nombre: string; tipo: string; tabulador: string | null } | null;
  partidas: PartidaPreciada[];
  honorarios: HonorarioSugerido[];
  insumos: InsumoCosteado[];
  totales: TotalesSimulacion;
}

/**
 * Qué costaría el protocolo para un pagador: partidas al precio del convenio
 * (o lista), honorarios sugeridos y costo estimado de insumos.
 */
export async function simularProtocolo(db: Db, args: { companyId: string; protocoloId: string; pagadorId?: string | null }): Promise<Simulacion> {
  const protocolo = await db.hospProtocolo.findUnique({
    where: { id: args.protocoloId },
    include: { partidas: { orderBy: { orden: "asc" } }, insumos: true },
  });
  if (!protocolo || protocolo.companyId !== args.companyId) throw new HospitalError(404, "Protocolo no encontrado");

  let pagador: Simulacion["pagador"] = null;
  if (args.pagadorId) {
    const p = await db.hospPagador.findUnique({ where: { id: args.pagadorId }, select: { id: true, companyId: true, nombre: true, tipo: true, tabulador: true } });
    if (!p || p.companyId !== args.companyId) throw new HospitalError(400, "pagadorId inválido");
    pagador = { id: p.id, nombre: p.nombre, tipo: p.tipo, tabulador: p.tabulador };
  }

  const preciado = await preciarPartidas(db, args.companyId, pagador?.id ?? null, entradasDeProtocolo(protocolo.partidas));
  const insumos = await costearInsumos(
    db,
    args.companyId,
    protocolo.insumos.map((x) => ({ insumoId: x.insumoId, cantidad: Number(x.cantidad), opcional: x.opcional }))
  );
  const honorarios = honorariosSugeridos(protocolo);

  return {
    protocolo: {
      id: protocolo.id,
      clave: protocolo.clave,
      nombre: protocolo.nombre,
      version: protocolo.version,
      tipoEpisodio: protocolo.tipoEpisodio,
      estanciaNoches: protocolo.estanciaNoches,
      quirofanoMinutos: protocolo.quirofanoMinutos,
      tipoAnestesia: protocolo.tipoAnestesia,
      requiereAnestesiologo: protocolo.requiereAnestesiologo,
    },
    pagador,
    partidas: preciado.partidas,
    honorarios,
    insumos,
    totales: totalesSimulacion(preciado.partidas, honorarios, insumos),
  };
}
