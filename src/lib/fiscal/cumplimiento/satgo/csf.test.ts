import { describe, it, expect } from "vitest";
import { estatusPadronDeTexto, codigoPostalDeTexto, rfcDeTexto, perfilDesdeCsfData } from "./csf";

const TEXTO = `
CONSTANCIA DE SITUACIÓN FISCAL
RFC: CBA170606FQ8
Denominación/Razón Social: CONSTRUCTORA BARTIZ-VERT
Estatus en el padrón: ACTIVO
Código Postal: 72810
Régimen General de Ley Personas Morales   Fecha Inicio: 06/06/2017
`;

describe("csf desde PDF", () => {
  it("lee estatus, CP y RFC del texto", () => {
    expect(estatusPadronDeTexto(TEXTO)).toBe("ACTIVO");
    expect(codigoPostalDeTexto(TEXTO)).toBe("72810");
    expect(rfcDeTexto(TEXTO)).toBe("CBA170606FQ8");
    expect(estatusPadronDeTexto("Estatus en el padrón: SUSPENDIDO")).toBe("SUSPENDIDO");
    expect(estatusPadronDeTexto("sin renglón")).toBe("DESCONOCIDO");
  });

  it("perfil: claves de régimen ordenadas, obligaciones deduplicadas, CP del texto si Claude no lo trae", () => {
    const perfil = perfilDesdeCsfData(
      {
        rfc: null, tipoContribuyente: "PM", razonSocial: null, nombre: null, primerApellido: null, segundoApellido: null,
        curp: null, regimenFiscal: null,
        regimenes: [{ code: "626", label: "RESICO", since: null }, { code: "601", label: "General", since: null }, { code: "General", label: "x", since: null }],
        fechaInicioRegimen: null, codigoPostal: null, calle: null, numExterior: null, numInterior: null, colonia: null,
        municipio: null, estado: null, correo: null, telefono: null, actividadEconomica: null,
        obligaciones: ["Pago  definitivo mensual de IVA.", "Pago definitivo mensual de IVA.", "Declaración anual de ISR"],
      },
      TEXTO,
      "CBA170606FQ8",
    );
    expect(perfil.regimenes).toEqual(["601", "626"]);
    expect(perfil.obligaciones).toEqual(["Declaración anual de ISR", "Pago definitivo mensual de IVA."]);
    expect(perfil.codigoPostal).toBe("72810");
    expect(perfil.rfc).toBe("CBA170606FQ8");
    expect(perfil.estatusPadron).toBe("ACTIVO");
  });
});
