// ─────────────────────────────────────────────────────────────────────────────
// Textos legales del paquete de admisión (firma electrónica simple, Código de
// Comercio art. 89 y LFPDPPP): contrato de servicios, compromiso de pago,
// cesión de derechos a la aseguradora, consentimiento de datos sensibles,
// aviso de privacidad y consentimiento de ingreso (NOM-004 10.1.1).
//
// Cada plantilla tiene versión. El hospital puede sustituir cualquiera desde
// HospConfig.plantillasDocumentos[tipo] = { version, texto }; si no, aplica la
// default de aquí. `renderizarPlantilla` resuelve los marcadores
// {{paciente.*}}, {{hospital.*}}, {{episodio.*}}, {{pagador.*}}, {{fecha}},
// {{plantilla.version}} y {{contenido.*}}; los desconocidos quedan vacíos y se
// listan como advertencias. El texto resuelto es lo que se firma
// (HospDocumento.textoFirmado) y su hash junto con `contenido` es
// `hashContenido`, que cada HospFirma repite como `hashDocumento`.
//
// Puro (sin Prisma): el satélite puede espejarlo para la vista previa.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import type { HospDocumentoTipo, HospFirmanteRol } from "@prisma/client";

export const VERSION_PLANTILLAS_DEFAULT = "2026-09";

export const TIPOS_CON_PLANTILLA = [
  "CONTRATO_SERVICIOS",
  "COMPROMISO_PAGO",
  "CESION_DERECHOS",
  "CONSENTIMIENTO_DATOS",
  "AVISO_PRIVACIDAD",
  "CONSENTIMIENTO_HOSPITALIZACION",
] as const satisfies readonly HospDocumentoTipo[];

export type TipoConPlantilla = (typeof TIPOS_CON_PLANTILLA)[number];

export interface PlantillaLegal {
  version: string;
  titulo: string;
  texto: string;
}

