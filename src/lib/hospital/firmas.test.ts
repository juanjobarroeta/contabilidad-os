import { describe, expect, it } from "vitest";
import type { HospFirma } from "@prisma/client";
import { MAX_IMAGEN_FIRMA_BYTES, documentoConFirmas, firmasFaltantes, grupoDeRol, hashFirma, validarImagenFirma, verificarHashFirma, type DocumentoConFirmasFila } from "./firmas";
import { hashContenidoDocumento } from "./plantillas-legales";

/** PNG de 1×1 px (válido) como data URL. */
export const PNG_1PX = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("validarImagenFirma", () => {
  it("acepta un PNG chico como data URL y rechaza lo demás", () => {
    expect(validarImagenFirma(PNG_1PX)).toEqual({ ok: true, bytes: 70 });
    expect(validarImagenFirma("")).toMatchObject({ ok: false });
    expect(validarImagenFirma(null)).toMatchObject({ ok: false, error: expect.stringMatching(/requerida/) });
    expect(validarImagenFirma("data:image/jpeg;base64,/9j/4AAQ")).toMatchObject({ ok: false, error: expect.stringMatching(/PNG/) });
    // Base64 válido pero no es PNG (cabecera distinta).
    expect(validarImagenFirma(`data:image/png;base64,${Buffer.from("no soy png ni de lejos").toString("base64")}`)).toMatchObject({ ok: false, error: expect.stringMatching(/PNG válido/) });
    // Demasiado grande: 300 KB + 1 con cabecera PNG.
    const grande = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(MAX_IMAGEN_FIRMA_BYTES)]);
    expect(validarImagenFirma(`data:image/png;base64,${grande.toString("base64")}`)).toMatchObject({ ok: false, error: expect.stringMatching(/300 KB/) });
  });
});

describe("requisitos de firma", () => {
  const requeridas = ["PACIENTE|REPRESENTANTE", "TESTIGO1", "TESTIGO2", "MEDICO"];

  it("un rol satisface su grupo; las alternativas cuentan como uno", () => {
    expect(grupoDeRol(requeridas, "REPRESENTANTE")).toBe("PACIENTE|REPRESENTANTE");
    expect(grupoDeRol(requeridas, "HOSPITAL")).toBeNull();
    expect(firmasFaltantes(requeridas, [])).toEqual(requeridas);
    expect(firmasFaltantes(requeridas, [{ rol: "REPRESENTANTE" }, { rol: "TESTIGO1" }])).toEqual(["TESTIGO2", "MEDICO"]);
    expect(firmasFaltantes(requeridas, [{ rol: "PACIENTE" }, { rol: "TESTIGO1" }, { rol: "TESTIGO2" }, { rol: "MEDICO" }])).toEqual([]);
    expect(firmasFaltantes([], [])).toEqual([]);
  });
});

