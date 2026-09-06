// Dictado realista de una nota postoperatoria (colecistectomía laparoscópica)
// como lo escupe el reconocimiento de voz: de corrido, con muletillas y sin
// puntuación, y lo que el modelo contesta para ese dictado (capturado a mano
// con la forma que pide SISTEMA_ESCRIBA). El médico NO dictó el conteo de
// gasas — la nota lo exige — y dijo «heparina» donde el contexto sugiere
// «hemostasia»: el escriba lo marca [verificar]. El modelo además inventó una
// clave de sección («evolucionEsperada») que no está en la plantilla y
// propone códigos que el catálogo debe rechazar.

export const DICTADO_POSTOPERATORIA = `nota postoperatoria paciente con diagnóstico preoperatorio de litiasis vesicular sin colecistitis K80.2 se realiza colecistectomía laparoscópica bajo anestesia general balanceada este neumoperitoneo con aguja de Veress a doce milímetros de mercurio cuatro puertos disección del triángulo de Calot se identifica arteria y conducto cístico se colocan tres grapas y se secciona extracción de la pieza en bolsa por el puerto umbilical hallazgos vesícula con múltiples litos pared delgada sin adherencias vía biliar de calibre normal sangrado aproximado de treinta mililitros sin incidentes ni accidentes se verifica heparina del lecho diagnóstico postoperatorio litiasis vesicular sin colecistitis paciente estable extubada en quirófano pasa a recuperación plan analgesia multimodal dieta líquida en seis horas deambulación temprana alta en veinticuatro a cuarenta y ocho horas pieza a patología equipo quirúrgico cirujano el que dicta anestesióloga doctora Rentería instrumentista enfermera Cruz`;

/** Lo que el modelo contesta (ya parseado) para DICTADO_POSTOPERATORIA. */
export const RESPUESTA_MODELO_POSTOPERATORIA = {
  secciones: {
    diagnosticoPreoperatorio: "Litiasis vesicular sin colecistitis (K80.2).",
    operacionRealizada: "Colecistectomía laparoscópica bajo anestesia general balanceada.",
    diagnosticoPostoperatorio: "Litiasis vesicular sin colecistitis.",
    tecnica:
      "Neumoperitoneo con aguja de Veress a 12 mmHg, cuatro puertos, disección del triángulo de Calot; se identifican arteria y conducto cístico, se colocan tres grapas y se seccionan. Extracción de la pieza en bolsa por el puerto umbilical.",
    hallazgos: "Vesícula con múltiples litos, pared delgada, sin adherencias; vía biliar de calibre normal.",
    sangrado: "Aproximadamente 30 ml.",
    conteoGasas: "",
    incidentes: "Sin incidentes ni accidentes. Se verifica heparina [verificar] del lecho.",
    estadoPostquirurgico: "Estable, extubada en quirófano; pasa a recuperación.",
    plan: "Analgesia multimodal, dieta líquida en 6 horas, deambulación temprana; alta en 24 a 48 horas.",
    piezasPatologia: "Pieza a patología.",
    equipoQuirurgico: "Cirujano: el que dicta; anestesióloga Dra. Rentería; instrumentista Enf. Cruz.",
    evolucionEsperada: "Favorable.",
  },
  texto: "Colecistectomía laparoscópica sin incidentes por litiasis vesicular sin colecistitis; sangrado de 30 ml; paciente estable pasa a recuperación.",
  codigos: {
    diagnosticos: [
      { codigo: "K80.2", nombre: "Cálculo de la vesícula biliar sin colecistitis", confianza: 0.97, fragmento: "litiasis vesicular sin colecistitis K80.2" },
      { codigo: "K80", nombre: "Colelitiasis", confianza: 0.6, fragmento: "litiasis vesicular" },
      { codigo: "O80.0", nombre: "Parto único espontáneo", confianza: 0.55, fragmento: "extracción de la pieza en bolsa" },
      { codigo: "Z99.9", nombre: "Dependencia de máquina no especificada", confianza: 0.5, fragmento: "extubada" },
      { codigo: "k80.2", nombre: "repetido", confianza: 0.3, fragmento: "diagnóstico postoperatorio litiasis vesicular" },
    ],
    procedimientos: [
      { codigo: "51.23", nombre: "Colecistectomía laparoscópica", confianza: 0.98, fragmento: "se realiza colecistectomía laparoscópica" },
      { codigo: "51.2", nombre: "Colecistectomía", confianza: 0.7, fragmento: "colecistectomía" },
    ],
  },
  advertencias: ["No se dictó el conteo de gasas y compresas.", "«heparina del lecho» suena a «hemostasia del lecho»: verificar."],
};

/** Las secciones que deben quedar (sólo claves de PLANTILLAS_NOTA.POSTOPERATORIA, sin vacías). */
export const SECCIONES_ESPERADAS_POSTOPERATORIA = {
  diagnosticoPreoperatorio: RESPUESTA_MODELO_POSTOPERATORIA.secciones.diagnosticoPreoperatorio,
  operacionRealizada: RESPUESTA_MODELO_POSTOPERATORIA.secciones.operacionRealizada,
  diagnosticoPostoperatorio: RESPUESTA_MODELO_POSTOPERATORIA.secciones.diagnosticoPostoperatorio,
  tecnica: RESPUESTA_MODELO_POSTOPERATORIA.secciones.tecnica,
  hallazgos: RESPUESTA_MODELO_POSTOPERATORIA.secciones.hallazgos,
  sangrado: RESPUESTA_MODELO_POSTOPERATORIA.secciones.sangrado,
  incidentes: RESPUESTA_MODELO_POSTOPERATORIA.secciones.incidentes,
  estadoPostquirurgico: RESPUESTA_MODELO_POSTOPERATORIA.secciones.estadoPostquirurgico,
  plan: RESPUESTA_MODELO_POSTOPERATORIA.secciones.plan,
  piezasPatologia: RESPUESTA_MODELO_POSTOPERATORIA.secciones.piezasPatologia,
  equipoQuirurgico: RESPUESTA_MODELO_POSTOPERATORIA.secciones.equipoQuirurgico,
};