export const PLANTILLAS_LEGALES_DEFAULT: Record<TipoConPlantilla, PlantillaLegal> = {
  CONTRATO_SERVICIOS: {
    version: VERSION_PLANTILLAS_DEFAULT,
    titulo: "Contrato de prestación de servicios hospitalarios",
    texto: `CONTRATO DE PRESTACIÓN DE SERVICIOS HOSPITALARIOS

Que celebran, por una parte, {{hospital.razonSocial}} (en adelante «el Hospital»), establecimiento de atención médica con CLUES {{hospital.clues}} y licencia sanitaria {{hospital.licenciaSanitaria}}, bajo la responsabilidad sanitaria de {{hospital.responsableSanitario}}, y por la otra {{paciente.nombreCompleto}}, CURP {{paciente.curp}}, con domicilio en {{paciente.domicilio}} (en adelante «el Paciente»), con relación al ingreso {{episodio.folio}} del {{episodio.fechaIngreso}}, al tenor de las siguientes cláusulas:

PRIMERA. OBJETO. El Hospital se obliga a prestar al Paciente los servicios de atención médica, hospitalización, quirófano, enfermería, estudios de laboratorio y gabinete, medicamentos, materiales e insumos que requiera su padecimiento conforme a las indicaciones del médico tratante, con apego a la Ley General de Salud, su Reglamento en materia de prestación de servicios de atención médica y las Normas Oficiales Mexicanas aplicables (NOM-004-SSA3-2012, NOM-016-SSA3-2012, NOM-026-SSA3-2012).

SEGUNDA. TARIFAS Y COTIZACIÓN. Los servicios se cobran conforme al tarifario vigente del Hospital o, en su caso, al convenio celebrado con {{pagador.nombre}}. La cotización entregada en la admisión es estimada: la cuenta final refleja los servicios efectivamente prestados y registrados en el expediente clínico, y puede consultarse en cualquier momento durante la estancia.

TERCERA. DEPÓSITO Y PAGO. El Paciente, o el responsable de pago que firma el compromiso correspondiente, entrega el depósito indicado en la admisión y liquida el saldo de la cuenta al egreso. Los honorarios de los médicos tratantes son independientes de los servicios del Hospital, se informan por separado y son facturados por cada profesional.

CUARTA. RESPONSABILIDADES DEL HOSPITAL. Prestar los servicios con personal de salud que cuenta con cédula profesional, en instalaciones y con equipo amparados por la licencia sanitaria; integrar, conservar y resguardar el expediente clínico por lo menos cinco años a partir del último acto médico; y entregar al Paciente, a su solicitud, el resumen clínico correspondiente.

QUINTA. RESPONSABILIDADES DEL PACIENTE. Proporcionar información veraz y completa sobre su estado de salud, antecedentes y alergias; seguir las indicaciones del personal de salud; respetar el reglamento interno del Hospital; y cubrir la cuenta en los términos de este contrato.

SEXTA. CONSENTIMIENTO INFORMADO. Todo procedimiento quirúrgico, anestésico, de transfusión o de riesgo se realiza previa carta de consentimiento informado firmada por el Paciente o su representante legal, con dos testigos y el médico que informa, conforme al numeral 10.1 de la NOM-004-SSA3-2012. Dichas cartas forman parte integrante de este contrato.

SÉPTIMA. DATOS PERSONALES. El Hospital trata los datos personales y los datos sensibles de salud del Paciente conforme a la Ley Federal de Protección de Datos Personales en Posesión de los Particulares y a su Aviso de Privacidad ({{hospital.avisoPrivacidadUrl}}), que el Paciente declara haber conocido antes de la firma.

OCTAVA. VIGENCIA. Este contrato surte efectos desde su firma y hasta el egreso del Paciente y la liquidación total de la cuenta.

Leído que fue por las partes y enteradas de su contenido y alcance legal, lo firman el {{fecha}}. Versión de la plantilla: {{plantilla.version}}.`,
  },
  COMPROMISO_PAGO: {
    version: VERSION_PLANTILLAS_DEFAULT,
    titulo: "Compromiso de pago (responsable solidario)",
    texto: `COMPROMISO DE PAGO Y RESPONSABILIDAD SOLIDARIA

Quien firma al calce como RESPONSABLE DE PAGO se obliga solidariamente con el Paciente {{paciente.nombreCompleto}} (CURP {{paciente.curp}}) frente a {{hospital.razonSocial}} (el Hospital) al pago de la cuenta hospitalaria del ingreso {{episodio.folio}} iniciado el {{episodio.fechaIngreso}}, en los términos siguientes:

1. SALDO. Reconoce que la cuenta comprende todos los servicios registrados en el expediente clínico —hospitalización, quirófano, medicamentos, materiales, estudios y honorarios que pasen por la cuenta— y que el saldo a su cargo es el que resulte después de aplicar, en su caso, el deducible, el coaseguro y el monto autorizado por {{pagador.nombre}}. Los conceptos que el pagador rechace, no cubra o no autorice quedan íntegramente a su cargo.

2. FORMA Y PLAZO DE PAGO. El saldo se liquida al egreso del Paciente, en efectivo, tarjeta o transferencia, contra el estado de cuenta que entrega el Hospital. El Hospital emite el comprobante fiscal (CFDI) al receptor fiscal que se le indique.

3. INTERESES MORATORIOS. Vencido el plazo sin pago, el saldo insoluto genera un interés moratorio del 3 % (tres por ciento) mensual, sin perjuicio de los gastos y costas de cobranza que se originen.

4. JURISDICCIÓN. Para la interpretación y cumplimiento de este compromiso las partes se someten a las leyes aplicables y a los tribunales competentes del domicilio del Hospital, renunciando a cualquier otro fuero que pudiera corresponderles.

Firma el {{fecha}}. Versión de la plantilla: {{plantilla.version}}.`,
  },
  CESION_DERECHOS: {
    version: VERSION_PLANTILLAS_DEFAULT,
    titulo: "Cesión de derechos y asignación de beneficios a la aseguradora",
    texto: `CESIÓN DE DERECHOS Y ASIGNACIÓN DE BENEFICIOS

{{paciente.nombreCompleto}}, CURP {{paciente.curp}}, asegurado(a) de {{pagador.nombre}} (la Aseguradora), con relación al ingreso {{episodio.folio}} del {{episodio.fechaIngreso}}:

1. CEDE a favor de {{hospital.razonSocial}} (el Hospital) el derecho a cobrar directamente a la Aseguradora los beneficios de su póliza que correspondan a los servicios de este ingreso, hasta por el monto que la Aseguradora autorice y pague.

2. AUTORIZA al Hospital a presentar en su nombre la reclamación, los informes médicos, estudios, notas del expediente y la documentación soporte que la Aseguradora requiera para dictaminar la procedencia del siniestro.

3. RECONOCE que el deducible, el coaseguro, los conceptos no cubiertos por la póliza y los montos que la Aseguradora rechace o no autorice son a su cargo o del responsable de pago, y que esta cesión no lo(a) libera de esa obligación.

4. CONSIENTE la transferencia a la Aseguradora de los datos personales y de salud estrictamente necesarios para tramitar la reclamación, con esa única finalidad (LFPDPPP art. 36).

Firma el {{fecha}}. Versión de la plantilla: {{plantilla.version}}.`,
  },
  CONSENTIMIENTO_DATOS: {
    version: VERSION_PLANTILLAS_DEFAULT,
    titulo: "Consentimiento expreso para el tratamiento de datos personales sensibles",
    texto: `CONSENTIMIENTO EXPRESO PARA EL TRATAMIENTO DE DATOS PERSONALES SENSIBLES

Yo, {{paciente.nombreCompleto}}, CURP {{paciente.curp}}, manifiesto que {{hospital.razonSocial}} (el Responsable) me dio a conocer, a través de su Aviso de Privacidad integral ({{hospital.avisoPrivacidadUrl}}), la identidad y domicilio del Responsable, los datos que recaba, las finalidades del tratamiento, las transferencias que realiza y los medios para ejercer mis derechos.

Con fundamento en los artículos 8, 9 y 36 de la Ley Federal de Protección de Datos Personales en Posesión de los Particulares, OTORGO MI CONSENTIMIENTO EXPRESO Y POR ESCRITO para:

a) El tratamiento de mis datos personales sensibles —estado de salud presente, pasado y futuro, diagnósticos, tratamientos, medicamentos, resultados de estudios y demás información clínica— con las finalidades de prestación de los servicios de atención médica, integración y conservación del expediente clínico, facturación y cobranza, y cumplimiento de las obligaciones sanitarias, fiscales y legales del Responsable.

b) La transferencia de los datos estrictamente necesarios a {{pagador.nombre}} (aseguradora o convenio que cubre la atención) para la autorización, reclamación y pago de los servicios; a los médicos tratantes y laboratorios o gabinetes externos que participen en mi atención; y a las autoridades sanitarias y fiscales cuando una ley lo exija.

Entiendo que puedo ejercer mis derechos de acceso, rectificación, cancelación y oposición, así como revocar este consentimiento, por los medios señalados en el Aviso de Privacidad, sin efectos retroactivos y con las limitaciones que impone la conservación obligatoria del expediente clínico (NOM-004-SSA3-2012).

Firma el {{fecha}}. Versión de la plantilla: {{plantilla.version}}.`,
  },
  AVISO_PRIVACIDAD: {
    version: VERSION_PLANTILLAS_DEFAULT,
    titulo: "Aviso de privacidad integral (constancia de aceptación)",
    texto: `AVISO DE PRIVACIDAD INTEGRAL PARA PACIENTES

RESPONSABLE. {{hospital.razonSocial}}, con domicilio en {{hospital.domicilio}} y medios de contacto {{hospital.contacto}}, es responsable del tratamiento de sus datos personales conforme a la Ley Federal de Protección de Datos Personales en Posesión de los Particulares y su Reglamento.

DATOS QUE RECABAMOS. Datos de identificación y contacto (nombre, CURP, RFC, fecha de nacimiento, sexo, nacionalidad, domicilio, teléfono, correo electrónico e identificación oficial); datos de la persona responsable de pago y del contacto de emergencia; datos patrimoniales y financieros necesarios para la facturación y el cobro; y datos personales SENSIBLES de salud: antecedentes, diagnósticos, tratamientos, medicamentos, estudios y toda la información que integra el expediente clínico.

FINALIDADES PRIMARIAS. Prestar los servicios de atención médica y hospitalaria; integrar, conservar y resguardar el expediente clínico (NOM-004-SSA3-2012); gestionar la cuenta, la facturación y la cobranza; tramitar la cobertura con la aseguradora o convenio del paciente; y cumplir las obligaciones legales, sanitarias y fiscales del Hospital, incluidos los reportes al Sistema de Información en Salud.

FINALIDADES SECUNDARIAS. Encuestas de calidad, recordatorios de citas y seguimiento posterior al egreso. Puede oponerse a ellas en cualquier momento por los medios de contacto indicados sin que ello afecte su atención.

TRANSFERENCIAS. Sus datos pueden transferirse, con las finalidades descritas, a la aseguradora o convenio que cubre la atención, a los médicos tratantes y a laboratorios o gabinetes que participen en ella, y a las autoridades sanitarias y fiscales cuando una ley lo exija. Toda otra transferencia requiere su consentimiento expreso.

DERECHOS ARCO Y REVOCACIÓN. Puede acceder, rectificar y cancelar sus datos, oponerse a su tratamiento y revocar su consentimiento presentando su solicitud en {{hospital.contacto}}, acreditando su identidad. La cancelación no procede respecto del expediente clínico durante el plazo de conservación obligatoria.

CAMBIOS AL AVISO. Las actualizaciones se publican en {{hospital.avisoPrivacidadUrl}}.

CONSTANCIA. Yo, {{paciente.nombreCompleto}}, CURP {{paciente.curp}}, declaro que el {{fecha}} se me dio a conocer el presente Aviso de Privacidad (versión {{plantilla.version}}) y que consiento el tratamiento de mis datos personales, incluidos los sensibles de salud, en los términos aquí descritos.`,
  },
  CONSENTIMIENTO_HOSPITALIZACION: {
    version: VERSION_PLANTILLAS_DEFAULT,
    titulo: "Carta de consentimiento informado para ingreso hospitalario",
    texto: `CARTA DE CONSENTIMIENTO INFORMADO PARA INGRESO HOSPITALARIO

Establecimiento: {{hospital.razonSocial}} · CLUES {{hospital.clues}} · Licencia sanitaria {{hospital.licenciaSanitaria}}
Paciente: {{paciente.nombreCompleto}} · CURP {{paciente.curp}} · Expediente {{paciente.expedienteNumero}}
Ingreso: {{episodio.folio}} del {{episodio.fechaIngreso}} · Médico tratante: {{episodio.medico}}

Yo, {{paciente.nombreCompleto}}, o en su caso mi representante legal, en pleno uso de mis facultades, declaro que el médico tratante me informó en lenguaje claro y comprensible sobre mi diagnóstico ({{episodio.diagnostico}}), el plan de atención propuesto ({{contenido.procedimiento}}), los beneficios esperados ({{contenido.beneficios}}), los riesgos y las complicaciones posibles ({{contenido.riesgos}}), las alternativas de tratamiento ({{contenido.alternativas}}) y las consecuencias de no aceptarlo, y que se resolvieron todas mis dudas.

AUTORIZO mi ingreso hospitalario y la realización de los procedimientos diagnósticos y terapéuticos que el equipo médico considere necesarios para mi atención, así como la administración de medicamentos y los cuidados de enfermería que ésta requiera. Autorizo igualmente los procedimientos adicionales que resulten indispensables ante una situación imprevista durante la atención, salvo los que expresamente excluya por escrito.

Se me informó que puedo revocar este consentimiento en cualquier momento, que el expediente clínico es propiedad del establecimiento y la información en él contenida es de mi titularidad, y que puedo solicitar un resumen clínico.

Firmado por el paciente o su representante legal, en presencia de dos testigos y del médico que informó, conforme al numeral 10.1.1 de la NOM-004-SSA3-2012 y a los artículos 80 a 83 del Reglamento de la Ley General de Salud en materia de prestación de servicios de atención médica, el {{fecha}}. Versión de la plantilla: {{plantilla.version}}.`,
  },
};

