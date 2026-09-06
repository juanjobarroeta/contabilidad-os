// ─────────────────────────────────────────────────────────────────────────────
// Cuerpo del CDA: las secciones del anexo de la DGIS en su orden, cada una con
// templateId, code LOINC, título, narrativa (`text`, nunca vacía) y entradas
// codificadas cuando hay clave (CIE-10, CIE-9-MC, LOINC de signos vitales,
// tipo de sangre, afiliación). Lo que no se puede codificar va sólo en la
// narrativa: la guía admite texto libre y el certificador lee las dos cosas.
// Puro: DatosResumen + Contexto → nodos XML.
// ─────────────────────────────────────────────────────────────────────────────

import type { HospNotaTipo } from "@prisma/client";
import { ETIQUETA_CONTENIDO } from "../documentos";
import { ETIQUETA_SECCION, PLANTILLAS_NOTA } from "../notas";
import { el, type XmlNodo } from "../xml";
import {
  codigo,
  codigoNulo,
  fechaHoraCda,
  fechaLegible,
  idNodo,
  idNulo,
  limpiar,
  narrativa,
  nodoNombreLibre,
  parrafo,
  parrafos,
  tabla,
  textoDe,
} from "./comun";
import type { DatosResumen, NotaResumen, SignosResumen } from "./datos";
import type { Contexto } from "./encabezado";
import {
  ACT_CLASS_CONCERN,
  DERECHOHABIENCIA_NOMBRE,
  HEREDOFAMILIARES_OBLIGATORIOS,
  LOINC_TIPO_SANGRE,
  OID_CEDULA_PROFESIONAL,
  OID_CIE10,
  OID_CIE9MC,
  OID_CUADRO_BASICO_MEDICAMENTOS,
  OID_HEALTHCARE_SERVICE_LOCATION,
  OID_HL7_ACT_CLASS,
  OID_HL7_ROLE_CLASS,
  OID_HL7_ROLE_CODE,
  OID_LOINC,
  OID_POLIZA,
  OID_RFC,
  OID_SNOMED,
  OID_VIA_ADMINISTRACION_CBM,
  ROLE_FAMILIAR,
  SECCION,
  SIGNO_VITAL,
  SNOMED_CONDICION,
  SNOMED_DIAGNOSTICO,
  SNOMED_SIGNOS_VITALES,
  UBICACION_PROCEDIMIENTO,
  type ClaveSignoVital,
  type SeccionCda,
} from "./oids";

// ── Utilería de notas ───────────────────────────────────────────────────────

/** Última nota vigente de un tipo (las notas vienen en orden cronológico). */
function ultimaNota(d: DatosResumen, tipo: HospNotaTipo): NotaResumen | null {
  for (let i = d.notas.length - 1; i >= 0; i--) if (d.notas[i].tipo === tipo) return d.notas[i];
  return null;
}

function seccionDe(nota: NotaResumen | null, clave: string): string | null {
  return textoDe(nota?.secciones?.[clave]);
}

function firma(n: NotaResumen): string {
  return `${fechaLegible(n.fecha)} — ${n.autorNombre}${n.autorCedula ? ` (céd. ${n.autorCedula})` : ""}`;
}

function etiqueta(clave: string): string {
  return ETIQUETA_SECCION[clave] ?? ETIQUETA_CONTENIDO[clave] ?? clave;
}

/** Párrafos etiquetados «Etiqueta: texto» de varias secciones de una nota, en el orden dado. */
function parrafosDeNota(nota: NotaResumen | null, claves: string[]): XmlNodo[] {
  if (!nota) return [];
  const out: XmlNodo[] = [];
  for (const k of claves) {
    const t = seccionDe(nota, k);
    if (t) out.push(...parrafos(t, etiqueta(k)));
  }
  return out;
}

function encabezadoNota(n: NotaResumen): XmlNodo {
  return el("paragraph", {}, [el("content", { styleCode: "Bold" }, [`${PLANTILLAS_NOTA[n.tipo]?.titulo ?? n.tipo} · ${firma(n)}`])]);
}

/** `<component><section>…</section></component>` con templateIds, code, título, narrativa y entradas. */
function seccion(def: SeccionCda, texto: XmlNodo[], entradas: Array<XmlNodo | null> = []): XmlNodo {
  return el("component", {}, [
    el("section", {}, [
      ...def.templateIds.map((t) => el("templateId", { root: t })),
      codigo("code", def, OID_LOINC, "LOINC"),
      el("title", {}, [def.titulo]),
      el("text", {}, texto),
      ...entradas,
    ]),
  ]);
}

