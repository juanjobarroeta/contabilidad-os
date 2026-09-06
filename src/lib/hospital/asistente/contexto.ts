// ─────────────────────────────────────────────────────────────────────────────
// Captura asistida — lo que el modelo puede ver del episodio, y nada más.
//
// Al modelo nunca se le manda más que el episodio en cuestión, y de él sólo
// lo clínico: tipo, fechas, diagnósticos y procedimiento del episodio, sexo y
// edad del paciente (no su nombre ni su CURP), los últimos signos vitales y
// las notas vigentes (las reemplazadas no) en orden cronológico. Recibe el
// cliente Prisma o la transacción como el resto del módulo.
// ─────────────────────────────────────────────────────────────────────────────

import type { HospEpisodioEstado, HospEpisodioTipo, HospMotivoEgreso, HospNotaTipo, HospSexo, Prisma, PrismaClient } from "@prisma/client";
import { HospitalError } from "../errores";
import { ETIQUETA_SECCION, PLANTILLAS_NOTA } from "../notas";
import { partesLocales } from "../tz";
import { diaDeEstanciaSimple } from "../util";

type Db = PrismaClient | Prisma.TransactionClient;

export interface PacienteAsistente {
  sexo: HospSexo | null;
  fechaNacimiento: Date | null;
}

export interface SignosAsistente {
  fecha: Date;
  taSistolica: number | null;
  taDiastolica: number | null;
  fc: number | null;
  fr: number | null;
  temperatura: number | null;
  spo2: number | null;
  glucosa: number | null;
  peso: number | null;
  talla: number | null;
  dolor: number | null;
}

export interface NotaAsistente {
  id: string;
  tipo: HospNotaTipo;
  fecha: Date;
  texto: string;
  secciones: Record<string, unknown> | null;
}

export interface EpisodioAsistente {
  id: string;
  companyId: string;
  folio: string;
  tipo: HospEpisodioTipo;
  estado: HospEpisodioEstado;
  fechaIngreso: Date;
  fechaAlta: Date | null;
  motivoEgreso: HospMotivoEgreso | null;
  motivo: string | null;
  diagnostico: string | null;
  procedimiento: string | null;
  diagnosticoIngresoCie10: string | null;
  diagnosticoEgresoCie10: string | null;
  procedimientoCie9: string | null;
  asa: string | null;
  aldreteEgreso: number | null;
  paciente: PacienteAsistente;
  medico: { nombre: string; cedula: string | null; especialidad: string | null } | null;
  /** Del más reciente al más antiguo. */
  signos: SignosAsistente[];
  /** Vigentes, en orden cronológico. */
  notas: NotaAsistente[];
}

