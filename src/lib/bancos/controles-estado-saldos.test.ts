import { describe, expect, it } from "vitest";
import { duplicadosExactos, leerSaldos, leerControles, cotejarControles } from "./controles-estado";

// Texto tal cual sale del estado de cuenta real (BBVA, agosto 2026, Centro de
// Procedimientos): el resumen que el banco imprime en su primera página.
const RESUMEN_BBVA = `
Comportamiento
Saldo de Liquidación Inicial 322,417.91
Saldo de Operación Inicial 322,417.91
Depósitos / Abonos (+) 42 3,376,161.67
Retiros / Cargos (-) 126 3,620,943.87
Saldo Final (+) 77,635.71
Saldo de Operación Final 77,635.71
`;

const mov = (fecha: string, monto: number, descripcion = "MOV", referencia?: string) => ({
  fecha: new Date(`${fecha}T12:00:00Z`),
  descripcion,
  monto,
  referencia,
});

describe("leerSaldos — el banco los imprime; el modelo a veces no los ve", () => {
  it("lee inicial y final del resumen de BBVA", () => {
    expect(leerSaldos(RESUMEN_BBVA)).toEqual({ inicial: 322_417.91, final: 77_635.71 });
  });

  it("sin saldos en el texto devuelve nulls, no ceros", () => {
    expect(leerSaldos("Estado de cuenta sin resumen")).toEqual({ inicial: null, final: null });
  });
});

describe("cotejarControles — diagnóstico de signo", () => {
  it("nombra el problema de SIGNO con lo realmente importado en agosto", () => {
    // 38 depósitos / 3,206,379.94 y 131 cargos / 3,817,418.84.
    const movs = [
      ...Array.from({ length: 37 }, (_, i) => mov("2026-08-02", 1, `DEP ${i}`)),
      mov("2026-08-03", 3_206_379.94 - 37, "DEP GRANDE"),
      ...Array.from({ length: 130 }, (_, i) => mov("2026-08-04", -1, `RET ${i}`)),
      mov("2026-08-05", -(3_817_418.84 - 130), "RET GRANDE"),
    ];
    const r = cotejarControles(leerControles(RESUMEN_BBVA), movs);
    expect(r.cuadra).toBe(false);
    expect(r.advertencias.join(" ")).toMatch(/problema de SIGNO/);
    expect(r.advertencias.join(" ")).toMatch(/4 depósitos/);
  });

  it("extracción correcta: sin advertencias y sin pista de signo", () => {
    const movs = [
      ...Array.from({ length: 41 }, (_, i) => mov("2026-08-02", 1, `DEP ${i}`)),
      mov("2026-08-03", 3_376_161.67 - 41, "DEP GRANDE"),
      ...Array.from({ length: 125 }, (_, i) => mov("2026-08-04", -1, `RET ${i}`)),
      mov("2026-08-05", -(3_620_943.87 - 125), "RET GRANDE"),
    ];
    const r = cotejarControles(leerControles(RESUMEN_BBVA), movs);
    expect(r.cuadra).toBe(true);
    expect(r.advertencias).toEqual([]);
  });
});

describe("duplicadosExactos — dos cobros iguales el mismo día pueden ser reales", () => {
  it("detecta el renglón repetido exacto (el SPEI de $26,693.24 del 21/ago)", () => {
    const d = duplicadosExactos([
      mov("2026-08-21", -26_693.24, "T17 SPEI ENVIADO SANTANDER"),
      mov("2026-08-21", -26_693.24, "T17 SPEI ENVIADO SANTANDER"),
      mov("2026-08-21", -1_000, "OTRO"),
    ]);
    expect(d).toHaveLength(1);
    expect(d[0].veces).toBe(2);
  });

  it("misma fecha e importe con referencia distinta NO es duplicado", () => {
    expect(
      duplicadosExactos([
        mov("2026-08-21", 5_000, "PAGO PACIENTE", "REF-1"),
        mov("2026-08-21", 5_000, "PAGO PACIENTE", "REF-2"),
      ]),
    ).toEqual([]);
  });
});
