import { describe, it, expect } from "vitest";
import {
  decidirApertura,
  periodoAnteriorDe,
  nombrePeriodo,
  type AperturaInputs,
} from "./apertura";

// ─────────────────────────────────────────────────────────────────────────────
// Golden tests de la DECISIÓN de la apertura fiscal (función pura, sin DB):
// procedencia (fuente) y editabilidad por dato, empresa vacía, empresa
// alimentada por acuses y overrides manuales.
// ─────────────────────────────────────────────────────────────────────────────

const RFC_PM = "BAR840101AB1"; // 12 caracteres → persona moral
const RFC_PF = "BARJ840101AB2"; // 13 caracteres → persona física

/** Empresa PM "vacía": sin declaraciones, sin pérdidas, sin nómina, sin confirmar. */
function baseInputs(overrides: Partial<AperturaInputs> = {}): AperturaInputs {
  return {
    hoy: new Date(2026, 6, 4), // 4 de julio de 2026
    rfc: RFC_PM,
    regimenFiscal: "601",
    primerPeriodo: "2026-03",
    declaracionAnterior: null,
    coeficiente: { manual: null, manualAnio: null, deAnual: null, deProvisional: null },
    perdidaManual: { valor: null, anio: null },
    perdidaDeAnual: null,
    perdidasLedger: [],
    pagosProvisionales: [],
    obligaciones: [],
    nomina: { empleadosActivos: 0, corridasImportadasSat: 0 },
    sincronizacion: { periodosCubiertos: 0, periodosTotales: 0, faltantes: [], backfillTerminado: false },
    confirmacion: { confirmadaAt: null, confirmadaPor: null },
    ...overrides,
  };
}

describe("periodoAnteriorDe / nombrePeriodo", () => {
  it("resta un mes y cruza el ejercicio en enero", () => {
    expect(periodoAnteriorDe("2026-03")).toBe("2026-02");
    expect(periodoAnteriorDe("2026-01")).toBe("2025-12");
  });

  it("nombra el periodo en español", () => {
    expect(nombrePeriodo("2026-05")).toBe("mayo de 2026");
  });
});

describe("decidirApertura — empresa vacía", () => {
  it("todo sin dato pero editable, sin confirmar", () => {
    const a = decidirApertura(baseInputs());
    expect(a.primerPeriodo).toBe("2026-03");
    expect(a.periodoAnterior).toBe("2026-02");
    expect(a.esPersonaMoral).toBe(true);

    expect(a.ivaSaldoFavor.valor).toBeNull();
    expect(a.ivaSaldoFavor.fuente.tipo).toBe("sin-dato");
    expect(a.ivaSaldoFavor.fuente.etiqueta).toContain("captúralo");
    expect(a.ivaSaldoFavor.editable).toBe(true);

    expect(a.coeficiente.aplica).toBe(true);
    expect(a.coeficiente.valor).toBeNull();
    expect(a.coeficiente.fuente.tipo).toBe("sin-dato");
    expect(a.coeficiente.editable).toBe(true);

    expect(a.perdidaPendiente.aplica).toBe(true);
    expect(a.perdidaPendiente.valor).toBeNull();
    expect(a.perdidasPorAmortizar).toEqual([]);
    expect(a.pagosProvisionalesEjercicio).toEqual([]);
    expect(a.confirmada).toBe(false);
    expect(a.confirmadaAt).toBeNull();
  });
});

