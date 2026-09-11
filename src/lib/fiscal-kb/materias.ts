// ─────────────────────────────────────────────────────────────────────────────
// Materias y ámbito del corpus jurídico (docs/MOTOR-JURIDICO.md §3.1).
//
// Un solo corpus, dos alcances: cada FiscalDocument lleva `materias` y
// `ambito`; el copiloto de Contabilidad OS busca con MATERIAS_CONTADOR fijas en
// el servidor, el producto legal busca sin filtro. La clasificación de una ley
// sale de su título por reglas (clasificarMaterias) y se corrige a mano por
// clave (MATERIAS_POR_CLAVE); el resultado queda en catalogo/federal.json y
// entra por PR, como los valores fiscales.
// ─────────────────────────────────────────────────────────────────────────────

export const MATERIAS = [
  "constitucional",
  "fiscal",
  "aduanero",
  "comercio_exterior",
  "hacienda_publica",
  "laboral",
  "seguridad_social",
  "mercantil",
  "financiero",
  "seguros",
  "pld",
  "civil",
  "familiar",
  "penal",
  "procesal",
  "amparo",
  "administrativo",
  "servidores_publicos",
  "judicial",
  "legislativo",
  "electoral",
  "propiedad_intelectual",
  "competencia",
  "consumidor",
  "datos_personales",
  "transparencia",
  "ambiental",
  "energia",
  "agrario",
  "salud",
  "educacion",
  "cultura",
  "deporte",
  "derechos_humanos",
  "migracion",
  "internacional",
  "telecomunicaciones",
  "transporte",
  "vivienda",
  "militar",
  "seguridad_publica",
  "cooperativas",
  "organico",
  "estadistica",
  "juegos_sorteos",
  "religioso",
] as const;

export type Materia = (typeof MATERIAS)[number];

const MATERIAS_SET: ReadonlySet<string> = new Set(MATERIAS);
export function esMateria(x: string): x is Materia {
  return MATERIAS_SET.has(x);
}

/**
 * Lo que un contador cita. El executor del hub pasa este conjunto a la
 * búsqueda; el modelo no lo elige. Constitucional queda fuera a propósito: la
 * CPEUM entera es la mayor fuente de vecinos ruidosos para una pregunta de
 * deducciones, y el eval decide si entra después.
 */
export const MATERIAS_CONTADOR: readonly Materia[] = [
  "fiscal",
  "aduanero",
  "comercio_exterior",
  "laboral",
  "seguridad_social",
  "mercantil",
  "pld",
];

/**
 * Para la jurisprudencia el SJF no tiene materia «Fiscal»: lo tributario va en
 * «Administrativa» (el normalizador agrega «fiscal» cuando el rubro lo delata).
 * El contador ve, además de sus materias, toda la administrativa.
 */
export const MATERIAS_CONTADOR_JURISPRUDENCIA: readonly Materia[] = [...MATERIAS_CONTADOR, "administrativo"];

export type Ambito = "FEDERAL" | "ESTATAL" | "MUNICIPAL" | "INTERNACIONAL";

