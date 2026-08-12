import { describe, it, expect } from "vitest";
import { armar, type InsumosResultados } from "./resultados";

// ─────────────────────────────────────────────────────────────────────────────
// El panel y el estado de resultados leen de aquí: si el armado se mueve, los
// dos tableros mienten a la vez. Casos fijos sobre el margen y la absorción.
// ─────────────────────────────────────────────────────────────────────────────

const unidad = (o: Partial<InsumosResultados["unidades"][0]> = {}) => ({
  id: "v1", vin: "VIN1", marca: "GM", modelo: "Aveo", anio: 2026,
  tipo: "NUEVO", fechaVenta: new Date("2026-07-10"), precioVenta: 300_000,
  costoCompra: 250_000, comisionMonto: 0, isan: 0, cliente: null, costos: [],
  ...o,
});

const base = (o: Partial<InsumosResultados> = {}): InsumosResultados => ({
  unidades: [],
  servicios: [],
  refaccionesRaw: [],
  nomina: [],
  nominaPorSucursal: [],
  gastos: { total: 0, lineas: [], sinClasificar: { facturas: 0, monto: 0 } },
  ...o,
});

const nom = (linea: string, percepciones: number, cuotas = 0, recibos = 1) => ({
  linea, _sum: { percepciones, cuotasPatronales: cuotas }, _count: { _all: recibos },
});

describe("armar() — margen por línea", () => {
  it("una unidad sin costo de compra queda FUERA del margen, no en cero", () => {
    const r = armar(base({ unidades: [unidad(), unidad({ id: "v2", costoCompra: 0, precioVenta: 400_000 })] }));
    const nuevas = r.lineas.find((l) => l.clave === "unidades_nuevas")!;
    expect(nuevas.unidades).toBe(2);
    expect(nuevas.sinCosto).toBe(1);
    // El ingreso de la unidad sin costo NO infla el margen…
    expect(nuevas.ingreso).toBe(300_000);
    expect(nuevas.utilidad).toBe(50_000);
    // …pero tampoco se esconde.
    expect(nuevas.ingresoSinCosto).toBe(400_000);
    expect(r.totales.ingresoSinCosto).toBe(400_000);
  });

  it("el costo de la mano de obra es la nómina del TALLER, no un estimado", () => {
    const r = armar(
      base({
        servicios: [{ fecha: new Date("2026-07-05"), manoObra: 100_000, refacciones: 40_000 }],
        nomina: [nom("TALLER", 60_000, 15_000, 8)],
      })
    );
    const mo = r.lineas.find((l) => l.clave === "mano_obra")!;
    expect(mo.costo).toBe(75_000); // percepciones + cuotas patronales estimadas
    expect(mo.utilidad).toBe(25_000);
    expect(mo.costoEsNomina).toBe(true);
  });

  it("la nómina que no produce baja a estructura, no al costo de una línea", () => {
    const r = armar(base({ nomina: [nom("VENTAS", 10_000), nom("ADMIN", 30_000)], gastos: { total: 20_000, lineas: [], sinClasificar: { facturas: 0, monto: 0 } } }));
    expect(r.estructura).toBe(60_000);
    expect(r.totales.utilidadBruta).toBe(0);
    expect(r.totales.utilidad).toBe(-60_000);
  });
});

describe("armar() — absorción de servicio", () => {
  it("100% es el punto donde el back end paga solo toda la estructura", () => {
    const r = armar(
      base({
        servicios: [{ fecha: new Date("2026-07-05"), manoObra: 100_000, refacciones: 0 }],
        refaccionesRaw: [{ en_orden: false, ingreso: 50_000, costo: 20_000, piezas: 10 }],
        nomina: [nom("TALLER", 40_000), nom("ADMIN", 40_000)],
        gastos: { total: 50_000, lineas: [], sinClasificar: { facturas: 0, monto: 0 } },
      })
    );
    // Fixed ops: (100k − 40k de taller) + (50k − 20k) = 90k. Estructura: 90k.
    expect(r.absorcion.utilidadFixedOps).toBe(90_000);
    expect(r.absorcion.estructura).toBe(90_000);
    expect(r.absorcion.porcentaje).toBe(100);
  });

  it("sin estructura no se reporta 0% ni infinito: se reporta que no se puede calcular", () => {
    const r = armar(base({ servicios: [{ fecha: new Date("2026-07-05"), manoObra: 10_000, refacciones: 0 }] }));
    expect(r.absorcion.porcentaje).toBeNull();
  });

  it("la venta de unidades NO entra en la absorción — sólo el back end", () => {
    const r = armar(
      base({
        unidades: [unidad({ precioVenta: 1_000_000, costoCompra: 500_000 })],
        nomina: [nom("ADMIN", 100_000)],
      })
    );
    expect(r.absorcion.utilidadFixedOps).toBe(0);
    expect(r.absorcion.porcentaje).toBe(0);
    // …aunque el mes haya sido muy bueno vendiendo coches.
    expect(r.totales.utilidad).toBe(400_000);
  });
});
