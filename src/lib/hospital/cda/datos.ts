// ─────────────────────────────────────────────────────────────────────────────
// Lo que el CDA necesita del expediente, ya cargado y aplanado: `DatosResumen`
// es el contrato entre `cargarDatos` (Prisma) y `armarCda` (puro). Aquí viven
// las reglas de qué episodio se puede resumir (EGRESO sólo con ALTA,
// REFERENCIA sólo con destinatario) y los cruces con el catálogo CIE.
// Recibe el cliente o la transacción, igual que cie.ts y notas.ts.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  HospArea,
  HospDocumentoTipo,
  HospEpisodioEstado,
  HospEpisodioTipo,
  HospInsumoCategoria,
  HospMotivoEgreso,
  HospNotaTipo,
  HospPagadorTipo,
  HospSexo,
  Prisma,
  PrismaClient,
} from "@prisma/client";
import { buscarCie, claveDeCodigoCie, normalizarCodigoCie } from "../cie";
import { HospitalError } from "../errores";
import { limpiar, objeto, textoDe } from "./comun";

type Db = PrismaClient | Prisma.TransactionClient;

export type TipoResumen = "EPISODIO" | "EGRESO" | "REFERENCIA";
export const TIPOS_RESUMEN: readonly TipoResumen[] = ["EPISODIO", "EGRESO", "REFERENCIA"];

export interface Destinatario {
  nombre: string;
  cedula?: string | null;
  clues?: string | null;
  organizacion?: string | null;
}

export interface CodigoCie {
  /** Forma clínica como la capturó el piso: «K80.2». */
  codigo: string;
  /** Clave DGIS sin punto: «K802», «I10X», «5123». Es lo que va en `code`. */
  clave: string;
  /** Nombre del catálogo; null si el código no está en él. */
  nombre: string | null;
}

export interface DiagnosticoResumen extends CodigoCie {
  /** «Ingreso», «Egreso», «Comorbilidad», «Causa externa», «Nota de evolución 2026-09-04»… */
  tipo: string;
  fecha: Date | null;
  /** Glosa del médico (texto libre). */
  texto: string | null;
}

export interface ProcedimientoResumen extends CodigoCie {
  fecha: Date | null;
  /** Texto libre del médico (operación realizada / glosa del episodio). */
  texto: string | null;
  medicoNombre: string | null;
  medicoCedula: string | null;
  /** Se hizo en quirófano (nota postoperatoria o SAEH). */
  quirofano: boolean;
  anestesia: string | null;
}

export interface MedicamentoResumen {
  id: string;
  fecha: Date;
  nombre: string;
  categoria: HospInsumoCategoria | null;
  presentacion: string | null;
  sustanciaActiva: string | null;
  cantidad: number;
  unidad: string;
  lote: string | null;
  dosis: string | null;
  via: string | null;
  observaciones: string | null;
  medicoNombre: string | null;
  medicoCedula: string | null;
}

export interface NotaResumen {
  id: string;
  tipo: HospNotaTipo;
  fecha: Date;
  autorNombre: string;
  autorCedula: string | null;
  texto: string;
  secciones: Record<string, unknown> | null;
}

export interface SignosResumen {
  fecha: Date;
  taSistolica: number | null;
  taDiastolica: number | null;
  fc: number | null;
  fr: number | null;
  temperatura: number | null;
  spo2: number | null;
  glucosa: number | null;
  peso: number | null;
  /** Como la captura el piso (metros o centímetros; se normaliza al armar). */
  talla: number | null;
  dolor: number | null;
  registradoPor: string;
}

export interface DocumentoResumen {
  tipo: HospDocumentoTipo;
  nombre: string;
  estado: string;
  createdAt: Date;
  contenido: Record<string, unknown> | null;
}

