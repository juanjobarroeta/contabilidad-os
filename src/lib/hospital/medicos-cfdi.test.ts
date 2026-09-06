import { describe, expect, it } from "vitest";
import { clasificarConcepto, clasificarProveedorMedico } from "./medicos-cfdi";

const c = (claveProdServ: string, descripcion: string, importe = 1000, cuentaPredial?: string) => ({ claveProdServ, descripcion, importe, cuentaPredial });

describe("clasificarConcepto", () => {
  it("reconoce honorarios y servicios médicos por clave o descripción", () => {
    expect(clasificarConcepto(c("85121600", "HONORARIOS MEDICOS")).medico).toBe(true);
    expect(clasificarConcepto(c("85121600", "INTERPRETACION ESTUDIOS IMAGEN")).medico).toBe(true);
    expect(clasificarConcepto(c("85101502", "SERVICIO DE ENDOSCOPIA PX MARÍA LUISA")).medico).toBe(true);
    expect(clasificarConcepto(c("84111506", "HONORARIOS CIRUGÍA")).medico).toBe(true);
    expect(clasificarConcepto(c("85161504", "ASISTENCIA VMI PX: JOSÉ JUAN")).medico).toBe(true);
  });

  it("excluye renta, intereses, insumos, ambulancia y mantenimiento con motivo", () => {
    expect(clasificarConcepto(c("80131500", "PAGO RENTA DEL MES DE ABRIL 2026 DEL INMUEBLE"))).toEqual({ medico: false, motivo: "renta" });
    expect(clasificarConcepto(c("80131502", "RENTA DE AGOSTO 2026 DEL TERRENO", 1, "12345"))).toEqual({ medico: false, motivo: "renta" });
    expect(clasificarConcepto(c("84101700", "PAGO DE INTERESES DEL PERIODO DE MARZO 2026"))).toEqual({ medico: false, motivo: "intereses" });
    expect(clasificarConcepto(c("42142402", "JERINGA 5 ML")).motivo).toBe("insumos");
    expect(clasificarConcepto(c("92101902", "SERVICIO DE AMBULANCIA")).motivo).toBe("ambulancia");
    expect(clasificarConcepto(c("72101511", "SERVICIO DE MANTENIMIENTO PREVENTIVO A 13 EQUIPOS")).motivo).toBe("mantenimiento");
    expect(clasificarConcepto(c("85151500", "ANÁLISIS MICROBIOLÓGICO DE AGUA, AMBIENTES")).motivo).toBe("laboratorio ambiental");
    expect(clasificarConcepto(c("85161504", "RENTA DE CISTOSCOPIO OLYMPUS 22 FR")).motivo).toBe("renta de equipo");
    expect(clasificarConcepto(c("53102700", "UNIFORME QUIRURGICO M05 CON LOGO BORDADO")).motivo).toBe("uniformes");
    expect(clasificarConcepto(c("42311901", "DRENAJE POSQUIRURGICO BIOVAC 10 MM")).motivo).toBe("insumos");
    expect(clasificarConcepto(c("41115800", "BATAS CLINICAS PARA MEDICOS")).motivo).toBe("uniformes");
  });

  it("deja neutros los conceptos genéricos", () => {
    expect(clasificarConcepto(c("84111506", "PAGO"))).toEqual({ medico: false, motivo: null });
    expect(clasificarConcepto(c("84111506", "ANTICIPO DEL BIEN O SERVICIO"))).toEqual({ medico: false, motivo: null });
  });
});

describe("clasificarProveedorMedico", () => {
  it("el arrendador con retención de ISR no es médico", () => {
    const r = clasificarProveedorMedico([c("80131500", "PAGO RENTA DEL MES DE ABRIL 2026", 45000), c("84111506", "PAGO", 45000)]);
    expect(r.clasificacion).toBe("NO_MEDICO");
    expect(r.motivos).toEqual(["renta"]);
  });

  it("la que interpreta estudios sí es médica aunque un renglón diga PAGO", () => {
    const r = clasificarProveedorMedico([c("85121600", "HONORARIOS MEDICOS- INTERPRETACIONES", 8000), c("84111506", "PAGO", 8000)]);
    expect(r.clasificacion).toBe("MEDICO");
    expect(r.proporcionMedica).toBe(1);
  });

  it("honorarios de cirugía mezclados con intereses quedan MIXTO para revisión", () => {
    const r = clasificarProveedorMedico([c("85121600", "HONORARIOS CIRUGÍA", 12000), c("84101700", "PAGO DE INTERESES DEL PERIODO DE MARZO 2026", 30000)]);
    expect(r.clasificacion).toBe("MIXTO");
    expect(r.motivos).toEqual(["intereses"]);
  });

  it("el proveedor de insumos con muchas claves 42 no es médico", () => {
    const r = clasificarProveedorMedico([c("42142402", "JERINGA", 500), c("42241505", "VENDA", 300), c("11151512", "ALGODÓN", 200)]);
    expect(r.clasificacion).toBe("NO_MEDICO");
    expect(r.motivos).toEqual(["insumos"]);
  });

  it("sin conceptos no es médico", () => {
    expect(clasificarProveedorMedico([]).clasificacion).toBe("NO_MEDICO");
  });
});