// ── Firmas requeridas por tipo ───────────────────────────────────────────────

const PACIENTE_O_REPRESENTANTE = "PACIENTE|REPRESENTANTE";
const CONSENTIMIENTO_NOM004 = [PACIENTE_O_REPRESENTANTE, "TESTIGO1", "TESTIGO2", "MEDICO"] as const;

/**
 * Cada entrada es un grupo de alternativas separadas por «|»: basta una firma
 * de cualquier rol del grupo. Los tipos ausentes no se firman electrónicamente
 * (identificación, póliza, estudios…): se reciben como archivo.
 */
export const FIRMAS_REQUERIDAS: Partial<Record<HospDocumentoTipo, readonly string[]>> = {
  CONTRATO_SERVICIOS: [PACIENTE_O_REPRESENTANTE, "HOSPITAL"],
  COMPROMISO_PAGO: ["RESPONSABLE_PAGO"],
  CESION_DERECHOS: [PACIENTE_O_REPRESENTANTE],
  AVISO_PRIVACIDAD: [PACIENTE_O_REPRESENTANTE],
  CONSENTIMIENTO_DATOS: [PACIENTE_O_REPRESENTANTE],
  CONSENTIMIENTO_HOSPITALIZACION: CONSENTIMIENTO_NOM004,
  CONSENTIMIENTO_CIRUGIA: CONSENTIMIENTO_NOM004,
  CONSENTIMIENTO_ANESTESIA: CONSENTIMIENTO_NOM004,
  CONSENTIMIENTO_TRANSFUSION: CONSENTIMIENTO_NOM004,
  HOJA_EGRESO: [PACIENTE_O_REPRESENTANTE, "MEDICO"],
  IDENTIFICACION: [],
  CONSTANCIA_CURP: [],
};

