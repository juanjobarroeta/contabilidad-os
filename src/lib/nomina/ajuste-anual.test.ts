import { describe, it, expect } from "vitest";
import {
  calcularAjusteAnualEmpleado,
  LIMITE_INGRESOS_ANUALES_ART97,
  type ReciboAjuste,
} from "./ajuste-anual";

// ─────────────────────────────────────────────────────────────────────────────
// GOLDENS HECHOS A MANO del ajuste anual de ISR (Art. 97 LISR + decreto de
// subsidio DOF 01-may-2024, Art. Tercero). Cada cifra esperada está calculada
// a mano a partir de las tablas de src/lib/fiscal/tarifas.ts:
//
//   Tarifa ANUAL 2024 (Art. 152, vigente también para 2025 por roll-forward):
//     renglón $185,852.58 → cuota $19,682.13, 21.36% s/excedente
//     renglón  $75,984.56 → cuota  $4,461.94, 10.88% s/excedente
//     renglón   $8,952.50 → cuota    $171.88,  6.40% s/excedente
//   Tarifa MENSUAL 2024 (Art. 96, ídem 2025):
//     renglón  $15,487.72 → cuota  $1,640.18, 21.36% s/excedente
//     renglón   $6,332.06 → cuota    $371.83, 10.88% s/excedente
//   Subsidio al empleo 2025 (DOF 31-dic-2024): 13.8% × UMA mensual
//     = 0.138 × 113.14 × 30.4 = $474.64; tope base mensual $10,171.00.
//     Enero 2025 (Transitorio Segundo): 14.39% × UMA 2024 mensual
//     = 0.1439 × 108.57 × 30.4 = $474.95.
// ─────────────────────────────────────────────────────────────────────────────

/** Recibo mensual simple del ejercicio (pago el día 28 del mes). */
function recibo(
  ejercicio: number,
  mes: number,
  gravado: number | null,
  isrRetenido: number,
  extra?: Partial<ReciboAjuste>
): ReciboAjuste {
  return {
    fechaPago: `${ejercicio}-${String(mes).padStart(2, "0")}-28`,
    gravado,
    totalPercepciones: gravado ?? 0,
    isrRetenido,
    esSeparacion: false,
    ...extra,
  };
}

function base(ejercicio: number, recibos: ReciboAjuste[]) {
  return calcularAjusteAnualEmpleado({
    ejercicio,
    fechaIngreso: "2020-01-01", // año completo
    fechaBaja: null, // sigue activo
    recibos,
  });
}

describe("ajuste anual — año completo con sueldo uniforme (2025)", () => {
  // $20,000 gravados/mes. Retención mensual (tarifa Art. 96):
  //   1,640.18 + (20,000 − 15,487.72) × 0.2136 = 2,604.003008 → $2,604.00/mes
  //   (sin subsidio: base mensual > tope de $10,171). Retenido anual: $31,248.00.
  // ISR anual (tarifa Art. 152, base $240,000):
  //   19,682.13 + (240,000 − 185,852.58) × 0.2136 = 31,248.018912 → $31,248.02.
  // La diferencia de $0.02 a cargo es el efecto de redondeo ENTRE tablas
  // (la mensual es la anual ÷ 12 con centavos truncados) — por diseño.
  const recibos = Array.from({ length: 12 }, (_, i) => recibo(2025, i + 1, 20_000, 2_604.0));

  it("ISR anual exacto de la tarifa del Art. 152 y diferencia de centavos", () => {
    const r = base(2025, recibos);
    expect(r.estado).toBe("aplica");
    expect(r.baseAnual).toBe(240_000);
    expect(r.isrTarifaAnual).toBe(31_248.02);
    expect(r.subsidioAnualCorrespondido).toBe(0);
    expect(r.isrAnual).toBe(31_248.02);
    expect(r.retenidoAcumulado).toBe(31_248.0);
    expect(r.diferencia).toBe(0.02);
    expect(r.sentido).toBe("a-cargo");
    // Diferencia ≤ $1: se explica como redondeo entre tablas.
    expect(r.advertencias.join(" ")).toContain("redondeo");
    // 2025 resuelve con la tabla anual de 2024 (roll-forward documentado).
    expect(r.advertencias.join(" ")).toContain("2024");
  });
});