/** Reglas título → materias. Se aplican todas; una ley puede tener varias. */
const REGLAS: [RegExp, Materia[]][] = [
  [/^CONSTITUCI[ÓO]N|^LEY Reglamentaria de (?:la |las )?[Ff]racci/i, ["constitucional"]],
  [/Impuesto|Fiscal\b(?!ía)|Tributaria|Contribuyente|Contribuci[óo]n de Mejoras|Federal de Derechos|Ingresos sobre Hidrocarburos|Unidad de Medida y Actualizaci[óo]n|Contencioso Administrativo|Tribunal Federal de Justicia Administrativa/i, ["fiscal"]],
  [/Aduanera/i, ["aduanero", "fiscal", "comercio_exterior"]],
  [/Comercio Exterior|Importaci[óo]n y de Exportaci[óo]n|Inversi[óo]n Extranjera|Zonas Econ[óo]micas|Normas Extranjeras|Tratados Internacionales en Materia Econ[óo]mica/i, ["comercio_exterior"]],
  [/Presupuesto|Hacendaria|Tesorer[íi]a|Deuda P[úu]blica|Disciplina Financiera|Coordinaci[óo]n Fiscal|Contabilidad Gubernamental|Fondo Mexicano del Petr[óo]leo|Ingresos de la Federaci[óo]n|Fiscalizaci[óo]n y Rendici[óo]n|Egresos|Austeridad/i, ["hacienda_publica"]],
  [/\bTrabajo\b|Trabajadores|Laboral|Ayuda Alimentaria|Remuneraciones|Consumo de los Trabajadores|Servicio Profesional de Carrera/i, ["laboral"]],
  [/Seguro Social|Seguridad Social|Seguridad y Servicios Sociales|Ahorro para el Retiro|Fondo Nacional de la Vivienda/i, ["seguridad_social"]],
  [/C[ÓO]DIGO de Comercio|Sociedades Mercantiles|T[íi]tulos y Operaciones de Cr[ée]dito|Concursos Mercantiles|Corredur[íi]a|C[áa]maras Empresariales|Firma Electr[óo]nica|Sociedades de Responsabilidad Limitada|Sociedades de Solidaridad|Contrato de Seguro|Navegaci[óo]n y Comercio Mar[íi]timos|Econom[íi]a Social|Micro, Peque[ñn]a y Mediana|Microindustria|Sociedades Cooperativas$/i, ["mercantil"]],
  [/Instituciones de Cr[ée]dito|Banc[oa]|Bancari|Mercado de Valores|Fondos de Inversi[óo]n|Ahorro y Cr[ée]dito|Uniones de Cr[ée]dito|Agrupaciones Financieras|Tecnolog[íi]a Financiera|Informaci[óo]n Crediticia|Sistemas de Pagos|Servicios Financieros|Actividades Auxiliares del Cr[ée]dito|Cooperativas de Ahorro|Cr[ée]dito Garantizado|Monetaria|Casa de Moneda|Nacional Financiera|Hipotecaria|Fondos de Aseguramiento|Fondo de Garant[íi]a/i, ["financiero"]],
  [/\bSeguros\b|Contrato de Seguro|Fianzas|Aseguramiento/i, ["seguros"]],
  [/Recursos de Procedencia Il[íi]cita/i, ["pld"]],
  [/C[ÓO]DIGO Civil|Procedimientos Civiles|Responsabilidad Civil|Expropiaci[óo]n|Mecanismos Alternativos de Soluci[óo]n de Controversias$/i, ["civil"]],
  [/Civiles y Familiares|C[ÓO]DIGO Civil Federal/i, ["familiar"]],
  [/\bPenal\b|Penales|Delincuencia Organizada|Delitos|Extinci[óo]n de Dominio|Ejecuci[óo]n Penal|Secuestro|Trata de Personas|Tortura|Extorsi[óo]n|Armas de Fuego|Amnist[íi]a|Extradici[óo]n|Registro de Detenciones|Uso de la Fuerza|Precursores Qu[íi]micos|Sustancias Qu[íi]micas|Justicia Penal para Adolescentes|Desaparici[óo]n Forzada|Procedimiento Penal/i, ["penal"]],
  [/Procedimientos|Procedimiento\b|Amparo|Mecanismos Alternativos|Medios de Impugnaci[óo]n|Concursos Mercantiles/i, ["procesal"]],
  [/\bAmparo\b/i, ["amparo", "constitucional"]],
  [/Administraci[óo]n P[úu]blica|Procedimiento Administrativo|Responsabilidades Administrativas|Entidades Paraestatales|Adquisiciones|Obras P[úu]blicas|Asociaciones P[úu]blico|Bienes Nacionales|Bienes del Sector P[úu]blico|Tr[áa]mites Burocr[áa]ticos|Fomento a la Confianza|Servidores P[úu]blicos|Anticorrupci[óo]n|Responsabilidad Patrimonial|Planeaci[óo]n\b|Archivos|Comunicaci[óo]n Social|Diario Oficial|Husos Horarios|Premios, Est[íi]mulos|Infraestructura de la Calidad|Infraestructura Estrat[ée]gica|Firma Electr[óo]nica|Mejora Regulatoria|Fomento a las Actividades|Registro P[úu]blico Vehicular|Cooperaci[óo]n Internacional/i, ["administrativo"]],
  [/Servidores P[úu]blicos|Responsabilidades Administrativas|Anticorrupci[óo]n|Servicio Profesional de Carrera|Remuneraciones|Austeridad/i, ["servidores_publicos"]],
  [/Poder Judicial|Carrera Judicial|Tribunales Agrarios|Fiscal[íi]a General|Defensor[íi]a P[úu]blica|Tribunal Federal|Procuradur[íi]a/i, ["judicial"]],
  [/Congreso General|C[áa]mara de Diputados|Senado/i, ["legislativo"]],
  [/Electoral|Partidos Pol[íi]ticos|Consulta Popular|Revocaci[óo]n de Mandato/i, ["electoral"]],
  [/Propiedad Industrial|Derecho de Autor|Variedades Vegetales|Patrimonio Cultural de los Pueblos/i, ["propiedad_intelectual"]],
  [/Competencia Econ[óo]mica|Competitividad|Pr[áa]cticas Indebidas/i, ["competencia"]],
  [/Consumidor|Usuario de Servicios Financieros/i, ["consumidor"]],
  [/Datos Personales/i, ["datos_personales"]],
  [/Transparencia y Acceso|Transparencia, Prevenci[óo]n/i, ["transparencia"]],
  [/Ambiente|Ambiental|Ecol[óo]gico|Cambio Clim[áa]tico|Residuos|Vida Silvestre|Forestal|\bAguas\b|Pesca|Bioseguridad|Vertimientos|Econom[íi]a Circular|Sanidad|Productos Org[áa]nicos|Ma[íi]z Nativo|Semillas|Da[ñn]os Nucleares/i, ["ambiental"]],
  [/Energ[íi]a|El[ée]ctric|Hidrocarburos|Petr[óo]leo|Geotermia|Biocombustibles|Nuclear|Miner[íi]a|Mineras|Transici[óo]n Energ[ée]tica|Uranio|Petróleos Mexicanos/i, ["energia"]],
  [/Agraria|Agrarios|Agr[íi]cola|Ganader|para el Campo|Rural|Cafeticultura|Ca[ñn]a de Az[úu]car|Procampo|Chapingo|Antonio Narro|Avicultura/i, ["agrario"]],
  [/\bSalud\b|Tabaco|C[áa]ncer|Autista|Alimentaci[óo]n Adecuada/i, ["salud"]],
  [/Educaci[óo]n|Universidad|Polit[ée]cnico|Maestras|Ciencias, Tecnolog[íi]as|Lectura y el Libro|Bibliotecas|Humanidades/i, ["educacion"]],
  [/Cultura\b|Monumentos|Bellas Artes|Antropolog[íi]a|Seminario de Cultura|Escudo, la Bandera|Cruz Roja|Cine\b|Audiovisual/i, ["cultura"]],
  [/Deporte/i, ["deporte"]],
  [/Derechos Humanos|Discriminaci[óo]n|Mujeres|Ni[ñn]as, Ni[ñn]os|V[íi]ctimas|Personas con Discapacidad|Adultas Mayores|Pueblos Ind[íi]genas|Igualdad|Juventud|Desaparecidas|Periodistas|Asistencia Social|Desarrollo Social|Ling[üu][íi]sticos|Desarrollo Integral Infantil|Tortura|Refugiados/i, ["derechos_humanos"]],
  [/Migraci[óo]n|Nacionalidad|Refugiados|Poblaci[óo]n/i, ["migracion"]],
  [/Tratados|Convenio Constitutivo|Cooperaci[óo]n Internacional|Servicio Exterior|Extradici[óo]n|Neutralidad|Banco Interamericano|Banco de Desarrollo del Caribe|Asociaci[óo]n Internacional de Fomento|Derecho Internacional/i, ["internacional"]],
  [/Telecomunicaciones|Radiodifusi[óo]n|Derecho de R[ée]plica|Servicio Postal|Comunicaci[óo]n Social|Cine\b|Audiovisual/i, ["telecomunicaciones"]],
  [/Caminos|Autotransporte|Aviaci[óo]n|Aeropuertos|\bPuertos\b|Ferroviario|V[íi]as Generales|Navegaci[óo]n|Espacio A[ée]reo|Movilidad|Agencia Espacial/i, ["transporte"]],
  [/Vivienda|Asentamientos Humanos|Hipotecaria/i, ["vivienda"]],
  [/Militar|Armada\b|Ej[ée]rcito|Fuerza A[ée]rea|Guardia Nacional|Fuerzas Armadas|Educaci[óo]n Naval|Neutralidad del Pa[íi]s/i, ["militar"]],
  [/Seguridad P[úu]blica|Seguridad Nacional|Seguridad Interior|Polic[íi]a|Guardia Nacional|Seguridad Privada|Protecci[óo]n Civil|Prevenci[óo]n Social de la Violencia|Investigaci[óo]n e Inteligencia|Registro P[úu]blico Vehicular|Seguridad Vial|Armas de Fuego/i, ["seguridad_publica"]],
  [/Cooperativ/i, ["cooperativas"]],
  [/^LEY Org[áa]nica|^LEY que crea|^LEY que Crea|^ESTATUTO|Org[áa]nica de|Instituto Nacional|Instituto Mexicano|Comisi[óo]n Nacional|Agencia Nacional|Empresa P[úu]blica del Estado/i, ["organico"]],
  [/Estad[íi]stica y Geogr[áa]fica/i, ["estadistica"]],
  [/Juegos y Sorteos/i, ["juegos_sorteos"]],
  [/Asociaciones Religiosas/i, ["religioso"]],
];

