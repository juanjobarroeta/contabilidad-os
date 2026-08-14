import { describe, it, expect } from "vitest";
import { revertirDerivadosDeCancelada } from "./revertir-cancelada";

// ─────────────────────────────────────────────────────────────────────────────
// Cancelar un CFDI sólo cambiaba `Invoice.status`. El motor fiscal aguanta
// porque filtra al leer, pero la capa de operación materializa filas y ningún
// filtro deshace una fila escrita: en MARGOM quedaron 3,699 canceladas con todo
// su efecto vivo. Estos casos fijan qué se revierte y qué NO.
// ─────────────────────────────────────────────────────────────────────────────

const INV = "inv-cancelada";

/** Prisma-client mínimo en memoria: sólo lo que usa la reversión. */
function fakeDb(seed: {
  vehiculos?: Array<Record<string, unknown>>;
  costos?: Array<Record<string, unknown>>;
  movimientos?: Array<Record<string, unknown>>;
  servicios?: Array<Record<string, unknown>>;
  nomina?: Array<Record<string, unknown>>;
} = {}) {
  const vehiculos = seed.vehiculos ?? [];
  let costos = seed.costos ?? [];
  let movimientos = seed.movimientos ?? [];
  let servicios = seed.servicios ?? [];
  let nomina = seed.nomina ?? [];

  const coincide = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => row[k] === v);

  const tabla = <T extends Record<string, unknown>>(
    get: () => T[],
    set: (v: T[]) => void,
  ) => ({
    findMany: async ({ where }: any) => get().filter((r) => coincide(r, where)),
    deleteMany: async ({ where }: any) => {
      const antes = get().length;
      set(get().filter((r) => !coincide(r, where)));
      return { count: antes - get().length };
    },
  });

  const db: any = {
    _vehiculos: vehiculos,
    get _costos() { return costos; },
    get _movimientos() { return movimientos; },
    get _servicios() { return servicios; },
    get _nomina() { return nomina; },
    vehiculo: {
      findMany: async ({ where }: any) => vehiculos.filter((v) => coincide(v, where)),
      updateMany: async ({ where, data }: any) => {
        let n = 0;
        for (const v of vehiculos) {
          if (coincide(v, where)) { Object.assign(v, data); n++; }
        }
        return { count: n };
      },
    },
    vehiculoCosto: tabla(() => costos, (v) => { costos = v; }),
    refaccionMovimiento: tabla(() => movimientos, (v) => { movimientos = v; }),
    servicioVenta: tabla(() => servicios, (v) => { servicios = v; }),
    nominaCosto: tabla(() => nomina, (v) => { nomina = v; }),
    $transaction: async (fn: any) => fn(db),
  };
  return db;
}

describe("revertirDerivadosDeCancelada", () => {
  it("una VENTA cancelada devuelve la unidad al piso", () => {
    const db = fakeDb({
      vehiculos: [
        { id: "v1", ventaInvoiceId: INV, estado: "VENDIDO", precioVenta: 326_724.14, fechaVenta: new Date(), clienteId: "c1", costoCompra: 270_000 },
      ],
    });
    return revertirDerivadosDeCancelada(db, INV).then((r) => {
      expect(r.ventas).toEqual({ unidades: 1, ingresoLiberado: 326_724.14 });
      const v = db._vehiculos[0];
      expect(v.estado).toBe("DISPONIBLE");
      expect(v.ventaInvoiceId).toBeNull();
      expect(v.precioVenta).toBeNull();
      expect(v.clienteId).toBeNull();
      // El COSTO de compra no se toca: esa compra sigue siendo válida.
      expect(v.costoCompra).toBe(270_000);
      expect(r.huboCambios).toBe(true);
    });
  });

  it("una COMPRA cancelada deja la unidad SIN borrarla, con costo en cero", async () => {
    const db = fakeDb({
      vehiculos: [{ id: "v1", compraInvoiceId: INV, costoCompra: 445_700.05, ventaInvoiceId: null }],
    });
    const r = await revertirDerivadosDeCancelada(db, INV);
    expect(r.compras).toEqual({ unidades: 1, costoLiberado: 445_700.05 });
    // Casi siempre es refacturación: borrar la fila perdería el VIN y su
    // expediente, y el CFDI nuevo la vuelve a derivar con el costo correcto.
    expect(db._vehiculos).toHaveLength(1);
    expect(db._vehiculos[0].compraInvoiceId).toBeNull();
    expect(db._vehiculos[0].costoCompra).toBe(0);
  });

  it("CONSERVA los costos capturados a mano y borra sólo los derivados", async () => {
    const db = fakeDb({
      costos: [
        { id: "c1", invoiceId: INV, monto: 11_732.86, autoCreado: true },
        { id: "c2", invoiceId: INV, monto: 5_000, autoCreado: true },
        { id: "c3", invoiceId: INV, monto: 9_999, autoCreado: false }, // lo teclearon
      ],
    });
    const r = await revertirDerivadosDeCancelada(db, INV);
    expect(r.costos).toEqual({ borrados: 2, monto: 16_732.86, conservadosManuales: 1 });
    // Nadie tecleó un costo para que una cancelación se lo lleve.
    expect(db._costos).toHaveLength(1);
    expect(db._costos[0].id).toBe("c3");
  });

  it("borra kardex, orden de servicio y nómina del CFDI", async () => {
    const db = fakeDb({
      movimientos: [
        { id: "m1", invoiceId: INV },
        { id: "m2", invoiceId: INV },
        { id: "m3", invoiceId: "otra" },
      ],
      servicios: [{ id: "s1", invoiceId: INV }],
      nomina: [{ id: "n1", invoiceId: INV }],
    });
    const r = await revertirDerivadosDeCancelada(db, INV);
    expect(r.refacciones.movimientos).toBe(2);
    expect(r.servicios.borrados).toBe(1);
    expect(r.nomina.borrados).toBe(1);
    // Lo de otras facturas queda intacto.
    expect(db._movimientos).toEqual([{ id: "m3", invoiceId: "otra" }]);
  });

  it("es idempotente: la segunda corrida no cambia nada", async () => {
    const db = fakeDb({
      vehiculos: [{ id: "v1", ventaInvoiceId: INV, estado: "VENDIDO", precioVenta: 300_000, costoCompra: 250_000 }],
      costos: [{ id: "c1", invoiceId: INV, monto: 1_000, autoCreado: true }],
    });
    const primera = await revertirDerivadosDeCancelada(db, INV);
    expect(primera.huboCambios).toBe(true);

    const segunda = await revertirDerivadosDeCancelada(db, INV);
    expect(segunda.huboCambios).toBe(false);
    expect(segunda.ventas.unidades).toBe(0);
    expect(segunda.costos.borrados).toBe(0);
    // Y la unidad sigue en piso, no se volvió a "revertir" a otro estado.
    expect(db._vehiculos[0].estado).toBe("DISPONIBLE");
  });

  it("no reporta cambios cuando el CFDI no derivó nada", async () => {
    const r = await revertirDerivadosDeCancelada(fakeDb(), INV);
    expect(r.huboCambios).toBe(false);
    expect(r.compras.unidades).toBe(0);
    expect(r.ventas.unidades).toBe(0);
  });
});
