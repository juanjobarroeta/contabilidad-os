import { describe, expect, it, vi } from "vitest";

// The functions under test are real; persistence is deliberately unavailable.
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { evaluarCoberturaBancaria } from "@/lib/bancos/conciliacion";
import { estadoDelPeriodo } from "@/lib/cierre/estado-periodo";
import { resumenNegocio } from "@/lib/cierre/negocio";
import { compuertaParaEstado } from "@/lib/cierre/compuerta-entregables";
import { contratoMensualFiscal } from "@/lib/fiscal/contrato-mensual";
import { periodoMensualActual, periodoMensualPorDefecto, rangoPeriodoMensual } from "@/lib/fiscal/periodo-operativo";
import {
  assertAnnualCompanyCalculationSupported, assertMonthlyCompanyCalculationSupported,
  companyRegimenCodesForPeriod, RegimenCalculationNotSupportedError, tipoPersonaFromRfc,
} from "@/lib/fiscal/regimen-capabilities";
import { closeCases, periodCases, regimeCases } from "./fixtures/v1";
import { fiscalScenario, periodNumbers, regimeRows } from "./scenario";

describe("QA-001 v1: calendar contracts", () => {
  it.each(periodCases)("$id — $description", (fixture) => {
    const { expected } = fixture;
    const now = new Date(fixture.now);
    const contract = contratoMensualFiscal(now);
    expect(contract.hoy.key).toBe(expected.today);
    expect(periodoMensualActual(now).key).toBe(expected.current);
    expect(periodoMensualPorDefecto(now).key).toBe(expected.period);
    expect(contract.periodo.key).toBe(expected.period);
    expect(contract.fechaLimite).toBe(expected.due);
    expect(contract.diasRestantes).toBe(expected.days);
    expect(contract.vencida).toBe(expected.days < 0);

    const { checklist, cierre } = fiscalScenario({
      ...closeCases[2].input, now: fixture.now, period: expected.period,
    });
    expect(checklist).toMatchObject({ fechaLimite: expected.due, diasRestantes: expected.days });
    const closeDeclaration = cierre.pasos.find((p) => p.clave === "declaracion");
    expect(closeDeclaration).toMatchObject({ fechaLimite: expected.due, diasRestantes: expected.days });
    expect(resumenNegocio(cierre)).toMatchObject({ fechaLimite: expected.due, diasRestantes: expected.days });
  });
});

describe("QA-001 v1: bank evidence, declarations and close consumers", () => {
  it.each(closeCases)("$id — $description", ({ input, expected }) => {
    const coverage = evaluarCoberturaBancaria(input.bankTotal, input.bankPending, input.noBankConfirmed);
    expect(coverage.estado).toBe(expected.coverage);
    expect(coverage.porcentajeConciliado).toBe(expected.percentage);

    const { checklist, readiness, cierre } = fiscalScenario(input);
    expect(checklist?.items.find((item) => item.clave === "conciliacion-bancaria")?.estado ?? null)
      .toBe(expected.checklistBank);
    expect(readiness?.checks.find((check) => check.clave === "banco")?.estado ?? null)
      .toBe(expected.readinessBank);
    expect(cierre.pasos.find((paso) => paso.clave === "banco")?.estadoCalculado).toBe(expected.closeBank);
    expect(cierre.estado).toMatchObject({
      fase: expected.phase, estadoContable: input.accounting, declarado: expected.declared,
      cerrado: expected.phase === "CERRADO", descargable: expected.downloadable, origenCierre: expected.origin,
    });
    expect(estadoDelPeriodo(cierre)).toMatchObject({ declarado: expected.declared, pagado: expected.paid });
    const business = resumenNegocio(cierre);
    expect(business).toMatchObject({
      declarado: expected.declared, cerradoFueraDeContabilidadOS: expected.origin === "FUERA_DE_CONTABILIDAD_OS",
    });
    if (expected.phase === "BLOQUEADO") {
      expect(cierre.estado.bloqueos.length).toBeGreaterThan(0);
      expect(business.alDia).toBe(false);
    }
    if (expected.origin === "FUERA_DE_CONTABILIDAD_OS") {
      expect(business).toMatchObject({ alDia: true, detienen: 0, falta: [] });
    }
    if (!input.enginesAvailable) expect(business.aPagar).toBeNull();

    const download = compuertaParaEstado(cierre.estado);
    expect(download.ok).toBe(expected.downloadable);
    if (!expected.downloadable) {
      expect(download).toMatchObject({ status: 409, body: { code: "CIERRE_NO_DESCARGABLE" } });
    }
  });
});

describe("QA-001 v1: period-aware calculation capability (not tax math)", () => {
  it.each(regimeCases)("$id — $description", (fixture) => {
    const { year, month } = periodNumbers(fixture.period);
    const range = fixture.calculation === "ANNUAL"
      ? { from: new Date(Date.UTC(year, 0, 1)), to: new Date(Date.UTC(year + 1, 0, 1)) }
      : rangoPeriodoMensual({ year, month });
    const codes = companyRegimenCodesForPeriod({
      regimenFiscal: fixture.scalar, regimenes: regimeRows(fixture), ...range,
    });
    expect(codes).toEqual(fixture.expected.codes);
    const guard = fixture.calculation === "MONTHLY"
      ? assertMonthlyCompanyCalculationSupported : assertAnnualCompanyCalculationSupported;
    const run = () => guard({ regimenFiscal: null, regimenes: codes, tipoPersona: tipoPersonaFromRfc(fixture.rfc) });
    if (fixture.expected.reason === null) {
      expect(run().trackId).toBe(fixture.expected.track);
    } else {
      expect(run).toThrow(RegimenCalculationNotSupportedError);
      expect(run).toThrow(expect.objectContaining({
        reason: fixture.expected.reason, status: 422,
        regimen: expect.objectContaining({ trackId: fixture.expected.track }),
      }));
    }
  });
});
