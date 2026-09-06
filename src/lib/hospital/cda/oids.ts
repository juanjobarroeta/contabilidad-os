// ─────────────────────────────────────────────────────────────────────────────
// OIDs, códigos y plantillas del CDA R2 «Resumen Clínico» (NOM-024-SSA3-2012
// 6.1.3.1 · GIIS-A001-01-05 · GIIS-A003-01-05).
//
// Cada constante dice de dónde sale. Las que vienen del anexo de la DGIS
// (`resumen_clinico_mx.xml`) pero no de un registro público llevan «sólo en
// el anexo» para que quien certifique sepa qué está fijo y qué es convención.
// Sólo constantes: sin lógica, sin imports.
// ─────────────────────────────────────────────────────────────────────────────

// ── Identificadores mexicanos (GIIS-A003-01-05, tabla de OIDs registrados) ──

/** CURP — Clave Única de Registro de Población (RENAPO). GIIS-A003. */
export const OID_CURP = "2.16.840.1.113883.4.629";
/** RFC — Registro Federal de Contribuyentes (SAT). GIIS-A003. */
export const OID_RFC = "2.16.840.1.113883.4.630";
/** CLUES — Clave Única de Establecimientos de Salud (DGIS). GIIS-A003. */
export const OID_CLUES = "2.16.840.1.113883.4.631";
/**
 * Cédula profesional (DGP/SEP) como identificador del médico. Arco
 * 2.16.840.1.113883.3.215.12 (Secretaría de Salud, catálogos); el .18 lo fija
 * el anexo de la GIIS-A001 en `legalAuthenticator`, `performer` y
 * `informationRecipient`.
 */
export const OID_CEDULA_PROFESIONAL = "2.16.840.1.113883.3.215.12.18";
/**
 * Licencia sanitaria del establecimiento (COFEPRIS). Arco
 * 2.16.840.1.113883.3.215.1 (Subsecretaría de Integración y Desarrollo del
 * Sector Salud); el .1 lo usa el anexo en `representedOrganization` y
 * `healthCareFacility`.
 */
export const OID_LICENCIA_SANITARIA = "2.16.840.1.113883.3.215.1.1";
/** Número de póliza de aseguramiento (anexo GIIS-A001, sección de afiliaciones). */
export const OID_POLIZA = "2.16.840.1.113883.3.215.1.2";
/**
 * templateId del «Documento Clínico Electrónico para México». SÓLO aparece
 * en el anexo de la GIIS-A001 (2.16.840.1.113883.3.215.11 es el arco del
 * Consejo Nacional para Personas con Discapacidad en la GIIS-A003); se emite
 * tal cual porque la certificación lo busca ahí.
 */
export const OID_TEMPLATE_DOCUMENTO_MX = "2.16.840.1.113883.3.215.11.1.1";
/** Catálogo de nacionalidades (RENAPO) — `patientRole/id` opcional del anexo. */
export const OID_NACIONALIDAD = "2.16.840.1.113883.3.215.12.15";
/** Catálogo de lenguas indígenas (INEGI) — `ethnicGroupCode` del anexo. */
export const OID_LENGUAS_INDIGENAS = "2.16.840.1.113883.3.215.12.10";
/** Catálogo de religiones (INEGI) — `religiousAffiliationCode` del anexo (no se emite). */
export const OID_RELIGIONES = "2.16.840.1.113883.3.215.12.11";
/** Vía de administración del Cuadro Básico de Medicamentos (no tenemos el catálogo: routeCode sale nullFlavor). */
export const OID_VIA_ADMINISTRACION_CBM = "2.16.840.1.113883.3.215.12.12";
/** Cuadro Básico de Medicamentos (clave del medicamento; sin catálogo local → nullFlavor UNK + originalText). */
export const OID_CUADRO_BASICO_MEDICAMENTOS = "2.16.840.1.113883.3.215.12.8";
/** Tipos de beneficiario de la DGIS (afiliaciones). */
export const OID_TIPO_BENEFICIARIO = "2.16.840.1.113883.3.215.12.16";

// ── Vocabularios internacionales ────────────────────────────────────────────

