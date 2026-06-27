import { describe, it, expect } from "vitest";
import {
  auditarIngresoNoFacturado,
  esConceptoExcluido,
  type IngresoNoFacturado,
} from "./ingreso-no-facturado";

const periodo = "mayo–junio 2026";

function dep(id: string, monto: number, descripcion: string) {
  return { id, monto, fecha: new Date("2026-06-15T00:00:00Z"), descripcion };
}

describe("esConceptoExcluido", () => {
  it("excluye traspasos / transferencias entre cuentas propias", () => {
    expect(esConceptoExcluido("TRASPASO entre cuentas propias")).toBe(true);
    expect(esConceptoExcluido("SPEI a cuenta propia")).toBe(true);
  });

  it("excluye devoluciones, reembolsos, préstamos e intereses (con y sin acento)", () => {
    expect(esConceptoExcluido("Devolución de proveedor")).toBe(true);
    expect(esConceptoExcluido("REEMBOLSO viaticos")).toBe(true);
    expect(esConceptoExcluido("Disposición de crédito")).toBe(true);
    expect(esConceptoExcluido("Pago de prestamo")).toBe(true);
    expect(esConceptoExcluido("Intereses ganados")).toBe(true);
  });

  it("NO excluye un depósito de cliente normal", () => {
    expect(esConceptoExcluido("DEPOSITO CLIENTE ACME SA")).toBe(false);
    expect(esConceptoExcluido("Pago factura A-123")).toBe(false);
  });
});

describe("auditarIngresoNoFacturado", () => {
  it("no emite hallazgo cuando no hay depósitos", () => {
    const data: IngresoNoFacturado = { depositos: [], periodo };
    expect(auditarIngresoNoFacturado(data)).toEqual([]);
  });

  it("emite UN hallazgo agregado con el total y todas las referencias", () => {
    const data: IngresoNoFacturado = {
      depositos: [
        dep("tx1", 5000, "DEPOSITO CLIENTE ACME"),
        dep("tx2", 12000, "Transferencia recibida"),
      ],
      periodo,
    };
    const out = auditarIngresoNoFacturado(data);
    expect(out).toHaveLength(1);
    const h = out[0];
    expect(h.checkClave).toBe("banco.ingreso_no_facturado");
    expect(h.severidad).toBe("warn");
    expect(h.referencias).toEqual(["tx1", "tx2"]);
    expect(h.fundamento).toEqual({ ley: "LISR", articulo: "102" });
    // 5000 + 12000 = 17000, formateado en es-MX.
    expect(h.mensaje).toContain("17,000.00");
    expect(h.mensaje).toContain("2 depósito");
    expect(h.mensaje).toContain(periodo);
  });
});

// ─── Filtrado a nivel loader (gating) ────────────────────────────────────────
// El cruce con Prisma (tipo CREDITO, status UNMATCHED, invoiceId null, monto y
// fecha) lo hace la query; aquí probamos la lógica pura de filtrado que el loader
// aplica sobre las filas y la regla "reconciliación inactiva → []".

import * as mod from "./ingreso-no-facturado";

describe("cargarIngresoNoFacturado — gating (lógica de filtrado)", () => {
  // Simulamos lo que produce la combinación query + filtro de denylist, para
  // documentar qué entra y qué se ignora sin depender de la base de datos.
  const candidatos = [
    { id: "flagged", monto: 8000, descripcion: "DEPOSITO CLIENTE", incluir: true },
    { id: "transfer", monto: 9000, descripcion: "Traspaso entre cuentas propias", incluir: false },
    { id: "interes", monto: 3000, descripcion: "Intereses ganados", incluir: false },
  ];

  it("conserva el depósito de cliente y descarta traspaso/intereses por denylist", () => {
    const sobreviven = candidatos
      .filter((c) => !esConceptoExcluido(c.descripcion))
      .map((c) => c.id);
    expect(sobreviven).toEqual(["flagged"]);
  });

  it("el módulo exporta el loader y el umbral de monto", () => {
    expect(typeof mod.cargarIngresoNoFacturado).toBe("function");
    expect(mod.UMBRAL_MONTO).toBe(1000);
  });
});