export const ROLES_FIRMANTE: readonly HospFirmanteRol[] = ["PACIENTE", "REPRESENTANTE", "TESTIGO1", "TESTIGO2", "MEDICO", "RESPONSABLE_PAGO", "HOSPITAL"];

export function firmasRequeridasPara(tipo: HospDocumentoTipo): string[] {
  return [...(FIRMAS_REQUERIDAS[tipo] ?? [])];
}

/** Lo guardado en HospDocumento.firmasRequeridas (JSON) → grupos válidos; lo raro se descarta. */
export function parsearFirmasRequeridas(json: unknown): string[] {
  if (!Array.isArray(json)) return [];
  const roles = new Set<string>(ROLES_FIRMANTE);
  const grupos: string[] = [];
  for (const g of json) {
    if (typeof g !== "string") continue;
    const partes = g.split("|").map((s) => s.trim().toUpperCase()).filter((s) => roles.has(s));
    if (partes.length) grupos.push(partes.join("|"));
  }
  return grupos;
}

// ── Plantillas configuradas por el hospital ──────────────────────────────────

export type PlantillasConfig = Partial<Record<string, { version: string; texto: string }>>;

const MAX_TEXTO_PLANTILLA = 200_000;

/** Valida HospConfig.plantillasDocumentos: { [tipo]: { version, texto } } sólo para tipos con plantilla. */
export function validarPlantillasConfig(v: unknown): { ok: true; valor: Record<string, { version: string; texto: string }> } | { ok: false; error: string } {
  if (v == null) return { ok: true, valor: {} };
  if (typeof v !== "object" || Array.isArray(v)) return { ok: false, error: "plantillasDocumentos debe ser un objeto { TIPO: { version, texto } }" };
  const valor: Record<string, { version: string; texto: string }> = {};
  for (const [tipo, p] of Object.entries(v as Record<string, unknown>)) {
    if (!(TIPOS_CON_PLANTILLA as readonly string[]).includes(tipo)) {
      return { ok: false, error: `plantillasDocumentos: «${tipo}» no admite plantilla (válidos: ${TIPOS_CON_PLANTILLA.join(", ")})` };
    }
    if (p == null) continue; // null = volver a la default
    if (typeof p !== "object" || Array.isArray(p)) return { ok: false, error: `plantillasDocumentos.${tipo} debe ser { version, texto }` };
    const { version, texto } = p as { version?: unknown; texto?: unknown };
    if (typeof version !== "string" || !version.trim() || version.trim().length > 40) return { ok: false, error: `plantillasDocumentos.${tipo}.version es obligatoria (máx. 40 caracteres)` };
    if (typeof texto !== "string" || !texto.trim()) return { ok: false, error: `plantillasDocumentos.${tipo}.texto es obligatorio` };
    if (texto.length > MAX_TEXTO_PLANTILLA) return { ok: false, error: `plantillasDocumentos.${tipo}.texto excede ${MAX_TEXTO_PLANTILLA} caracteres` };
    valor[tipo] = { version: version.trim(), texto };
  }
  return { ok: true, valor };
}

