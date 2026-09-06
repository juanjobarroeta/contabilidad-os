import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { fechaHoraCda, oidDeUuid, partirNombre, raicesDe, uuidV5 } from "./comun";
import { cargarDatos, extraerCodigosCie10, type DatosResumen } from "./datos";
import { armarCda } from "./resumen-clinico";

const OID_HOSPITAL = "2.16.840.1.113883.3.9999.1";
const UUID_DOC = "6f1d2c3b-4a5e-4f60-8b71-9c2d3e4f5a6b";
const AHORA = new Date("2026-09-05T20:30:00Z"); // 14:30 en la Ciudad de México

function fixture(extra: Partial<DatosResumen> = {}): DatosResumen {
  return {
    tipo: "EPISODIO",
    companyId: "cmp_haltus",
    hospital: {
      nombre: "Haltus Hope",
      razonSocial: "HOSPITAL HALTUS HOPE SA DE CV",
      rfc: "HHH010101AAA",
      clues: "PLSMP001234",
      licenciaSanitaria: "COFEPRIS 21-AM-21-114-0034",
      oidRaiz: null,
      telefono: "222 123 4567",
      email: "contacto@haltus.test",
      domicilio: "Av. Reforma 100, Centro, Puebla",
      codigoPostal: "72000",
      responsableSanitario: "Dra. Patricia Ledesma",
      responsableSanitarioCedula: "5217736",
    },
    usuario: { id: "usr_1", email: "revisor@haltus.test", nombre: "Revisor Haltus" },
    paciente: {
      id: "pac_ortega",
      expedienteNumero: "EXP-2026-0001",
      nombre: "María Fernanda",
      apellidoPaterno: "Ortega",
      apellidoMaterno: "Ruiz",
      curp: "OERF920314MPLRZR06",
      sinCurp: false,
      rfc: null,
      sexo: "FEMENINO",
      fechaNacimiento: new Date("1992-03-14T18:00:00Z"),
      telefono: "222 431 8890",
      email: null,
      domicilio: "Av. Juárez 2915 int. 4B, La Paz, Puebla, Puebla, C.P. 72160",
      calle: "Av. Juárez",
      numeroExterior: "2915",
      numeroInterior: "4B",
      colonia: "La Paz",
      municipio: "Puebla",
      estado: "Puebla",
      codigoPostal: "72160",
      paisResidenciaClave: "142",
      entidadResidenciaClave: "21",
      municipioResidenciaClave: "114",
      localidadResidenciaClave: "0001",
      nacionalidad: "MEX",
      entidadNacimientoClave: "21",
      estadoConyugal: 5,
      hablaLenguaIndigena: false,
      lenguaIndigenaClave: null,
      tipoSangre: "O+",
      alergias: "Penicilina <urticaria> & AINEs",
      antecedentes: null,
      contactoEmergenciaNombre: "Rodrigo Salazar Mendoza",
      contactoEmergenciaTelefono: "222 555 0000",
      contactoEmergenciaParentesco: "Esposo",
      derechohabienciaClave: "1",
    },
    episodio: {
      id: "epi_0418",
      folio: "HOSP-2026-0418",
      tipo: "HOSPITALIZACION",
      estado: "ALTA",
      fechaIngreso: new Date("2026-09-03T19:20:00Z"),
      fechaAlta: new Date("2026-09-05T16:00:00Z"),
      motivoEgreso: "MEJORIA",
      motivo: "Programada para colecistectomía laparoscópica",
      diagnostico: "Cálculo de vesícula biliar",
      procedimiento: "Colecistectomía laparoscópica",
      autorizacionPagador: "GNP-A-2026-118240",
      area: "HOSPITALIZACION",
      recursoNombre: "204",
      asa: "I",
      aldreteEgreso: 10,
      triageNivel: null,
    },
    medico: { nombre: "Dr. Alonso Vega", nombres: null, apellidoPaterno: null, apellidoMaterno: null, cedula: "5583201", especialidad: "Cirugía general" },
    pagador: { nombre: "GNP Seguros", tipo: "ASEGURADORA", rfc: "GSE930415KL7", vigenciaInicio: new Date("2026-01-01T06:00:00Z"), vigenciaFin: new Date("2027-01-01T05:59:00Z"), poliza: "POL-778812" },
    diagnosticos: [
      { tipo: "Ingreso", codigo: "K80.2", clave: "K802", nombre: "Cálculo de la vesícula biliar sin colecistitis", fecha: new Date("2026-09-03T19:20:00Z"), texto: "Colelitiasis sintomática" },
      { tipo: "Egreso", codigo: "K80.2", clave: "K802", nombre: "Cálculo de la vesícula biliar sin colecistitis", fecha: new Date("2026-09-05T16:00:00Z"), texto: "Colelitiasis resuelta" },
    ],
    procedimientos: [
      { codigo: "51.23", clave: "5123", nombre: "Colecistectomía laparoscópica", fecha: new Date("2026-09-03T23:40:00Z"), texto: "Colecistectomía laparoscópica sin complicaciones", medicoNombre: "Dr. Alonso Vega", medicoCedula: "5583201", quirofano: true, anestesia: "General balanceada" },
    ],
    medicamentos: [
      { id: "car_1", fecha: new Date("2026-09-03T20:10:00Z"), nombre: "Cefalotina 1 g sol. iny.", categoria: "MEDICAMENTO", presentacion: "Frasco ámpula 1 g", sustanciaActiva: "Cefalotina", cantidad: 6, unidad: "pz", lote: "L-2291", dosis: "1 g c/8 h", via: "IV", observaciones: null, medicoNombre: "Dr. Alonso Vega", medicoCedula: "5583201" },
      { id: "car_2", fecha: new Date("2026-09-03T21:15:00Z"), nombre: "Solución Hartmann 1000 ml", categoria: "SOLUCION", presentacion: "Bolsa 1000 ml", sustanciaActiva: null, cantidad: 4, unidad: "pz", lote: "H-0455", dosis: null, via: null, observaciones: null, medicoNombre: null, medicoCedula: null },
    ],
    notas: [
      {
        id: "n1",
        tipo: "HISTORIA_CLINICA",
        fecha: new Date("2026-09-03T18:40:00Z"),
        autorNombre: "Dr. Alonso Vega",
        autorCedula: "5583201",
        texto: "Historia clínica de ingreso",
        secciones: {
          antecedentesHeredofamiliares: "Madre con diabetes tipo 2; padre hipertenso",
          antecedentesPersonalesPatologicos: "Niega crónico-degenerativos",
          antecedentesPersonalesNoPatologicos: "Tabaquismo negado; alcohol social",
          padecimientoActual: "Dolor en hipocondrio derecho de 3 meses",
          exploracionFisica: "Murphy positivo",
          diagnosticos: "Colelitiasis K80.2",
          pronostico: "Bueno para la vida y la función",
          plan: "Colecistectomía laparoscópica programada",
        },
      },
      {
        id: "n2",
        tipo: "EVOLUCION",
        fecha: new Date("2026-09-04T18:30:00Z"),
        autorNombre: "Dr. Alonso Vega",
        autorCedula: "5583201",
        texto: "Tolera dieta",
        secciones: { subjetivo: "Dolor 2/10", objetivo: "Herida limpia", analisis: "Evolución favorable", plan: "Alta mañana" },
      },
      {
        id: "n3",
        tipo: "EGRESO",
        fecha: new Date("2026-09-05T15:50:00Z"),
        autorNombre: "Dr. Alonso Vega",
        autorCedula: "5583201",
        texto: "Egreso por mejoría",
        secciones: { diagnosticoEgreso: "Colelitiasis K80.2", motivoEgreso: "Mejoría", evolucion: "Postoperatorio sin complicaciones", planManejo: "Analgésico c/8 h; retiro de puntos en 7 días", pronostico: "Bueno" },
      },
    ],
    signos: [
      { fecha: new Date("2026-09-03T19:30:00Z"), taSistolica: 122, taDiastolica: 80, fc: 78, fr: 17, temperatura: 36.6, spo2: 97, glucosa: null, peso: 62.5, talla: 1.64, dolor: 1, registradoPor: "Enf. Laura Méndez" },
      { fecha: new Date("2026-09-04T18:00:00Z"), taSistolica: 118, taDiastolica: 76, fc: 72, fr: 16, temperatura: 36.4, spo2: 98, glucosa: null, peso: null, talla: null, dolor: 2, registradoPor: "Enf. Laura Méndez" },
    ],
    documentos: [{ tipo: "HOJA_EGRESO", nombre: "Hoja de egreso", estado: "FIRMADO", createdAt: new Date("2026-09-05T16:00:00Z"), contenido: { instrucciones: "Dieta blanda", datosAlarma: "Fiebre > 38 °C", citaSeguimiento: "12-sep-2026" } }],
    destinatario: null,
    motivoReferencia: null,
    ...extra,
  };
}