describe("decidirApertura — saldo a favor de IVA inicial", () => {
  it("fila con rastro de acuse → fuente acuse con el mes en la etiqueta", () => {
    const a = decidirApertura(
      baseInputs({
        declaracionAnterior: { ivaSaldoFavor: 15230.5, status: "FILED", isHistorical: true, tieneAcuse: true },
      })
    );
    expect(a.ivaSaldoFavor.valor).toBe(15230.5);
    expect(a.ivaSaldoFavor.fuente.tipo).toBe("acuse");
    expect(a.ivaSaldoFavor.fuente.referencia).toBe("2026-02");
    expect(a.ivaSaldoFavor.fuente.etiqueta).toBe("del acuse de febrero de 2026");
  });

  it("fila histórica SIN acuse → capturado manualmente", () => {
    const a = decidirApertura(
      baseInputs({
        declaracionAnterior: { ivaSaldoFavor: 8000, status: "FILED", isHistorical: true, tieneAcuse: false },
      })
    );
    expect(a.ivaSaldoFavor.fuente.tipo).toBe("manual");
    expect(a.ivaSaldoFavor.fuente.etiqueta).toBe("capturado manualmente");
  });

  it("fila guardada in-app (no histórica) → calculado", () => {
    const a = decidirApertura(
      baseInputs({
        declaracionAnterior: { ivaSaldoFavor: null, status: "CALCULATED", isHistorical: false, tieneAcuse: false },
      })
    );
    expect(a.ivaSaldoFavor.fuente.tipo).toBe("calculado");
    // ivaSaldoFavor null en la fila se muestra como 0 (dato presente, sin saldo).
    expect(a.ivaSaldoFavor.valor).toBe(0);
  });
});

describe("decidirApertura — coeficiente de utilidad", () => {
  it("manual vigente gana sobre la anual", () => {
    const a = decidirApertura(
      baseInputs({
        coeficiente: {
          manual: 0.1234,
          manualAnio: 2026,
          deAnual: { valor: 0.2, ejercicio: 2025 },
          deProvisional: null,
        },
      })
    );
    expect(a.coeficiente.valor).toBe(0.1234);
    expect(a.coeficiente.fuente.tipo).toBe("manual");
  });

  it("manual de OTRO ejercicio se ignora y cae a la anual", () => {
    const a = decidirApertura(
      baseInputs({
        coeficiente: {
          manual: 0.1234,
          manualAnio: 2024, // desactualizado — hoy es 2026
          deAnual: { valor: 0.2, ejercicio: 2025 },
          deProvisional: null,
        },
      })
    );
    expect(a.coeficiente.valor).toBe(0.2);
    expect(a.coeficiente.fuente.tipo).toBe("acuse");
    expect(a.coeficiente.fuente.etiqueta).toBe("de la declaración anual 2025");
  });

  it("sin manual ni anual → el aplicado en un provisional capturado", () => {
    const a = decidirApertura(
      baseInputs({
        coeficiente: { manual: null, manualAnio: null, deAnual: null, deProvisional: { valor: 0.15, periodo: "2026-04" } },
      })
    );
    expect(a.coeficiente.valor).toBe(0.15);
    expect(a.coeficiente.fuente.tipo).toBe("acuse");
    expect(a.coeficiente.fuente.etiqueta).toBe("del pago provisional de abril de 2026");
  });

  it("persona física: no aplica ni es editable", () => {
    const a = decidirApertura(baseInputs({ rfc: RFC_PF, regimenFiscal: "612" }));
    expect(a.esPersonaMoral).toBe(false);
    expect(a.coeficiente.aplica).toBe(false);
    expect(a.coeficiente.editable).toBe(false);
    expect(a.perdidaPendiente.aplica).toBe(false);
  });
});