export interface PlantillaVigente extends PlantillaLegal {
  tipo: TipoConPlantilla;
  personalizada: boolean;
}

/** La plantilla que rige para el tipo: la del hospital si la configuró, si no la default. null si el tipo no lleva texto. */
export function plantillaVigente(tipo: HospDocumentoTipo, config: PlantillasConfig | null | undefined): PlantillaVigente | null {
  if (!(TIPOS_CON_PLANTILLA as readonly string[]).includes(tipo)) return null;
  const t = tipo as TipoConPlantilla;
  const propia = config?.[t];
  const base = PLANTILLAS_LEGALES_DEFAULT[t];
  if (propia && typeof propia.texto === "string" && propia.texto.trim() && typeof propia.version === "string" && propia.version.trim()) {
    return { tipo: t, titulo: base.titulo, version: propia.version.trim(), texto: propia.texto, personalizada: true };
  }
  return { tipo: t, ...base, personalizada: false };
}

/** Versión vigente por tipo (para la configuración y para saber si un aviso firmado sigue vigente). */
export function versionesVigentes(config: PlantillasConfig | null | undefined): Record<TipoConPlantilla, { version: string; personalizada: boolean }> {
  const out = {} as Record<TipoConPlantilla, { version: string; personalizada: boolean }>;
  for (const t of TIPOS_CON_PLANTILLA) {
    const p = plantillaVigente(t, config)!;
    out[t] = { version: p.version, personalizada: p.personalizada };
  }
  return out;
}

