import { describe, it, expect } from "vitest";
import forge from "@vilic/node-forge";
import { parseFielVigencia } from "./sat-fiel";

// Certificado X.509 autofirmado con el atributo x500UniqueIdentifier (2.5.4.45)
// que el SAT usa para el RFC — mismo campo que @nodecfdi/credentials parsea.
// Se devuelve como DER base64, el formato en que la FIEL queda almacenada
// (tras descifrar) en Company.fielCer.
function makeCerBase64(notBefore: Date, notAfter: Date, rfc = "TEST010101AAA"): string {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = notBefore;
  cert.validity.notAfter = notAfter;
  const attrs = [
    { name: "commonName", value: "EMPRESA DE PRUEBA" },
    { type: "2.5.4.45", value: `${rfc} / ${rfc}` },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  return forge.util.encode64(der);
}

const DIA = 86_400_000;

describe("parseFielVigencia", () => {
  it("certificado vigente: valida=true con fechas y RFC", () => {
    const desde = new Date(Date.now() - 30 * DIA);
    const hasta = new Date(Date.now() + 365 * DIA);
    const v = parseFielVigencia(makeCerBase64(desde, hasta));

    expect(v.valida).toBe(true);
    expect(v.rfc).toBe("TEST010101AAA");
    // forge serializa con precisión de segundos (UTCTime) — tolerancia de 2s.
    expect(Math.abs(v.validoDesde!.getTime() - desde.getTime())).toBeLessThan(2000);
    expect(Math.abs(v.validoHasta!.getTime() - hasta.getTime())).toBeLessThan(2000);
  });

  it("certificado vencido: valida=false pero conserva las fechas", () => {
    const desde = new Date(Date.now() - 4 * 365 * DIA);
    const hasta = new Date(Date.now() - 10 * DIA);
    const v = parseFielVigencia(makeCerBase64(desde, hasta));

    expect(v.valida).toBe(false);
    expect(v.validoHasta).toBeInstanceOf(Date);
    expect(v.validoHasta!.getTime()).toBeLessThan(Date.now());
  });

  it("contenido ilegible: valida=false sin lanzar", () => {
    expect(parseFielVigencia("esto no es un certificado")).toEqual({ valida: false });
    expect(parseFielVigencia("")).toEqual({ valida: false });
  });
});