export interface DatosResumen {
  tipo: TipoResumen;
  companyId: string;
  hospital: {
    nombre: string;
    razonSocial: string;
    rfc: string | null;
    clues: string | null;
    licenciaSanitaria: string | null;
    oidRaiz: string | null;
    telefono: string | null;
    email: string | null;
    domicilio: string | null;
    codigoPostal: string | null;
    responsableSanitario: string | null;
    responsableSanitarioCedula: string | null;
  };
  /** Quien pidió el documento (dataEnterer). null = proceso del sistema. */
  usuario: { id: string | null; email: string | null; nombre: string | null } | null;
  paciente: {
    id: string;
    expedienteNumero: string | null;
    nombre: string;
    apellidoPaterno: string;
    apellidoMaterno: string | null;
    curp: string | null;
    sinCurp: boolean;
    rfc: string | null;
    sexo: HospSexo | null;
    fechaNacimiento: Date | null;
    telefono: string | null;
    email: string | null;
    domicilio: string | null;
    calle: string | null;
    numeroExterior: string | null;
    numeroInterior: string | null;
    colonia: string | null;
    municipio: string | null;
    estado: string | null;
    codigoPostal: string | null;
    paisResidenciaClave: string | null;
    entidadResidenciaClave: string | null;
    municipioResidenciaClave: string | null;
    localidadResidenciaClave: string | null;
    nacionalidad: string | null;
    entidadNacimientoClave: string | null;
    estadoConyugal: number | null;
    hablaLenguaIndigena: boolean | null;
    lenguaIndigenaClave: string | null;
    tipoSangre: string | null;
    alergias: string | null;
    antecedentes: string | null;
    contactoEmergenciaNombre: string | null;
    contactoEmergenciaTelefono: string | null;
    contactoEmergenciaParentesco: string | null;
    derechohabienciaClave: string | null;
  };
  episodio: {
    id: string;
    folio: string;
    tipo: HospEpisodioTipo;
    estado: HospEpisodioEstado;
    fechaIngreso: Date;
    fechaAlta: Date | null;
    motivoEgreso: HospMotivoEgreso | null;
    motivo: string | null;
    diagnostico: string | null;
    procedimiento: string | null;
    autorizacionPagador: string | null;
    area: HospArea | null;
    recursoNombre: string | null;
    asa: string | null;
    aldreteEgreso: number | null;
    triageNivel: number | null;
  };
  medico: {
    nombre: string;
    nombres: string | null;
    apellidoPaterno: string | null;
    apellidoMaterno: string | null;
    cedula: string | null;
    especialidad: string | null;
  } | null;
  pagador: {
    nombre: string;
    tipo: HospPagadorTipo;
    rfc: string | null;
    vigenciaInicio: Date | null;
    vigenciaFin: Date | null;
    /** Número de póliza (documento POLIZA → contenido.poliza). */
    poliza: string | null;
  } | null;
  diagnosticos: DiagnosticoResumen[];
  procedimientos: ProcedimientoResumen[];
  medicamentos: MedicamentoResumen[];
  /** Notas vigentes (las reemplazadas no), en orden cronológico. */
  notas: NotaResumen[];
  signos: SignosResumen[];
  documentos: DocumentoResumen[];
  destinatario: Destinatario | null;
  motivoReferencia: string | null;
}

export interface CargarDatosArgs {
  companyId: string;
  episodioId: string;
  tipo: TipoResumen;
  destinatario?: Destinatario | null;
  /** Motivo de la referencia (REFERENCIA); si falta se toma de la nota de referencia. */
  motivo?: string | null;
  usuario?: { id?: string | null; email?: string | null; nombre?: string | null } | null;
}

const RE_CIE10 = /\b([A-TV-Z][0-9]{2}\.[0-9X]{1,2})\b/gi;

/** Códigos CIE-10 con punto que el médico escribió dentro de un texto («… K80.2 …»). */
export function extraerCodigosCie10(texto: string | null | undefined): string[] {
  if (!texto) return [];
  const out = new Set<string>();
  for (const m of texto.matchAll(RE_CIE10)) out.add(normalizarCodigoCie(m[1]));
  return [...out];
}

/** Secciones de notas donde el médico escribe diagnósticos (para extraer códigos). */
const SECCIONES_DIAGNOSTICO: Partial<Record<HospNotaTipo, string[]>> = {
  HISTORIA_CLINICA: ["diagnosticos"],
  INGRESO: ["diagnosticos"],
  EVOLUCION: ["diagnosticos"],
  HOJA_URGENCIAS: ["diagnosticos"],
  POSTOPERATORIA: ["diagnosticoPostoperatorio"],
  EGRESO: ["diagnosticoEgreso"],
  INTERCONSULTA: ["sugerenciasDiagnosticas"],
};

