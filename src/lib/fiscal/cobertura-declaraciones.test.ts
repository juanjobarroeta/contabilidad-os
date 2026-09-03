import { describe, expect, it } from "vitest";
import { anualVencida, mensualVencido } from "./cobertura-declaraciones";

// Caso real (FRC ABOGADOS, 3-sep-2026): el banner pedía el acuse de agosto
// 2026 cuando agosto vence el 17 de septiembre. Un periodo cuya fecha límite no
// pasó está PENDIENTE, no faltante.
describe("mensualVencido", () => {
  it("el mes anterior NO está vencido antes del 17 del mes en curso", () => {
    expect(mensualVencido(2026, 8, new Date(2026, 8, 3))).toBe(false);
    expect(mensualVencido(2026, 8, new Date(2026, 8, 17))).toBe(false); // el propio día límite sigue en tiempo
  });

  it("el mes anterior SÍ está vencido pasado el día límite", () => {
    expect(mensualVencido(2026, 8, new Date(2026, 8, 18))).toBe(true);
    expect(mensualVencido(2026, 8, new Date(2026, 9, 1))).toBe(true);
  });

  it("los meses más atrás ya están vencidos", () => {
    expect(mensualVencido(2026, 7, new Date(2026, 8, 3))).toBe(true);
    expect(mensualVencido(2026, 1, new Date(2026, 8, 3))).toBe(true);
  });

  it("diciembre vence el 17 de enero del año siguiente", () => {
    expect(mensualVencido(2025, 12, new Date(2026, 0, 10))).toBe(false);
    expect(mensualVencido(2025, 12, new Date(2026, 1, 1))).toBe(true);
  });

  it("si el 17 cae en fin de semana se recorre a hábil (no vence el 18)", () => {
    // Mayo 2026: 17-jun-2026 es miércoles → vence el 17. Enero 2027: 17-feb-2027 es
    // miércoles → vence el 17. Buscamos uno en fin de semana: octubre 2026 vence
    // 17-nov-2026 (martes)… usamos abril 2027: 17-may-2027 es lunes. Enero 2026:
    // 17-feb-2026 martes. Marzo 2026: 17-abr-2026 viernes. Abril 2026: 17-may-2026
    // es DOMINGO → se recorre al lunes 18.
    expect(mensualVencido(2026, 4, new Date(2026, 4, 18))).toBe(false);
    expect(mensualVencido(2026, 4, new Date(2026, 4, 19))).toBe(true);
  });
});

describe("anualVencida", () => {
  it("persona moral: vence el 31 de marzo del año siguiente", () => {
    expect(anualVencida(2025, false, new Date(2026, 2, 15))).toBe(false);
    expect(anualVencida(2025, false, new Date(2026, 2, 31))).toBe(false);
    expect(anualVencida(2025, false, new Date(2026, 3, 1))).toBe(true);
  });

  it("persona física: vence el 30 de abril del año siguiente", () => {
    expect(anualVencida(2025, true, new Date(2026, 3, 15))).toBe(false);
    expect(anualVencida(2025, true, new Date(2026, 3, 30))).toBe(false);
    expect(anualVencida(2025, true, new Date(2026, 4, 1))).toBe(true);
  });

  it("ejercicios más viejos siempre están vencidos", () => {
    expect(anualVencida(2023, false, new Date(2026, 0, 2))).toBe(true);
    expect(anualVencida(2023, true, new Date(2026, 0, 2))).toBe(true);
  });
});