const numero = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Carga el episodio con lo que el asistente necesita; 404 si no es de la empresa, 409 si está cancelado. */
export async function cargarEpisodioAsistente(
  db: Db,
  args: { companyId: string; episodioId: string; conNotas?: boolean; signos?: number }
): Promise<EpisodioAsistente> {
  const ep = await db.hospEpisodio.findUnique({
    where: { id: args.episodioId },
    include: {
      paciente: { select: { sexo: true, fechaNacimiento: true } },
      medico: { select: { nombre: true, cedula: true, especialidad: true } },
      signos: { orderBy: { fecha: "desc" as const }, take: Math.max(0, args.signos ?? 1) },
      notas: args.conNotas
        ? {
            where: { reemplazadaPor: { is: null } },
            orderBy: [{ fecha: "asc" as const }, { createdAt: "asc" as const }],
            select: { id: true, tipo: true, fecha: true, texto: true, secciones: true },
          }
        : false,
    },
  });
  if (!ep || ep.companyId !== args.companyId) throw new HospitalError(404, "Episodio no encontrado");
  if (ep.estado === "CANCELADO") throw new HospitalError(409, `El episodio ${ep.folio} está cancelado`);
  const notas = (args.conNotas ? (ep.notas as Array<{ id: string; tipo: HospNotaTipo; fecha: Date; texto: string; secciones: unknown }>) : []).map((n) => ({
    id: n.id,
    tipo: n.tipo,
    fecha: n.fecha,
    texto: n.texto,
    secciones: n.secciones && typeof n.secciones === "object" && !Array.isArray(n.secciones) ? (n.secciones as Record<string, unknown>) : null,
  }));
  return {
    id: ep.id,
    companyId: ep.companyId,
    folio: ep.folio,
    tipo: ep.tipo,
    estado: ep.estado,
    fechaIngreso: ep.fechaIngreso,
    fechaAlta: ep.fechaAlta,
    motivoEgreso: ep.motivoEgreso,
    motivo: ep.motivo,
    diagnostico: ep.diagnostico,
    procedimiento: ep.procedimiento,
    diagnosticoIngresoCie10: ep.diagnosticoIngresoCie10,
    diagnosticoEgresoCie10: ep.diagnosticoEgresoCie10,
    procedimientoCie9: ep.procedimientoCie9,
    asa: ep.asa,
    aldreteEgreso: ep.aldreteEgreso,
    paciente: { sexo: ep.paciente.sexo, fechaNacimiento: ep.paciente.fechaNacimiento },
    medico: ep.medico ? { nombre: ep.medico.nombre, cedula: ep.medico.cedula, especialidad: ep.medico.especialidad } : null,
    signos: ep.signos.map((s) => ({
      fecha: s.fecha,
      taSistolica: s.taSistolica,
      taDiastolica: s.taDiastolica,
      fc: s.fc,
      fr: s.fr,
      temperatura: numero(s.temperatura),
      spo2: s.spo2,
      glucosa: s.glucosa,
      peso: numero(s.peso),
      talla: numero(s.talla),
      dolor: s.dolor,
    })),
    notas,
  };
}

// ── Texto para el modelo ─────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, "0");

/** «2026-09-04 13:40» en hora local del hospital. */
export function fechaHoraTexto(d: Date): string {
  const p = partesLocales(d);
  return `${p.y}-${pad(p.m)}-${pad(p.d)} ${pad(p.h)}:${pad(p.min)}`;
}

/** «34 años», «7 meses», «12 días»; null sin fecha de nacimiento. */
export function edadTexto(fechaNacimiento: Date | null | undefined, hoy: Date = new Date()): string | null {
  if (!fechaNacimiento) return null;
  const dias = Math.max(0, Math.floor((hoy.getTime() - fechaNacimiento.getTime()) / 86_400_000));
  const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;
  if (dias >= 730) return plural(Math.floor(dias / 365.25), "año", "años");
  if (dias >= 60) return plural(Math.floor(dias / 30.4), "mes", "meses");
  return plural(dias, "día", "días");
}

const SEXO_TEXTO: Record<HospSexo, string> = { FEMENINO: "femenino", MASCULINO: "masculino", OTRO: "otro" };
const TIPO_TEXTO: Record<HospEpisodioTipo, string> = {
  HOSPITALIZACION: "hospitalización",
  AMBULATORIO: "cirugía ambulatoria",
  URGENCIAS: "urgencias",
  CONSULTA: "consulta externa",
};

export function describirPaciente(p: PacienteAsistente, hoy: Date = new Date()): string {
  const partes = [p.sexo ? `sexo ${SEXO_TEXTO[p.sexo]}` : null, edadTexto(p.fechaNacimiento, hoy) ? `edad ${edadTexto(p.fechaNacimiento, hoy)}` : null].filter(Boolean);
  return partes.length ? partes.join(", ") : "sexo y edad no registrados";
}

export function describirSignos(s: SignosAsistente): string {
  const partes: string[] = [];
  if (s.taSistolica != null && s.taDiastolica != null) partes.push(`TA ${s.taSistolica}/${s.taDiastolica}`);
  if (s.fc != null) partes.push(`FC ${s.fc}`);
  if (s.fr != null) partes.push(`FR ${s.fr}`);
  if (s.temperatura != null) partes.push(`T ${s.temperatura} °C`);
  if (s.spo2 != null) partes.push(`SpO2 ${s.spo2} %`);
  if (s.glucosa != null) partes.push(`glucosa ${s.glucosa} mg/dL`);
  if (s.peso != null) partes.push(`peso ${s.peso} kg`);
  if (s.talla != null) partes.push(`talla ${s.talla} ${s.talla > 3 ? "cm" : "m"}`);
  if (s.dolor != null) partes.push(`dolor ${s.dolor}/10`);
  return `${partes.join(", ") || "sin valores"} (toma de las ${fechaHoraTexto(s.fecha)})`;
}