const fecha = (d: Date | null | undefined) => (d ? fechaLegible(d) : "—");
const numero = (n: number | null | undefined, decimales = 0) => (n == null ? null : Number(n).toFixed(decimales).replace(/\.0+$/, ""));

// ── Secciones ───────────────────────────────────────────────────────────────

function motivoReferencia(d: DatosResumen): XmlNodo | null {
  if (d.tipo !== "REFERENCIA") return null;
  const ref = ultimaNota(d, "REFERENCIA");
  const r = d.destinatario;
  const destino = r
    ? `Destinatario: ${r.nombre}${limpiar(r.cedula) ? ` (céd. ${r.cedula})` : ""}${limpiar(r.organizacion) ? ` · ${r.organizacion}` : ""}${limpiar(r.clues) ? ` · CLUES ${r.clues}` : ""}`
    : null;
  return seccion(
    SECCION.MOTIVO_REFERENCIA,
    narrativa(
      [
        ...parrafos(d.motivoReferencia, "Motivo de envío"),
        ...(destino ? [parrafo(destino)] : []),
        ...parrafosDeNota(ref, ["impresionDiagnostica", "terapeuticaEmpleada", "condicionesTraslado", "establecimientoReceptor", "medicoReceptor"]),
      ],
      "Sin motivo de referencia registrado"
    )
  );
}

function afiliaciones(d: DatosResumen, ctx: Contexto): XmlNodo {
  const p = d.pagador;
  const filas: XmlNodo[] = [];
  const entradas: XmlNodo[] = [];
  const vigencia = p && (p.vigenciaInicio || p.vigenciaFin) ? `${p.vigenciaInicio ? fechaLegible(p.vigenciaInicio, false) : "—"} a ${p.vigenciaFin ? fechaLegible(p.vigenciaFin, false) : "—"}` : "—";
  if (p) {
    filas.push(
      tabla(
        ["Programa / pagador", "Tipo", "Póliza", "Autorización", "Vigencia del convenio"],
        [[p.nombre, p.tipo.charAt(0) + p.tipo.slice(1).toLowerCase(), p.poliza ?? "—", d.episodio.autorizacionPagador ?? "—", vigencia]]
      )
    );
  }
  if (d.paciente.derechohabienciaClave) {
    filas.push(parrafo(`Derechohabiencia (catálogo DGIS): ${DERECHOHABIENCIA_NOMBRE[d.paciente.derechohabienciaClave] ?? d.paciente.derechohabienciaClave}`));
  }
  if (p?.tipo === "ASEGURADORA") {
    entradas.push(
      el("entry", {}, [
        el("act", { classCode: "ACT", moodCode: "EVN" }, [
          codigo("code", { code: SECCION.AFILIACIONES.code, displayName: "Fuentes de financiamiento" }, OID_LOINC, "LOINC"),
          el("statusCode", { code: "completed" }),
          el("entryRelationship", { typeCode: "COMP" }, [
            el("act", { classCode: "ACT", moodCode: "EVN" }, [
              // No hay catálogo de programas de aseguramiento privado: el plan va como texto.
              codigoNulo("code", "OTH", `${p.nombre} — seguro de gastos médicos`),
              el("statusCode", { code: "completed" }),
              el("performer", { typeCode: "PRF" }, [
                el("time", { nullFlavor: "NA" }),
                el("assignedEntity", {}, [
                  p.rfc ? idNodo(OID_RFC, p.rfc, "RFC") : idNulo(null, "UNK"),
                  el("code", { code: "PAYOR", codeSystem: OID_HL7_ROLE_CLASS, codeSystemName: "RoleClass" }),
                  el("representedOrganization", {}, [el("name", {}, [p.nombre])]),
                ]),
              ]),
              el("participant", { typeCode: "COV" }, [
                p.vigenciaInicio || p.vigenciaFin
                  ? el("time", {}, [
                      p.vigenciaInicio ? el("low", { value: fechaHoraCda(p.vigenciaInicio) }) : null,
                      p.vigenciaFin ? el("high", { value: fechaHoraCda(p.vigenciaFin) }) : null,
                    ])
                  : null,
                el("participantRole", { classCode: "PAT" }, [idNodo(ctx.raices.pacientes, d.paciente.id, "HospitalOS")]),
              ]),
              p.poliza ? el("participant", { typeCode: "HLD" }, [el("participantRole", {}, [idNodo(OID_POLIZA, p.poliza, "Póliza")])]) : null,
            ]),
          ]),
        ]),
      ])
    );
  }
  return seccion(SECCION.AFILIACIONES, narrativa(filas, "Sin afiliación ni pagador registrado (particular)"), entradas);
}

