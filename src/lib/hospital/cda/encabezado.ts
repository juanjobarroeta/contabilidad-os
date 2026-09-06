// ─────────────────────────────────────────────────────────────────────────────
// Cabecera del CDA (ClinicalDocument hasta componentOf) en el ORDEN que exige
// POCD_MT000040.xsd — el anexo de la DGIS pone informationRecipient antes de
// author y birthplace antes de guardian, y así no valida; aquí manda el XSD.
// Puro: recibe DatosResumen y el contexto (instante, arcos, advertencias).
// ─────────────────────────────────────────────────────────────────────────────

import { el, type XmlNodo } from "../xml";
import {
  claveTexto,
  codigo,
  codigoNulo,
  fechaCda,
  fechaHoraCda,
  idNodo,
  idNulo,
  limpiar,
  nodoNombre,
  nodoNombreLibre,
  telecoms,
  type Raices,
} from "./comun";
import type { DatosResumen } from "./datos";
import {
  AREA_ENCUENTRO,
  CODIGO_DOCUMENTO,
  CONFIDENTIALITY_NORMAL,
  ESTADO_CONYUGAL_CDA,
  LANGUAGE_CODE,
  MOTIVO_EGRESO_CDA,
  OID_CEDULA_PROFESIONAL,
  OID_CLUES,
  OID_CURP,
  OID_HL7_ACT_CODE,
  OID_HL7_ADMINISTRATIVE_GENDER,
  OID_HL7_CONFIDENTIALITY,
  OID_HL7_DISCHARGE_DISPOSITION,
  OID_HL7_MARITAL_STATUS,
  OID_HL7_PARTICIPATION_FUNCTION,
  OID_HL7_ROLE_CODE,
  OID_LENGUAS_INDIGENAS,
  OID_LICENCIA_SANITARIA,
  OID_LOINC,
  OID_NACIONALIDAD,
  OID_RFC,
  OID_TEMPLATE_DOCUMENTO_MX,
  PARENTESCO_CDA,
  REALM_CODE,
  SEXO_CDA,
  SOFTWARE_FABRICANTE,
  SOFTWARE_NOMBRE,
  TIPO_ENCUENTRO,
  TYPE_ID_EXTENSION,
  TYPE_ID_ROOT,
} from "./oids";

export interface Contexto {
  ahora: Date;
  /** UUID del documento (extension con OID registrado; base del 2.25 sin él). */
  idDocumento: string;
  raices: Raices;
  /** Se van acumulando: lo que el documento no pudo llenar como pide la guía. */
  advertencias: string[];
}

/** Tipo de episodio (documentationOf) y de encuentro (componentOf) por tipo de episodio. */
export function codigosEncuentro(tipo: DatosResumen["episodio"]["tipo"]) {
  switch (tipo) {
    case "HOSPITALIZACION":
      return { episodio: TIPO_ENCUENTRO.IMP, encuentro: TIPO_ENCUENTRO.IMP, area: AREA_ENCUENTRO.HOSP };
    case "URGENCIAS":
      return { episodio: TIPO_ENCUENTRO.EMER, encuentro: TIPO_ENCUENTRO.EMER, area: AREA_ENCUENTRO.ER };
    case "AMBULATORIO":
      // Cirugía ambulatoria: el episodio es ambulatorio; el encuentro, de corta estancia (≤ 12 h, NOM-026).
      return { episodio: TIPO_ENCUENTRO.AMB, encuentro: TIPO_ENCUENTRO.SS, area: AREA_ENCUENTRO.OF };
    case "CONSULTA":
    default:
      return { episodio: TIPO_ENCUENTRO.AMB, encuentro: TIPO_ENCUENTRO.AMB, area: AREA_ENCUENTRO.PROFF };
  }
}

/** `<name>` del médico: campos separados (SAEH) o el nombre en una cadena. */
export function nombreMedico(m: NonNullable<DatosResumen["medico"]>): XmlNodo {
  if (m.nombres) {
    const prefijo = /^dra?\.?\s/i.test(m.nombre) ? (m.nombre.toLowerCase().startsWith("dra") ? "Dra." : "Dr.") : null;
    return nodoNombre({ prefijo, nombres: m.nombres, apellidoPaterno: m.apellidoPaterno, apellidoMaterno: m.apellidoMaterno });
  }
  return nodoNombreLibre(m.nombre);
}

function idClues(clues: string | null): XmlNodo {
  return clues ? idNodo(OID_CLUES, clues, "CLUES") : idNulo(OID_CLUES, "UNK", "CLUES");
}

function addrHospital(h: DatosResumen["hospital"]): XmlNodo | null {
  if (!h.domicilio && !h.codigoPostal) return null;
  return el("addr", {}, [h.domicilio, h.codigoPostal ? el("postalCode", {}, [h.codigoPostal]) : null, el("country", {}, ["MEX"])]);
}

