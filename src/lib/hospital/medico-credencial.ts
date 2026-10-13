// ─────────────────────────────────────────────────────────────────────────────
// Credencialización del médico: qué documentos pide el hospital, cuáles ya
// están verificados y vigentes, y qué vence pronto.
//
// Puro: recibe el médico y sus documentos (sin el archivo) y arma el resumen.
// El especialista (cualquier especialidad que no sea medicina general o
// familiar) además debe traer cédula de especialidad y certificación vigente
// del consejo. Lo que tiene vigencia (consejo, seguro de RC) vence; lo demás no.
// ─────────────────────────────────────────────────────────────────────────────

export const DIAS_POR_VENCER = 30;

/** Columnas del documento para listar (nunca el archivo). */
export const selectDocumento = {
  id: true, tipo: true, numero: true, emitidoPor: true, vigenciaHasta: true, estado: true, notas: true,
  verificadoPorNombre: true, verificadoAt: true, nombreArchivo: true, mime: true, bytes: true, createdAt: true,
} as const;

export const TIPOS_DOCUMENTO_MEDICO = {
  CEDULA_PROFESIONAL: { etiqueta: "Cédula profesional", vigencia: false },
  CEDULA_ESPECIALIDAD: { etiqueta: "Cédula de especialidad", vigencia: false },
  TITULO: { etiqueta: "Título", vigencia: false },
  CERTIFICACION_CONSEJO: { etiqueta: "Certificación del consejo", vigencia: true },
  SEGURO_RC: { etiqueta: "Seguro de responsabilidad civil", vigencia: true },
  INE: { etiqueta: "Identificación oficial", vigencia: true },
  CONSTANCIA_FISCAL: { etiqueta: "Constancia de situación fiscal", vigencia: false },
  CURRICULUM: { etiqueta: "Currículum", vigencia: false },
  CONTRATO: { etiqueta: "Convenio con el hospital", vigencia: true },
  OTRO: { etiqueta: "Otro", vigencia: true },
} as const;
export type TipoDocumentoMedico = keyof typeof TIPOS_DOCUMENTO_MEDICO;
export const TIPOS_DOCUMENTO = Object.keys(TIPOS_DOCUMENTO_MEDICO) as TipoDocumentoMedico[];

export const esEspecialista = (especialidad: string | null | undefined) =>
  !!especialidad?.trim() && !/general|familiar|^m[eé]dico$/i.test(especialidad);

/** Lo que el hospital exige para dar por credencializado. */
export function requeridos(m: { especialidad: string | null }): TipoDocumentoMedico[] {
  const base: TipoDocumentoMedico[] = ["CEDULA_PROFESIONAL", "INE", "CONSTANCIA_FISCAL", "SEGURO_RC", "CURRICULUM"];
  return esEspecialista(m.especialidad) ? ["CEDULA_PROFESIONAL", "CEDULA_ESPECIALIDAD", "CERTIFICACION_CONSEJO", ...base.slice(1)] : base;
}

export interface DocumentoMedicoResumen {
  id: string;
  tipo: string;
  estado: string;
  vigenciaHasta: Date | null;
  createdAt: Date;
}

export type EstadoRequisito = "OK" | "POR_VENCER" | "VENCIDO" | "POR_VERIFICAR" | "RECHAZADO" | "FALTA";
export type EstadoCredencial = "COMPLETO" | "POR_VENCER" | "VENCIDO" | "INCOMPLETO";

const inicioDia = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

function estadoDe(doc: DocumentoMedicoResumen | undefined, hoy: Date): EstadoRequisito {
  if (!doc) return "FALTA";
  if (doc.estado === "RECHAZADO") return "RECHAZADO";
  if (doc.vigenciaHasta) {
    const v = inicioDia(doc.vigenciaHasta).getTime();
    const h = inicioDia(hoy).getTime();
    if (v < h) return "VENCIDO";
    if (doc.estado !== "VERIFICADO") return "POR_VERIFICAR";
    return v - h <= DIAS_POR_VENCER * 86_400_000 ? "POR_VENCER" : "OK";
  }
  return doc.estado === "VERIFICADO" ? "OK" : "POR_VERIFICAR";
}

/**
 * Por cada tipo, el documento que cuenta: el verificado con la vigencia más
 * lejana; si no hay verificado, el más reciente (recibido o rechazado).
 */
export function vigentePorTipo(docs: DocumentoMedicoResumen[]): Map<string, DocumentoMedicoResumen> {
  const m = new Map<string, DocumentoMedicoResumen>();
  const peso = (d: DocumentoMedicoResumen) => (d.estado === "VERIFICADO" ? 2 : d.estado === "RECIBIDO" ? 1 : 0);
  for (const d of docs) {
    const a = m.get(d.tipo);
    const mejor =
      !a ||
      peso(d) > peso(a) ||
      (peso(d) === peso(a) && ((d.vigenciaHasta?.getTime() ?? Infinity) > (a.vigenciaHasta?.getTime() ?? Infinity) || ((d.vigenciaHasta?.getTime() ?? Infinity) === (a.vigenciaHasta?.getTime() ?? Infinity) && d.createdAt > a.createdAt)));
    if (mejor) m.set(d.tipo, d);
  }
  return m;
}

export function resumenCredencial(m: { especialidad: string | null }, docs: DocumentoMedicoResumen[], hoy = new Date()) {
  const porTipo = vigentePorTipo(docs);
  const req = requeridos(m);
  const requisitos = req.map((tipo) => {
    const doc = porTipo.get(tipo);
    return { tipo, etiqueta: TIPOS_DOCUMENTO_MEDICO[tipo].etiqueta, estado: estadoDe(doc, hoy), documentoId: doc?.id ?? null, vigenciaHasta: doc?.vigenciaHasta ?? null };
  });
  const cumplidos = requisitos.filter((r) => r.estado === "OK" || r.estado === "POR_VENCER").length;
  const vencidos = requisitos.filter((r) => r.estado === "VENCIDO");
  const porVencer = requisitos.filter((r) => r.estado === "POR_VENCER");
  const estado: EstadoCredencial = vencidos.length ? "VENCIDO" : cumplidos < req.length ? "INCOMPLETO" : porVencer.length ? "POR_VENCER" : "COMPLETO";
  const vigencias = requisitos.map((r) => r.vigenciaHasta).filter((v): v is Date => !!v && v >= inicioDia(hoy)).sort((a, b) => a.getTime() - b.getTime());
  return {
    estado,
    requeridos: req.length,
    cumplidos,
    faltan: requisitos.filter((r) => r.estado === "FALTA" || r.estado === "RECHAZADO").map((r) => r.etiqueta),
    porVerificar: requisitos.filter((r) => r.estado === "POR_VERIFICAR").length,
    vencidos: vencidos.map((r) => r.etiqueta),
    porVencer: porVencer.map((r) => r.etiqueta),
    proximoVencimiento: vigencias[0] ?? null,
    requisitos,
  };
}