/** LOINC (GIIS-A003). */
export const OID_LOINC = "2.16.840.1.113883.6.1";
/** SNOMED CT (GIIS-A003). */
export const OID_SNOMED = "2.16.840.1.113883.6.96";
/** CIE-10 / ICD-10 (GIIS-A003). Las claves van como las publica la DGIS: sin punto, «K802», «I10X». */
export const OID_CIE10 = "2.16.840.1.113883.6.3";
/**
 * CIE-9-MC (procedimientos). La GIIS-A003 registra 2.16.840.1.113883.6.104
 * para «CIE-9 MC». El anexo de la GIIS-A001 pone 2.16.840.1.113883.6.2, que
 * en HL7 es ICD-9-CM *diagnósticos*; 6.104 es ICD-9-CM *procedimientos* y es
 * lo que dice la guía de OIDs, así que se usa 6.104.
 */
export const OID_CIE9MC = "2.16.840.1.113883.6.104";
/** HealthcareServiceLocation (CDC/NHSN) — ubicación del procedimiento (anexo). */
export const OID_HEALTHCARE_SERVICE_LOCATION = "2.16.840.1.113883.6.259";
/** UCUM — unidades de las PQ de signos vitales (implícito en HL7 v3). */
export const UCUM = "UCUM";

// ── Vocabularios HL7 v3 / v2 ────────────────────────────────────────────────

export const OID_HL7_CONFIDENTIALITY = "2.16.840.1.113883.5.25";
export const OID_HL7_ADMINISTRATIVE_GENDER = "2.16.840.1.113883.5.1";
export const OID_HL7_MARITAL_STATUS = "2.16.840.1.113883.5.2";
/** RoleCode: parentesco del tutor, área del encuentro (HOSP, ER…), FAMMEMB. */
export const OID_HL7_ROLE_CODE = "2.16.840.1.113883.5.111";
/** RoleClass: PAYOR en afiliaciones. */
export const OID_HL7_ROLE_CLASS = "2.16.840.1.113883.5.110";
/** ActCode: tipo de episodio/encuentro (IMP, AMB, EMER, SS) y ASSERTION. */
export const OID_HL7_ACT_CODE = "2.16.840.1.113883.5.4";
/** ActClass: CONC (concern) del acto que envuelve cada diagnóstico. */
export const OID_HL7_ACT_CLASS = "2.16.840.1.113883.5.6";
/** ParticipationFunction (tabla v2 0443): PP médico responsable, CP consultado, RP referido. */
export const OID_HL7_PARTICIPATION_FUNCTION = "2.16.840.1.113883.12.443";
/**
 * Discharge Disposition (tabla v2 0112). El anexo de la DGIS usa este OID con
 * los códigos 1-6 del motivo de egreso del SAEH (Curación, Mejoría,
 * Voluntario, Pase a otro hospital, Defunción, Otro), que NO son los valores
 * de la tabla 0112 de HL7 (01 home, 02 short-term hospital…). Se sigue el
 * anexo porque es lo que valida la DGIS.
 */
export const OID_HL7_DISCHARGE_DISPOSITION = "2.16.840.1.113883.12.112";

// ── Cabecera ────────────────────────────────────────────────────────────────

/** typeId de todo CDA R2: RMIM registrado POCD_HD000040. */
export const TYPE_ID_ROOT = "2.16.840.1.113883.1.3";
export const TYPE_ID_EXTENSION = "POCD_HD000040";
export const REALM_CODE = "MX";
export const LANGUAGE_CODE = "es-MX";
/** Confidencialidad normal (N). R para psiquiatría/VIH quedará configurable. */
export const CONFIDENTIALITY_NORMAL = { code: "N", displayName: "Normal" } as const;

/** Tipo de documento (LOINC), según la GIIS-A001 variable 4 «Tipo de documento». */
export const CODIGO_DOCUMENTO = {
  EPISODIO: { code: "34133-9", displayName: "Nota resumen de episodio", titulo: "Resumen clínico" },
  EGRESO: { code: "18842-5", displayName: "Resumen de egreso", titulo: "Resumen clínico de egreso" },
  REFERENCIA: { code: "11488-4", displayName: "Nota de interconsulta o referencia", titulo: "Resumen clínico de referencia" },
} as const;

/** Nombre del SIRES tal como va en `assignedAuthoringDevice`. */
export const SOFTWARE_NOMBRE = "HospitalOS / ContabilidadOS";
export const SOFTWARE_FABRICANTE = "ContabilidadOS";

// ── Secciones del cuerpo (orden del anexo) ──────────────────────────────────