/** Establecimiento como Organization (id CLUES [+ licencia], nombre, contacto, domicilio). */
function organizacionHospital(d: DatosResumen, opciones: { conLicencia?: boolean; unSoloContacto?: boolean } = {}): XmlNodo[] {
  const h = d.hospital;
  const tel = telecoms(h.telefono, h.email);
  return [
    idClues(h.clues),
    opciones.conLicencia && h.licenciaSanitaria ? idNodo(OID_LICENCIA_SANITARIA, h.licenciaSanitaria, "Licencia Sanitaria") : null,
    el("name", {}, [h.nombre]),
    ...(opciones.unSoloContacto ? tel.slice(0, 1) : tel),
    addrHospital(h),
  ].filter((n): n is XmlNodo => !!n);
}

function addrPaciente(p: DatosResumen["paciente"]): XmlNodo | null {
  const partes: XmlNodo["hijos"] = [
    p.domicilio,
    p.calle ? el("streetName", {}, [p.calle]) : null,
    p.numeroExterior ? el("houseNumber", {}, [p.numeroExterior]) : null,
    p.numeroInterior ? el("unitID", {}, [p.numeroInterior]) : null,
    p.colonia ? el("deliveryInstallationArea", {}, [p.colonia]) : null,
    p.localidadResidenciaClave ? el("precinct", {}, [p.localidadResidenciaClave]) : null,
    p.municipioResidenciaClave || p.municipio ? el("county", {}, [p.municipioResidenciaClave ?? p.municipio!]) : null,
    p.municipioResidenciaClave && p.municipio ? el("city", {}, [p.municipio]) : null,
    p.entidadResidenciaClave || p.estado ? el("state", {}, [p.entidadResidenciaClave ?? p.estado!]) : null,
    p.codigoPostal ? el("postalCode", {}, [p.codigoPostal]) : null,
    el("country", {}, [p.paisResidenciaClave ?? "MEX"]),
  ];
  const hayAlgo = partes.some((x) => x && (typeof x !== "object" || x.tag !== "country"));
  return hayAlgo ? el("addr", { use: "HP" }, partes) : null;
}

function guardian(p: DatosResumen["paciente"]): XmlNodo | null {
  if (!p.contactoEmergenciaNombre || !p.contactoEmergenciaParentesco) return null;
  const parentesco = PARENTESCO_CDA[claveTexto(p.contactoEmergenciaParentesco)];
  return el("guardian", {}, [
    parentesco ? codigo("code", parentesco, OID_HL7_ROLE_CODE, "RoleCode") : codigoNulo("code", "OTH", p.contactoEmergenciaParentesco),
    ...telecoms(p.contactoEmergenciaTelefono, null),
    el("guardianPerson", {}, [nodoNombreLibre(p.contactoEmergenciaNombre)]),
  ]);
}

function recordTarget(d: DatosResumen, ctx: Contexto): XmlNodo {
  const p = d.paciente;
  const ids: XmlNodo[] = [idNodo(ctx.raices.pacientes, p.id, "HospitalOS")];
  if (p.expedienteNumero) ids.push(idNodo(ctx.raices.expedientes, p.expedienteNumero, "Número de expediente"));
  if (p.curp && !p.sinCurp) ids.push(idNodo(OID_CURP, p.curp, "CURP"));
  else if (p.sinCurp) ids.push(idNulo(OID_CURP, "NA", "CURP"));
  else {
    ids.push(idNulo(OID_CURP, "UNK", "CURP"));
    ctx.advertencias.push("El paciente no tiene CURP registrada (NOM-024 6.5.1)");
  }
  if (p.rfc) ids.push(idNodo(OID_RFC, p.rfc, "RFC"));
  if (p.nacionalidad) ids.push(idNodo(OID_NACIONALIDAD, p.nacionalidad, "Nacionalidad"));

  const sexo = p.sexo ? SEXO_CDA[p.sexo] : null;
  const conyugal = p.estadoConyugal != null ? ESTADO_CONYUGAL_CDA[p.estadoConyugal] : null;

  return el("recordTarget", {}, [
    el("patientRole", {}, [
      ...ids,
      addrPaciente(p),
      ...telecoms(p.telefono, p.email),
      el("patient", {}, [
        nodoNombre({ nombres: p.nombre, apellidoPaterno: p.apellidoPaterno, apellidoMaterno: p.apellidoMaterno }),
        sexo ? codigo("administrativeGenderCode", sexo, OID_HL7_ADMINISTRATIVE_GENDER, "AdministrativeGender") : codigoNulo("administrativeGenderCode", "UNK"),
        p.fechaNacimiento ? el("birthTime", { value: fechaCda(p.fechaNacimiento) }) : el("birthTime", { nullFlavor: "UNK" }),
        conyugal ? codigo("maritalStatusCode", conyugal, OID_HL7_MARITAL_STATUS, "MaritalStatus") : null,
        p.hablaLenguaIndigena && p.lenguaIndigenaClave
          ? codigo("ethnicGroupCode", { code: p.lenguaIndigenaClave }, OID_LENGUAS_INDIGENAS, "Lenguas Indígenas INEGI")
          : null,
        guardian(p),
        p.entidadNacimientoClave ? el("birthplace", {}, [el("place", {}, [el("addr", {}, [el("state", {}, [p.entidadNacimientoClave]), el("country", {}, ["MEX"])])])]) : null,
      ]),
      el("providerOrganization", {}, organizacionHospital(d)),
    ]),
  ]);
}