const armar = (extra: Partial<DatosResumen> = {}) => armarCda(fixture(extra), { ahora: AHORA, idDocumento: UUID_DOC });

describe("comun", () => {
  it("formatea fechas HL7 con el offset de la Ciudad de México", () => {
    expect(fechaHoraCda(AHORA)).toBe("20260905143000-0600");
    expect(fechaHoraCda(new Date("2026-01-01T05:59:59Z"))).toBe("20251231235959-0600");
  });

  it("parte nombres con prefijo y heurística de apellidos", () => {
    expect(partirNombre("Dr. Alonso Vega")).toEqual({ prefijo: "Dr.", nombres: "Alonso", apellidos: ["Vega"] });
    expect(partirNombre("Rodrigo Salazar Mendoza")).toEqual({ prefijo: null, nombres: "Rodrigo", apellidos: ["Salazar", "Mendoza"] });
    expect(partirNombre("María Fernanda Ortega Ruiz")).toEqual({ prefijo: null, nombres: "María Fernanda", apellidos: ["Ortega", "Ruiz"] });
  });

  it("deriva arcos 2.25 estables sin OID registrado y .1/.2/.3 con él", () => {
    const sin = raicesDe(null, "cmp_1", UUID_DOC);
    expect(sin.registrado).toBe(false);
    expect(sin.documento).toBe(oidDeUuid(UUID_DOC));
    expect(sin.documento).toMatch(/^2\.25\.\d+$/);
    expect(sin.pacientes).toBe(raicesDe(null, "cmp_1", "00000000-0000-4000-8000-000000000000").pacientes);
    expect(sin.pacientes).not.toBe(raicesDe(null, "cmp_2", UUID_DOC).pacientes);
    const con = raicesDe(OID_HOSPITAL, "cmp_1", UUID_DOC);
    expect(con).toMatchObject({ registrado: true, documento: `${OID_HOSPITAL}.1`, pacientes: `${OID_HOSPITAL}.2`, episodios: `${OID_HOSPITAL}.3` });
    expect(uuidV5("x")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("extrae códigos CIE-10 con punto del texto del médico", () => {
    expect(extraerCodigosCie10("Colelitiasis K80.2 y HAS i10.x; vitamina B12 normal")).toEqual(["K80.2", "I10.X"]);
  });
});

describe("armarCda — cabecera", () => {
  it("lleva realm MX, templateId de México, CURP, CLUES del custodio y el LOINC del tipo", () => {
    const { xml, meta } = armar();
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<ClinicalDocument xmlns="urn:hl7-org:v3"')).toBe(true);
    expect(xml).toContain('<realmCode code="MX"/>');
    expect(xml).toContain('<typeId root="2.16.840.1.113883.1.3" extension="POCD_HD000040"/>');
    expect(xml).toContain('<templateId root="2.16.840.1.113883.3.215.11.1.1"/>');
    expect(xml).toContain('<id root="2.16.840.1.113883.4.629" extension="OERF920314MPLRZR06" assigningAuthorityName="CURP"/>');
    expect(xml).toMatch(/<representedCustodianOrganization>\s*<id root="2\.16\.840\.1\.113883\.4\.631" extension="PLSMP001234" assigningAuthorityName="CLUES"\/>/);
    expect(xml).toContain('code="34133-9"');
    expect(xml).toContain("<title>Resumen clínico</title>");
    expect(xml).toContain('<effectiveTime value="20260905143000-0600"/>');
    expect(xml).toContain('<languageCode code="es-MX"/>');
    expect(xml).toContain('<administrativeGenderCode code="F"');
    expect(xml).toContain('<birthTime value="19920314"/>');
    expect(xml).toContain('<maritalStatusCode code="M"');
    expect(xml).toMatch(/<guardian>\s*<code code="SPS"/);
    expect(xml).toContain('<softwareName>HospitalOS / ContabilidadOS</softwareName>');
    expect(xml).toContain('<dischargeDispositionCode code="2" codeSystem="2.16.840.1.113883.12.112"');
    expect(xml).toContain('<code code="IMP" codeSystem="2.16.840.1.113883.5.4"');
    expect(xml).toContain('<id root="2.16.840.1.113883.3.215.12.18" extension="5583201"');
    expect(xml).toContain('<id root="2.16.840.1.113883.3.215.1.1" extension="COFEPRIS 21-AM-21-114-0034"');
    expect(xml).toContain('<signatureCode code="S"/>');
    expect(meta).toMatchObject({ tipo: "EPISODIO", codigo: "34133-9", id: UUID_DOC });
    expect(meta.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sin OID registrado usa el arco 2.25 y marca el documento como no intercambiable", () => {
    const { xml, meta } = armar();
    expect(meta.intercambiable).toBe(false);
    expect(meta.oidRoot).toBe(oidDeUuid(UUID_DOC));
    expect(xml).toContain(`<id root="${meta.oidRoot}" assigningAuthorityName="HospitalOS / ContabilidadOS"/>`);
    expect(xml).toContain(`<setId root="${meta.oidRoot}" assigningAuthorityName="HospitalOS / ContabilidadOS"/>`);
    expect(meta.advertencias.some((a) => a.includes("Sin OID registrado"))).toBe(true);
  });

  it("con OID registrado y CLUES el documento es intercambiable y cuelga de oidRaiz.1", () => {
    const { xml, meta } = armar({ hospital: { ...fixture().hospital, oidRaiz: OID_HOSPITAL } });
    expect(meta.intercambiable).toBe(true);
    expect(meta.oidRoot).toBe(`${OID_HOSPITAL}.1`);
    expect(xml).toContain(`<id root="${OID_HOSPITAL}.1" extension="${UUID_DOC}" assigningAuthorityName="HospitalOS / ContabilidadOS"/>`);
    expect(xml).toContain(`<setId root="${OID_HOSPITAL}.1" extension="${UUID_DOC}" assigningAuthorityName="HospitalOS / ContabilidadOS"/>`);
    expect(xml).toContain('<versionNumber value="1"/>');
    expect(xml).toContain(`<id root="${OID_HOSPITAL}.2" extension="pac_ortega" assigningAuthorityName="HospitalOS"/>`);
    expect(xml).toContain(`<id root="${OID_HOSPITAL}.3" extension="HOSP-2026-0418"`);
    expect(meta.advertencias.some((a) => a.includes("Sin OID registrado"))).toBe(false);
  });

  it("cambia LOINC y título por tipo, y sólo REFERENCIA lleva destinatario y motivo", () => {
    const egreso = armar({ tipo: "EGRESO" });
    expect(egreso.xml).toContain('code="18842-5"');
    expect(egreso.xml).toContain("<title>Resumen clínico de egreso</title>");
    expect(egreso.xml).not.toContain("<informationRecipient");
    expect(egreso.xml).not.toContain('code="42349-1"');

    const ref = armar({
      tipo: "REFERENCIA",
      destinatario: { nombre: "Dra. Elena Prieto Sosa", cedula: "7001122", clues: "PLSSA000123", organizacion: "Hospital General de Puebla" },
      motivoReferencia: "Valoración por gastroenterología",
    });
    expect(ref.xml).toContain('code="11488-4"');
    expect(ref.xml).toContain('<informationRecipient typeCode="PRCP">');
    expect(ref.xml).toContain('<id root="2.16.840.1.113883.3.215.12.18" extension="7001122"');
    expect(ref.xml).toMatch(/<receivedOrganization>\s*<id root="2\.16\.840\.1\.113883\.4\.631" extension="PLSSA000123"/);
    expect(ref.xml).toContain('code="42349-1"');
    expect(ref.xml).toContain("Valoración por gastroenterología");
  });

  it("CURP ausente: nullFlavor NA cuando es sinCurp, UNK (con advertencia) cuando falta", () => {
    const sin = armar({ paciente: { ...fixture().paciente, curp: null, sinCurp: true } });
    expect(sin.xml).toContain('<id root="2.16.840.1.113883.4.629" nullFlavor="NA" assigningAuthorityName="CURP"/>');
    const falta = armar({ paciente: { ...fixture().paciente, curp: null, sinCurp: false } });
    expect(falta.xml).toContain('<id root="2.16.840.1.113883.4.629" nullFlavor="UNK" assigningAuthorityName="CURP"/>');
    expect(falta.meta.advertencias.some((a) => a.includes("CURP"))).toBe(true);
  });

  it("médico sin cédula: sin legalAuthenticator y con advertencia", () => {
    const { xml, meta } = armar({ medico: { ...fixture().medico!, cedula: null } });
    expect(xml).not.toContain("<legalAuthenticator>");
    expect(meta.advertencias.some((a) => a.includes("cédula"))).toBe(true);
  });
});

describe("armarCda — cuerpo", () => {
  const LOINC_SECCIONES = ["48768-6", "48765-2", "10157-6", "29762-2", "11348-0", "10154-3", "51848-0", "11450-4", "47519-4", "29549-3", "8648-8", "8716-3", "18776-5", "47420-5"];

  it("trae todas las secciones con su LOINC en el orden del anexo", () => {
    const { xml } = armar();
    let pos = -1;
    for (const code of LOINC_SECCIONES) {
      const i = xml.indexOf(`<code code="${code}" codeSystem="2.16.840.1.113883.6.1"`);
      expect(i, `sección ${code}`).toBeGreaterThan(pos);
      pos = i;
    }
    expect(xml).not.toContain("<text/>");
  });

  it("codifica diagnósticos (CIE-10 clave DGIS), procedimientos (CIE-9-MC en 6.104), medicamentos y signos vitales", () => {
    const { xml } = armar();
    expect(xml).toContain('<code code="CONC" codeSystem="2.16.840.1.113883.5.6"');
    expect(xml).toContain('<value xsi:type="CD" code="K802" codeSystem="2.16.840.1.113883.6.3" codeSystemName="CIE-10" displayName="Cálculo de la vesícula biliar sin colecistitis"/>');
    expect(xml).toContain('<code code="5123" codeSystem="2.16.840.1.113883.6.104" codeSystemName="CIE-9-MC" displayName="Colecistectomía laparoscópica">');
    expect(xml).toMatch(/<participantRole classCode="SDLOC">\s*<code code="1096-7"/);
    expect(xml).toContain('<substanceAdministration classCode="SBADM" moodCode="EVN" negationInd="false">');
    expect(xml).toContain('<doseQuantity value="6" unit="{pz}"/>');
    expect(xml).toContain("<lotNumberText>L-2291</lotNumberText>");
    expect(xml).toContain('<routeCode nullFlavor="OTH" codeSystem="2.16.840.1.113883.3.215.12.12"');
    expect(xml).toContain('<code code="8480-6" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC" displayName="Tensión arterial sistólica"/>');
    expect(xml).toContain('<value xsi:type="PQ" value="164" unit="cm"/>');
    expect(xml).toContain('<value xsi:type="PQ" value="62.5" unit="kg"/>');
    expect(xml).toContain('<value xsi:type="CS" code="O+"/>');
    expect(xml).toContain('<id root="2.16.840.1.113883.3.215.1.2" extension="POL-778812"');
    expect(xml).toContain('<id root="2.16.840.1.113883.4.630" extension="GSE930415KL7"');
    // Heredofamiliares: los tres padecimientos obligatorios sin información estructurada.
    expect(xml.match(/<observation classCode="OBS" moodCode="EVN" nullFlavor="NI">/g)?.length).toBe(3);
    expect(xml).toContain('<value xsi:type="CD" code="I10X" codeSystem="2.16.840.1.113883.6.3" codeSystemName="CIE-10" displayName="Hipertensión"/>');
  });

  it("escapa el texto del paciente en la narrativa y nunca deja secciones vacías", () => {
    const { xml } = armar({ paciente: { ...fixture().paciente, alergias: 'Penicilina <urticaria> & "AINEs"' } });
    expect(xml).toContain("Penicilina &lt;urticaria&gt; &amp; \"AINEs\"");
    expect(xml).not.toContain("<urticaria>");
    const vacio = armar({ paciente: { ...fixture().paciente, alergias: null }, medicamentos: [], signos: [], diagnosticos: [], procedimientos: [], notas: [], documentos: [] });
    expect(vacio.xml).toContain("Sin alergias registradas");
    expect(vacio.xml).toContain("Sin medicamentos administrados registrados");
    expect(vacio.xml).toContain("Sin signos vitales registrados");
    expect(vacio.xml).toContain("Sin pronóstico registrado");
    expect(vacio.xml).not.toContain("<text/>");
  });

  it("es determinista con el mismo instante e id", () => {
    expect(armar().xml).toBe(armar().xml);
    expect(armar().meta.hash).toBe(armar().meta.hash);
  });
});

// ── cargarDatos con un Prisma de mentira ────────────────────────────────────

function dbFalsa(episodio: Record<string, unknown>, catalogo: Array<{ tipo: string; clave: string; codigo: string; nombre: string }> = []) {
  return {
    hospEpisodio: { findUnique: async () => episodio },
    hospConfig: { findUnique: async () => ({ nombreHospital: "Haltus Hope", clues: "PLSMP001234", licenciaSanitaria: null, oidRaiz: null, responsableSanitario: null, responsableSanitarioCedula: null }) },
    company: { findUnique: async () => ({ razonSocial: "HOSPITAL HALTUS HOPE SA DE CV", nombreComercial: "Haltus Hope", rfc: "HHH010101AAA", telefono: null, email: null, domicilioFiscal: null, codigoPostal: "72000" }) },
    hospDocumento: { findMany: async () => [] },
    hospCatalogo: {
      findFirst: async ({ where }: { where: { tipo: string; OR: Array<Record<string, string>> } }) => {
        const buscados = where.OR.flatMap((o) => Object.values(o));
        const f = catalogo.find((c) => c.tipo === where.tipo && (buscados.includes(c.codigo) || buscados.includes(c.clave)));
        return f ? { ...f, nivel: 4, capitulo: null, capituloNombre: null, subtipo: null, sexo: null, edadMin: null, edadMax: null, activo: true } : null;
      },
    },
  } as unknown as PrismaClient;
}

function episodioFalso(extra: Record<string, unknown> = {}) {
  const f = fixture();
  return {
    id: "epi_0418",
    companyId: "cmp_haltus",
    folio: "HOSP-2026-0418",
    tipo: "HOSPITALIZACION",
    estado: "POSTOPERATORIO",
    fechaIngreso: f.episodio.fechaIngreso,
    fechaAlta: null,
    motivoEgreso: null,
    motivo: f.episodio.motivo,
    diagnostico: f.episodio.diagnostico,
    procedimiento: f.episodio.procedimiento,
    autorizacionPagador: null,
    asa: null,
    aldreteEgreso: null,
    triageNivel: null,
    diagnosticoIngresoCie10: "K80.2",
    diagnosticoEgresoCie10: null,
    procedimientoCie9: "51.23",
    pacienteId: "pac_ortega",
    paciente: { ...f.paciente, estadoConyugal: null, curpValidada: true },
    medico: { nombre: "Dr. Alonso Vega", nombres: null, apellidoPaterno: null, apellidoMaterno: null, cedula: "5583201", especialidad: null },
    pagador: null,
    recurso: { nombre: "204", area: "HOSPITALIZACION" },
    notas: [
      { ...f.notas[0], medico: null, reemplazadaPor: null, secciones: { ...f.notas[0].secciones, diagnosticos: "Colelitiasis K80.2; HAS I10.X" } },
      { id: "n_vieja", tipo: "EVOLUCION", fecha: new Date("2026-09-04T10:00:00Z"), autorNombre: "Dr. Vega", autorCedula: "5583201", texto: "versión superada", secciones: null, medico: null, reemplazadaPor: { id: "n2" } },
      { ...f.notas[1], medico: null, reemplazadaPor: null },
    ],
    signos: [{ ...f.signos[0], temperatura: { toString: () => "36.60" }, peso: "62.50", talla: "1.64" }],
    cargos: [
      {
        id: "car_1",
        fecha: f.medicamentos[0].fecha,
        descripcion: "Cefalotina 1 g sol. iny. · lote L-2291 · 6 pz",
        cantidad: "6",
        movimientoInsumo: { insumo: { nombre: "Cefalotina 1 g sol. iny.", categoria: "MEDICAMENTO", presentacion: "Frasco ámpula 1 g", sustanciaActiva: "Cefalotina", unidad: "pz" }, lote: { lote: "L-2291" } },
        medico: null,
        nota: { secciones: { dosis: "1 g c/8 h", via: "IV" } },
      },
    ],
    egresoSaeh: null,
    ...extra,
  };
}

describe("cargarDatos", () => {
  const catalogo = [
    { tipo: "CIE10", clave: "K802", codigo: "K80.2", nombre: "Cálculo de la vesícula biliar sin colecistitis" },
    { tipo: "CIE10", clave: "I10X", codigo: "I10.X", nombre: "Hipertensión esencial (primaria)" },
    { tipo: "CIE9MC", clave: "5123", codigo: "51.23", nombre: "Colecistectomía laparoscópica" },
  ];

  it("aplana el expediente: CIE del episodio y de las notas, medicamentos con dosis/vía, notas vigentes, signos numéricos", async () => {
    const d = await cargarDatos(dbFalsa(episodioFalso(), catalogo), { companyId: "cmp_haltus", episodioId: "epi_0418", tipo: "EPISODIO" });
    expect(d.diagnosticos.map((x) => [x.tipo, x.clave, x.nombre])).toEqual([
      ["Ingreso", "K802", "Cálculo de la vesícula biliar sin colecistitis"],
      ["Historia clínica", "I10X", "Hipertensión esencial (primaria)"],
    ]);
    expect(d.procedimientos[0]).toMatchObject({ clave: "5123", nombre: "Colecistectomía laparoscópica", medicoCedula: "5583201", quirofano: true });
    expect(d.medicamentos[0]).toMatchObject({ nombre: "Cefalotina 1 g sol. iny.", cantidad: 6, unidad: "pz", lote: "L-2291", dosis: "1 g c/8 h", via: "IV" });
    expect(d.notas.map((n) => n.id)).toEqual(["n1", "n2"]);
    expect(d.signos[0]).toMatchObject({ temperatura: 36.6, peso: 62.5, talla: 1.64 });
    expect(d.hospital).toMatchObject({ nombre: "Haltus Hope", clues: "PLSMP001234", oidRaiz: null });
    const { xml } = armarCda(d, { ahora: AHORA, idDocumento: UUID_DOC });
    expect(xml).toContain('code="I10X"');
  });

  it("EGRESO exige alta (409), REFERENCIA exige destinatario (400), otra empresa es 404", async () => {
    await expect(cargarDatos(dbFalsa(episodioFalso()), { companyId: "cmp_haltus", episodioId: "epi_0418", tipo: "EGRESO" })).rejects.toMatchObject({ status: 409 });
    await expect(cargarDatos(dbFalsa(episodioFalso()), { companyId: "cmp_haltus", episodioId: "epi_0418", tipo: "REFERENCIA" })).rejects.toMatchObject({ status: 400 });
    await expect(cargarDatos(dbFalsa(episodioFalso()), { companyId: "otra", episodioId: "epi_0418", tipo: "EPISODIO" })).rejects.toMatchObject({ status: 404 });
    await expect(cargarDatos(dbFalsa(episodioFalso({ estado: "CANCELADO" })), { companyId: "cmp_haltus", episodioId: "epi_0418", tipo: "EPISODIO" })).rejects.toMatchObject({ status: 409 });
    const alta = await cargarDatos(dbFalsa(episodioFalso({ estado: "ALTA", fechaAlta: new Date("2026-09-05T16:00:00Z"), motivoEgreso: "MEJORIA", diagnosticoEgresoCie10: "K80.2" }), catalogo), {
      companyId: "cmp_haltus",
      episodioId: "epi_0418",
      tipo: "EGRESO",
    });
    expect(alta.diagnosticos.map((x) => x.tipo)).toEqual(["Ingreso", "Egreso", "Historia clínica"]);
  });
});

// ── Validación contra el XSD de HL7 con xmllint (si está instalado) ─────────

const XSD = path.join(process.cwd(), "src", "lib", "hospital", "cda", "xsd", "CDA.xsd");
const hayXmllint = spawnSync("xmllint", ["--version"], { encoding: "utf8" }).status === 0;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cda-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function validar(nombre: string, xml: string): string {
  const archivo = path.join(dir, `${nombre}.xml`);
  fs.writeFileSync(archivo, xml, "utf8");
  const r = spawnSync("xmllint", ["--noout", "--schema", XSD, archivo], { encoding: "utf8" });
  return r.status === 0 ? "" : `${r.stdout}\n${r.stderr}`;
}

describe.skipIf(!hayXmllint)("validación XSD (xmllint)", () => {
  if (!hayXmllint) console.warn("xmllint no está en el PATH: se omite la validación contra CDA.xsd");

  it("EPISODIO valida contra CDA.xsd", () => {
    expect(validar("episodio", armar().xml)).toBe("");
  });

  it("EGRESO con OID registrado valida", () => {
    expect(validar("egreso", armar({ tipo: "EGRESO", hospital: { ...fixture().hospital, oidRaiz: OID_HOSPITAL } }).xml)).toBe("");
  });

  it("REFERENCIA valida", () => {
    const ref = armar({
      tipo: "REFERENCIA",
      destinatario: { nombre: "Dra. Elena Prieto Sosa", cedula: "7001122", clues: "PLSSA000123", organizacion: "Hospital General de Puebla" },
      motivoReferencia: "Valoración por gastroenterología",
    });
    expect(validar("referencia", ref.xml)).toBe("");
  });

  it("un expediente casi vacío (sin médico, sin CLUES, sin notas) sigue validando", () => {
    const vacio = armar({
      hospital: { ...fixture().hospital, clues: null, licenciaSanitaria: null, telefono: null, email: null, domicilio: null, codigoPostal: null },
      medico: null,
      pagador: null,
      usuario: null,
      paciente: { ...fixture().paciente, curp: null, sinCurp: true, sexo: null, fechaNacimiento: null, contactoEmergenciaNombre: null, tipoSangre: null, alergias: null, domicilio: null, calle: null, numeroExterior: null, numeroInterior: null, colonia: null, municipio: null, estado: null, codigoPostal: null, entidadResidenciaClave: null, municipioResidenciaClave: null, localidadResidenciaClave: null, paisResidenciaClave: null, telefono: null, entidadNacimientoClave: null, nacionalidad: null, expedienteNumero: null },
      episodio: { ...fixture().episodio, estado: "HOSPITALIZADO", fechaAlta: null, motivoEgreso: null, recursoNombre: null, aldreteEgreso: null },
      medicamentos: [],
      signos: [],
      diagnosticos: [],
      procedimientos: [],
      notas: [],
      documentos: [],
    });
    expect(validar("vacio", vacio.xml)).toBe("");
  });
});