export interface SeccionCda {
  /** templateIds del anexo (C-CDA / IHE PCC); vacío cuando el anexo no pone ninguno. */
  templateIds: readonly string[];
  code: string;
  displayName: string;
  titulo: string;
}

export const SECCION = {
  MOTIVO_REFERENCIA: { templateIds: ["1.3.6.1.4.1.19376.1.5.3.1.3.1"], code: "42349-1", displayName: "Motivo de Referencia", titulo: "Motivo de la referencia" },
  AFILIACIONES: { templateIds: ["2.16.840.1.113883.10.20.22.2.18"], code: "48768-6", displayName: "Pagador", titulo: "Afiliaciones / Planes de aseguramiento" },
  ALERGIAS: { templateIds: ["2.16.840.1.113883.10.20.22.2.22"], code: "48765-2", displayName: "Alergias", titulo: "Alergias y reacciones adversas" },
  HEREDOFAMILIARES: { templateIds: ["2.16.840.1.113883.10.20.1.4"], code: "10157-6", displayName: "Antecedentes Familiares", titulo: "Antecedentes heredo-familiares" },
  NO_PATOLOGICOS: { templateIds: ["2.16.840.1.113883.10.20.22.4.38"], code: "29762-2", displayName: "Antecedentes no patológicos", titulo: "Antecedentes personales no patológicos" },
  PATOLOGICOS: { templateIds: ["2.16.840.1.113883.10.20.22.2.20"], code: "11348-0", displayName: "Antecedentes patológicos", titulo: "Antecedentes personales patológicos" },
  MANIFESTACIONES_INICIALES: { templateIds: ["1.3.6.1.4.1.19376.1.5.3.1.1.13.2.1"], code: "10154-3", displayName: "Manifestaciones Iniciales", titulo: "Manifestaciones iniciales" },
  IMPRESION_DIAGNOSTICA: { templateIds: ["2.16.840.1.113883.10.20.22.2.8"], code: "51848-0", displayName: "Impresión diagnóstica", titulo: "Impresión diagnóstica" },
  DIAGNOSTICOS: { templateIds: ["2.16.840.1.113883.10.20.22.2.5", "2.16.840.1.113883.10.20.22.2.5.1"], code: "11450-4", displayName: "Lista de Problemas", titulo: "Diagnósticos y problemas de salud" },
  PROCEDIMIENTOS: { templateIds: ["2.16.840.1.113883.10.20.1.12"], code: "47519-4", displayName: "Historial de procedimientos", titulo: "Procedimientos quirúrgicos y terapéuticos" },
  MEDICAMENTOS: { templateIds: ["2.16.840.1.113883.10.20.22.2.38"], code: "29549-3", displayName: "Medicamentos administrados", titulo: "Terapéutica empleada" },
  EVOLUCION: { templateIds: ["1.3.6.1.4.1.19376.1.5.3.1.3.5"], code: "8648-8", displayName: "Evolución", titulo: "Evolución durante la atención" },
  SIGNOS_VITALES: { templateIds: ["2.16.840.1.113883.10.20.22.2.4"], code: "8716-3", displayName: "Signos Vitales", titulo: "Signos vitales" },
  PLAN: { templateIds: ["2.16.840.1.113883.10.20.22.2.10"], code: "18776-5", displayName: "Plan de tratamiento", titulo: "Plan de tratamiento y recomendaciones terapéuticas" },
  PRONOSTICO: { templateIds: [], code: "47420-5", displayName: "Evaluación del Estado Funcional", titulo: "Pronóstico de salud del paciente" },
} as const satisfies Record<string, SeccionCda>;

// ── Códigos de entradas ─────────────────────────────────────────────────────

/** SNOMED CT 282291009 «Diagnóstico» — code de cada observación diagnóstica (anexo). */
export const SNOMED_DIAGNOSTICO = { code: "282291009", displayName: "Diagnóstico" } as const;
/** SNOMED CT 64572001 «Condition» — antecedentes heredofamiliares (anexo). */
export const SNOMED_CONDICION = { code: "64572001", displayName: "Condition" } as const;
/** SNOMED CT 46680005 «Signos vitales» — organizer de la sección (anexo). */
export const SNOMED_SIGNOS_VITALES = { code: "46680005", displayName: "Signos vitales" } as const;
/** LOINC 882-1 grupo ABO + Rh (anexo, antecedentes no patológicos). */
export const LOINC_TIPO_SANGRE = { code: "882-1", displayName: "GRUPO ABO+RH" } as const;
/** ActClass CONC: acto «concern» que envuelve cada problema (anexo). */
export const ACT_CLASS_CONCERN = { code: "CONC", displayName: "Concern" } as const;
/** RoleCode FAMMEMB: familiar no especificado (anexo). */
export const ROLE_FAMILIAR = { code: "FAMMEMB", displayName: "Familiar" } as const;

