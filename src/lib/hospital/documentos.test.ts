import { describe, expect, it } from "vitest";
import { ETIQUETA_CONTENIDO, PLANTILLAS_DOCUMENTO, TIPOS_DOCUMENTO, errorContenido, errorFirma } from "./documentos";

const consentimiento = {
  procedimiento: "Colecistectomía laparoscópica",
  riesgos: "Sangrado, lesión de vía biliar, conversión a cirugía abierta",
  beneficios: "Resolución del cuadro de litiasis vesicular",
  alternativas: "Tratamiento médico expectante",
};

describe("plantillas de documento (NOM-004 §10)", () => {
  it("cubre todos los tipos y etiqueta cada sección", () => {
    for (const tipo of TIPOS_DOCUMENTO) {
      const p = PLANTILLAS_DOCUMENTO[tipo];
      expect(p, tipo).toBeDefined();
      for (const s of [...p.obligatorias, ...p.opcionales]) expect(ETIQUETA_CONTENIDO[s], `${tipo}.${s}`).toBeTruthy();
    }
    expect(PLANTILLAS_DOCUMENTO.CONSENTIMIENTO_CIRUGIA.obligatorias).toEqual(["procedimiento", "riesgos", "beneficios", "alternativas"]);
    expect(PLANTILLAS_DOCUMENTO.CONSENTIMIENTO_ANESTESIA.firma).toEqual({ firmante: true, testigos: true, medico: true });
    expect(PLANTILLAS_DOCUMENTO.IDENTIFICACION.firma.firmante).toBe(false);
  });
});

describe("errorContenido", () => {
  it("un documento PENDIENTE puede nacer sin contenido; al firmar lo exige", () => {
    expect(errorContenido("CONSENTIMIENTO_CIRUGIA", null, false)).toBeNull();
    expect(errorContenido("CONSENTIMIENTO_CIRUGIA", null, true)).toMatch(/requiere el contenido/);
    expect(errorContenido("CONSENTIMIENTO_CIRUGIA", { procedimiento: "x" }, false)).toBeNull();
    expect(errorContenido("CONSENTIMIENTO_CIRUGIA", { procedimiento: "x" }, true)).toMatch(/le falta: Riesgos y complicaciones posibles, Beneficios esperados, Alternativas/);
    expect(errorContenido("CONSENTIMIENTO_CIRUGIA", consentimiento, true)).toBeNull();
  });

  it("los documentos sin contenido mínimo aceptan cualquier JSON razonable", () => {
    expect(errorContenido("IDENTIFICACION", null, true)).toBeNull();
    expect(errorContenido("OTRO", { nota: "recibido en admisión" }, true)).toBeNull();
    expect(errorContenido("OTRO", "texto", true)).toMatch(/objeto/);
    expect(errorContenido("OTRO", { "mal nombre": 1 }, true)).toMatch(/inválido/);
  });
});

describe("errorFirma", () => {
  it("un consentimiento se firma con paciente, dos testigos y médico con cédula", () => {
    const completo = {
      tipo: "CONSENTIMIENTO_CIRUGIA" as const,
      contenido: consentimiento,
      firmadoPor: "María Fernanda Ortega Ruiz",
      firmadoParentesco: "Paciente",
      testigo1: "Rodrigo Salazar Mendoza",
      testigo2: "Enf. Laura Méndez",
      medicoNombre: "Dr. Alonso Vega",
      medicoCedula: "5583201",
    };
    expect(errorFirma(completo)).toBeNull();
    expect(errorFirma({ ...completo, testigo2: "" })).toMatch(/dos testigos/);
    expect(errorFirma({ ...completo, medicoCedula: null })).toMatch(/cédula/);
    expect(errorFirma({ ...completo, firmadoPor: null })).toMatch(/firmadoPor/);
    expect(errorFirma({ ...completo, contenido: { procedimiento: "x" } })).toMatch(/le falta/);
  });

  it("registro anestésico: sólo el médico; identificación: nada", () => {
    expect(errorFirma({ tipo: "REGISTRO_ANESTESICO", contenido: { tecnica: "General balanceada", farmacos: "Propofol 200 mg 08:40", inicio: "08:35", fin: "11:05", incidentes: "Ninguno" } })).toMatch(/médico/);
    expect(
      errorFirma({ tipo: "REGISTRO_ANESTESICO", contenido: { tecnica: "General balanceada", farmacos: "Propofol", inicio: "08:35", fin: "11:05", incidentes: "Ninguno" }, medicoNombre: "Dra. Rentería", medicoCedula: "6120944" })
    ).toBeNull();
    expect(errorFirma({ tipo: "IDENTIFICACION" })).toBeNull();
  });
});
