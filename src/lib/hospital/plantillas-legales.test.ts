import { describe, expect, it } from "vitest";
import { contenidoDefaultConsentimientoIngreso, documentosAdmisionRequeridos } from "./admision";
import { PLANTILLAS_DOCUMENTO, TIPOS_ADMISION, TIPOS_DOCUMENTO, errorContenido } from "./documentos";
import {
  FIRMAS_REQUERIDAS,
  PLANTILLAS_LEGALES_DEFAULT,
  TIPOS_CON_PLANTILLA,
  VERSION_PLANTILLAS_DEFAULT,
  canonicalJson,
  firmasRequeridasPara,
  hashContenidoDocumento,
  parsearFirmasRequeridas,
  plantillaVigente,
  renderizarPlantilla,
  validarPlantillasConfig,
  versionesVigentes,
  type ContextoPlantilla,
} from "./plantillas-legales";

const ctx: ContextoPlantilla = {
  paciente: { nombreCompleto: "María Fernanda Ortega Ruiz", curp: "OERF920314MPLRZR09", rfc: null, domicilio: "Av. Juárez 2915 int. 4B, La Paz, Puebla, Puebla, C.P. 72160", expedienteNumero: "EXP-2026-0001", fechaNacimiento: "1992-03-14", telefono: null, email: null },
  hospital: { razonSocial: "HOSPITAL HALTUS HOPE SA DE CV", nombreComercial: "Haltus Hope", rfc: "HHH190215K73", clues: "PLSMP001234", licenciaSanitaria: "COFEPRIS 21-AM-21-114-0034", responsableSanitario: "Dra. Patricia Ledesma (céd. 5217736)", responsableSanitarioCedula: "5217736", domicilio: "C.P. 72000", contacto: "privacidad@haltus.test", avisoPrivacidadUrl: "https://haltus.test/aviso-de-privacidad" },
  episodio: { folio: "HOSP-2026-0418", fechaIngreso: "4 de septiembre de 2026", tipo: "HOSPITALIZACION", medico: "Dr. Alonso Vega", diagnostico: "K80.2 Cálculo de vesícula biliar", procedimiento: "Colecistectomía laparoscópica" },
  pagador: { nombre: "GNP Seguros", tipo: "ASEGURADORA" },
  fecha: "5 de septiembre de 2026",
  contenido: { procedimiento: "Ingreso hospitalario para colecistectomía laparoscópica", riesgos: "Infección, sangrado", beneficios: "Resolución del cuadro", alternativas: "Manejo conservador" },
};

