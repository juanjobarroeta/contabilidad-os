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
  gastos: { total: 0, lineas: [], sinClasificar: { facturas: 0, monto: 0 }, anticipos: { facturas: 0, monto: 0 }, isan: { facturas: 0, monto: 0 } },
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
    const r = armar(base({ nomina: [nom("VENTAS", 10_000), nom("ADMIN", 30_000)], gastos: { total: 20_000, lineas: [], sinClasificar: { facturas: 0, monto: 0 }, anticipos: { facturas: 0, monto: 0 }, isan: { facturas: 0, monto: 0 } } }));
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
        gastos: { total: 50_000, lineas: [], sinClasificar: { facturas: 0, monto: 0 }, anticipos: { facturas: 0, monto: 0 }, isan: { facturas: 0, monto: 0 } },
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

  it("ni el bono ni el UDI entran: los dos son front end", () => {
    const r = armar(
      base({
        nomina: [nom("ADMIN", 100_000)],
        otros: {
          total: 150_000,
          lineas: [
            { clave: "uso_instalaciones", nombre: "Comisiones de seguros (UDI)", importe: 50_000, conceptos: 3 },
            { clave: "bonos", nombre: "Bonos y apoyos del distribuidor", importe: 100_000, conceptos: 7 },
          ],
        },
      })
    );
    // Los dos suman a la utilidad bruta: no tienen costo directo…
    expect(r.totales.utilidadBruta).toBe(150_000);
    // …pero NINGUNO al back end. El UDI engaña por el nombre («uso de
    // instalaciones») y en realidad es comisión por colocar pólizas: si
    // entrara, la absorción diría 50% de un taller que no produjo nada.
    expect(r.absorcion.utilidadFixedOps).toBe(0);
    expect(r.absorcion.porcentaje).toBe(0);
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

describe("armar() — costo de refacciones no comparable (tambo vs litro)", () => {
  // Caso REAL de Margom: el aceite se compra por TAMBO (208 L) y se vende por
  // LITRO. El «último costo» es el del tambo, así que aplicarlo a los litros
  // que salen multiplica el costo por 208 y el estado de resultados reportó
  // −$838M de utilidad en una línea que en realidad gana ~30%.
  it("deja fuera del margen lo que no se puede costear, y lo reporta", () => {
    const r = armar(
      base({
        refaccionesRaw: [
          {
            en_orden: true,
            ingreso: 100_000, // salidas SÍ costeables
            costo: 70_000,
            piezas: 500,
            ingreso_sin_costo: 29_000, // lubricantes: unidad de compra ≠ venta
          },
        ],
      })
    );
    const linea = r.lineas.find((l) => l.clave === "refacciones_taller")!;
    expect(linea.ingreso).toBe(100_000);
    expect(linea.costo).toBe(70_000);
    expect(linea.utilidad).toBe(30_000);
    expect(linea.margen).toBe(30);
    // Lo no costeable no se inventa ni se esconde: se reporta aparte.
    expect(linea.ingresoSinCosto).toBe(29_000);
    expect(r.totales.ingresoSinCosto).toBe(29_000);
    // Y NUNCA produce una utilidad negativa absurda.
    expect(r.totales.utilidadBruta).toBe(30_000);
  });

  it("sin ingreso_sin_costo se comporta como antes", () => {
    const r = armar(
      base({ refaccionesRaw: [{ en_orden: false, ingreso: 1_000, costo: 600, piezas: 10 }] })
    );
    const linea = r.lineas.find((l) => l.clave === "refacciones_mostrador")!;
    expect(linea.utilidad).toBe(400);
    expect(linea.ingresoSinCosto).toBe(0);
  });
});

// ─── Ancla a la Contabilidad Electrónica ─────────────────────────────────────
// Una unidad sin CFDI de compra se vendió y se facturó: su ingreso es REAL.
// Dejarla fuera por los dos lados es lo que producía la brecha contra la
// balanza —−$188.1M de ingreso y −$178.6M de costo, casi cancelándose— y hacía
// que los libros dieran utilidad y el tablero pérdida.

describe("armar() — ancla a los libros", () => {
  const dos = [unidad(), unidad({ id: "v2", costoCompra: 0, precioVenta: 400_000 })];

  it("sin ancla se comporta igual que siempre", () => {
    const r = armar(base({ unidades: dos }));
    expect(r.lineas.find((l) => l.clave === "unidades_sin_cfdi_compra")).toBeUndefined();
    expect(r.totales.ingreso).toBe(300_000);
    expect(r.totales.ingresoSinCosto).toBe(400_000);
    expect(r.totales.ancla).toBeUndefined();
  });

  it("con ancla, la unidad sin CFDI entra con su ingreso y su costo por diferencia", () => {
    // Los libros dicen que el costo de ventas fue 570,000. Ya explicamos
    // 250,000 con CFDIs, así que los 320,000 restantes son de esa unidad.
    const r = armar(base({ unidades: dos, anclaCE: { costoDeVentas: 570_000 } }));
    const l = r.lineas.find((x) => x.clave === "unidades_sin_cfdi_compra")!;
    expect(l.ingreso).toBe(400_000);
    expect(l.costo).toBe(320_000);
    expect(l.utilidad).toBe(80_000);
    expect(l.unidades).toBe(1);
    expect(l.costoDesdeLibros).toBe(true);

    // El ingreso total ya incluye la venta que antes se caía.
    expect(r.totales.ingreso).toBe(700_000);
    // Y el costo total queda EXACTAMENTE sobre los libros: 250,000 + 320,000.
    const costoTotal = r.lineas.reduce((sum, x) => sum + x.costo, 0);
    expect(costoTotal).toBe(570_000);
  });

  it("los márgenes de las demás líneas no se contaminan", () => {
    const r = armar(base({ unidades: dos, anclaCE: { costoDeVentas: 570_000 } }));
    const nuevas = r.lineas.find((l) => l.clave === "unidades_nuevas")!;
    // Sigue midiendo sólo lo que tiene su costo real: 300,000 − 250,000.
    expect(nuevas.ingreso).toBe(300_000);
    expect(nuevas.utilidad).toBe(50_000);
    expect(nuevas.margen).toBeCloseTo(16.67, 1);
  });

  it("no cuenta dos veces el ingreso sin costo", () => {
    const r = armar(base({ unidades: dos, anclaCE: { costoDeVentas: 570_000 } }));
    // Ya entró en su propia línea; seguir reportándolo como «se quedó fuera»
    // haría que quien sume las dos cosas lo contara dos veces.
    expect(r.totales.ingresoSinCosto).toBe(0);
  });

  it("un residuo NEGATIVO se reporta como está, no se recorta a cero", () => {
    // Los libros registran MENOS costo del que ya atribuimos: eso no es el
    // costo de esas unidades, es un descuadre, y esconderlo sería fingir que
    // cuadra. Aquí se ve.
    const r = armar(base({ unidades: dos, anclaCE: { costoDeVentas: 200_000 } }));
    const l = r.lineas.find((x) => x.clave === "unidades_sin_cfdi_compra")!;
    expect(l.costo).toBe(-50_000);
  });

  it("deja auditables las tres cifras con las que se armó", () => {
    const r = armar(base({ unidades: dos, anclaCE: { costoDeVentas: 570_000 } }));
    expect(r.totales.ancla).toEqual({
      costoDeVentasLibros: 570_000,
      costoExplicadoPorCfdis: 250_000,
      ingresoSinCfdiDeCompra: 400_000,
    });
  });
});

// ─── El ancla sólo vale con la apertura DEL CIERRE ───────────────────────────
// El guard original miraba el AÑO de la apertura pero no el MES. La apertura de
// MARGOM viene de la balanza de junio de 2026 (fechada 2026-07-01), así que
// empataba con `year: 2026` al pedir el ejercicio 2025 y le colgaba a 2025 el
// costo acumulado de enero–junio de 2026: $510,100,635.37 contra ~$1,732,595,264
// propios, o sea un residuo de −$1,222,494,629. Un costo negativo de mil
// doscientos millones se presenta como UTILIDAD.

describe("armar() — el ancla con residuo negativo grande", () => {
  it("un costo por diferencia NEGATIVO se ve como tal, no se disfraza de utilidad", () => {
    // Los libros dicen 100,000 de costo pero ya atribuimos 900,000 con CFDIs:
    // eso no es el costo de esas unidades, es un descuadre de −800,000.
    const r = armar(
      base({
        unidades: [unidad({ costoCompra: 900_000, precioVenta: 1_000_000 })],
        anclaCE: { costoDeVentas: 100_000 },
      }),
    );
    const l = r.lineas.find((x) => x.clave === "unidades_sin_cfdi_compra")!;
    expect(l.costo).toBe(-800_000);
    // Y queda auditable de dónde salió, en vez de aparecer como margen.
    expect(r.totales.ancla).toEqual({
      costoDeVentasLibros: 100_000,
      costoExplicadoPorCfdis: 900_000,
      ingresoSinCfdiDeCompra: 0,
    });
  });
});