function author(d: DatosResumen, ctx: Contexto): XmlNodo {
  return el("author", {}, [
    el("time", { value: fechaHoraCda(ctx.ahora) }),
    el("assignedAuthor", {}, [
      idNodo(ctx.raices.sistema, null, SOFTWARE_NOMBRE),
      el("assignedAuthoringDevice", {}, [el("manufacturerModelName", {}, [SOFTWARE_FABRICANTE]), el("softwareName", {}, [SOFTWARE_NOMBRE])]),
      el("representedOrganization", {}, [idClues(d.hospital.clues), el("name", {}, [d.hospital.nombre])]),
    ]),
  ]);
}

function dataEnterer(d: DatosResumen, ctx: Contexto): XmlNodo | null {
  const u = d.usuario;
  if (!u || (!u.email && !u.id)) return null;
  const nombre = limpiar(u.nombre);
  return el("dataEnterer", {}, [
    el("time", { value: fechaHoraCda(ctx.ahora) }),
    el("assignedEntity", {}, [
      idNodo(ctx.raices.usuarios, u.email ?? u.id, "Usuario HospitalOS"),
      el("assignedPerson", {}, [nombre ? nodoNombreLibre(nombre) : el("name", {}, [u.email ?? u.id!])]),
    ]),
  ]);
}

function custodian(d: DatosResumen): XmlNodo {
  return el("custodian", {}, [
    el("assignedCustodian", {}, [el("representedCustodianOrganization", {}, organizacionHospital(d, { unSoloContacto: true }))]),
  ]);
}

function informationRecipient(d: DatosResumen): XmlNodo | null {
  const r = d.destinatario;
  if (d.tipo !== "REFERENCIA" || !r) return null;
  const clues = limpiar(r.clues);
  const organizacion = limpiar(r.organizacion);
  return el("informationRecipient", { typeCode: "PRCP" }, [
    el("intendedRecipient", {}, [
      limpiar(r.cedula) ? idNodo(OID_CEDULA_PROFESIONAL, r.cedula!.trim(), "Cédula profesional") : null,
      el("informationRecipient", {}, [nodoNombreLibre(r.nombre)]),
      clues || organizacion
        ? el("receivedOrganization", {}, [clues ? idNodo(OID_CLUES, clues, "CLUES") : null, organizacion ? el("name", {}, [organizacion]) : null])
        : null,
    ]),
  ]);
}

function legalAuthenticator(d: DatosResumen, ctx: Contexto): XmlNodo | null {
  const m = d.medico;
  if (!m) {
    ctx.advertencias.push("El episodio no tiene médico tratante: el documento sale sin legalAuthenticator");
    return null;
  }
  if (!m.cedula) {
    ctx.advertencias.push(`${m.nombre} no tiene cédula profesional registrada: el documento sale sin legalAuthenticator (NOM-004)`);
    return null;
  }
  return el("legalAuthenticator", {}, [
    el("time", { value: fechaHoraCda(d.episodio.fechaAlta ?? ctx.ahora) }),
    el("signatureCode", { code: "S" }),
    el("assignedEntity", {}, [idNodo(OID_CEDULA_PROFESIONAL, m.cedula, "Cédula profesional"), el("assignedPerson", {}, [nombreMedico(m)])]),
  ]);
}

function assignedEntityMedico(d: DatosResumen, conOrganizacion: boolean): XmlNodo {
  const m = d.medico!;
  return el("assignedEntity", {}, [
    m.cedula ? idNodo(OID_CEDULA_PROFESIONAL, m.cedula, "Cédula profesional") : idNulo(OID_CEDULA_PROFESIONAL, "UNK", "Cédula profesional"),
    el("assignedPerson", {}, [nombreMedico(m)]),
    conOrganizacion ? el("representedOrganization", {}, organizacionHospital(d, { conLicencia: true })) : null,
  ]);
}

function intervalo(inicio: Date, fin: Date | null): XmlNodo {
  return el("effectiveTime", {}, [el("low", { value: fechaHoraCda(inicio) }), fin ? el("high", { value: fechaHoraCda(fin) }) : null]);
}

