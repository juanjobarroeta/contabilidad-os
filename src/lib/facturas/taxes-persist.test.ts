import { describe, it, expect } from "vitest";
import { invoiceTaxRowsFromItems, type ItemConImpuestos } from "./taxes-persist";

const item = (
  price: number,
  taxes: ItemConImpuestos["product"]["taxes"],
  quantity = 1
): ItemConImpuestos => ({ quantity, product: { price, taxes } });

const IVA16 = { type: "IVA", rate: 0.16, factor: "Tasa", withholding: false };

describe("invoiceTaxRowsFromItems", () => {
  it("una factura IVA 16 genera su fila con base y importe correctos", () => {
    // Caso real del bug: $2,586.21 + IVA = $3,000.00. Esta factura NO guardaba
    // filas de impuesto y por eso su complemento de pago era intimbrable.
    const rows = invoiceTaxRowsFromItems([item(2586.21, [IVA16])]);
    expect(rows).toEqual([
      { tipo: "IVA", factor: "TASA", tasa: 0.16, base: 2586.21, importe: 413.79, retencion: false },
    ]);
  });

  it("agrega partidas con el mismo impuesto en una sola fila por comprobante", () => {
    const rows = invoiceTaxRowsFromItems([
      item(1000, [IVA16]),
      item(500, [IVA16], 2), // 2 × 500 = 1,000
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].base).toBe(2000);
    expect(rows[0].importe).toBe(320);
  });

  it("separa tasas distintas y retenciones en filas propias", () => {
    const rows = invoiceTaxRowsFromItems([
      item(1000, [IVA16, { type: "ISR", rate: 0.1, factor: "Tasa", withholding: true }]),
      item(2000, [{ type: "IVA", rate: 0, factor: "Tasa", withholding: false }]),
    ]);
    expect(rows).toHaveLength(3);
    const retencion = rows.find((r) => r.retencion)!;
    expect(retencion).toMatchObject({ tipo: "ISR", tasa: 0.1, base: 1000, importe: 100 });
    expect(rows.filter((r) => !r.retencion).map((r) => r.tasa).sort()).toEqual([0, 0.16]);
  });

  it("EXENTO conserva la base con importe 0 (proporción de acreditamiento)", () => {
    const rows = invoiceTaxRowsFromItems([
      item(3000, [{ type: "IVA", rate: 0, factor: "Exento", withholding: false }]),
    ]);
    expect(rows).toEqual([
      { tipo: "IVA", factor: "EXENTO", tasa: 0, base: 3000, importe: 0, retencion: false },
    ]);
  });

  it("omite tipos y factores fuera del modelo en vez de inventar bases", () => {
    const rows = invoiceTaxRowsFromItems([
      item(1000, [
        IVA16,
        { type: "IEPS", rate: 0.53, factor: "Cuota", withholding: false }, // cuota por unidad: fuera
        { type: "LOCAL", rate: 0.005, factor: "Tasa", withholding: true }, // tipo desconocido: fuera
      ]),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].tipo).toBe("IVA");
  });

  it("partidas sin impuestos no generan filas", () => {
    expect(invoiceTaxRowsFromItems([item(1000, undefined), item(500, [])])).toEqual([]);
  });
});
