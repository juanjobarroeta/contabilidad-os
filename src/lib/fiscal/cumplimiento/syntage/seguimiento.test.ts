import { describe, expect, it } from "vitest";
import {
  MAX_ACUSES_POR_LLAMADA,
  cronParaExtractor,
  cronsParaTerminadas,
  esEstadoFinal,
  intervaloSondeo,
} from "./seguimiento";

describe("seguimiento: qué cron cosecha cada extractor", () => {
  it("las mensuales van al backfill acotado a la empresa, con tope por llamada", () => {
    expect(cronParaExtractor("monthly_tax_return", "c1")).toEqual({
      name: "declaraciones-backfill",
      query: `companyId=c1&max=${MAX_ACUSES_POR_LLAMADA}`,
    });
  });

  it("opinión, CSF, anuales y CE van al compliance-sync de la empresa", () => {
    for (const ex of ["tax_compliance", "tax_status", "annual_tax_return", "electronic_accounting"] as const) {
      expect(cronParaExtractor(ex, "c1")).toEqual({ name: "compliance-sync", query: "companyId=c1" });
    }
  });

  it("invoice y retenciones no se cosechan aquí", () => {
    expect(cronParaExtractor("invoice", "c1")).toBeNull();
    expect(cronParaExtractor("tax_retention", "c1")).toBeNull();
  });

  it("escapa el companyId en la query", () => {
    expect(cronParaExtractor("tax_status", "a b&c")?.query).toBe("companyId=a%20b%26c");
  });
});

describe("seguimiento: colapso de crons", () => {
  it("varias extracciones que cosecha el mismo cron → una sola corrida", () => {
    const crons = cronsParaTerminadas(["tax_compliance", "tax_status", "annual_tax_return"], "c1");
    expect(crons).toHaveLength(1);
    expect(crons[0].name).toBe("compliance-sync");
  });

  it("mensuales + opinión → backfill y sync, uno cada uno", () => {
    const nombres = cronsParaTerminadas(["monthly_tax_return", "tax_compliance", "monthly_tax_return"], "c1").map(
      (c) => c.name,
    );
    expect(nombres.sort()).toEqual(["compliance-sync", "declaraciones-backfill"]);
  });

  it("sin terminadas, sin crons", () => {
    expect(cronsParaTerminadas([], "c1")).toEqual([]);
  });
});

describe("seguimiento: estados y sondeo", () => {
  it("sólo los estados terminales cortan el sondeo", () => {
    for (const s of ["finished", "failed", "stopped", "cancelled"]) expect(esEstadoFinal(s)).toBe(true);
    for (const s of ["pending", "running", ""]) expect(esEstadoFinal(s)).toBe(false);
  });

  it("sondea seguido al inicio y se relaja con el tiempo", () => {
    expect(intervaloSondeo(0)).toBe(15_000);
    expect(intervaloSondeo(5 * 60_000)).toBe(30_000);
    expect(intervaloSondeo(60 * 60_000)).toBe(60_000);
    expect(intervaloSondeo(0)).toBeLessThan(intervaloSondeo(60 * 60_000));
  });
});
