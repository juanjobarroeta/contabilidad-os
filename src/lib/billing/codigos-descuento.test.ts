import { describe, expect, it } from "vitest";
import { construirCodigoParams, resumenDePromotionCode } from "./codigos-descuento";
import { esAdminPlataforma } from "./admin-plataforma";
import type Stripe from "stripe";

const AHORA = Date.UTC(2026, 6, 8, 12, 0, 0); // 2026-07-08T12:00:00Z

describe("construirCodigoParams", () => {
  it("porcentaje siempre → coupon forever con percent_off", () => {
    const out = construirCodigoParams(
      { tipo: "porcentaje", valor: 30, duracion: "siempre", cliente: "Despacho García" },
      AHORA,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.params.coupon.percent_off).toBe(30);
    expect(out.params.coupon.amount_off).toBeUndefined();
    expect(out.params.coupon.duration).toBe("forever");
    expect(out.params.coupon.metadata).toEqual({ cliente: "Despacho García" });
    expect(out.params.coupon.name).toContain("Despacho García");
    expect(out.params.coupon.name).toContain("30%");
  });

  it("monto MXN → amount_off en centavos con currency mxn", () => {
    const out = construirCodigoParams(
      { tipo: "monto", valor: 400.5, duracion: "una_vez" },
      AHORA,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.params.coupon.amount_off).toBe(40050);
    expect(out.params.coupon.currency).toBe("mxn");
    expect(out.params.coupon.duration).toBe("once");
  });

  it("duración en meses exige meses entero 1–36", () => {
    const ok = construirCodigoParams(
      { tipo: "porcentaje", valor: 20, duracion: "meses", meses: 12 },
      AHORA,
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.params.coupon.duration).toBe("repeating");
      expect(ok.params.coupon.duration_in_months).toBe(12);
    }
    for (const meses of [0, 37, 1.5, undefined]) {
      const bad = construirCodigoParams(
        { tipo: "porcentaje", valor: 20, duracion: "meses", meses },
        AHORA,
      );
      expect(bad.ok).toBe(false);
    }
  });

  it("código explícito se normaliza a mayúsculas y se valida", () => {
    const ok = construirCodigoParams(
      { tipo: "porcentaje", valor: 10, duracion: "siempre", codigo: "garcia-30" },
      AHORA,
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.params.promo.code).toBe("GARCIA-30");

    for (const codigo of ["ab", "tiene espacios", "ñoño!", "x".repeat(41)]) {
      const bad = construirCodigoParams(
        { tipo: "porcentaje", valor: 10, duracion: "siempre", codigo },
        AHORA,
      );
      expect(bad.ok).toBe(false);
    }
  });

  it("sin código → Stripe lo genera (no se manda code)", () => {
    const out = construirCodigoParams(
      { tipo: "porcentaje", valor: 10, duracion: "siempre", codigo: "  " },
      AHORA,
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect("code" in out.params.promo).toBe(false);
  });

  it("defaults: 1 canje y vencimiento a 30 días; expiraDias 0 = sin vencer", () => {
    const out = construirCodigoParams({ tipo: "porcentaje", valor: 10, duracion: "siempre" }, AHORA);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.params.promo.max_redemptions).toBe(1);
      expect(out.params.promo.expires_at).toBe(Math.floor(AHORA / 1000) + 30 * 86400);
    }
    const sinVencer = construirCodigoParams(
      { tipo: "porcentaje", valor: 10, duracion: "siempre", expiraDias: 0 },
      AHORA,
    );
    expect(sinVencer.ok).toBe(true);
    if (sinVencer.ok) expect("expires_at" in sinVencer.params.promo).toBe(false);
  });

  it("rechaza valores fuera de rango", () => {
    const casos = [
      { tipo: "porcentaje", valor: 0, duracion: "siempre" },
      { tipo: "porcentaje", valor: -5, duracion: "siempre" },
      { tipo: "porcentaje", valor: 101, duracion: "siempre" },
      { tipo: "monto", valor: 0, duracion: "siempre" },
      { tipo: "porcentaje", valor: 10, duracion: "siempre", maxCanjes: 0 },
      { tipo: "porcentaje", valor: 10, duracion: "siempre", maxCanjes: 1001 },
      { tipo: "porcentaje", valor: 10, duracion: "siempre", expiraDias: -1 },
      { tipo: "porcentaje", valor: 10, duracion: "siempre", expiraDias: 366 },
      { tipo: "otro", valor: 10, duracion: "siempre" },
      { tipo: "porcentaje", valor: 10, duracion: "otra" },
    ] as const;
    for (const c of casos) {
      // @ts-expect-error — se prueban inputs inválidos a propósito
      expect(construirCodigoParams(c, AHORA).ok, JSON.stringify(c)).toBe(false);
    }
  });
});