function alergias(d: DatosResumen): XmlNodo {
  return seccion(SECCION.ALERGIAS, narrativa(parrafos(d.paciente.alergias), "Sin alergias registradas"));
}

function heredofamiliares(d: DatosResumen): XmlNodo {
  const hc = ultimaNota(d, "HISTORIA_CLINICA");
  const texto = parrafosDeNota(hc, ["antecedentesHeredofamiliares"]);
  // La guía exige observar hipertensión, dislipidemias y diabetes siempre. La
  // historia clínica los trae en texto libre, no en campos: se declaran «sin
  // información estructurada» (nullFlavor NI) y la narrativa lleva el texto.
  const entrada = el("entry", { typeCode: "DRIV" }, [
    el("organizer", { classCode: "CLUSTER", moodCode: "EVN" }, [
      el("statusCode", { code: "completed" }),
      el("subject", {}, [el("relatedSubject", { classCode: "PRS" }, [codigo("code", ROLE_FAMILIAR, OID_HL7_ROLE_CODE, "RoleCode")])]),
      ...HEREDOFAMILIARES_OBLIGATORIOS.map((h) =>
        el("component", {}, [
          el("observation", { classCode: "OBS", moodCode: "EVN", nullFlavor: "NI" }, [
            codigo("code", SNOMED_CONDICION, OID_SNOMED, "SNOMED CT"),
            el("statusCode", { code: "completed" }),
            el("value", { "xsi:type": "CD", code: h.code, codeSystem: OID_CIE10, codeSystemName: "CIE-10", displayName: h.displayName }),
          ]),
        ])
      ),
    ]),
  ]);
  return seccion(SECCION.HEREDOFAMILIARES, narrativa(texto, "Sin antecedentes heredo-familiares registrados"), [entrada]);
}

function noPatologicos(d: DatosResumen): XmlNodo {
  const hc = ultimaNota(d, "HISTORIA_CLINICA");
  const sangre = d.paciente.tipoSangre;
  const texto = [parrafo(`Tipo de sangre: ${sangre ?? "no registrado"}`), ...parrafosDeNota(hc, ["antecedentesPersonalesNoPatologicos"])];
  const entradas = sangre
    ? [
        el("entry", {}, [
          el("observation", { classCode: "OBS", moodCode: "EVN" }, [
            codigo("code", LOINC_TIPO_SANGRE, OID_LOINC, "LOINC"),
            el("statusCode", { code: "completed" }),
            el("value", { "xsi:type": "CS", code: sangre.replace(/\s+/g, "").toUpperCase() }),
          ]),
        ]),
      ]
    : [];
  return seccion(SECCION.NO_PATOLOGICOS, texto, entradas);
}

function patologicos(d: DatosResumen): XmlNodo {
  const hc = ultimaNota(d, "HISTORIA_CLINICA");
  const texto = [
    ...parrafosDeNota(hc, ["antecedentesPersonalesPatologicos", "antecedentesGinecoObstetricos"]),
    ...parrafos(d.paciente.antecedentes, "Antecedentes registrados en la ficha del paciente"),
  ];
  return seccion(SECCION.PATOLOGICOS, narrativa(texto, "Sin antecedentes personales patológicos registrados"));
}

function manifestacionesIniciales(d: DatosResumen): XmlNodo {
  const texto = [
    ...parrafosDeNota(ultimaNota(d, "HISTORIA_CLINICA"), ["padecimientoActual"]),
    ...parrafosDeNota(ultimaNota(d, "INGRESO"), ["resumenInterrogatorio"]),
    ...parrafosDeNota(ultimaNota(d, "HOJA_URGENCIAS"), ["motivoAtencion", "resumenInterrogatorio"]),
  ];
  if (!texto.length && d.episodio.motivo) texto.push(...parrafos(d.episodio.motivo, "Motivo del ingreso"));
  if (d.episodio.triageNivel) texto.push(parrafo(`Triage (NOM-027): nivel ${d.episodio.triageNivel}`));
  return seccion(SECCION.MANIFESTACIONES_INICIALES, narrativa(texto, "Sin manifestaciones iniciales registradas"));
}