const ETIQUETA_NOTA: Partial<Record<HospNotaTipo, string>> = {
  HISTORIA_CLINICA: "Historia clínica",
  INGRESO: "Nota de ingreso",
  EVOLUCION: "Nota de evolución",
  HOJA_URGENCIAS: "Hoja de urgencias",
  POSTOPERATORIA: "Nota postoperatoria",
  EGRESO: "Nota de egreso",
  INTERCONSULTA: "Interconsulta",
};

function numero(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Nombre del medicamento sin el sufijo «· lote X · n pz» que pone aplicar-insumo. */
function nombreDeDescripcion(descripcion: string): string {
  return descripcion.split(" · ")[0]?.trim() || descripcion;
}

export async function cargarDatos(db: Db, args: CargarDatosArgs): Promise<DatosResumen> {
  if (!TIPOS_RESUMEN.includes(args.tipo)) throw new HospitalError(400, `tipo inválido: ${args.tipo} (EPISODIO, EGRESO o REFERENCIA)`);

  const ep = await db.hospEpisodio.findUnique({
    where: { id: args.episodioId },
    include: {
      paciente: true,
      medico: true,
      pagador: { include: { customer: { select: { rfc: true } } } },
      recurso: { select: { nombre: true, area: true } },
      notas: {
        orderBy: [{ fecha: "asc" }, { createdAt: "asc" }],
        include: { medico: { select: { nombre: true, cedula: true } }, reemplazadaPor: { select: { id: true } } },
      },
      signos: { orderBy: { fecha: "asc" }, take: 500 },
      cargos: {
        where: { categoria: "FARMACIA", cancelado: false },
        orderBy: { fecha: "asc" },
        include: {
          movimientoInsumo: {
            include: {
              insumo: { select: { nombre: true, categoria: true, presentacion: true, sustanciaActiva: true, unidad: true } },
              lote: { select: { lote: true } },
            },
          },
          medico: { select: { nombre: true, cedula: true } },
          nota: { select: { secciones: true } },
        },
      },
      egresoSaeh: true,
    },
  });
  if (!ep || ep.companyId !== args.companyId) throw new HospitalError(404, "Episodio no encontrado");
  if (ep.estado === "CANCELADO") throw new HospitalError(409, `El episodio ${ep.folio} está cancelado: no tiene resumen clínico`);
  if (args.tipo === "EGRESO" && ep.estado !== "ALTA") {
    throw new HospitalError(409, `El resumen de egreso se emite cuando el episodio ${ep.folio} tiene alta; hoy está ${ep.estado.replace(/_/g, " ").toLowerCase()}`);
  }
  const destinatario = args.destinatario && limpiar(args.destinatario.nombre) ? { ...args.destinatario, nombre: args.destinatario.nombre.trim() } : null;
  if (args.tipo === "REFERENCIA" && !destinatario) {
    throw new HospitalError(400, "La nota de referencia necesita destinatario (destinatarioNombre y, de preferencia, destinatarioCedula y destinatarioClues)");
  }

  const [config, company, documentos] = await Promise.all([
    db.hospConfig.findUnique({ where: { companyId: ep.companyId } }),
    db.company.findUnique({
      where: { id: ep.companyId },
      select: { razonSocial: true, nombreComercial: true, rfc: true, telefono: true, email: true, domicilioFiscal: true, codigoPostal: true },
    }),
    db.hospDocumento.findMany({
      where: { OR: [{ episodioId: ep.id }, { pacienteId: ep.pacienteId, episodioId: null, tipo: "POLIZA" }] },
      orderBy: { createdAt: "asc" },
      select: { tipo: true, nombre: true, estado: true, createdAt: true, contenido: true },
    }),
  ]);
  if (!company) throw new HospitalError(404, "Empresa no encontrada");

  const notas: NotaResumen[] = ep.notas
    .filter((n) => !n.reemplazadaPor)
    .map((n) => ({
      id: n.id,
      tipo: n.tipo,
      fecha: n.fecha,
      autorNombre: n.autorNombre,
      autorCedula: n.autorCedula ?? n.medico?.cedula ?? null,
      texto: n.texto,
      secciones: objeto(n.secciones),
    }));

  // ── Motivo de referencia: lo que mandaron o la nota de referencia vigente ──
  let motivoReferencia = limpiar(args.motivo);
  if (args.tipo === "REFERENCIA" && !motivoReferencia) {
    const ref = [...notas].reverse().find((n) => n.tipo === "REFERENCIA");
    motivoReferencia = textoDe(ref?.secciones?.motivoEnvio) ?? limpiar(ref?.texto);
    if (!motivoReferencia) throw new HospitalError(400, "Indica el motivo de la referencia (motivo=) o registra antes la nota de referencia");
  }

  // ── Diagnósticos codificados: episodio, SAEH y los que el médico escribió en las notas ──
  const saeh = ep.egresoSaeh;
  const comorbilidades = (Array.isArray(saeh?.comorbilidades) ? saeh!.comorbilidades : []) as Array<Record<string, unknown>>;
  const candidatos: Array<Omit<DiagnosticoResumen, "clave" | "nombre">> = [];
  if (ep.diagnosticoIngresoCie10) candidatos.push({ tipo: "Ingreso", codigo: ep.diagnosticoIngresoCie10, fecha: ep.fechaIngreso, texto: limpiar(ep.diagnostico) });
  if (ep.diagnosticoEgresoCie10) {
    candidatos.push({ tipo: "Egreso", codigo: ep.diagnosticoEgresoCie10, fecha: ep.fechaAlta, texto: textoDe(notas.find((n) => n.tipo === "EGRESO")?.secciones?.diagnosticoEgreso) ?? limpiar(ep.diagnostico) });
  }
  for (const c of comorbilidades) {
    const codigo = textoDe(c.codigo);
    if (codigo) candidatos.push({ tipo: "Comorbilidad", codigo, fecha: ep.fechaAlta, texto: textoDe(c.descripcion) });
  }
  if (saeh?.codigoCausaExterna) candidatos.push({ tipo: "Causa externa", codigo: saeh.codigoCausaExterna, fecha: ep.fechaIngreso, texto: limpiar(saeh.causaExterna) });
  for (const n of notas) {
    const secciones = SECCIONES_DIAGNOSTICO[n.tipo];
    if (!secciones || !n.secciones) continue;
    for (const s of secciones) {
      const texto = textoDe(n.secciones[s]);
      for (const codigo of extraerCodigosCie10(texto)) {
        candidatos.push({ tipo: ETIQUETA_NOTA[n.tipo] ?? n.tipo, codigo, fecha: n.fecha, texto });
      }
    }
  }
  const vistos = new Set<string>();
  const diagnosticos: DiagnosticoResumen[] = [];
  for (const c of candidatos) {
    const codigo = normalizarCodigoCie(c.codigo);
    const llave = claveDeCodigoCie(codigo);
    // El mismo código no se repite; el episodio (Ingreso/Egreso) gana sobre las notas.
    if (vistos.has(`${llave}|${c.tipo}`)) continue;
    if (c.tipo !== "Ingreso" && c.tipo !== "Egreso" && [...vistos].some((v) => v.startsWith(`${llave}|`))) continue;
    vistos.add(`${llave}|${c.tipo}`);
    const fila = await buscarCie(db, "CIE10", codigo);
    diagnosticos.push({ ...c, codigo: fila?.codigo ?? codigo, clave: fila?.clave ?? llave, nombre: fila?.nombre ?? null });
  }

  // ── Procedimientos: el del episodio y los de la hoja SAEH ──
  const postoperatoria = [...notas].reverse().find((n) => n.tipo === "POSTOPERATORIA");
  const notaProcedimiento = [...notas].reverse().find((n) => n.tipo === "PROCEDIMIENTO");
  const pasoPorQuirofano = !!postoperatoria || ep.estado === "EN_QUIROFANO" || ep.estado === "POSTOPERATORIO";
  const procedimientos: ProcedimientoResumen[] = [];
  const agregarProcedimiento = async (p: Omit<ProcedimientoResumen, "clave" | "nombre">) => {
    const codigo = normalizarCodigoCie(p.codigo);
    const llave = claveDeCodigoCie(codigo);
    if (procedimientos.some((x) => x.clave === llave)) return;
    const fila = await buscarCie(db, "CIE9MC", codigo);
    procedimientos.push({ ...p, codigo: fila?.codigo ?? codigo, clave: fila?.clave ?? llave, nombre: fila?.nombre ?? null });
  };
  if (ep.procedimientoCie9) {
    await agregarProcedimiento({
      codigo: ep.procedimientoCie9,
      fecha: postoperatoria?.fecha ?? notaProcedimiento?.fecha ?? null,
      texto: textoDe(postoperatoria?.secciones?.operacionRealizada) ?? limpiar(ep.procedimiento),
      medicoNombre: ep.medico?.nombre ?? null,
      medicoCedula: ep.medico?.cedula ?? null,
      quirofano: pasoPorQuirofano,
      anestesia: textoDe([...notas].reverse().find((n) => n.tipo === "PREANESTESICA")?.secciones?.tipoAnestesia),
    });
  }
  const procedimientosSaeh = (Array.isArray(saeh?.procedimientos) ? saeh!.procedimientos : []) as Array<Record<string, unknown>>;
  for (const p of procedimientosSaeh) {
    const codigo = textoDe(p.codigo);
    if (!codigo) continue;
    await agregarProcedimiento({
      codigo,
      fecha: postoperatoria?.fecha ?? ep.fechaAlta,
      texto: textoDe(p.descripcion),
      medicoNombre: null,
      medicoCedula: textoDe(p.cedula),
      quirofano: textoDe(p.quirofano) === "1" || p.quirofano === true,
      anestesia: textoDe(p.tipoAnestesia),
    });
  }

  // ── Medicamentos aplicados: cargos de farmacia con su lote y la nota que los generó ──
  const medicamentos: MedicamentoResumen[] = ep.cargos.map((c) => {
    const insumo = c.movimientoInsumo?.insumo ?? null;
    const secciones = objeto(c.nota?.secciones);
    return {
      id: c.id,
      fecha: c.fecha,
      nombre: insumo?.nombre ?? textoDe(secciones?.medicamento) ?? nombreDeDescripcion(c.descripcion),
      categoria: insumo?.categoria ?? null,
      presentacion: insumo?.presentacion ?? null,
      sustanciaActiva: insumo?.sustanciaActiva ?? null,
      cantidad: Number(c.cantidad),
      unidad: insumo?.unidad ?? "pieza",
      lote: c.movimientoInsumo?.lote?.lote ?? textoDe(secciones?.lote),
      dosis: textoDe(secciones?.dosis),
      via: textoDe(secciones?.via),
      observaciones: textoDe(secciones?.reaccion),
      medicoNombre: c.medico?.nombre ?? null,
      medicoCedula: c.medico?.cedula ?? null,
    };
  });

  // ── Póliza: documento POLIZA del paciente o del episodio ──
  const docs: DocumentoResumen[] = documentos.map((d) => ({ tipo: d.tipo, nombre: d.nombre, estado: d.estado, createdAt: d.createdAt, contenido: objeto(d.contenido) }));
  const poliza = docs.filter((d) => d.tipo === "POLIZA").map((d) => textoDe(d.contenido?.poliza)).find((p) => !!p) ?? null;

  const p = ep.paciente;
  return {
    tipo: args.tipo,
    companyId: ep.companyId,
    hospital: {
      nombre: limpiar(config?.nombreHospital) ?? limpiar(company.nombreComercial) ?? company.razonSocial,
      razonSocial: company.razonSocial,
      rfc: limpiar(company.rfc),
      clues: limpiar(config?.clues),
      licenciaSanitaria: limpiar(config?.licenciaSanitaria),
      oidRaiz: limpiar(config?.oidRaiz),
      telefono: limpiar(company.telefono),
      email: limpiar(company.email),
      domicilio: limpiar(company.domicilioFiscal),
      codigoPostal: limpiar(company.codigoPostal),
      responsableSanitario: limpiar(config?.responsableSanitario),
      responsableSanitarioCedula: limpiar(config?.responsableSanitarioCedula),
    },
    usuario: args.usuario ? { id: args.usuario.id ?? null, email: args.usuario.email ?? null, nombre: args.usuario.nombre ?? null } : null,
    paciente: {
      id: p.id,
      expedienteNumero: limpiar(p.expedienteNumero),
      nombre: p.nombre,
      apellidoPaterno: p.apellidoPaterno,
      apellidoMaterno: limpiar(p.apellidoMaterno),
      curp: limpiar(p.curp),
      sinCurp: p.sinCurp,
      rfc: limpiar(p.rfc),
      sexo: p.sexo,
      fechaNacimiento: p.fechaNacimiento,
      telefono: limpiar(p.telefono),
      email: limpiar(p.email),
      domicilio: limpiar(p.domicilio),
      calle: limpiar(p.calle),
      numeroExterior: limpiar(p.numeroExterior),
      numeroInterior: limpiar(p.numeroInterior),
      colonia: limpiar(p.colonia),
      municipio: limpiar(p.municipio),
      estado: limpiar(p.estado),
      codigoPostal: limpiar(p.codigoPostal),
      paisResidenciaClave: limpiar(p.paisResidenciaClave),
      entidadResidenciaClave: limpiar(p.entidadResidenciaClave),
      municipioResidenciaClave: limpiar(p.municipioResidenciaClave),
      localidadResidenciaClave: limpiar(p.localidadResidenciaClave),
      nacionalidad: limpiar(p.nacionalidad),
      entidadNacimientoClave: limpiar(p.entidadNacimientoClave),
      estadoConyugal: p.estadoConyugal,
      hablaLenguaIndigena: p.hablaLenguaIndigena,
      lenguaIndigenaClave: limpiar(p.lenguaIndigenaClave),
      tipoSangre: limpiar(p.tipoSangre),
      alergias: limpiar(p.alergias),
      antecedentes: limpiar(p.antecedentes),
      contactoEmergenciaNombre: limpiar(p.contactoEmergenciaNombre),
      contactoEmergenciaTelefono: limpiar(p.contactoEmergenciaTelefono),
      contactoEmergenciaParentesco: limpiar(p.contactoEmergenciaParentesco),
      derechohabienciaClave: limpiar(p.derechohabienciaClave),
    },
    episodio: {
      id: ep.id,
      folio: ep.folio,
      tipo: ep.tipo,
      estado: ep.estado,
      fechaIngreso: ep.fechaIngreso,
      fechaAlta: ep.fechaAlta,
      motivoEgreso: ep.motivoEgreso,
      motivo: limpiar(ep.motivo),
      diagnostico: limpiar(ep.diagnostico),
      procedimiento: limpiar(ep.procedimiento),
      autorizacionPagador: limpiar(ep.autorizacionPagador),
      area: ep.recurso?.area ?? null,
      recursoNombre: ep.recurso?.nombre ?? null,
      asa: limpiar(ep.asa),
      aldreteEgreso: ep.aldreteEgreso,
      triageNivel: ep.triageNivel,
    },
    medico: ep.medico
      ? {
          nombre: ep.medico.nombre,
          nombres: limpiar(ep.medico.nombres),
          apellidoPaterno: limpiar(ep.medico.apellidoPaterno),
          apellidoMaterno: limpiar(ep.medico.apellidoMaterno),
          cedula: limpiar(ep.medico.cedula),
          especialidad: limpiar(ep.medico.especialidad),
        }
      : null,
    pagador: ep.pagador
      ? {
          nombre: ep.pagador.nombre,
          tipo: ep.pagador.tipo,
          rfc: limpiar(ep.pagador.customer?.rfc),
          vigenciaInicio: ep.pagador.vigenciaInicio,
          vigenciaFin: ep.pagador.vigenciaFin,
          poliza,
        }
      : null,
    diagnosticos,
    procedimientos,
    medicamentos,
    notas,
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
      registradoPor: s.registradoPor,
    })),
    documentos: docs,
    destinatario,
    motivoReferencia,
  };
}