/** El episodio en pocas líneas: lo clínico y administrativo mínimo, sin datos personales. */
export function describirEpisodio(ep: EpisodioAsistente, hoy: Date = new Date()): string {
  const lineas = [
    `Tipo de episodio: ${TIPO_TEXTO[ep.tipo]} · estado actual: ${ep.estado.replace(/_/g, " ").toLowerCase()}`,
    `Paciente: ${describirPaciente(ep.paciente, hoy)}`,
    `Ingreso: ${fechaHoraTexto(ep.fechaIngreso)}${ep.fechaAlta ? ` · alta: ${fechaHoraTexto(ep.fechaAlta)}` : ` · día de estancia ${diaDeEstanciaSimple(ep.fechaIngreso, hoy)}`}`,
  ];
  if (ep.motivo) lineas.push(`Motivo del episodio: ${ep.motivo}`);
  if (ep.diagnostico || ep.diagnosticoIngresoCie10) lineas.push(`Diagnóstico de trabajo del episodio: ${[ep.diagnosticoIngresoCie10, ep.diagnostico].filter(Boolean).join(" ")}`);
  if (ep.diagnosticoEgresoCie10) lineas.push(`Diagnóstico de egreso ya registrado: ${ep.diagnosticoEgresoCie10}`);
  if (ep.procedimiento || ep.procedimientoCie9) lineas.push(`Procedimiento del episodio: ${[ep.procedimientoCie9, ep.procedimiento].filter(Boolean).join(" ")}`);
  if (ep.asa) lineas.push(`ASA registrado: ${ep.asa}`);
  if (ep.medico?.especialidad) lineas.push(`Especialidad del médico tratante: ${ep.medico.especialidad}`);
  return lineas.join("\n");
}

/** Tipos de nota que no aportan a la codificación ni al egreso (las genera el sistema). */
const NOTAS_SIN_VALOR_CLINICO = new Set<HospNotaTipo>(["MEDICAMENTO_APLICADO"]);

const MAX_SECCION = 2_500;
const MAX_CORPUS = 60_000;

function textoSeccion(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(textoSeccion).filter(Boolean).join("; ") || null;
  return null;
}

export function renderNota(n: NotaAsistente): string {
  const lineas = [`### ${PLANTILLAS_NOTA[n.tipo]?.titulo ?? n.tipo} — ${fechaHoraTexto(n.fecha)}`];
  if (n.texto.trim()) lineas.push(n.texto.trim().slice(0, MAX_SECCION));
  for (const [clave, valor] of Object.entries(n.secciones ?? {})) {
    const t = textoSeccion(valor);
    if (t) lineas.push(`- ${ETIQUETA_SECCION[clave] ?? clave}: ${t.slice(0, MAX_SECCION)}`);
  }
  return lineas.join("\n");
}

/**
 * Las notas vigentes como las lee el modelo, cronológicas. Si no caben en el
 * presupuesto se quedan las más recientes completas y se reporta cuántas
 * antiguas se omitieron (el egreso se arma con lo último; lo demás se
 * advierte).
 */
export function renderNotas(notas: NotaAsistente[], opciones: { incluirSistema?: boolean } = {}): { texto: string; omitidas: number; incluidas: number } {
  const utiles = notas.filter((n) => opciones.incluirSistema || !NOTAS_SIN_VALOR_CLINICO.has(n.tipo));
  const bloques = utiles.map(renderNota);
  let total = 0;
  let desde = bloques.length;
  for (let i = bloques.length - 1; i >= 0; i--) {
    if (total + bloques[i].length + 2 > MAX_CORPUS) break;
    total += bloques[i].length + 2;
    desde = i;
  }
  return { texto: bloques.slice(desde).join("\n\n"), omitidas: desde, incluidas: bloques.length - desde };
}