describe("plantillas legales default", () => {
  it("existen para los seis tipos, con versión y marcadores conocidos", () => {
    expect(TIPOS_CON_PLANTILLA).toEqual(["CONTRATO_SERVICIOS", "COMPROMISO_PAGO", "CESION_DERECHOS", "CONSENTIMIENTO_DATOS", "AVISO_PRIVACIDAD", "CONSENTIMIENTO_HOSPITALIZACION"]);
    for (const t of TIPOS_CON_PLANTILLA) {
      expect(PLANTILLAS_LEGALES_DEFAULT[t].version).toBe(VERSION_PLANTILLAS_DEFAULT);
      const r = renderizarPlantilla(t, ctx, null)!;
      expect(r.advertencias.filter((a) => a.startsWith("Marcador desconocido")), t).toEqual([]);
      expect(r.texto).not.toMatch(/\{\{/);
      expect(r.texto).toContain("María Fernanda Ortega Ruiz");
      expect(r.texto).toContain(VERSION_PLANTILLAS_DEFAULT);
    }
    expect(renderizarPlantilla("IDENTIFICACION", ctx, null)).toBeNull();
  });

  it("todos los tipos del enum tienen plantilla de contenido y los de admisión están declarados", () => {
    for (const t of TIPOS_DOCUMENTO) expect(PLANTILLAS_DOCUMENTO[t], t).toBeDefined();
    expect(TIPOS_ADMISION).toContain("CONTRATO_SERVICIOS");
    expect(errorContenido("CONTRATO_SERVICIOS", null, true)).toBeNull();
    expect(errorContenido("CONSTANCIA_CURP", { curp: "X", estatus: "AN" }, true)).toBeNull();
  });

  it("firmas requeridas por tipo como las describe el contrato", () => {
    expect(FIRMAS_REQUERIDAS.CONTRATO_SERVICIOS).toEqual(["PACIENTE|REPRESENTANTE", "HOSPITAL"]);
    expect(FIRMAS_REQUERIDAS.COMPROMISO_PAGO).toEqual(["RESPONSABLE_PAGO"]);
    expect(FIRMAS_REQUERIDAS.CESION_DERECHOS).toEqual(["PACIENTE|REPRESENTANTE"]);
    expect(FIRMAS_REQUERIDAS.AVISO_PRIVACIDAD).toEqual(["PACIENTE|REPRESENTANTE"]);
    expect(FIRMAS_REQUERIDAS.CONSENTIMIENTO_DATOS).toEqual(["PACIENTE|REPRESENTANTE"]);
    for (const t of ["CONSENTIMIENTO_HOSPITALIZACION", "CONSENTIMIENTO_CIRUGIA", "CONSENTIMIENTO_ANESTESIA", "CONSENTIMIENTO_TRANSFUSION"] as const) {
      expect(FIRMAS_REQUERIDAS[t]).toEqual(["PACIENTE|REPRESENTANTE", "TESTIGO1", "TESTIGO2", "MEDICO"]);
    }
    expect(firmasRequeridasPara("IDENTIFICACION")).toEqual([]);
    expect(firmasRequeridasPara("POLIZA")).toEqual([]);
    expect(parsearFirmasRequeridas(["paciente|representante", "HOSPITAL", "NADIE", 3])).toEqual(["PACIENTE|REPRESENTANTE", "HOSPITAL"]);
    expect(parsearFirmasRequeridas("x")).toEqual([]);
  });
});

describe("renderizarPlantilla", () => {
  it("resuelve marcadores de todos los bloques y avisa de los datos ausentes", () => {
    const r = renderizarPlantilla("CONTRATO_SERVICIOS", { ...ctx, hospital: { ...ctx.hospital, clues: null }, pagador: null }, null)!;
    expect(r.texto).toContain("HOSPITAL HALTUS HOPE SA DE CV");
    expect(r.texto).toContain("OERF920314MPLRZR09");
    expect(r.texto).toContain("HOSP-2026-0418");
    expect(r.texto).toContain("5 de septiembre de 2026");
    expect(r.advertencias).toEqual(["Sin dato para {{hospital.clues}}", "Sin dato para {{pagador.nombre}}"]);
    expect(r.personalizada).toBe(false);
  });

  it("usa la plantilla del hospital cuando existe y lista marcadores desconocidos", () => {
    const config = { COMPROMISO_PAGO: { version: "haltus-2", texto: "Yo {{paciente.nombreCompleto}} pago {{monto.total}} a {{hospital.razonSocial}} ({{plantilla.version}}) {{paciente.inexistente}} {{contenido.deposito}}" } };
    const r = renderizarPlantilla("COMPROMISO_PAGO", { ...ctx, contenido: { deposito: 15000 } }, config)!;
    expect(r.personalizada).toBe(true);
    expect(r.version).toBe("haltus-2");
    expect(r.texto).toBe("Yo María Fernanda Ortega Ruiz pago  a HOSPITAL HALTUS HOPE SA DE CV (haltus-2)  15000");
    expect(r.advertencias).toEqual(["Marcador desconocido: {{monto.total}}", "Marcador desconocido: {{paciente.inexistente}}"]);
    // Sin dato en contenido libre es «sin dato», no «desconocido».
    const r2 = renderizarPlantilla("COMPROMISO_PAGO", { ...ctx, contenido: null }, config)!;
    expect(r2.advertencias).toContain("Sin dato para {{contenido.deposito}}");
    expect(plantillaVigente("COMPROMISO_PAGO", config)?.titulo).toBe("Compromiso de pago (responsable solidario)");
    expect(versionesVigentes(config).COMPROMISO_PAGO).toEqual({ version: "haltus-2", personalizada: true });
    expect(versionesVigentes(config).AVISO_PRIVACIDAD).toEqual({ version: VERSION_PLANTILLAS_DEFAULT, personalizada: false });
  });

  it("validarPlantillasConfig acepta la forma { tipo: { version, texto } } y rechaza lo demás", () => {
    expect(validarPlantillasConfig(null)).toEqual({ ok: true, valor: {} });
    expect(validarPlantillasConfig({ AVISO_PRIVACIDAD: { version: " v3 ", texto: "hola" }, CONTRATO_SERVICIOS: null })).toEqual({ ok: true, valor: { AVISO_PRIVACIDAD: { version: "v3", texto: "hola" } } });
    expect(validarPlantillasConfig({ POLIZA: { version: "1", texto: "x" } })).toMatchObject({ ok: false, error: expect.stringMatching(/POLIZA/) });
    expect(validarPlantillasConfig({ AVISO_PRIVACIDAD: { texto: "x" } })).toMatchObject({ ok: false, error: expect.stringMatching(/version/) });
    expect(validarPlantillasConfig({ AVISO_PRIVACIDAD: { version: "1", texto: "" } })).toMatchObject({ ok: false, error: expect.stringMatching(/texto/) });
    expect(validarPlantillasConfig([])).toMatchObject({ ok: false });
  });
});

describe("hash del documento", () => {
  it("es estable ante el orden de las llaves y cambia con el texto o el contenido", () => {
    expect(canonicalJson({ b: 1, a: [{ d: null, c: "x" }], e: undefined })).toBe('{"a":[{"c":"x","d":null}],"b":1}');
    const h1 = hashContenidoDocumento("texto", { a: 1, b: 2 });
    expect(h1).toBe(hashContenidoDocumento("texto", { b: 2, a: 1 }));
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(hashContenidoDocumento("texto", null)).toBe(hashContenidoDocumento("texto", undefined));
    expect(hashContenidoDocumento("texto2", { a: 1, b: 2 })).not.toBe(h1);
    expect(hashContenidoDocumento("texto", { a: 1 })).not.toBe(h1);
  });
});

describe("paquete de admisión", () => {
  it("elige los documentos según tipo de episodio y pagador", () => {
    expect(documentosAdmisionRequeridos({ tipoEpisodio: "HOSPITALIZACION", pagadorTipo: "ASEGURADORA" })).toEqual([
      "AVISO_PRIVACIDAD",
      "CONSENTIMIENTO_DATOS",
      "CONTRATO_SERVICIOS",
      "COMPROMISO_PAGO",
      "CESION_DERECHOS",
      "CONSENTIMIENTO_HOSPITALIZACION",
      "IDENTIFICACION",
    ]);
    expect(documentosAdmisionRequeridos({ tipoEpisodio: "AMBULATORIO", pagadorTipo: "EMPRESA" })).toEqual(["AVISO_PRIVACIDAD", "CONSENTIMIENTO_DATOS", "CONTRATO_SERVICIOS", "COMPROMISO_PAGO", "CONSENTIMIENTO_HOSPITALIZACION", "IDENTIFICACION"]);
    expect(documentosAdmisionRequeridos({ tipoEpisodio: "CONSULTA", pagadorTipo: "PARTICULAR" })).toEqual(["AVISO_PRIVACIDAD", "CONTRATO_SERVICIOS", "COMPROMISO_PAGO", "IDENTIFICACION"]);
    expect(documentosAdmisionRequeridos({ tipoEpisodio: "URGENCIAS", pagadorTipo: null })).toEqual(["AVISO_PRIVACIDAD", "CONTRATO_SERVICIOS", "COMPROMISO_PAGO", "IDENTIFICACION"]);
  });

  it("el consentimiento de ingreso default cumple el contenido mínimo NOM-004", () => {
    const c = contenidoDefaultConsentimientoIngreso({ establecimiento: "Haltus Hope", procedimiento: "Colecistectomía laparoscópica" });
    expect(errorContenido("CONSENTIMIENTO_HOSPITALIZACION", c, true)).toBeNull();
    expect(c.procedimiento).toBe("Ingreso hospitalario para Colecistectomía laparoscópica");
    expect(contenidoDefaultConsentimientoIngreso({ establecimiento: "H", diagnostico: "Neumonía" }).procedimiento).toMatch(/tratamiento de Neumonía/);
  });
});