function impresionDiagnostica(d: DatosResumen): XmlNodo {
  const texto = [
    ...parrafosDeNota(ultimaNota(d, "INGRESO"), ["diagnosticos"]),
    ...parrafosDeNota(ultimaNota(d, "HOJA_URGENCIAS"), ["diagnosticos"]),
    ...parrafosDeNota(ultimaNota(d, "HISTORIA_CLINICA"), ["diagnosticos"]),
    ...parrafosDeNota(ultimaNota(d, "PREOPERATORIA"), ["diagnostico"]),
  ];
  const ingreso = d.diagnosticos.find((x) => x.tipo === "Ingreso");
  if (ingreso) texto.push(parrafo(`Diagnóstico de ingreso (CIE-10 ${ingreso.codigo}): ${ingreso.nombre ?? ingreso.texto ?? ingreso.codigo}`));
  else if (d.episodio.diagnostico) texto.push(...parrafos(d.episodio.diagnostico, "Diagnóstico de ingreso"));
  return seccion(SECCION.IMPRESION_DIAGNOSTICA, narrativa(texto, "Sin impresión diagnóstica registrada"));
}

function diagnosticos(d: DatosResumen, ctx: Contexto): XmlNodo {
  const filas = d.diagnosticos.map((x) => [x.tipo, fecha(x.fecha), x.codigo, x.nombre ?? "(no está en el catálogo CIE-10)", x.texto ?? "—"]);
  const texto: XmlNodo[] = filas.length ? [tabla(["Tipo", "Fecha", "CIE-10", "Diagnóstico (catálogo)", "Glosa del médico"], filas)] : [];
  if (!filas.length && d.episodio.diagnostico) texto.push(...parrafos(d.episodio.diagnostico, "Diagnóstico (sin codificar)"));
  const entradas = d.diagnosticos.map((x, i) =>
    el("entry", { typeCode: "DRIV" }, [
      el("act", { classCode: "ACT", moodCode: "EVN" }, [
        codigo("code", ACT_CLASS_CONCERN, OID_HL7_ACT_CLASS, "ActClass"),
        el("statusCode", { code: "completed" }),
        el("effectiveTime", {}, [
          el("low", { value: fechaHoraCda(x.fecha ?? d.episodio.fechaIngreso) }),
          x.tipo === "Egreso" && d.episodio.fechaAlta ? el("high", { value: fechaHoraCda(d.episodio.fechaAlta) }) : null,
        ]),
        el("entryRelationship", { typeCode: "SUBJ" }, [
          el("observation", { classCode: "OBS", moodCode: "EVN" }, [
            idNodo(ctx.raices.episodios, `${d.episodio.id}/dx/${i + 1}`, x.tipo),
            codigo("code", SNOMED_DIAGNOSTICO, OID_SNOMED, "SNOMED CT"),
            x.texto ? el("text", {}, [x.texto]) : null,
            el("statusCode", { code: "completed" }),
            x.fecha ? el("effectiveTime", {}, [el("low", { value: fechaHoraCda(x.fecha) })]) : null,
            el(
              "value",
              { "xsi:type": "CD", code: x.clave, codeSystem: OID_CIE10, codeSystemName: "CIE-10", displayName: x.nombre ?? undefined },
              x.nombre ? [] : [el("originalText", {}, [x.texto ?? x.codigo])]
            ),
          ]),
        ]),
      ]),
    ])
  );
  return seccion(SECCION.DIAGNOSTICOS, narrativa(texto, "Sin diagnósticos codificados registrados"), entradas);
}

/** Dónde se hizo el procedimiento (HealthcareServiceLocation) según lo que sabemos del episodio. */
function ubicacionProcedimiento(d: DatosResumen, quirofano: boolean) {
  if (quirofano) return UBICACION_PROCEDIMIENTO.QUIROFANO;
  if (d.episodio.area === "TERAPIA") return UBICACION_PROCEDIMIENTO.UCI;
  if (d.episodio.tipo === "URGENCIAS") return UBICACION_PROCEDIMIENTO.URGENCIAS;
  if (d.episodio.tipo === "AMBULATORIO") return UBICACION_PROCEDIMIENTO.CIRUGIA_AMBULATORIA;
  return UBICACION_PROCEDIMIENTO.PABELLON;
}

