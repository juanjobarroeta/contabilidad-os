import { describe, it, expect } from "vitest";
import { periodoImssMensual, bimestreDe, estimadoImssBimestral } from "./imss-pagos";

// ─────────────────────────────────────────────────────────────────────────────
// Golden tests del ciclo de pago IMSS (SIPARE) — funciones PURAS, sin DB:
// fecha límite mensual (día 17 del mes siguiente en hábil, con cruce de
// ejercicio), mapeo de bimestres (ene-feb → 17 mar … nov-dic → 17 ene) y
// armado del estimado desde las sumas de nómina.
// ─────────────────────────────────────────────────────────────────────────────

describe("periodoImssMensual — fecha límite día 17 del mes siguiente, hábil", () => {
  const sums = { imssObrero: 0, imssPatronal: 0 };

  it("mayo 2026 vence el 17 de junio de 2026 (miércoles hábil)", () => {
    const p = periodoImssMensual(2026, 5, sums);
    expect(p.periodo).toBe("2026-05");
    expect(p.fechaLimite.getFullYear()).toBe(2026);
    expect(p.fechaLimite.getMonth()).toBe(5); // junio
    expect(p.fechaLimite.getDate()).toBe(17);
  });

  it("diciembre cruza el ejercicio: cuotas de dic 2025 vencen en enero 2026", () => {
    const p = periodoImssMensual(2025, 12, sums);
    expect(p.fechaLimite.getFullYear()).toBe(2026);
    expect(p.fechaLimite.getMonth()).toBe(0); // enero
    // 17 ene 2026 cae sábado → recorre al lunes hábil 19.
    expect(p.fechaLimite.getDate()).toBe(19);
  });

  it("recorre a día hábil: cuotas de abril 2026 (17 may es domingo) vencen el lunes 18", () => {
    const p = periodoImssMensual(2026, 4, sums);
    expect(p.fechaLimite.getFullYear()).toBe(2026);
    expect(p.fechaLimite.getMonth()).toBe(4); // mayo
    expect(p.fechaLimite.getDate()).toBe(18);
  });

  it("arma el estimado redondeado a centavos desde las sumas de nómina", () => {
    const p = periodoImssMensual(2026, 5, { imssObrero: 1234.567, imssPatronal: 8765.432 });
    expect(p.estimado.imssObrero).toBe(1234.57);
    expect(p.estimado.imssPatronal).toBe(8765.43);
    expect(p.estimado.total).toBe(10000);
  });
});

describe("bimestreDe — mapeo de bimestres y su fecha límite (LSS Art. 39)", () => {
  it("enero pertenece al bimestre 1 (ene-feb) pero NO lo cierra", () => {
    const b = bimestreDe(2026, 1);
    expect(b.bimestre).toBe(1);
    expect(b.meses).toEqual([1, 2]);
    expect(b.cierraBimestre).toBe(false);
    expect(b.periodo).toBe("2026-02");
  });

  it("ene-feb vence el 17 de marzo (febrero cierra el bimestre)", () => {
    const b = bimestreDe(2026, 2);
    expect(b.cierraBimestre).toBe(true);
    expect(b.etiqueta).toBe("enero-febrero de 2026");
    expect(b.fechaLimite.getFullYear()).toBe(2026);
    expect(b.fechaLimite.getMonth()).toBe(2); // marzo
    expect(b.fechaLimite.getDate()).toBe(17); // martes hábil
  });

  it("los seis bimestres cierran en feb, abr, jun, ago, oct y dic", () => {
    const cierres = [2, 4, 6, 8, 10, 12];
    for (const mes of cierres) {
      const b = bimestreDe(2026, mes);
      expect(b.cierraBimestre, `mes ${mes}`).toBe(true);
      expect(b.bimestre).toBe(mes / 2);
      expect(b.meses).toEqual([mes - 1, mes]);
    }
    for (const mes of [1, 3, 5, 7, 9, 11]) {
      expect(bimestreDe(2026, mes).cierraBimestre, `mes ${mes}`).toBe(false);
    }
  });

  it("nov-dic cruza el ejercicio: vence en enero del año siguiente, en hábil", () => {
    const b = bimestreDe(2025, 12);
    expect(b.bimestre).toBe(6);
    expect(b.meses).toEqual([11, 12]);
    expect(b.periodo).toBe("2025-12");
    expect(b.fechaLimite.getFullYear()).toBe(2026);
    expect(b.fechaLimite.getMonth()).toBe(0); // enero
    expect(b.fechaLimite.getDate()).toBe(19); // 17 ene 2026 es sábado → lunes 19
  });

  it("mes intermedio (noviembre) comparte bimestre y fecha límite con diciembre", () => {
    const nov = bimestreDe(2025, 11);
    const dic = bimestreDe(2025, 12);
    expect(nov.periodo).toBe(dic.periodo);
    expect(nov.fechaLimite.getTime()).toBe(dic.fechaLimite.getTime());
  });
});

describe("estimadoImssBimestral — Infonavit de los dos meses", () => {
  it("suma y redondea a centavos", () => {
    const e = estimadoImssBimestral([{ infonavit: 1200.505 }, { infonavit: 800 }]);
    expect(e.infonavit).toBe(2000.51);
    expect(e.total).toBe(2000.51);
  });

  it("sin retenciones Infonavit → estimado cero (piso, no cifra final)", () => {
    const e = estimadoImssBimestral([{ infonavit: 0 }, { infonavit: 0 }]);
    expect(e.total).toBe(0);
  });
});