// ── Render ───────────────────────────────────────────────────────────────────

export interface ContextoPlantilla {
  paciente: {
    nombreCompleto: string;
    curp: string | null;
    rfc: string | null;
    domicilio: string | null;
    expedienteNumero: string | null;
    fechaNacimiento: string | null;
    telefono: string | null;
    email: string | null;
  };
  hospital: {
    razonSocial: string;
    nombreComercial: string | null;
    rfc: string | null;
    clues: string | null;
    licenciaSanitaria: string | null;
    responsableSanitario: string | null;
    responsableSanitarioCedula: string | null;
    domicilio: string | null;
    contacto: string | null;
    avisoPrivacidadUrl: string | null;
  };
  episodio: {
    folio: string;
    fechaIngreso: string;
    tipo: string;
    medico: string | null;
    diagnostico: string | null;
    procedimiento: string | null;
  } | null;
  pagador: { nombre: string; tipo: string } | null;
  /** Fecha de la firma/renderizado, ya formateada. */
  fecha: string;
  plantilla?: { version: string };
  contenido?: Record<string, unknown> | null;
}

export interface PlantillaRenderizada {
  tipo: TipoConPlantilla;
  titulo: string;
  version: string;
  texto: string;
  personalizada: boolean;
  advertencias: string[];
}