/**
 * Correcciones por clave sobre lo que dicen las reglas: SUSTITUYEN la lista
 * (no la complementan). Revisadas a mano el 2026-09-11; el abogado revisor
 * ajusta aquí, no en el JSON generado.
 */
export const MATERIAS_POR_CLAVE: Record<string, Materia[]> = {
  CPEUM: ["constitucional"],
  CFF: ["fiscal", "procesal"],
  LISR: ["fiscal"],
  LIVA: ["fiscal"],
  LIEPS: ["fiscal"],
  LFD: ["fiscal"],
  LIF: ["fiscal", "hacienda_publica"],
  LCF: ["fiscal", "hacienda_publica"],
  LFISAN: ["fiscal"],
  LIH: ["fiscal", "energia"],
  LSAT: ["fiscal", "administrativo"],
  LOPDC: ["fiscal", "judicial"],
  LFDC: ["fiscal"],
  LFPCA: ["fiscal", "administrativo", "procesal"],
  LOTFJA: ["fiscal", "administrativo", "judicial"],
  LFPA: ["administrativo", "procesal"],
  LDVUMA: ["fiscal", "laboral"],
  LADUA: ["aduanero", "fiscal", "comercio_exterior"],
  LCE: ["comercio_exterior"],
  LIE: ["comercio_exterior", "mercantil"],
  LFT: ["laboral"],
  LFTSE: ["laboral", "servidores_publicos"],
  LSS: ["seguridad_social", "laboral"],
  LINFONAVIT: ["seguridad_social", "laboral", "vivienda"],
  LSAR: ["seguridad_social", "financiero"],
  LISSSTE: ["seguridad_social", "servidores_publicos"],
  LIFNCT: ["laboral", "financiero"],
  LAAT: ["laboral", "fiscal"],
  LOCFCRL: ["laboral", "organico"],
  CCOM: ["mercantil", "procesal"],
  LGSM: ["mercantil"],
  LGTOC: ["mercantil", "financiero"],
  LCM: ["mercantil", "procesal"],
  LGSC: ["mercantil", "cooperativas"],
  LFCP: ["mercantil"],
  LFEA: ["administrativo", "mercantil"],
  LFPIORPI: ["pld", "mercantil"],
  LFPC: ["consumidor", "mercantil"],
  LFPDPPP: ["datos_personales", "mercantil"],
  LFPPI: ["propiedad_intelectual"],
  LFDA: ["propiedad_intelectual"],
  LIC: ["financiero"],
  LMV: ["financiero"],
  LISF: ["seguros", "financiero"],
  LSCS: ["seguros", "mercantil"],
  CCF: ["civil", "familiar"],
  CFPC: ["civil", "procesal"],
  CNPCF: ["civil", "familiar", "procesal"],
  CPF: ["penal"],
  CNPP: ["penal", "procesal"],
  LAMP: ["amparo", "constitucional", "procesal"],
  LGMASC: ["civil", "mercantil", "procesal"],
  LGRA: ["administrativo", "servidores_publicos"],
  LOAPF: ["administrativo", "organico"],
  LGCG: ["hacienda_publica", "administrativo"],
  LFPRH: ["hacienda_publica"],
  LGTAIP: ["transparencia", "administrativo"],
  LGPDPPSO: ["datos_personales", "administrativo"],
  LMTR: ["telecomunicaciones", "administrativo"],
  LGS: ["salud", "administrativo"],
  LGEEPA: ["ambiental", "administrativo"],
  LGE: ["educacion"],
  LGIPE: ["electoral"],
  LAGRA: ["agrario", "civil"],
  LMIGRA: ["migracion", "administrativo"],
  LVIV: ["vivienda", "administrativo"],
  LPROF: ["administrativo", "laboral"],
  LFGR: ["penal", "judicial", "organico"],
  LSPCAPF: ["servidores_publicos", "administrativo"],
  LFREMSP: ["servidores_publicos", "hacienda_publica"],
  LISSFAM: ["militar"],
  LOBNCE: ["financiero", "organico"],
  LFCE: ["competencia"],
  LRITF: ["financiero"],
};

/** Materias de una ley a partir de su clave y su título. Nunca vacío. */
export function clasificarMaterias(clave: string, titulo: string): Materia[] {
  const manual = MATERIAS_POR_CLAVE[clave.toUpperCase()];
  if (manual) return [...manual];
  const out: Materia[] = [];
  for (const [re, materias] of REGLAS) {
    if (!re.test(titulo)) continue;
    for (const m of materias) if (!out.includes(m)) out.push(m);
  }
  return out.length > 0 ? out : ["administrativo"];
}