function performerMedico(nombre: string | null, cedula: string | null): XmlNodo | null {
  if (!nombre && !cedula) return null;
  return el("performer", {}, [
    el("assignedEntity", {}, [
      cedula ? idNodo(OID_CEDULA_PROFESIONAL, cedula, "Cédula profesional") : idNulo(OID_CEDULA_PROFESIONAL, "UNK", "Cédula profesional"),
      nombre ? el("assignedPerson", {}, [nodoNombreLibre(nombre)]) : null,
    ]),
  ]);
}

function procedimientos(d: DatosResumen): XmlNodo {
  const nota = ultimaNota(d, "PROCEDIMIENTO");
  const post = ultimaNota(d, "POSTOPERATORIA");
  const filas = d.procedimientos.map((x) => [
    x.codigo,
    x.nombre ?? "(no está en el catálogo CIE-9-MC)",
    fecha(x.fecha),
    x.medicoNombre ? `${x.medicoNombre}${x.medicoCedula ? ` (céd. ${x.medicoCedula})` : ""}` : x.medicoCedula ? `céd. ${x.medicoCedula}` : "—",
    [x.texto, x.anestesia ? `Anestesia: ${x.anestesia}` : null, x.quirofano ? "Quirófano" : null].filter(Boolean).join(" · ") || "—",
  ]);
  const texto: XmlNodo[] = filas.length ? [tabla(["CIE-9-MC", "Procedimiento (catálogo)", "Fecha", "Médico", "Observaciones"], filas)] : [];
  if (!filas.length && d.episodio.procedimiento) texto.push(...parrafos(d.episodio.procedimiento, "Procedimiento (sin codificar)"));
  texto.push(...parrafosDeNota(post, ["operacionRealizada", "hallazgos", "incidentes", "estadoPostquirurgico"]));
  if (nota && !post) texto.push(encabezadoNota(nota), ...parrafos(nota.texto));
  const entradas = d.procedimientos.map((x) =>
    el("entry", { typeCode: "DRIV" }, [
      el("procedure", { classCode: "PROC", moodCode: "EVN" }, [
        el("code", { code: x.clave, codeSystem: OID_CIE9MC, codeSystemName: "CIE-9-MC", displayName: x.nombre ?? undefined }, x.texto ? [el("originalText", {}, [x.texto])] : []),
        el("statusCode", { code: "completed" }),
        x.fecha ? el("effectiveTime", { value: fechaHoraCda(x.fecha) }) : null,
        performerMedico(x.medicoNombre, x.medicoCedula),
        el("participant", { typeCode: "LOC" }, [
          el("participantRole", { classCode: "SDLOC" }, [codigo("code", ubicacionProcedimiento(d, x.quirofano), OID_HEALTHCARE_SERVICE_LOCATION, "HealthcareServiceLocation")]),
        ]),
      ]),
    ])
  );
  return seccion(SECCION.PROCEDIMIENTOS, narrativa(texto, "Sin procedimientos registrados"), entradas);
}

/** Unidad de farmacia («pz», «frasco ámpula») como anotación UCUM: `{pz}`. */
function unidadUcum(unidad: string): string {
  const limpia = unidad.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9_.-]/g, "");
  return `{${limpia || "unidad"}}`;
}