const MARCADOR_RE = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;

function aTexto(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "boolean") return v ? "Sí" : "No";
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "" : v.toISOString().slice(0, 10);
  if (Array.isArray(v)) return v.map(aTexto).filter(Boolean).join(", ");
  return "";
}

function resolverMarcador(ctx: ContextoPlantilla, ruta: string): { conocido: boolean; valor: string } {
  const partes = ruta.split(".");
  const raiz = partes[0] as keyof ContextoPlantilla;
  if (!(raiz in ctx) && raiz !== "plantilla" && raiz !== "contenido") return { conocido: false, valor: "" };
  let actual: unknown = ctx[raiz];
  for (let i = 1; i < partes.length; i++) {
    if (actual == null) return { conocido: true, valor: "" };
    if (typeof actual !== "object") return { conocido: false, valor: "" };
    const obj = actual as Record<string, unknown>;
    // Los bloques fijos tienen llaves conocidas; `contenido` es libre (dato faltante, no marcador desconocido).
    if (!(partes[i] in obj) && raiz !== "contenido") return { conocido: false, valor: "" };
    actual = obj[partes[i]];
  }
  if (partes.length === 1 && actual != null && typeof actual === "object") return { conocido: false, valor: "" };
  return { conocido: true, valor: aTexto(actual) };
}

/**
 * Texto de la plantilla con los marcadores resueltos. Marcador desconocido →
 * vacío + advertencia «Marcador desconocido»; dato ausente → vacío +
 * advertencia «Sin dato». null si el tipo no lleva plantilla.
 */
export function renderizarPlantilla(tipo: HospDocumentoTipo, ctx: ContextoPlantilla, config: PlantillasConfig | null | undefined): PlantillaRenderizada | null {
  const plantilla = plantillaVigente(tipo, config);
  if (!plantilla) return null;
  const advertencias: string[] = [];
  const vistos = new Set<string>();
  const contexto: ContextoPlantilla = { ...ctx, plantilla: ctx.plantilla ?? { version: plantilla.version } };
  const texto = plantilla.texto.replace(MARCADOR_RE, (_m, ruta: string) => {
    const r = resolverMarcador(contexto, ruta);
    if (!r.conocido) {
      if (!vistos.has(`?${ruta}`)) advertencias.push(`Marcador desconocido: {{${ruta}}}`);
      vistos.add(`?${ruta}`);
      return "";
    }
    if (!r.valor && !vistos.has(`!${ruta}`)) {
      advertencias.push(`Sin dato para {{${ruta}}}`);
      vistos.add(`!${ruta}`);
    }
    return r.valor;
  });
  return { tipo: plantilla.tipo, titulo: plantilla.titulo, version: plantilla.version, texto, personalizada: plantilla.personalizada, advertencias };
}

// ── Hash del documento ───────────────────────────────────────────────────────

/** JSON con llaves ordenadas: el mismo contenido siempre da el mismo hash. */
export function canonicalJson(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const obj = v as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}

/** sha256(textoFirmado + "\n" + contenido canónico): lo que cada firma atestigua. */
export function hashContenidoDocumento(textoFirmado: string, contenido: unknown): string {
  return createHash("sha256").update(textoFirmado, "utf8").update("\n").update(canonicalJson(contenido ?? null), "utf8").digest("hex");
}
