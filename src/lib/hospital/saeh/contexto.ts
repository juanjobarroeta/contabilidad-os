// ─────────────────────────────────────────────────────────────────────────────
// SAEH — de dónde sale cada dato de la hoja: el episodio, el paciente, el
// médico, la hoja guardada (HospEgresoSaeh), los signos, las notas, las camas
// por las que pasó y el establecimiento (HospConfig + catálogo CLUES).
//
// `cargarFuentesSaeh` trae todo con pocas consultas (un findMany con includes
// más dos auxiliares) para que la lista del mes no haga N viajes por egreso.
// Sin authz: recibe el cliente Prisma como el resto de la lógica del módulo.
// ─────────────────────────────────────────────────────────────────────────────

import type { HospArea, HospEgresoSaeh, HospEpisodioEstado, HospEpisodioTipo, HospMotivoEgreso, Prisma, PrismaClient } from "@prisma/client";
import { claveDeCodigoCie } from "../cie";
import type { EdadSaeh } from "./codigos";
import { CLUES_ESTATUS_EN_OPERACION, TIPOLOGIAS_PSIQUIATRICAS } from "./codigos";
import type { HojaSaeh, PacienteSaeh } from "./hoja";
import type { RegistroSaeh } from "./registro";

type Db = PrismaClient | Prisma.TransactionClient;

export interface EpisodioSaeh {
  id: string;
  companyId: string;
  folio: string;
  tipo: HospEpisodioTipo;
  estado: HospEpisodioEstado;
  fechaIngreso: Date;
  fechaAlta: Date | null;
  motivoEgreso: HospMotivoEgreso | null;
  diagnosticoIngresoCie10: string | null;
  diagnosticoEgresoCie10: string | null;
  procedimientoCie9: string | null;
  medicoId: string | null;
  pacienteId: string;
}

export interface MedicoSaeh {
  id: string;
  nombre: string;
  especialidad: string | null;
  cedula: string | null;
  curp: string | null;
  nombres: string | null;
  apellidoPaterno: string | null;
  apellidoMaterno: string | null;
  paisNacimientoClave: string | null;
}

export interface EstablecimientoSaeh {
  clues: string | null;
  /** Tres letras de institución para el nombre del archivo (SMP = Servicios Médicos Privados). */
  institucion: string;
  nombre: string | null;
  /** La CLUES está en el catálogo ESTABLECIMIENTO DE SALUD cargado. */
  enCatalogo: boolean;
  entidad: string | null;
  tipo: string | null;
  tipologia: string | null;
  estatus: string | null;
  enOperacion: boolean;
  psiquiatrico: boolean;
}

export interface FuenteSaeh {
  episodio: EpisodioSaeh;
  paciente: PacienteSaeh;
  /** Médico tratante del episodio. */
  medico: MedicoSaeh | null;
  /** Médico responsable guardado en la hoja (si difiere del tratante). */
  medicoResponsable: MedicoSaeh | null;
  fila: HospEgresoSaeh | null;
  signos: { peso: number | null; talla: number | null };
  notas: { tipoAnestesiaTexto: string | null; hayPostoperatoria: boolean };
  /** Áreas de las camas/salas por las que pasó (recurso actual + traslados). */
  areas: HospArea[];
  pasoPorUrgencias: boolean;
  /** Minutos de quirófano según las citas de cirugía del episodio; null si no hay. */
  minutosQuirofano: number | null;
  /** Horas en camas de TERAPIA según los traslados; null si no pasó por terapia. */
  horasTerapia: number | null;
  /** Ya había egresado antes de esta unidad con la misma afección principal. */
  subsecuente: boolean;
  establecimiento: EstablecimientoSaeh;
}

/** Lo que consumen validar y exportar: fuente + hoja y paciente efectivos (guardado ⊕ prellenado) + el registro de 82 campos. */
export interface ContextoSaeh {
  fuente: FuenteSaeh;
  hoja: HojaSaeh;
  /** Campos de la hoja que salieron del prellenado y no están guardados. */
  prellenado: string[];
  paciente: PacienteSaeh;
  pacientePrellenado: string[];
  edad: EdadSaeh | null;
  registro: RegistroSaeh;
  hoy: Date;
}

// ── Carga ────────────────────────────────────────────────────────────────────

const medicoSelect = {
  id: true, nombre: true, especialidad: true, cedula: true, curp: true, nombres: true, apellidoPaterno: true, apellidoMaterno: true, paisNacimientoClave: true,
} as const;

const pacienteSelect = {
  id: true, nombre: true, apellidoPaterno: true, apellidoMaterno: true, fechaNacimiento: true, sexo: true, curp: true, sinCurp: true, nacionalidad: true,
  entidadNacimiento: true, municipio: true, estado: true,
  paisNacimientoClave: true, entidadNacimientoClave: true, estadoConyugal: true, seConsideraIndigena: true, hablaLenguaIndigena: true, lenguaIndigenaClave: true,
  seConsideraAfromexicano: true, esMigranteRetornado: true, seIdentificaLgbti: true, genero: true, paisResidenciaClave: true, entidadResidenciaClave: true,
  municipioResidenciaClave: true, localidadResidenciaClave: true, otraLocalidad: true, derechohabienciaClave: true, codigoPostal: true,
} as const;

