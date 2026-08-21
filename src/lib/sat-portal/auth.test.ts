import { describe, it, expect, beforeAll } from "vitest";
import { generateKeyPairSync, createSign, createVerify, type KeyObject } from "node:crypto";
import {
  extraerReto,
  firmarReto,
  cuerpoDeLogin,
  extraerCookieSesion,
  SatPortalAuthError,
  type FirmanteFiel,
} from "./auth";

// Un firmante de PRUEBA con crypto de Node — nunca una FIEL real. Firma de
// verdad con una llave RSA generada en memoria, así que el manejo binario→base64
// del sobre se ejerce contra una firma auténtica, offline y sin dependencias.
// El certificado y la serie son fijos: su ENCODE es lo que probamos, no su RSA.
class FirmanteDePrueba implements FirmanteFiel {
  readonly priv: KeyObject;
  readonly pub: KeyObject;
  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    this.priv = privateKey;
    this.pub = publicKey;
  }
  sign(data: string, algorithm = "sha1"): string {
    const s = createSign(algorithm);
    s.update(data, "binary");
    // Firma en cadena binaria — el mismo formato que devuelve Credential.sign().
    return s.sign(this.priv, "binary");
  }
  rfc() { return "AAA010101AAA"; }
  certificate() {
    return {
      pemAsOneLine: () => "MIIDdummyCERToneLineBase64Content",
      serialNumber: () => ({ decimal: () => "30001000000400000123" }),
    };
  }
  verifica(data: string, firmaBinaria: string, algorithm = "sha1"): boolean {
    const v = createVerify(algorithm);
    v.update(data, "binary");
    return v.verify(this.pub, Buffer.from(firmaBinaria, "binary"));
  }
}

describe("extraerReto()", () => {
  const base = "https://login.siat.sat.gob.mx/nidp/wsfed/ep";

  it("saca el token y la action del formulario, por nombre no por posición", () => {
    const html = `
      <form method="post" action="/nidp/app/login?sid=0">
        <input type="hidden" name="otraCosa" value="ruido"/>
        <input type="hidden" name="tokenValue" value="RETO-ABC-123"/>
      </form>`;
    const r = extraerReto(html, base);
    expect(r.token).toBe("RETO-ABC-123");
    expect(r.actionUrl).toBe("https://login.siat.sat.gob.mx/nidp/app/login?sid=0");
  });

  it("acepta `token` como nombre alterno del campo", () => {
    const html = `<form action="x"><input name="token" value="Z9"/></form>`;
    expect(extraerReto(html, base).token).toBe("Z9");
  });

  it("sin action, postea a la misma URL", () => {
    const html = `<form><input name="tokenValue" value="Q"/></form>`;
    expect(extraerReto(html, base).actionUrl).toBe(base);
  });

  it("falla RUIDOSAMENTE si no hay reto — un token vacío firmado miente", () => {
    expect(() => extraerReto("<form></form>", base)).toThrow(SatPortalAuthError);
  });
});

describe("firmarReto()", () => {
  let f: FirmanteDePrueba;
  beforeAll(() => { f = new FirmanteDePrueba(); });

  it("la firma del sobre verifica contra la llave que la produjo", () => {
    const reto = { token: "RETO-XYZ", actionUrl: "https://x" };
    const sobre = firmarReto(reto, f);
    const firmaBinaria = Buffer.from(sobre.firmaBase64, "base64").toString("binary");
    expect(f.verifica(reto.token, firmaBinaria, "sha1")).toBe(true);
  });

  it("el sobre lleva certificado en una línea, serie decimal y RFC del titular", () => {
    const sobre = firmarReto({ token: "T", actionUrl: "x" }, f);
    expect(sobre.certificadoBase64).not.toContain("BEGIN CERTIFICATE");
    expect(sobre.numeroSerie).toMatch(/^\d+$/);
    expect(sobre.rfc).toBe("AAA010101AAA");
  });

  it("firmar el mismo token dos veces da la misma firma (RSA PKCS#1 determinista)", () => {
    const a = firmarReto({ token: "IGUAL", actionUrl: "x" }, f);
    const b = firmarReto({ token: "IGUAL", actionUrl: "x" }, f);
    expect(a.firmaBase64).toBe(b.firmaBase64);
  });

  it("una firma SHA-256 no verifica como SHA-1: el algoritmo importa", () => {
    const sobre = firmarReto({ token: "T", actionUrl: "x" }, f, "sha256");
    const bin = Buffer.from(sobre.firmaBase64, "base64").toString("binary");
    expect(f.verifica("T", bin, "sha256")).toBe(true);
    expect(f.verifica("T", bin, "sha1")).toBe(false);
  });
});

describe("cuerpoDeLogin()", () => {
  it("arma un form-urlencoded con los campos que espera el SAT", () => {
    const cuerpo = cuerpoDeLogin({
      token: "T T", firmaBase64: "Zg==", certificadoBase64: "Q0VSVA==",
      numeroSerie: "12345", rfc: "AAA010101AAA",
    });
    const p = new URLSearchParams(cuerpo);
    expect(p.get("tokenValue")).toBe("T T");
    expect(p.get("firma")).toBe("Zg==");
    expect(p.get("numeroSerie")).toBe("12345");
    expect(p.get("rfc")).toBe("AAA010101AAA");
  });
});

describe("extraerCookieSesion()", () => {
  it("une los pares nombre=valor de varios set-cookie en un header Cookie", () => {
    const c = extraerCookieSesion([
      "JSESSIONID=abc123; Path=/; HttpOnly",
      "IPCZQX=deadbeef; Secure",
    ]);
    expect(c).toBe("JSESSIONID=abc123; IPCZQX=deadbeef");
  });

  it("sin set-cookie no hay sesión: login rechazado", () => {
    expect(extraerCookieSesion(null)).toBeNull();
    expect(extraerCookieSesion([])).toBeNull();
  });
});
