import { describe, it, expect } from "vitest";
import {
  planNombrarStubs,
  NOMBRES_FAMILIA_28_MARGOM,
  type CuentaCatalogoExistente,
} from "./nombrar-stubs";

// Filas como las deja importarBalanza al dar de alta un stub: nombre = código,
// naturaleza por primer dígito, nivel por número de grupos del código (3).
const stub = (over: Partial<CuentaCatalogoExistente> & { cuentaSAT: string }): CuentaCatalogoExistente => ({
  id: `id-${over.cuentaSAT}`,
  subcuenta: null,
  nombre: over.cuentaSAT,
  naturaleza: "D",
  nivel: 3,
  ...over,
});

describe("planNombrarStubs() — sólo toca lo que sigue siendo stub", () => {
  it("nombra un stub y ajusta nivel al del catálogo", () => {
    const plan = planNombrarStubs(
      [stub({ cuentaSAT: "1301-0028-0000" })],
      [{ codigo: "1301-0028-0000", nombre: "INVENTARIO VEHICULOS NUEVOS TRAVELER", nivel: 2, evidencia: "x" }],
    );
    expect(plan.actualizaciones).toEqual([
      {
        id: "id-1301-0028-0000",
        codigo: "1301-0028-0000",
        data: { nombre: "INVENTARIO VEHICULOS NUEVOS TRAVELER", nivel: 2 },
        evidencia: "x",
      },
    ]);
    expect(plan.omitidas).toEqual([]);
  });

  it("NUNCA pisa una cuenta que ya tiene nombre (manual o de un CT remandado)", () => {
    const plan = planNombrarStubs(
      [stub({ cuentaSAT: "1301-0028-0000", nombre: "INVENTARIO TRAVELER (puesto a mano)" })],
      [{ codigo: "1301-0028-0000", nombre: "INVENTARIO VEHICULOS NUEVOS TRAVELER", evidencia: "x" }],
    );
    expect(plan.actualizaciones).toEqual([]);
    expect(plan.omitidas).toEqual([{ codigo: "1301-0028-0000", razon: "ya tiene nombre" }]);
  });

  it("reporta como omitida la cuenta que no existe, sin inventarla", () => {
    const plan = planNombrarStubs([], [{ codigo: "9200-0007-0000", nombre: "X", evidencia: "x" }]);
    expect(plan.actualizaciones).toEqual([]);
    expect(plan.omitidas).toEqual([{ codigo: "9200-0007-0000", razon: "no existe" }]);
  });

  it("corrige la naturaleza sólo cuando difiere (4201-* es contra-ingreso: D)", () => {
    const plan = planNombrarStubs(
      [
        stub({ cuentaSAT: "4201-0028-0000", naturaleza: "A" }), // stub mal derivado
        stub({ cuentaSAT: "5101-0028-0000", naturaleza: "D" }), // ya correcta
      ],
      [
        { codigo: "4201-0028-0000", nombre: "DESCUENTO NUEVOS TRAVELER", naturaleza: "D", evidencia: "x" },
        { codigo: "5101-0028-0000", nombre: "COSTO NUEVOS TRAVELER", naturaleza: "D", evidencia: "x" },
      ],
    );
    expect(plan.actualizaciones.map((a) => a.data)).toEqual([
      { nombre: "DESCUENTO NUEVOS TRAVELER", naturaleza: "D" },
      { nombre: "COSTO NUEVOS TRAVELER" },
    ]);
  });

  it("empata por subcuenta cuando la cuenta la tiene (códigos con punto)", () => {
    const plan = planNombrarStubs(
      [stub({ cuentaSAT: "102", subcuenta: "102.01", nombre: "102.01" })],
      [{ codigo: "102.01", nombre: "BANCOS NACIONALES", evidencia: "x" }],
    );
    expect(plan.actualizaciones.map((a) => a.codigo)).toEqual(["102.01"]);
  });

  it("es idempotente: aplicar el plan y volver a planear sale vacío", () => {
    const cuentas = [stub({ cuentaSAT: "4101-0028-0000", naturaleza: "A" })];
    const confirmados = [
      { codigo: "4101-0028-0000", nombre: "VENTA NUEVOS TRAVELER", nivel: 2, evidencia: "x" },
    ];
    const primero = planNombrarStubs(cuentas, confirmados);
    expect(primero.actualizaciones).toHaveLength(1);

    const despues = cuentas.map((c) => ({ ...c, ...primero.actualizaciones[0].data }));
    const segundo = planNombrarStubs(despues, confirmados);
    expect(segundo.actualizaciones).toEqual([]);
    expect(segundo.omitidas).toEqual([{ codigo: "4101-0028-0000", razon: "ya tiene nombre" }]);
  });
});

describe("NOMBRES_FAMILIA_28_MARGOM — la constante que aplica el script", () => {
  it("cubre exactamente las cuatro cuentas de la familia 28", () => {
    expect(NOMBRES_FAMILIA_28_MARGOM.map((c) => c.codigo).sort()).toEqual([
      "1301-0028-0000",
      "4101-0028-0000",
      "4201-0028-0000",
      "5101-0028-0000",
    ]);
  });

  it("sigue la convención del CT del contador y sólo corrige la naturaleza del descuento", () => {
    const porCodigo = new Map(NOMBRES_FAMILIA_28_MARGOM.map((c) => [c.codigo, c]));
    expect(porCodigo.get("1301-0028-0000")?.nombre).toBe("INVENTARIO VEHICULOS NUEVOS TRAVELER");
    expect(porCodigo.get("4101-0028-0000")?.nombre).toBe("VENTA NUEVOS TRAVELER");
    expect(porCodigo.get("5101-0028-0000")?.nombre).toBe("COSTO NUEVOS TRAVELER");
    expect(porCodigo.get("4201-0028-0000")?.nombre).toBe("DESCUENTO NUEVOS TRAVELER");
    expect(NOMBRES_FAMILIA_28_MARGOM.filter((c) => c.naturaleza).map((c) => c.codigo)).toEqual([
      "4201-0028-0000",
    ]);
    // Nivel 2 = detalle, como sus hermanas 0001–0027 importadas del CT.
    expect(NOMBRES_FAMILIA_28_MARGOM.every((c) => c.nivel === 2)).toBe(true);
  });
});
