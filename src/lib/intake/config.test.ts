import { afterEach, describe, expect, it } from "vitest";
import { diaSemanaLocal, githubRepoForProduct, horaLocal, lunesDeLaSemana, productByKey } from "./config";

describe("productByKey", () => {
  it("resuelve claves conocidas (case-insensitive) y el core flag", () => {
    expect(productByKey("CONTABILIDADOS")?.core).toBe(true);
    expect(productByKey("automotriz")?.core).toBe(false);
    expect(productByKey("inventado")).toBeNull();
    expect(productByKey(null)).toBeNull();
  });
});

describe("hora/día local MX", () => {
  it("convierte UTC a America/Mexico_City (UTC-6, sin DST desde 2022)", () => {
    // 2026-08-19T14:00Z = 08:00 en CDMX
    const d = new Date("2026-08-19T14:00:00Z");
    expect(horaLocal(d)).toBe(8);
    expect(diaSemanaLocal(d)).toBe(3); // miércoles
  });

  it("madrugada UTC cae en el día local anterior", () => {
    const d = new Date("2026-08-17T03:00:00Z"); // domingo 21:00 CDMX
    expect(diaSemanaLocal(d)).toBe(0);
  });
});

describe("lunesDeLaSemana", () => {
  it("cualquier día de la semana ancla al mismo lunes", () => {
    const lunes = lunesDeLaSemana(new Date("2026-08-17T15:00:00Z")); // lunes
    const jueves = lunesDeLaSemana(new Date("2026-08-20T15:00:00Z"));
    const domingo = lunesDeLaSemana(new Date("2026-08-23T15:00:00Z"));
    expect(jueves.toISOString()).toBe(lunes.toISOString());
    expect(domingo.toISOString()).toBe(lunes.toISOString());
    expect(lunes.toISOString().startsWith("2026-08-17")).toBe(true);
  });

  it("la semana siguiente ancla a otro lunes", () => {
    const l1 = lunesDeLaSemana(new Date("2026-08-20T15:00:00Z"));
    const l2 = lunesDeLaSemana(new Date("2026-08-27T15:00:00Z"));
    expect(l2.getTime() - l1.getTime()).toBe(7 * 24 * 3600 * 1000);
  });
});

describe("githubRepoForProduct", () => {
  const OLD = { ...process.env };
  afterEach(() => {
    process.env.INTAKE_GITHUB_REPO = OLD.INTAKE_GITHUB_REPO;
    process.env.INTAKE_GITHUB_REPO_AUTOMOTRIZ = OLD.INTAKE_GITHUB_REPO_AUTOMOTRIZ;
  });

  it("usa el default y respeta el override por producto", () => {
    process.env.INTAKE_GITHUB_REPO = "owner/monorepo";
    process.env.INTAKE_GITHUB_REPO_AUTOMOTRIZ = "owner/automotriz";
    expect(githubRepoForProduct("contabilidados")).toBe("owner/monorepo");
    expect(githubRepoForProduct("automotriz")).toBe("owner/automotriz");
    expect(githubRepoForProduct(null)).toBe("owner/monorepo");
  });
});