function medicamentos(d: DatosResumen): XmlNodo {
  const filas = d.medicamentos.map((m) => [
    m.presentacion ? `${m.nombre} (${m.presentacion})` : m.nombre,
    m.via ?? "—",
    m.dosis ?? "—",
    `${numero(m.cantidad, 2)} ${m.unidad}`,
    fechaLegible(m.fecha),
    m.lote ?? "—",
    [m.sustanciaActiva ? `Sustancia activa: ${m.sustanciaActiva}` : null, m.observaciones, m.medicoNombre ? `Indica: ${m.medicoNombre}` : null].filter(Boolean).join(" · ") || "—",
  ]);
  const texto: XmlNodo[] = filas.length ? [tabla(["Medicamento", "Vía", "Dosis", "Cantidad", "Fecha y hora", "Lote", "Observaciones"], filas)] : [];
  const entradas = d.medicamentos.map((m) =>
    el("entry", {}, [
      el("substanceAdministration", { classCode: "SBADM", moodCode: "EVN", negationInd: "false" }, [
        el("text", {}, [[m.nombre, m.presentacion, m.dosis ? `dosis ${m.dosis}` : null, m.via ? `vía ${m.via}` : null, `${numero(m.cantidad, 2)} ${m.unidad}`, m.lote ? `lote ${m.lote}` : null].filter(Boolean).join(" · ")]),
        el("statusCode", { code: "completed" }),
        el("effectiveTime", { value: fechaHoraCda(m.fecha) }),
        // Sin catálogo de vías del Cuadro Básico: la vía capturada va como texto original.
        m.via ? codigoNulo("routeCode", "OTH", m.via, { codeSystem: OID_VIA_ADMINISTRACION_CBM, codeSystemName: "Vía de Administración CBM" }) : null,
        el("doseQuantity", { value: numero(m.cantidad, 3), unit: unidadUcum(m.unidad) }),
        el("consumable", {}, [
          el("manufacturedProduct", { classCode: "MANU" }, [
            el("manufacturedMaterial", {}, [
              // Sin clave del Cuadro Básico de Medicamentos en el catálogo local: nullFlavor UNK con el nombre.
              codigoNulo("code", "UNK", m.nombre, { codeSystem: OID_CUADRO_BASICO_MEDICAMENTOS, codeSystemName: "Cuadro Básico de Medicamentos" }),
              el("name", {}, [m.presentacion ? `${m.nombre} (${m.presentacion})` : m.nombre]),
              m.lote ? el("lotNumberText", {}, [m.lote]) : null,
            ]),
          ]),
        ]),
        performerMedico(m.medicoNombre, m.medicoCedula),
      ]),
    ])
  );
  return seccion(SECCION.MEDICAMENTOS, narrativa(texto, "Sin medicamentos administrados registrados"), entradas);
}

function evolucion(d: DatosResumen): XmlNodo {
  const texto: XmlNodo[] = [];
  for (const n of d.notas.filter((x) => x.tipo === "EVOLUCION")) {
    texto.push(encabezadoNota(n));
    const secciones = parrafosDeNota(n, ["subjetivo", "objetivo", "analisis", "plan", "diagnosticos", "pronostico"]);
    texto.push(...(secciones.length ? secciones : parrafos(n.texto)));
  }
  const egreso = ultimaNota(d, "EGRESO");
  if (egreso) texto.push(...parrafosDeNota(egreso, ["evolucion", "diasEstancia", "motivoEgreso"]));
  if (d.episodio.aldreteEgreso != null) texto.push(parrafo(`Aldrete al egreso (NOM-026): ${d.episodio.aldreteEgreso}`));
  return seccion(SECCION.EVOLUCION, narrativa(texto, "Sin notas de evolución registradas"));
}

function valorSigno(s: SignosResumen, k: ClaveSignoVital): number | null {
  const v = s[k];
  if (v == null) return null;
  // La talla se captura en metros («1.64») o en centímetros («164»); el CDA va en cm.
  if (k === "talla") return v <= 3 ? Math.round(v * 1000) / 10 : v;
  return v;
}