const incluye = {
  paciente: { select: pacienteSelect },
  medico: { select: medicoSelect },
  egresoSaeh: { include: { medicoResponsable: { select: medicoSelect } } },
  recurso: { select: { id: true, area: true } },
  traslados: { orderBy: { fecha: "asc" as const }, select: { fecha: true, tipo: true, deRecursoId: true, aRecursoId: true } },
  signos: { orderBy: { fecha: "desc" as const }, take: 30, select: { peso: true, talla: true } },
  notas: { where: { tipo: { in: ["PREANESTESICA", "POSTOPERATORIA"] as const }, reemplazadaPor: { is: null } }, select: { tipo: true, secciones: true } },
  citas: { where: { tipo: "CIRUGIA" as const, estado: { notIn: ["CANCELADA", "NO_ASISTIO"] as const } }, select: { inicio: true, fin: true } },
} satisfies Prisma.HospEpisodioInclude;

type EpisodioCargado = Prisma.HospEpisodioGetPayload<{ include: typeof incluye }>;

export const ESTABLECIMIENTO_VACIO: EstablecimientoSaeh = {
  clues: null, institucion: "SMP", nombre: null, enCatalogo: false, entidad: null, tipo: null, tipologia: null, estatus: null, enOperacion: false, psiquiatrico: false,
};

/** CLUES, institución y lo que el catálogo ESTABLECIMIENTO DE SALUD dice de ella. */
export async function cargarEstablecimiento(db: Db, companyId: string): Promise<EstablecimientoSaeh> {
  const cfg = await db.hospConfig.findUnique({ where: { companyId }, select: { clues: true, saehInstitucion: true, nombreHospital: true } });
  const clues = cfg?.clues?.trim().toUpperCase() || null;
  const base: EstablecimientoSaeh = {
    ...ESTABLECIMIENTO_VACIO,
    clues,
    institucion: (cfg?.saehInstitucion?.trim().toUpperCase() || (clues ? clues.slice(2, 5) : "") || "SMP").slice(0, 3),
    nombre: cfg?.nombreHospital ?? null,
  };
  if (!clues) return base;
  const fila = await db.hospCatalogo.findUnique({ where: { tipo_clave: { tipo: "CLUES", clave: clues } }, select: { nombre: true, padre: true, datos: true } });
  return establecimientoDesdeCatalogo(base, fila);
}

export function establecimientoDesdeCatalogo(
  base: EstablecimientoSaeh,
  fila: { nombre: string; padre: string | null; datos: unknown } | null
): EstablecimientoSaeh {
  if (!fila) return { ...base, enCatalogo: false };
  const datos = (fila.datos && typeof fila.datos === "object" ? fila.datos : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof datos[k] === "string" ? (datos[k] as string) : null);
  const tipologia = str("tipologia");
  const estatus = str("estatus");
  return {
    ...base,
    nombre: base.nombre ?? fila.nombre,
    enCatalogo: true,
    entidad: str("entidad") ?? fila.padre,
    tipo: str("tipo"),
    tipologia,
    estatus,
    enOperacion: estatus === CLUES_ESTATUS_EN_OPERACION,
    psiquiatrico: !!tipologia && TIPOLOGIAS_PSIQUIATRICAS.includes(tipologia),
  };
}