describe("resumenDePromotionCode", () => {
  it("mapea porcentaje/duración y metadata del cliente", () => {
    const pc = {
      id: "promo_1",
      code: "GARCIA-30",
      active: true,
      times_redeemed: 1,
      max_redemptions: 1,
      expires_at: Math.floor(AHORA / 1000) + 86400,
      created: Math.floor(AHORA / 1000),
      metadata: { cliente: "Despacho García" },
      promotion: {
        type: "coupon",
        coupon: {
          percent_off: 30,
          amount_off: null,
          currency: null,
          duration: "repeating",
          duration_in_months: 12,
          metadata: {},
          name: "x",
        },
      },
    } as unknown as Stripe.PromotionCode;
    const r = resumenDePromotionCode(pc);
    expect(r.codigo).toBe("GARCIA-30");
    expect(r.descuento).toBe("30%");
    expect(r.duracion).toBe("12 meses");
    expect(r.cliente).toBe("Despacho García");
    expect(r.canjes).toBe(1);
    expect(r.maxCanjes).toBe(1);
    expect(r.expiraEl).toBe(new Date((Math.floor(AHORA / 1000) + 86400) * 1000).toISOString());
  });

  it("mapea monto fijo en centavos a MXN legible", () => {
    const pc = {
      id: "promo_2",
      code: "PLAN-400",
      active: false,
      times_redeemed: 0,
      max_redemptions: null,
      expires_at: null,
      created: Math.floor(AHORA / 1000),
      metadata: {},
      promotion: {
        type: "coupon",
        coupon: {
          percent_off: null,
          amount_off: 40000,
          currency: "mxn",
          duration: "forever",
          duration_in_months: null,
          metadata: { cliente: "Cliente X" },
          name: "x",
        },
      },
    } as unknown as Stripe.PromotionCode;
    const r = resumenDePromotionCode(pc);
    expect(r.descuento).toBe("$400 MXN");
    expect(r.duracion).toBe("siempre");
    expect(r.cliente).toBe("Cliente X");
    expect(r.expiraEl).toBeNull();
    expect(r.maxCanjes).toBeNull();
  });
});

describe("esAdminPlataforma", () => {
  const env = { PLATFORM_ADMIN_EMAILS: "Admin@Ejemplo.com, otro@x.mx" };

  it("acepta correos de la lista sin distinguir mayúsculas ni espacios", () => {
    expect(esAdminPlataforma("admin@ejemplo.com", env)).toBe(true);
    expect(esAdminPlataforma("  OTRO@X.MX  ", env)).toBe(true);
  });

  it("rechaza correos fuera de la lista, vacíos o sin variable (falla cerrado)", () => {
    expect(esAdminPlataforma("intruso@x.mx", env)).toBe(false);
    expect(esAdminPlataforma("", env)).toBe(false);
    expect(esAdminPlataforma(null, env)).toBe(false);
    expect(esAdminPlataforma(undefined, env)).toBe(false);
    expect(esAdminPlataforma("admin@ejemplo.com", {})).toBe(false);
    expect(esAdminPlataforma("admin@ejemplo.com", { PLATFORM_ADMIN_EMAILS: "" })).toBe(false);
    expect(esAdminPlataforma("admin@ejemplo.com", { PLATFORM_ADMIN_EMAILS: " , ," })).toBe(false);
  });
});
