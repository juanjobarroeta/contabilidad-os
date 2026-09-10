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

// Firmante de PRUEBA con crypto de Node — nunca una FIEL real. Firma con una RSA
// generada en memoria, así que el ENCODE del token se ejerce contra una firma
// auténtica, offline. El cert/serie/vigencia son fijos: probamos su empaque.
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
    return s.sign(this.priv, "binary");
  }
  rfc() {
    return "AAA010101AAA";
  }
  certificate() {
    return {
      pemAsOneLine: () => "MIIDdummyCERToneLineBase64Content",
      serialNumber: () => ({ decimal: () => "30001000000400000123" }),
      validTo: () => "290828004113Z",
    };
  }
  verifica(data: string, firmaBinaria: string, algorithm = "sha1"): boolean {
    const v = createVerify(algorithm);
    v.update(data, "binary");
    return v.verify(this.pub, Buffer.from(firmaBinaria, "binary"));
  }
}

// El certform REAL (capturado en el HAR): guid + urlApplet + credentialsRequired
// + ks + los campos del applet vacíos. El cliente rellena token y fert.
const CERTFORM = `
  <form role="form" method="post"></form>
  <form name="certform" id="certform" method="post">
    <input type="text" name="txtCertificate" value=""/>
    <input type="password" name="privateKeyPassword"/>
    <input type="hidden" name="token" value=""/>
    <input type="hidden" name="credentialsRequired" value="CERT"/>
    <input type="hidden" name="guid" value="7be082aa-2c44-468f-9e0c-e117f278abbe"/>
    <input type="hidden" name="ks" value="null"/>
    <input type="hidden" name="urlApplet" value="https://login.siat.sat.gob.mx/nidp/app/applet"/>
    <input type="hidden" name="fert" value=""/>
  </form>`;

describe("extraerReto()", () => {
  const base = "https://login.siat.sat.gob.mx/nidp/idff/sso?id=fiel_Aviso";

  it("saca guid, urlApplet, credentialsRequired y ks del certform, por nombre", () => {
    const r = extraerReto(CERTFORM, base);
    expect(r.guid).toBe("7be082aa-2c44-468f-9e0c-e117f278abbe");
    expect(r.urlApplet).toContain("/nidp/app/applet");
    expect(r.credentialsRequired).toBe("CERT");
    expect(r.ks).toBe("null");
    expect(r.actionUrl).toBe(base); // certform sin action → postea a su propia URL
  });

  it("falla RUIDOSAMENTE si no hay guid — sin él no hay reto que firmar", () => {
    expect(() => extraerReto("<form></form>", base)).toThrow(SatPortalAuthError);
  });
});

describe("firmarReto() — la receta verificada contra la captura real", () => {
  let f: FirmanteDePrueba;
  beforeAll(() => {
    f = new FirmanteDePrueba();
  });

  it("token = base64( base64(guid|RFC|serie) # base64(base64(RSA-SHA1)) ), y la firma verifica", () => {
    const reto = extraerReto(CERTFORM, "x");
    const sobre = firmarReto(reto, f);
    // Desanidar el token igual que lo haría el portal.
    const inner = Buffer.from(sobre.token, "base64").toString("latin1");
    const [partA, partB] = inner.split("#");
    const desafio = Buffer.from(partA, "base64").toString("utf8");
    expect(desafio).toBe("7be082aa-2c44-468f-9e0c-e117f278abbe|AAA010101AAA|30001000000400000123");
    // partB es DOBLE base64 → firma de 256 bytes (RSA 2048).
    const firmaBin = Buffer.from(Buffer.from(partB, "base64").toString("latin1"), "base64").toString("binary");
    expect(Buffer.from(firmaBin, "binary").length).toBe(256);
    expect(f.verifica(desafio, firmaBin, "sha1")).toBe(true);
    // Es sobre el DESAFÍO y con SHA-1, no SHA-256.
    expect(f.verifica(desafio, firmaBin, "sha256")).toBe(false);
  });

  it("fert = la vigencia del cert (el campo que espera el POST)", () => {
    const sobre = firmarReto(extraerReto(CERTFORM, "x"), f);
    expect(sobre.fert).toBe("290828004113Z");
  });
});

describe("cuerpoDeLogin()", () => {
  it("arma el form-urlencoded del certform; el certificado NO va", () => {
    const reto = extraerReto(CERTFORM, "x");
    const sobre = firmarReto(reto, new FirmanteDePrueba());
    const p = new URLSearchParams(cuerpoDeLogin(reto, sobre));
    expect(p.get("token")).toBe(sobre.token);
    expect(p.get("credentialsRequired")).toBe("CERT");
    expect(p.get("guid")).toBe(reto.guid);
    expect(p.get("ks")).toBe("null");
    expect(p.get("urlApplet")).toContain("/nidp/app/applet");
    expect(p.get("fert")).toBe(sobre.fert);
    expect(p.has("certificado")).toBe(false);
    expect(p.has("firma")).toBe(false);
  });
});

describe("extraerCookieSesion()", () => {
  it("une los pares nombre=valor de varios set-cookie en un header Cookie", () => {
    const c = extraerCookieSesion(["JSESSIONID=abc123; Path=/; HttpOnly", "IPCZQX=deadbeef; Secure"]);
    expect(c).toBe("JSESSIONID=abc123; IPCZQX=deadbeef");
  });

  it("sin set-cookie no hay sesión: login rechazado", () => {
    expect(extraerCookieSesion(null)).toBeNull();
    expect(extraerCookieSesion([])).toBeNull();
  });
});