describe("ajuste anual — diferencia a cargo (retención insuficiente)", () => {
  it("retuvo $2,500/mes en lugar de $2,604 → a cargo $1,248.02, se retiene en diciembre y se entera en febrero", () => {
    const recibos = Array.from({ length: 12 }, (_, i) => recibo(2025, i + 1, 20_000, 2_500.0));
    const r = base(2025, recibos);
    expect(r.estado).toBe("aplica");
    expect(r.isrAnual).toBe(31_248.02);
    expect(r.retenidoAcumulado).toBe(30_000.0);
    expect(r.diferencia).toBe(1_248.02);
    expect(r.sentido).toBe("a-cargo");
    expect(r.accionDiciembre).toContain("diciembre");
    expect(r.accionDiciembre).toContain("febrero");
  });
});

describe("ajuste anual — diferencia a favor con subsidio al empleo (2025)", () => {
  // Ene-jun: $10,000 gravados/mes (≤ tope $10,171 → subsidio del mes).
  //   ISR mensual: 371.83 + 3,667.94 × 0.1088 = 770.901872
  //   retención = 770.901872 − 474.64 = 296.261872 → $296.26/mes.
  // Jul-dic: $30,000/mes → 1,640.18 + 14,512.28 × 0.2136 = 4,740.003008 → $4,740.00.
  // Retenido anual: 6×296.26 + 6×4,740.00 = 1,777.56 + 28,440.00 = $30,217.56.
  // Subsidio anual correspondido: enero $474.95 + 5 × $474.64 = $2,848.15.
  // ISR anual: tarifa 31,248.02 (base 240,000) − 2,848.15 = $28,399.87.
  // Diferencia: 28,399.87 − 30,217.56 = −$1,817.69 → a favor.
  it("subsidio mensual correspondido (6 meses, con transitorio de enero) y saldo a favor", () => {
    const recibos = [
      ...Array.from({ length: 6 }, (_, i) => recibo(2025, i + 1, 10_000, 296.26)),
      ...Array.from({ length: 6 }, (_, i) => recibo(2025, i + 7, 30_000, 4_740.0)),
    ];
    const r = base(2025, recibos);
    expect(r.estado).toBe("aplica");
    expect(r.baseAnual).toBe(240_000);
    expect(r.isrTarifaAnual).toBe(31_248.02);
    expect(r.mesesConSubsidio).toBe(6);
    expect(r.subsidioAnualCorrespondido).toBe(2_848.15);
    expect(r.subsidioAplicado).toBe(2_848.15);
    expect(r.isrAnual).toBe(28_399.87);
    expect(r.retenidoAcumulado).toBe(30_217.56);
    expect(r.diferencia).toBe(-1_817.69);
    expect(r.sentido).toBe("a-favor");
    expect(r.accionDiciembre).toContain("Compensar");
    expect(r.accionDiciembre).toContain("diciembre");
  });
});

describe("ajuste anual — subsidio topado al ISR anual (decreto, Art. Tercero fracc. III)", () => {
  // Sólo 3 meses con ingreso de $9,000 (permiso sin goce el resto; sigue
  // contratado todo el año). Subsidio correspondido: 3 × 474.64 = $1,423.92.
  // ISR anual (base $27,000): 171.88 + 18,047.50 × 0.064 = $1,326.92 — MENOR
  // que el subsidio → impuesto anual $0 y nada se entrega al trabajador.
  // Retención mensual de $9,000: 371.83 + 2,667.94 × 0.1088 = 662.101872;
  // − 474.64 = 187.461872 → $187.46/mes; retenido 3 × 187.46 = $562.38.
  it("el subsidio deja el impuesto en cero pero JAMÁS genera cantidad a entregar", () => {
    const recibos = [2, 3, 4].map((m) => recibo(2025, m, 9_000, 187.46));
    const r = base(2025, recibos);
    expect(r.estado).toBe("aplica");
    expect(r.isrTarifaAnual).toBe(1_326.92);
    expect(r.subsidioAnualCorrespondido).toBe(1_423.92);
    expect(r.subsidioAplicado).toBe(1_326.92); // topado, fracc. III
    expect(r.isrAnual).toBe(0);
    expect(r.retenidoAcumulado).toBe(562.38);
    expect(r.diferencia).toBe(-562.38);
    expect(r.sentido).toBe("a-favor");
  });
});

