import { describe, expect, it } from "vitest";
import crypto from "crypto";

import { checkProductionEnv } from "./env-check";

const validKey = crypto.randomBytes(32).toString("base64");

const fullEnv = {
  CREDENTIALS_ENCRYPTION_KEY: validKey,
  AUTH_SECRET: "s3cret",
  NEXTAUTH_SECRET: "s3cret",
  CRON_SECRET: "cron",
  SENTRY_DSN: "https://x@sentry.example/1",
};

describe("checkProductionEnv", () => {
  it("con la configuración completa no reporta nada", () => {
    const r = checkProductionEnv(fullEnv);
    expect(r.fatal).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("sin CREDENTIALS_ENCRYPTION_KEY es fatal", () => {
    const r = checkProductionEnv({ ...fullEnv, CREDENTIALS_ENCRYPTION_KEY: undefined });
    expect(r.fatal.some((m) => m.includes("CREDENTIALS_ENCRYPTION_KEY"))).toBe(true);
  });

  it("con llave de longitud incorrecta es fatal", () => {
    const shortKey = crypto.randomBytes(16).toString("base64");
    const r = checkProductionEnv({ ...fullEnv, CREDENTIALS_ENCRYPTION_KEY: shortKey });
    expect(r.fatal.some((m) => m.includes("inválida"))).toBe(true);
  });

  it("sin AUTH_SECRET ni NEXTAUTH_SECRET es fatal", () => {
    const r = checkProductionEnv({
      ...fullEnv,
      AUTH_SECRET: undefined,
      NEXTAUTH_SECRET: undefined,
    });
    expect(r.fatal.some((m) => m.includes("AUTH_SECRET"))).toBe(true);
  });

  it("basta con una de AUTH_SECRET/NEXTAUTH_SECRET", () => {
    const r = checkProductionEnv({ ...fullEnv, NEXTAUTH_SECRET: undefined });
    expect(r.fatal).toEqual([]);
  });

  it("sin CRON_SECRET y sin SENTRY_DSN solo advierte", () => {
    const r = checkProductionEnv({
      ...fullEnv,
      CRON_SECRET: undefined,
      SENTRY_DSN: undefined,
    });
    expect(r.fatal).toEqual([]);
    expect(r.warnings).toHaveLength(2);
  });
});
