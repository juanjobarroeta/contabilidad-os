import { describe, expect, it } from "vitest";
import { esEspecialista, requeridos, resumenCredencial, vigentePorTipo, type DocumentoMedicoResumen } from "./medico-credencial";

const HOY = new Date(2026, 9, 13, 10);
const d = (n: number) => new Date(2026, 9, 13 + n);
let k = 0;
const doc = (tipo: string, estado = "VERIFICADO", vigenciaHasta: Date | null = null, createdAt = d(-30)): DocumentoMedicoResumen => ({ id: `d${++k}`, tipo, estado, vigenciaHasta, createdAt });
const general = { especialidad: "Medicina general" };
const cirujano = { especialidad: "Cirugía plástica" };
const completosGeneral = () => [doc("CEDULA_PROFESIONAL"), doc("INE", "VERIFICADO", d(900)), doc("CONSTANCIA_FISCAL"), doc("SEGURO_RC", "VERIFICADO", d(200)), doc("CURRICULUM")];

describe("requisitos", () => {
  it("el especialista pide cédula de especialidad y consejo", () => {
    expect(esEspecialista("Medicina general")).toBe(false);
    expect(esEspecialista("Anestesiología")).toBe(true);
    expect(requeridos(general)).toHaveLength(5);
    expect(requeridos(cirujano)).toEqual(expect.arrayContaining(["CEDULA_ESPECIALIDAD", "CERTIFICACION_CONSEJO"]));
  });
});

describe("resumenCredencial", () => {
  it("completo: todo verificado y vigente", () => {
    const r = resumenCredencial(general, completosGeneral(), HOY);
    expect(r).toMatchObject({ estado: "COMPLETO", requeridos: 5, cumplidos: 5, faltan: [], vencidos: [] });
    expect(r.proximoVencimiento).toEqual(d(200));
  });

  it("incompleto: falta, por verificar y rechazado", () => {
    const r = resumenCredencial(cirujano, [doc("CEDULA_PROFESIONAL"), doc("INE", "RECIBIDO", d(900)), doc("SEGURO_RC", "RECHAZADO", d(200))], HOY);
    expect(r.estado).toBe("INCOMPLETO");
    expect(r.porVerificar).toBe(1);
    expect(r.faltan).toEqual(expect.arrayContaining(["Cédula de especialidad", "Certificación del consejo", "Seguro de responsabilidad civil", "Constancia de situación fiscal", "Currículum"]));
  });

  it("vence en 30 días = por vencer; vencido manda aunque lo demás esté", () => {
    const porVencer = [...completosGeneral().filter((x) => x.tipo !== "SEGURO_RC"), doc("SEGURO_RC", "VERIFICADO", d(10))];
    expect(resumenCredencial(general, porVencer, HOY)).toMatchObject({ estado: "POR_VENCER", porVencer: ["Seguro de responsabilidad civil"] });
    const vencido = [...completosGeneral().filter((x) => x.tipo !== "SEGURO_RC"), doc("SEGURO_RC", "VERIFICADO", d(-1))];
    expect(resumenCredencial(general, vencido, HOY)).toMatchObject({ estado: "VENCIDO", vencidos: ["Seguro de responsabilidad civil"] });
  });

  it("la renovación verificada reemplaza a la vencida", () => {
    const docs = [...completosGeneral().filter((x) => x.tipo !== "SEGURO_RC"), doc("SEGURO_RC", "VERIFICADO", d(-1), d(-400)), doc("SEGURO_RC", "VERIFICADO", d(365), d(-2))];
    expect(resumenCredencial(general, docs, HOY).estado).toBe("COMPLETO");
    // Una renovación recibida pero sin verificar no gana a la verificada.
    const m = vigentePorTipo([doc("SEGURO_RC", "VERIFICADO", d(100)), doc("SEGURO_RC", "RECIBIDO", d(465))]);
    expect(m.get("SEGURO_RC")!.estado).toBe("VERIFICADO");
  });
});