describe("ajuste anual — quincenas agregadas por mes de calendario (nativa + SAT mezcladas)", () => {
  // Dos recibos de $5,000 gravados por mes (24 en el año, p.ej. unos timbrados
  // en la app y otros importados del SAT — la fuente es indistinta: el insumo
  // es el gravado del XML). El derecho al subsidio se evalúa por MES de
  // calendario: $10,000 ≤ tope $10,171 → subsidio los 12 meses.
  //   Subsidio anual: enero 474.95 + 11 × 474.64 = $5,695.99.
  //   Retención por quincena (motor Art. 96, base mensualizada 5,000×30.4/15
  //   = 10,133.33): 371.83 + 3,801.2733×0.1088 = 785.40854; − 474.64 =
  //   310.76854; × 15/30.4 = 153.33974 → $153.34; retenido 24 × 153.34 = $3,680.16.
  //   ISR anual (base $120,000): 4,461.94 + 44,015.44 × 0.1088 = 9,250.819872
  //   → $9,250.82; − 5,695.99 = $3,554.83.
  //   Diferencia: 3,554.83 − 3,680.16 = −$125.33 → a favor.
  it("agrega el gravado de las quincenas del mes para el tope del subsidio", () => {
    const recibos: ReciboAjuste[] = [];
    for (let mes = 1; mes <= 12; mes++) {
      recibos.push(
        { ...recibo(2025, mes, 5_000, 153.34), fechaPago: `2025-${String(mes).padStart(2, "0")}-15` },
        { ...recibo(2025, mes, 5_000, 153.34), fechaPago: `2025-${String(mes).padStart(2, "0")}-28` }
      );
    }
    const r = base(2025, recibos);
    expect(r.estado).toBe("aplica");
    expect(r.baseAnual).toBe(120_000);
    expect(r.mesesConSubsidio).toBe(12);
    expect(r.subsidioAnualCorrespondido).toBe(5_695.99);
    expect(r.isrTarifaAnual).toBe(9_250.82);
    expect(r.isrAnual).toBe(3_554.83);
    expect(r.retenidoAcumulado).toBe(3_680.16);
    expect(r.diferencia).toBe(-125.33);
    expect(r.sentido).toBe("a-favor");
  });
});

describe("ajuste anual — exclusión por ingresos > $400,000 (Art. 97, inciso b)", () => {
  it("exactamente $400,000.00 NO excluye (el texto exige que EXCEDAN)", () => {
    const recibos = [
      ...Array.from({ length: 11 }, (_, i) =>
        recibo(2025, i + 1, 20_000, 2_604.0, { totalPercepciones: 33_000 })
      ),
      recibo(2025, 12, 20_000, 2_604.0, { totalPercepciones: 37_000 }),
    ];
    const r = base(2025, recibos);
    expect(r.ingresosTotales).toBe(400_000);
    expect(LIMITE_INGRESOS_ANUALES_ART97).toBe(400_000);
    expect(r.estado).toBe("aplica");
  });

  it("$400,000.01 excluye y remite a la declaración anual propia", () => {
    const recibos = [
      ...Array.from({ length: 11 }, (_, i) =>
        recibo(2025, i + 1, 20_000, 2_604.0, { totalPercepciones: 33_000 })
      ),
      recibo(2025, 12, 20_000, 2_604.0, { totalPercepciones: 37_000.01 }),
    ];
    const r = base(2025, recibos);
    expect(r.estado).toBe("no-aplica");
    expect(r.motivo).toBe("ingresos-mayores-400k");
    expect(r.accionDiciembre).toContain("declaración anual");
    // El retenido acumulado sigue siendo informativo.
    expect(r.retenidoAcumulado).toBe(31_248.0);
  });
});

