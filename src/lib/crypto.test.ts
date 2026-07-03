import { describe, it, expect, afterEach, vi } from "vitest";
import crypto from "crypto";
import {
  encryptSecret,
  decryptSecret,
  encryptNullable,
  decryptNullable,
  isEncrypted,
  parseKey,
  encryptionConfigured,
} from "./crypto";

// Clave válida de 32 bytes en base64 para las pruebas de ida y vuelta.
const VALID_KEY = crypto.randomBytes(32).toString("base64");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("encryptSecret en producción", () => {
  it("lanza error claro si CREDENTIALS_ENCRYPTION_KEY no está configurada (nunca guarda texto claro)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", "");
    expect(() => encryptSecret("secreto-fiel")).toThrow(
      /CREDENTIALS_ENCRYPTION_KEY es obligatoria en producción/
    );
  });

  it("lanza error claro si la clave es inválida (longitud incorrecta)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", Buffer.from("corta").toString("base64"));
    expect(() => encryptSecret("secreto-fiel")).toThrow(
      /CREDENTIALS_ENCRYPTION_KEY no es válida/
    );
  });

  it("cifra normalmente cuando la clave es válida", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", VALID_KEY);
    const stored = encryptSecret("sk_live_abc123");
    expect(isEncrypted(stored)).toBe(true);
    expect(stored).not.toContain("sk_live_abc123");
  });
});

describe("encryptSecret en desarrollo", () => {
  it("sin clave: regresa el texto claro y advierte por consola (dev local sigue funcionando)", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stored = encryptSecret("password-csd");
    expect(stored).toBe("password-csd");
    expect(isEncrypted(stored)).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("con clave inválida: lanza el error de configuración (no cae a texto claro en silencio)", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", "no-es-base64-de-32-bytes");
    expect(() => encryptSecret("password-csd")).toThrow(/32 bytes/);
  });
});

describe("ida y vuelta con clave configurada", () => {
  it("encryptSecret produce el sobre enc:v1: y decryptSecret recupera el original", () => {
    vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", VALID_KEY);
    const original = "contraseña-fiel-áéíóú-🔐".normalize();
    const stored = encryptSecret(original);
    expect(stored.startsWith("enc:v1:")).toBe(true);
    expect(decryptSecret(stored)).toBe(original);
  });

  it("dos cifrados del mismo texto difieren (IV aleatorio) pero ambos descifran igual", () => {
    vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", VALID_KEY);
    const a = encryptSecret("mismo-secreto");
    const b = encryptSecret("mismo-secreto");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe("mismo-secreto");
    expect(decryptSecret(b)).toBe("mismo-secreto");
  });

  it("encryptNullable/decryptNullable pasan null/undefined sin tocar", () => {
    vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", VALID_KEY);
    expect(encryptNullable(null)).toBeUndefined();
    expect(encryptNullable(undefined)).toBeUndefined();
    expect(decryptNullable(null)).toBeNull();
    const stored = encryptNullable("valor");
    expect(stored && decryptNullable(stored)).toBe("valor");
  });
});

describe("decryptSecret con valores legados en texto claro", () => {
  it("regresa el valor tal cual si no tiene el prefijo enc:v1: (sin clave configurada)", () => {
    vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", "");
    expect(decryptSecret("plaintext-legado")).toBe("plaintext-legado");
  });

  it("regresa el valor tal cual si no tiene el prefijo enc:v1: (con clave configurada)", () => {
    vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", VALID_KEY);
    expect(decryptSecret("plaintext-legado")).toBe("plaintext-legado");
  });

  it("también en producción: los renglones legados siguen leyéndose", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", "");
    expect(decryptSecret("plaintext-legado")).toBe("plaintext-legado");
  });

  it("lanza si el valor está cifrado pero no hay clave para descifrarlo", () => {
    vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", VALID_KEY);
    const stored = encryptSecret("secreto");
    vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", "");
    expect(() => decryptSecret(stored)).toThrow(/CREDENTIALS_ENCRYPTION_KEY no configurada/);
  });
});

describe("parseKey / encryptionConfigured", () => {
  it("parseKey acepta 32 bytes y rechaza otras longitudes", () => {
    expect(parseKey(VALID_KEY).length).toBe(32);
    expect(() => parseKey(Buffer.from("solo-dieciseis-b").toString("base64"))).toThrow(
      /32 bytes/
    );
  });

  it("encryptionConfigured refleja la presencia de la variable", () => {
    vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", "");
    expect(encryptionConfigured()).toBe(false);
    vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", VALID_KEY);
    expect(encryptionConfigured()).toBe(true);
  });
});