describe("decidirApertura — pérdidas fiscales", () => {
  it("remanente PM: manual gana; sin manual usa la anual previa", () => {
    const manual = decidirApertura(
      baseInputs({
        perdidaManual: { valor: 50000, anio: 2025 },
        perdidaDeAnual: { valor: 80000, ejercicio: 2025 },
      })
    );
    expect(manual.perdidaPendiente.valor).toBe(50000);
    expect(manual.perdidaPendiente.fuente.tipo).toBe("manual");

    const anual = decidirApertura(baseInputs({ perdidaDeAnual: { valor: 80000, ejercicio: 2025 } }));
    expect(anual.perdidaPendiente.valor).toBe(80000);
    expect(anual.perdidaPendiente.fuente.tipo).toBe("acuse");
    expect(anual.perdidaPendiente.fuente.etiqueta).toBe("de la declaración anual 2025");
  });

  it("ledger: ordenado por ejercicio, con fuente según origen", () => {
    const a = decidirApertura(
      baseInputs({
        perdidasLedger: [
          { ejercicio: 2024, montoOriginal: 30000, saldoActualizado: 31000, origen: "CALCULADA" },
          { ejercicio: 2023, montoOriginal: 90000, saldoActualizado: 95000, origen: "IMPORTADA" },
        ],
      })
    );
    expect(a.perdidasPorAmortizar.map((p) => p.ejercicio)).toEqual([2023, 2024]);
    expect(a.perdidasPorAmortizar[0].fuente.tipo).toBe("manual");
    expect(a.perdidasPorAmortizar[0].fuente.etiqueta).toContain("importada");
    expect(a.perdidasPorAmortizar[1].fuente.tipo).toBe("calculado");
    expect(a.perdidasPorAmortizar[1].saldoActualizado).toBe(31000);
  });
});

describe("decidirApertura — pagos provisionales y obligaciones", () => {
  it("pagos provisionales del ejercicio, ordenados y con fuente por fila", () => {
    const a = decidirApertura(
      baseInputs({
        pagosProvisionales: [
          { periodo: "2026-02", isrPagar: 1200, isHistorical: true, tieneAcuse: true },
          { periodo: "2026-01", isrPagar: null, isHistorical: false, tieneAcuse: false },
        ],
      })
    );
    expect(a.pagosProvisionalesEjercicio.map((p) => p.mes)).toEqual([1, 2]);
    expect(a.pagosProvisionalesEjercicio[0].isrPagado).toBe(0); // null → 0
    expect(a.pagosProvisionalesEjercicio[0].fuente.tipo).toBe("calculado");
    expect(a.pagosProvisionalesEjercicio[1].fuente.tipo).toBe("acuse");
    expect(a.pagosProvisionalesEjercicio[1].fuente.etiqueta).toBe("del acuse de febrero de 2026");
  });

  it("obligaciones: fuente legible por origen (REGIMEN/CSF/NOMINA)", () => {
    const a = decidirApertura(
      baseInputs({
        obligaciones: [
          { tipo: "IVA_MENSUAL", descripcion: "IVA mensual", activa: true, fuente: "REGIMEN" },
          { tipo: "DIOT", descripcion: "DIOT", activa: false, fuente: "CSF" },
          { tipo: "RETENCIONES_ISR", descripcion: "Retenciones", activa: true, fuente: "NOMINA" },
        ],
      })
    );
    expect(a.obligaciones[0].fuente.tipo).toBe("regimen");
    expect(a.obligaciones[1].fuente.tipo).toBe("csf");
    expect(a.obligaciones[1].activa).toBe(false);
    expect(a.obligaciones[2].fuente.tipo).toBe("nomina");
  });
});

describe("decidirApertura — nómina, sincronización y confirmación", () => {
  it("propaga conteos de nómina y cobertura de sincronización", () => {
    const a = decidirApertura(
      baseInputs({
        nomina: { empleadosActivos: 7, corridasImportadasSat: 12 },
        sincronizacion: {
          periodosCubiertos: 22,
          periodosTotales: 24,
          faltantes: ["2026-05", "2026-06"],
          backfillTerminado: false,
        },
      })
    );
    expect(a.nomina).toEqual({ empleadosActivos: 7, corridasImportadas: 12 });
    expect(a.sincronizacion.periodosCubiertos).toBe(22);
    expect(a.sincronizacion.faltantes).toEqual(["2026-05", "2026-06"]);
  });

  it("confirmación estampada → confirmada con quién y cuándo", () => {
    const cuando = new Date("2026-07-01T18:00:00Z");
    const a = decidirApertura(
      baseInputs({ confirmacion: { confirmadaAt: cuando, confirmadaPor: "contador@despacho.mx" } })
    );
    expect(a.confirmada).toBe(true);
    expect(a.confirmadaAt).toBe(cuando.toISOString());
    expect(a.confirmadaPor).toBe("contador@despacho.mx");
  });
});