/**
 * Los tres padecimientos heredofamiliares que el anexo exige observar
 * siempre (presencia, ausencia o sin información). CIE-10 en clave DGIS.
 */
export const HEREDOFAMILIARES_OBLIGATORIOS = [
  { code: "I10X", displayName: "Hipertensión" },
  { code: "E78", displayName: "Dislipidemias" },
  { code: "E14", displayName: "Diabetes" },
] as const;

/**
 * Signos vitales → LOINC + unidad UCUM. Los cuatro primeros y talla/peso son
 * los del value set «Vital Sign Result Type» de HITSP/C-CDA; SpO2 por
 * oximetría (59408-5), glucosa capilar (2339-0) y dolor 0-10 (72514-3) van
 * MÁS ALLÁ de la lista de la guía: se emiten porque el piso los captura y el
 * anexo admite «cada signo/medición» con cualquier LOINC.
 */
export const SIGNO_VITAL = {
  talla: { code: "8302-2", displayName: "Talla", unit: "cm" },
  peso: { code: "3141-9", displayName: "Peso", unit: "kg" },
  taSistolica: { code: "8480-6", displayName: "Tensión arterial sistólica", unit: "mm[Hg]" },
  taDiastolica: { code: "8462-4", displayName: "Tensión arterial diastólica", unit: "mm[Hg]" },
  fc: { code: "8867-4", displayName: "Frecuencia cardiaca", unit: "/min" },
  fr: { code: "9279-1", displayName: "Frecuencia respiratoria", unit: "/min" },
  temperatura: { code: "8310-5", displayName: "Temperatura corporal", unit: "Cel" },
  spo2: { code: "59408-5", displayName: "Saturación de oxígeno por oximetría de pulso", unit: "%" },
  glucosa: { code: "2339-0", displayName: "Glucosa en sangre", unit: "mg/dL" },
  dolor: { code: "72514-3", displayName: "Intensidad del dolor (0-10)", unit: "{score}" },
} as const;

export type ClaveSignoVital = keyof typeof SIGNO_VITAL;

/** Ubicación del procedimiento (HealthcareServiceLocation, CDC/NHSN). */
export const UBICACION_PROCEDIMIENTO = {
  QUIROFANO: { code: "1096-7", displayName: "Quirófano" },
  UCI: { code: "1024-9", displayName: "Unidad de cuidados intensivos" },
  URGENCIAS: { code: "1108-0", displayName: "Urgencias" },
  CIRUGIA_AMBULATORIA: { code: "1166-8", displayName: "Cirugía ambulatoria" },
  PABELLON: { code: "1060-3", displayName: "Hospitalización (pabellón)" },
} as const;

// ── Catálogos HL7 usados en la cabecera ─────────────────────────────────────

/** ActEncounterCode del episodio (documentationOf) y del encuentro (componentOf), GIIS-A001 variables 184 y 205. */
export const TIPO_ENCUENTRO = {
  IMP: { code: "IMP", displayName: "Hospitalización" },
  AMB: { code: "AMB", displayName: "Ambulatorio" },
  EMER: { code: "EMER", displayName: "Urgencias" },
  SS: { code: "SS", displayName: "Corta Estancia" },
} as const;

/** Área del encuentro (RoleCode ServiceDeliveryLocationRoleType), anexo `healthCareFacility/code`. */
export const AREA_ENCUENTRO = {
  HOSP: { code: "HOSP", displayName: "Hospitalización" },
  ER: { code: "ER", displayName: "Sala de emergencias" },
  OF: { code: "OF", displayName: "Servicios ambulatorios" },
  PROFF: { code: "PROFF", displayName: "Consultorio médico" },
} as const;