function documentationOf(d: DatosResumen, ctx: Contexto): XmlNodo {
  const e = d.episodio;
  const c = codigosEncuentro(e.tipo);
  return el("documentationOf", { typeCode: "DOC" }, [
    el("serviceEvent", { classCode: "PCPR" }, [
      idNodo(ctx.raices.episodios, e.folio, "Folio del episodio"),
      codigo("code", c.episodio, OID_HL7_ACT_CODE, "ActCode"),
      intervalo(e.fechaIngreso, e.fechaAlta),
      d.medico
        ? el("performer", { typeCode: "PRF" }, [
            codigo("functionCode", { code: "PP", displayName: "Médico responsable" }, OID_HL7_PARTICIPATION_FUNCTION, "ParticipationFunction"),
            assignedEntityMedico(d, true),
          ])
        : null,
    ]),
  ]);
}

function componentOf(d: DatosResumen, ctx: Contexto): XmlNodo {
  const e = d.episodio;
  const c = codigosEncuentro(e.tipo);
  const egreso = e.motivoEgreso ? MOTIVO_EGRESO_CDA[e.motivoEgreso] : null;
  const h = d.hospital;
  return el("componentOf", {}, [
    el("encompassingEncounter", {}, [
      idNodo(ctx.raices.episodios, e.id, "Episodio HospitalOS"),
      codigo("code", c.encuentro, OID_HL7_ACT_CODE, "ActCode"),
      intervalo(e.fechaIngreso, e.fechaAlta),
      egreso ? codigo("dischargeDispositionCode", egreso, OID_HL7_DISCHARGE_DISPOSITION, "HL7 Discharge Disposition") : null,
      d.medico ? el("responsibleParty", {}, [assignedEntityMedico(d, false)]) : null,
      el("location", {}, [
        el("healthCareFacility", {}, [
          idClues(h.clues),
          h.licenciaSanitaria ? idNodo(OID_LICENCIA_SANITARIA, h.licenciaSanitaria, "Licencia Sanitaria") : null,
          codigo("code", c.area, OID_HL7_ROLE_CODE, "RoleCode"),
          el("location", {}, [el("name", {}, [e.recursoNombre ? `${h.nombre} · ${e.recursoNombre}` : h.nombre]), addrHospital(h)]),
          el("serviceProviderOrganization", {}, [idClues(h.clues), el("name", {}, [h.nombre])]),
        ]),
      ]),
    ]),
  ]);
}

/** Todos los hijos de ClinicalDocument antes del `component` del cuerpo, en el orden del XSD. */
export function nodosEncabezado(d: DatosResumen, ctx: Contexto): XmlNodo[] {
  const doc = CODIGO_DOCUMENTO[d.tipo];
  const r = ctx.raices;
  // Con OID registrado el documento es root + extension (UUID); sin él, el 2.25 derivado del UUID es el id completo.
  const idDocumento = r.registrado ? idNodo(r.documento, ctx.idDocumento, SOFTWARE_NOMBRE) : idNodo(r.documento, null, SOFTWARE_NOMBRE);
  const setId = el("setId", { root: r.documento, extension: r.registrado ? ctx.idDocumento : undefined, assigningAuthorityName: SOFTWARE_NOMBRE });
  if (!r.registrado) ctx.advertencias.push("Sin OID registrado ante la DGIS (HospConfig.oidRaiz): identificadores temporales del arco 2.25, documento no intercambiable");
  if (!d.hospital.clues) ctx.advertencias.push("Sin CLUES del establecimiento (HospConfig.clues): custodian y encuentro salen con nullFlavor");
  if (!d.hospital.licenciaSanitaria) ctx.advertencias.push("Sin licencia sanitaria (HospConfig.licenciaSanitaria)");

  return [
    el("realmCode", { code: REALM_CODE }),
    el("typeId", { root: TYPE_ID_ROOT, extension: TYPE_ID_EXTENSION }),
    el("templateId", { root: OID_TEMPLATE_DOCUMENTO_MX }),
    idDocumento,
    codigo("code", doc, OID_LOINC, "LOINC"),
    el("title", {}, [doc.titulo]),
    el("effectiveTime", { value: fechaHoraCda(ctx.ahora) }),
    codigo("confidentialityCode", CONFIDENTIALITY_NORMAL, OID_HL7_CONFIDENTIALITY, "Confidentiality"),
    el("languageCode", { code: LANGUAGE_CODE }),
    setId,
    el("versionNumber", { value: 1 }),
    recordTarget(d, ctx),
    author(d, ctx),
    dataEnterer(d, ctx),
    custodian(d),
    informationRecipient(d),
    legalAuthenticator(d, ctx),
    documentationOf(d, ctx),
    componentOf(d, ctx),
  ].filter((n): n is XmlNodo => !!n);
}