describe("cadena de evidencia", () => {
  const at = new Date("2026-09-04T14:05:00.000Z");
  const hashContenido = hashContenidoDocumento("CONTRATO …", null);
  const firmaBase: HospFirma = {
    id: "f1",
    companyId: "c1",
    documentoId: "d1",
    rol: "PACIENTE",
    nombre: "María Fernanda Ortega Ruiz",
    identificacion: "OERF920314MPLRZR09",
    parentesco: null,
    metodo: "AUTOGRAFA_DIGITAL",
    imagen: PNG_1PX,
    hashDocumento: hashContenido,
    hashFirma: hashFirma({ imagen: PNG_1PX, hashDocumento: hashContenido, rol: "PACIENTE", nombre: "María Fernanda Ortega Ruiz", at }),
    otpVerificado: false,
    otpDestino: null,
    ip: "187.190.12.34",
    userAgent: "Haltus Admisión/1.0",
    geolocalizacion: null,
    userId: "u1",
    userEmail: "revisor@haltus.test",
    at,
  };

  it("hashFirma depende de imagen, hash del documento, rol, nombre y hora", () => {
    const base = { imagen: PNG_1PX, hashDocumento: hashContenido, rol: "PACIENTE", nombre: "María", at };
    const h = hashFirma(base);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashFirma({ ...base, rol: "REPRESENTANTE" })).not.toBe(h);
    expect(hashFirma({ ...base, nombre: "Maria" })).not.toBe(h);
    expect(hashFirma({ ...base, at: new Date(at.getTime() + 1000) })).not.toBe(h);
    expect(hashFirma({ ...base, hashDocumento: hashContenidoDocumento("otro texto", null) })).not.toBe(h);
  });

  it("verificarHashFirma detecta una firma o un documento alterados", () => {
    expect(verificarHashFirma(firmaBase, hashContenido)).toBe(true);
    expect(verificarHashFirma({ ...firmaBase, nombre: "Otra persona" }, hashContenido)).toBe(false);
    expect(verificarHashFirma(firmaBase, hashContenidoDocumento("CONTRATO modificado", null))).toBe(false);
    expect(verificarHashFirma({ ...firmaBase, imagen: null }, hashContenido)).toBeNull();
  });

  it("documentoConFirmas arma la evidencia sin imagen ni bytes, y FIRMADO sólo con todas las requeridas", () => {
    const doc: DocumentoConFirmasFila = {
      id: "d1",
      companyId: "c1",
      pacienteId: "p1",
      episodioId: "e1",
      createdAt: at,
      tipo: "CONTRATO_SERVICIOS",
      nombre: "Contrato",
      estado: "PENDIENTE",
      requerido: true,
      firmadoAt: null,
      mime: null,
      bytes: null,
      subidoPorUserId: null,
      contenido: null,
      firmadoPor: null,
      firmadoParentesco: null,
      testigo1: null,
      testigo2: null,
      medicoNombre: null,
      medicoCedula: null,
      plantillaVersion: "2026-09",
      textoFirmado: "CONTRATO …",
      hashContenido,
      firmasRequeridas: ["PACIENTE|REPRESENTANTE", "HOSPITAL"],
      firmas: [firmaBase],
    };
    const s = documentoConFirmas(doc);
    expect(s).not.toHaveProperty("archivo");
    expect(s.firmas[0]).not.toHaveProperty("imagen");
    expect(s.firmas[0]).toMatchObject({ rol: "PACIENTE", tieneImagen: true, hashVerificado: true });
    expect(s.firmasRequeridas).toEqual(["PACIENTE|REPRESENTANTE", "HOSPITAL"]);
    expect(s.firmasFaltantes).toEqual(["HOSPITAL"]);
    expect(s.evidencia).toMatchObject({ hashContenido, plantillaVersion: "2026-09", completo: false });
    expect(s.evidencia.firmas).toEqual([{ rol: "PACIENTE", nombre: "María Fernanda Ortega Ruiz", at, ip: "187.190.12.34", hashFirma: firmaBase.hashFirma }]);
    expect(documentoConFirmas(doc, { conImagen: true }).firmas[0]).toMatchObject({ imagen: PNG_1PX });
    expect(documentoConFirmas(doc, { conTexto: false })).not.toHaveProperty("textoFirmado");
    // Con la firma del hospital, la evidencia queda completa.
    const hospital: HospFirma = { ...firmaBase, id: "f2", rol: "HOSPITAL", nombre: "Lic. Adriana Mora", hashFirma: hashFirma({ imagen: PNG_1PX, hashDocumento: hashContenido, rol: "HOSPITAL", nombre: "Lic. Adriana Mora", at }) };
    const completo = documentoConFirmas({ ...doc, firmas: [firmaBase, hospital] });
    expect(completo.firmasFaltantes).toEqual([]);
    expect(completo.evidencia.completo).toBe(true);
    // Sin firmasRequeridas guardadas se usa la tabla por tipo.
    expect(documentoConFirmas({ ...doc, firmasRequeridas: null, tipo: "COMPROMISO_PAGO", firmas: [] }).firmasFaltantes).toEqual(["RESPONSABLE_PAGO"]);
  });
});