/** Motivo de egreso → código 1-6 del anexo (ver caveat en OID_HL7_DISCHARGE_DISPOSITION). */
export const MOTIVO_EGRESO_CDA: Record<string, { code: string; displayName: string }> = {
  CURACION: { code: "1", displayName: "Curación" },
  MEJORIA: { code: "2", displayName: "Mejoría" },
  VOLUNTARIA: { code: "3", displayName: "Voluntario" },
  TRASLADO: { code: "4", displayName: "Pase a otro hospital" },
  DEFUNCION: { code: "5", displayName: "Defunción" },
  FUGA: { code: "6", displayName: "Otro motivo" },
  OTRO: { code: "6", displayName: "Otro motivo" },
};

/** Sexo del paciente (HL7 AdministrativeGender). */
export const SEXO_CDA = {
  FEMENINO: { code: "F", displayName: "Femenino" },
  MASCULINO: { code: "M", displayName: "Masculino" },
  OTRO: { code: "UN", displayName: "Indiferenciado" },
} as const;

/**
 * Estado conyugal: catálogo ESTADO CONYUGAL de la DGIS (SAEH: 1 soltero, 2
 * viudo, 3 divorciado, 4 unión libre, 5 casado, 6 separado; 0/8/9 sin dato)
 * → HL7 MaritalStatus con los códigos que enumera el anexo.
 */
export const ESTADO_CONYUGAL_CDA: Record<number, { code: string; displayName: string }> = {
  1: { code: "U", displayName: "Soltero(a)" },
  2: { code: "W", displayName: "Viudo(a)" },
  3: { code: "D", displayName: "Divorciado(a)" },
  4: { code: "T", displayName: "Unión libre" },
  5: { code: "M", displayName: "Casado(a)" },
  6: { code: "L", displayName: "Separado(a)" },
};

/** Parentesco capturado en texto → HL7 RoleCode (PersonalRelationshipRoleType). Sin match: nullFlavor OTH + originalText. */
export const PARENTESCO_CDA: Record<string, { code: string; displayName: string }> = {
  MADRE: { code: "MTH", displayName: "Madre" },
  PADRE: { code: "FTH", displayName: "Padre" },
  ESPOSO: { code: "SPS", displayName: "Cónyuge" },
  ESPOSA: { code: "SPS", displayName: "Cónyuge" },
  CONYUGE: { code: "SPS", displayName: "Cónyuge" },
  PAREJA: { code: "DOMPART", displayName: "Pareja" },
  CONCUBINO: { code: "DOMPART", displayName: "Pareja" },
  CONCUBINA: { code: "DOMPART", displayName: "Pareja" },
  HIJO: { code: "SON", displayName: "Hijo" },
  HIJA: { code: "DAU", displayName: "Hija" },
  HERMANO: { code: "BRO", displayName: "Hermano" },
  HERMANA: { code: "SIS", displayName: "Hermana" },
  ABUELO: { code: "GRFTH", displayName: "Abuelo" },
  ABUELA: { code: "GRMTH", displayName: "Abuela" },
  NIETO: { code: "GRNDSON", displayName: "Nieto" },
  NIETA: { code: "GRNDDAU", displayName: "Nieta" },
  TIO: { code: "UNCLE", displayName: "Tío" },
  TIA: { code: "AUNT", displayName: "Tía" },
  PRIMO: { code: "COUSN", displayName: "Primo" },
  PRIMA: { code: "COUSN", displayName: "Prima" },
  SUEGRO: { code: "FTHINLAW", displayName: "Suegro" },
  SUEGRA: { code: "MTHINLAW", displayName: "Suegra" },
  YERNO: { code: "SONINLAW", displayName: "Yerno" },
  NUERA: { code: "DAUINLAW", displayName: "Nuera" },
  CUNADO: { code: "BROINLAW", displayName: "Cuñado" },
  CUNADA: { code: "SISINLAW", displayName: "Cuñada" },
  AMIGO: { code: "FRND", displayName: "Amigo" },
  AMIGA: { code: "FRND", displayName: "Amiga" },
};

/** Derechohabiencia (catálogo AFILIACION de la DGIS) para la narrativa de afiliaciones. */
export const DERECHOHABIENCIA_NOMBRE: Record<string, string> = {
  "0": "No especificado",
  "1": "Ninguna",
  "2": "IMSS",
  "3": "ISSSTE",
  "4": "PEMEX",
  "5": "SEDENA",
  "6": "SEMAR",
  "8": "Otra",
  "10": "IMSS Bienestar",
  "11": "ISSFAM",
  "13": "INSABI",
  "14": "OPD IMSS Bienestar",
  G: "Gratuidad",
  "99": "Se ignora",
};