function signosVitales(d: DatosResumen): XmlNodo {
  const filas = d.signos.map((s) => [
    fechaLegible(s.fecha),
    s.taSistolica != null && s.taDiastolica != null ? `${s.taSistolica}/${s.taDiastolica} mmHg` : "—",
    numero(s.fc),
    numero(s.fr),
    s.temperatura != null ? `${numero(s.temperatura, 1)} °C` : "—",
    s.spo2 != null ? `${s.spo2} %` : "—",
    s.glucosa != null ? `${s.glucosa} mg/dL` : "—",
    s.peso != null ? `${numero(s.peso, 2)} kg` : "—",
    valorSigno(s, "talla") != null ? `${numero(valorSigno(s, "talla"), 1)} cm` : "—",
    numero(s.dolor),
    s.registradoPor,
  ]);
  const texto: XmlNodo[] = filas.length ? [tabla(["Fecha y hora", "TA", "FC", "FR", "Temp.", "SpO2", "Glucosa", "Peso", "Talla", "Dolor 0-10", "Registró"], filas)] : [];

  // Entradas: la primera y la última toma con valor de cada signo (una organizer por toma).
  const claves = Object.keys(SIGNO_VITAL) as ClaveSignoVital[];
  const tomas = new Set<number>();
  for (const k of claves) {
    const indices = d.signos.map((s, i) => (valorSigno(s, k) != null ? i : -1)).filter((i) => i >= 0);
    if (indices.length) tomas.add(indices[0]).add(indices[indices.length - 1]);
  }
  const entradas = [...tomas]
    .sort((a, b) => a - b)
    .map((i) => {
      const s = d.signos[i];
      return el("entry", {}, [
        el("organizer", { classCode: "CLUSTER", moodCode: "EVN" }, [
          codigo("code", SNOMED_SIGNOS_VITALES, OID_SNOMED, "SNOMED CT"),
          el("statusCode", { code: "completed" }),
          el("effectiveTime", { value: fechaHoraCda(s.fecha) }),
          ...claves
            .filter((k) => valorSigno(s, k) != null)
            .map((k) =>
              el("component", {}, [
                el("observation", { classCode: "OBS", moodCode: "EVN" }, [
                  codigo("code", SIGNO_VITAL[k], OID_LOINC, "LOINC"),
                  el("statusCode", { code: "completed" }),
                  el("effectiveTime", { value: fechaHoraCda(s.fecha) }),
                  el("value", { "xsi:type": "PQ", value: String(valorSigno(s, k)), unit: SIGNO_VITAL[k].unit }),
                ]),
              ])
            ),
        ]),
      ]);
    });
  return seccion(SECCION.SIGNOS_VITALES, narrativa(texto, "Sin signos vitales registrados"), entradas);
}

function plan(d: DatosResumen): XmlNodo {
  const texto: XmlNodo[] = [];
  const egreso = ultimaNota(d, "EGRESO");
  texto.push(...parrafosDeNota(egreso, ["planManejo", "recomendaciones", "problemasPendientes"]));
  const hoja = [...d.documentos].reverse().find((x) => x.tipo === "HOJA_EGRESO" && x.contenido);
  if (hoja?.contenido) {
    for (const k of ["instrucciones", "medicamentos", "dieta", "actividad", "cuidadosHerida", "datosAlarma", "citaSeguimiento", "contactoUrgencias"]) {
      const t = textoDe(hoja.contenido[k]);
      if (t) texto.push(...parrafos(t, etiqueta(k)));
    }
  }
  if (!texto.length) {
    // Episodio abierto: el plan vigente es el de la última nota médica que lo trae.
    for (let i = d.notas.length - 1; i >= 0 && !texto.length; i--) {
      texto.push(...parrafosDeNota(d.notas[i], ["plan", "tratamiento", "planQuirurgico", "sugerenciasTratamiento"]));
      if (texto.length) texto.unshift(encabezadoNota(d.notas[i]));
    }
    const indicacion = ultimaNota(d, "INDICACION");
    if (indicacion) texto.push(encabezadoNota(indicacion), ...parrafosDeNota(indicacion, ["dieta", "soluciones", "medicamentos", "cuidados", "estudios"]));
  }
  return seccion(SECCION.PLAN, narrativa(texto, "Sin plan de tratamiento registrado"));
}

function pronostico(d: DatosResumen): XmlNodo {
  for (let i = d.notas.length - 1; i >= 0; i--) {
    const t = seccionDe(d.notas[i], "pronostico");
    if (t) return seccion(SECCION.PRONOSTICO, [...parrafos(t), parrafo(`Fuente: ${PLANTILLAS_NOTA[d.notas[i].tipo]?.titulo ?? d.notas[i].tipo}, ${firma(d.notas[i])}`)]);
  }
  return seccion(SECCION.PRONOSTICO, [parrafo("Sin pronóstico registrado")]);
}

/** `<component><structuredBody>` con las secciones en el orden del anexo. */
export function nodoCuerpo(d: DatosResumen, ctx: Contexto): XmlNodo {
  const secciones: Array<XmlNodo | null> = [
    motivoReferencia(d),
    afiliaciones(d, ctx),
    alergias(d),
    heredofamiliares(d),
    noPatologicos(d),
    patologicos(d),
    manifestacionesIniciales(d),
    impresionDiagnostica(d),
    diagnosticos(d, ctx),
    procedimientos(d),
    medicamentos(d),
    evolucion(d),
    signosVitales(d),
    plan(d),
    pronostico(d),
  ];
  return el("component", {}, [el("structuredBody", {}, secciones)]);
}