function seccionTexto(secciones: unknown, clave: string): string | null {
  if (!secciones || typeof secciones !== "object" || Array.isArray(secciones)) return null;
  const v = (secciones as Record<string, unknown>)[clave];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function fuenteDesdeEpisodio(
  e: EpisodioCargado,
  areaDeRecurso: Map<string, HospArea>,
  subsecuente: boolean,
  establecimiento: EstablecimientoSaeh
): FuenteSaeh {
  const areas = new Set<HospArea>();
  if (e.recurso) areas.add(e.recurso.area);
  for (const t of e.traslados) {
    for (const id of [t.deRecursoId, t.aRecursoId]) {
      const a = id ? areaDeRecurso.get(id) : undefined;
      if (a) areas.add(a);
    }
  }

  // Horas en terapia: de cada traslado hacia una cama de TERAPIA hasta el siguiente movimiento (o el alta).
  let horasTerapia: number | null = null;
  const cierre = e.fechaAlta ?? new Date();
  e.traslados.forEach((t, i) => {
    const area = t.aRecursoId ? areaDeRecurso.get(t.aRecursoId) : undefined;
    if (area !== "TERAPIA") return;
    const fin = e.traslados[i + 1]?.fecha ?? cierre;
    horasTerapia = (horasTerapia ?? 0) + Math.max(0, (fin.getTime() - t.fecha.getTime()) / 3_600_000);
  });

  let minutosQuirofano: number | null = null;
  for (const c of e.citas) {
    const min = (c.fin.getTime() - c.inicio.getTime()) / 60_000;
    if (min > 0) minutosQuirofano = (minutosQuirofano ?? 0) + min;
  }

  const peso = e.signos.find((s) => s.peso != null)?.peso;
  const talla = e.signos.find((s) => s.talla != null)?.talla;
  const pre = e.notas.find((n) => n.tipo === "PREANESTESICA");

  const { paciente, medico, egresoSaeh, recurso: _r, traslados: _t, signos: _s, notas: _n, citas: _c, ...ep } = e;
  const { medicoResponsable, ...fila } = egresoSaeh ?? { medicoResponsable: null };

  return {
    episodio: {
      id: ep.id, companyId: ep.companyId, folio: ep.folio, tipo: ep.tipo, estado: ep.estado, fechaIngreso: ep.fechaIngreso, fechaAlta: ep.fechaAlta,
      motivoEgreso: ep.motivoEgreso, diagnosticoIngresoCie10: ep.diagnosticoIngresoCie10, diagnosticoEgresoCie10: ep.diagnosticoEgresoCie10,
      procedimientoCie9: ep.procedimientoCie9, medicoId: ep.medicoId, pacienteId: ep.pacienteId,
    },
    paciente,
    medico,
    medicoResponsable: medicoResponsable ?? null,
    fila: egresoSaeh ? (fila as HospEgresoSaeh) : null,
    signos: { peso: peso == null ? null : Number(peso), talla: talla == null ? null : Math.round(Number(talla)) },
    notas: { tipoAnestesiaTexto: seccionTexto(pre?.secciones, "tipoAnestesia"), hayPostoperatoria: e.notas.some((n) => n.tipo === "POSTOPERATORIA") },
    areas: [...areas],
    pasoPorUrgencias: areas.has("URGENCIAS") || e.tipo === "URGENCIAS",
    minutosQuirofano,
    horasTerapia,
    subsecuente,
    establecimiento,
  };
}

/**
 * Carga las fuentes de uno o varios episodios de la empresa. `where` acota
 * (por id, por mes de alta…); el establecimiento se puede pasar ya cargado.
 */
export async function cargarFuentesSaeh(
  db: Db,
  args: { companyId: string; where?: Prisma.HospEpisodioWhereInput; establecimiento?: EstablecimientoSaeh }
): Promise<FuenteSaeh[]> {
  const establecimiento = args.establecimiento ?? (await cargarEstablecimiento(db, args.companyId));
  const episodios = await db.hospEpisodio.findMany({
    where: { companyId: args.companyId, ...(args.where ?? {}) },
    include: incluye,
    orderBy: [{ fechaAlta: "asc" }, { folio: "asc" }],
  });
  if (!episodios.length) return [];

  const recursoIds = new Set<string>();
  for (const e of episodios) for (const t of e.traslados) for (const id of [t.deRecursoId, t.aRecursoId]) if (id) recursoIds.add(id);
  const recursos = recursoIds.size ? await db.hospRecurso.findMany({ where: { id: { in: [...recursoIds] } }, select: { id: true, area: true } }) : [];
  const areaDeRecurso = new Map(recursos.map((r) => [r.id, r.area] as const));

  // Subsecuencia: otro egreso anterior del mismo paciente en esta unidad con la misma afección principal.
  const pacienteIds = [...new Set(episodios.map((e) => e.pacienteId))];
  const previos = await db.hospEpisodio.findMany({
    where: { companyId: args.companyId, pacienteId: { in: pacienteIds }, estado: "ALTA", fechaAlta: { not: null }, diagnosticoEgresoCie10: { not: null } },
    select: { id: true, pacienteId: true, fechaAlta: true, diagnosticoEgresoCie10: true },
  });
  const esSubsecuente = (e: EpisodioCargado) => {
    const dx = e.diagnosticoEgresoCie10 ?? e.diagnosticoIngresoCie10;
    if (!dx) return false;
    const clave = claveDeCodigoCie(dx);
    return previos.some(
      (p) => p.id !== e.id && p.pacienteId === e.pacienteId && p.fechaAlta && p.fechaAlta.getTime() < e.fechaIngreso.getTime() && p.diagnosticoEgresoCie10 && claveDeCodigoCie(p.diagnosticoEgresoCie10) === clave
    );
  };

  return episodios.map((e) => fuenteDesdeEpisodio(e, areaDeRecurso, esSubsecuente(e), establecimiento));
}

/** Fuente de un episodio; null si no existe. */
export async function cargarFuenteSaeh(db: Db, episodioId: string): Promise<FuenteSaeh | null> {
  const base = await db.hospEpisodio.findUnique({ where: { id: episodioId }, select: { companyId: true } });
  if (!base) return null;
  const [fuente] = await cargarFuentesSaeh(db, { companyId: base.companyId, where: { id: episodioId } });
  return fuente ?? null;
}