describe("ajuste anual — exclusión por periodo incompleto (Art. 97, inciso a)", () => {
  const recibos = Array.from({ length: 12 }, (_, i) => recibo(2025, i + 1, 20_000, 2_604.0));

  it("ingreso posterior al 1 de enero → no aplica", () => {
    const r = calcularAjusteAnualEmpleado({ ejercicio: 2025, fechaIngreso: "2025-03-01", fechaBaja: null, recibos });
    expect(r.estado).toBe("no-aplica");
    expect(r.motivo).toBe("periodo-incompleto");
  });

  it("ingreso exactamente el 1 de enero → SÍ aplica (no es posterior)", () => {
    const r = calcularAjusteAnualEmpleado({ ejercicio: 2025, fechaIngreso: "2025-01-01", fechaBaja: null, recibos });
    expect(r.estado).toBe("aplica");
  });

  it("baja antes del 1 de diciembre → no aplica", () => {
    const r = calcularAjusteAnualEmpleado({ ejercicio: 2025, fechaIngreso: "2020-01-01", fechaBaja: "2025-11-30", recibos });
    expect(r.estado).toBe("no-aplica");
    expect(r.motivo).toBe("periodo-incompleto");
  });

  it("baja el 1 de diciembre o después → SÍ aplica (no dejó de prestar servicios ANTES del 1-dic)", () => {
    const r = calcularAjusteAnualEmpleado({ ejercicio: 2025, fechaIngreso: "2020-01-01", fechaBaja: "2025-12-01", recibos });
    expect(r.estado).toBe("aplica");
  });
});

describe("ajuste anual — exclusiones de datos y de alcance", () => {
  it("sin recibos en el ejercicio → no aplica (sin-recibos)", () => {
    const r = base(2025, []);
    expect(r.estado).toBe("no-aplica");
    expect(r.motivo).toBe("sin-recibos");
  });

  it("recibo sin XML timbrado → base indeterminable (sin-xml)", () => {
    const recibos = Array.from({ length: 12 }, (_, i) => recibo(2025, i + 1, 20_000, 2_604.0));
    recibos[5] = recibo(2025, 6, null, 2_604.0, { totalPercepciones: 20_000 });
    const r = base(2025, recibos);
    expect(r.estado).toBe("no-aplica");
    expect(r.motivo).toBe("sin-xml");
    expect(r.recibosSinXml).toBe(1);
  });

  it("pagos por separación en el año → no aplica (mecánica del Art. 95 no modelada)", () => {
    const recibos = Array.from({ length: 12 }, (_, i) => recibo(2025, i + 1, 20_000, 2_604.0));
    recibos.push(recibo(2025, 12, 15_000, 500, { esSeparacion: true }));
    const r = calcularAjusteAnualEmpleado({
      ejercicio: 2025,
      fechaIngreso: "2020-01-01",
      fechaBaja: "2025-12-15", // baja en diciembre: pasa el inciso a), bloquea la separación
      recibos,
    });
    expect(r.estado).toBe("no-aplica");
    expect(r.motivo).toBe("pagos-por-separacion");
  });

  it("trabajador de salario mínimo → no aplica (Art. 96 último párrafo LISR y Art. 110 LFT)", () => {
    // 2025: mínimo general $278.80/día → $8,475.52 mensuales; $8,400 queda debajo.
    const recibos = Array.from({ length: 12 }, (_, i) => recibo(2025, i + 1, 8_400, 0));
    const r = base(2025, recibos);
    expect(r.estado).toBe("no-aplica");
    expect(r.motivo).toBe("salario-minimo");
  });
});

describe("ajuste anual — ejercicio 2024 (decreto de subsidio vigente desde el 1 de mayo)", () => {
  it("subsidio en juego en ene-abr 2024 (tabla 2013 no modelada) → no calculable", () => {
    const recibos = Array.from({ length: 12 }, (_, i) => recibo(2024, i + 1, 9_000, 100));
    const r = base(2024, recibos);
    expect(r.estado).toBe("no-aplica");
    expect(r.motivo).toBe("subsidio-regimen-2013");
  });

  it("ingresos sobre el tope todo el año → calcula normal con la tarifa anual 2024", () => {
    // $25,000/mes: retención mensual 1,640.18 + 9,512.28 × 0.2136 =
    // 3,672.003008 → $3,672.00; retenido anual $44,064.00.
    // ISR anual (base $300,000): 19,682.13 + 114,147.42 × 0.2136 =
    // 44,064.018912 → $44,064.02. Diferencia $0.02 a cargo (redondeo).
    const recibos = Array.from({ length: 12 }, (_, i) => recibo(2024, i + 1, 25_000, 3_672.0));
    const r = base(2024, recibos);
    expect(r.estado).toBe("aplica");
    expect(r.isrTarifaAnual).toBe(44_064.02);
    expect(r.subsidioAnualCorrespondido).toBe(0);
    expect(r.retenidoAcumulado).toBe(44_064.0);
    expect(r.diferencia).toBe(0.02);
    expect(r.sentido).toBe("a-cargo");
  });
});
