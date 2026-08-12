import { describe, it, expect } from "vitest";
import { armarCobertura, type FilaCobertura } from "./cobertura";
import { prepararReglas, type ReglaAplicable } from "./reglas";

// ─────────────────────────────────────────────────────────────────────────────
// El reporte de cobertura existe para NO esconder dinero. Cada caso de aquí es
// una forma conocida de esconderlo: repartir el residuo, contarlo dos veces,
// disfrazarlo de «Otros gastos», o dividir entre un neto que las notas de
// crédito dejaron en cero.
// ─────────────────────────────────────────────────────────────────────────────

const fila = (o: Partial<FilaCobertura> = {}): FilaCobertura => ({
  bucket: "pendiente", tipo: "INGRESO", clave: "", patron: "",
  muestra: null, facturas: 1, monto: 0, ...o,
});

const reglas = (...rs: Partial<ReglaAplicable>[]) =>
  prepararReglas(
    rs.map((r, i) => ({
      id: `r${i}`, ambito: "INGRESO", clavePrefijo: null, patron: null,
      destino: "otros_ingresos", etiqueta: "Otros", ...r,
    }))
  );

describe("armarCobertura() — el residuo se reporta, no se reparte", () => {
  it("lo que ninguna regla clasifica queda en «pendiente» y sale como cluster", () => {
    const r = armarCobertura(
      [
        fila({ bucket: "unidad_venta", monto: 1_000_000, facturas: 4 }),
        fila({ clave: "95121600", patron: "CONCEPTO RARO #", muestra: "CONCEPTO RARO 42", monto: 250_000 }),
      ],
      []
    );
    expect(r.ingresos.total).toBe(1_250_000);
    expect(r.ingresos.cubierto).toBe(1_000_000);
    expect(r.ingresos.pendiente).toBe(250_000);
    expect(r.ingresos.pct).toBe(80);
    // El residuo NO se sumó a la venta de unidades.
    const venta = r.ingresos.lineas.find((l) => l.bucket === "unidad_venta")!;
    expect(venta.monto).toBe(1_000_000);
    // …y sale accionable, con su muestra legible.
    expect(r.clusters).toHaveLength(1);
    expect(r.clusters[0].muestra).toBe("CONCEPTO RARO 42");
    expect(r.clusters[0].monto).toBe(250_000);
  });

  it("«Otros gastos» del catálogo NO cuenta como cobertura", () => {
    // classifyEgreso siempre responde algo: cuando no reconoce la clave devuelve
    // «Otros gastos». Si eso contara como clasificado, el residuo desaparecería
    // detrás de un renglón con nombre respetable — que es exactamente como se
    // pierde de vista.
    const r = armarCobertura(
      [fila({ tipo: "EGRESO", clave: "99999999", muestra: "ALGO NO RECONOCIDO", monto: 500_000 })],
      []
    );
    expect(r.egresos.pendiente).toBe(500_000);
    expect(r.egresos.pct).toBe(0);
  });

  it("una clave que el catálogo SÍ reconoce sí cuenta como cobertura", () => {
    // 78 = transporte y logística → fletes y acarreos.
    const r = armarCobertura(
      [fila({ tipo: "EGRESO", clave: "78181500", muestra: "FLETE FORÁNEO", monto: 90_000 })],
      []
    );
    expect(r.egresos.pendiente).toBe(0);
    expect(r.egresos.pct).toBe(100);
  });

  it("8014xx que no empata ni con bono ni con UDI vuelve a la cola, no a «otros»", () => {
    // clasificarIngreso devuelve «otros» cuando ninguna de las dos regex empata.
    // Ese «otros» es el residuo con otro nombre: si lo diéramos por clasificado,
    // el cluster más grande del ejercicio no aparecería nunca en la cola.
    const r = armarCobertura(
      [fila({ clave: "80141600", patron: "SERVICIO DE GESTION", muestra: "SERVICIO DE GESTION", monto: 44_000_000 })],
      []
    );
    expect(r.ingresos.pendiente).toBe(44_000_000);
    expect(r.clusters[0].clave).toBe("80141600");
  });

  it("el bono sí se clasifica solo: el catálogo genérico ya lo reconoce", () => {
    const r = armarCobertura(
      [fila({ clave: "80141600", muestra: "BONO FLOTILLAS ABRIL", monto: 52_700_000 })],
      []
    );
    expect(r.ingresos.pendiente).toBe(0);
    expect(r.ingresos.lineas[0].bucket).toBe("otros_ingresos");
  });
});

describe("armarCobertura() — reglas confirmadas por la agencia", () => {
  it("una regla confirmada saca al cluster de la cola", () => {
    // Ojo con la muestra: «apoyo» ya lo caza la regex de bonos del catálogo
    // genérico, así que no serviría para probar la regla de la agencia.
    const filas = [fila({ clave: "80141625", patron: "PUBLICIDAD COOPERATIVA #", muestra: "PUBLICIDAD COOPERATIVA 2026", monto: 3_000_000 })];
    // Sin regla: pendiente.
    expect(armarCobertura(filas, []).ingresos.pendiente).toBe(3_000_000);
    // Con regla: clasificado, y ya no aparece como trabajo por hacer.
    const r = armarCobertura(filas, reglas({ clavePrefijo: "8014", patron: "PUBLICIDAD COOPERATIVA" }));
    expect(r.ingresos.pendiente).toBe(0);
    expect(r.clusters).toHaveLength(0);
    expect(r.reglasActivas).toBe(1);
  });

  it("gana la regla MÁS específica, sin importar en qué orden se capturó", () => {
    const filas = [fila({ clave: "80141600", muestra: "UDI GNP MARZO", monto: 1_000 })];
    const r = armarCobertura(
      filas,
      reglas(
        { clavePrefijo: "80", destino: "otros_ingresos", etiqueta: "Genérica" },
        { clavePrefijo: "80141600", patron: "UDI", destino: "gasto", etiqueta: "Específica" }
      )
    );
    // La específica manda: el renglón es «gasto», no «otros_ingresos».
    expect(r.ingresos.lineas[0].bucket).toBe("gasto");
  });

  it("una regla de texto NO puede reclamar un bucket derivado", () => {
    // Si un CFDI es venta de unidad lo decide la unidad ligada, no una frase en
    // la descripción: si no, cualquiera podría inflar las ventas escribiendo
    // «VENTA DE VEHICULO» en un concepto de refacciones.
    const r = armarCobertura(
      [fila({ clave: "25101500", muestra: "VENTA DE VEHICULO (TEXTO)", monto: 400_000 })],
      reglas({ clavePrefijo: "2510", destino: "unidad_venta", etiqueta: "Trampa" })
    );
    expect(r.ingresos.pendiente).toBe(400_000);
  });

  it("una regla con destino desconocido no inventa un renglón sin nombre", () => {
    const r = armarCobertura(
      [fila({ clave: "80141600", muestra: "LO QUE SEA", monto: 1_000 })],
      reglas({ clavePrefijo: "8014", destino: "bucket_que_no_existe", etiqueta: "Rota" })
    );
    expect(r.ingresos.pendiente).toBe(1_000);
  });

  it("una regla con patrón que no compila se descarta: falla a NO aplicar", () => {
    const r = armarCobertura(
      [fila({ clave: "80141600", muestra: "SERVICIO DE GESTION", monto: 1_000 })],
      reglas({ clavePrefijo: "8014", patron: "((((" })
    );
    // Si la regla rota sobreviviera sin regex, empataría sólo por clave y
    // clasificaría de MÁS. El modo de fallar correcto es no aplicar.
    expect(r.ingresos.pendiente).toBe(1_000);
  });
});

describe("armarCobertura() — aritmética honesta", () => {
  it("el porcentaje se mide contra la magnitud FACTURADA, no contra el neto", () => {
    // Mes que emitió $1M y canceló $1M: el neto de la línea es cero. Medir
    // contra ese cero diría «no aplica» cuando sí se facturaron $2M que hay que
    // explicar — y dividir entre él daría Infinity.
    const r = armarCobertura(
      [
        fila({ bucket: "unidad_venta", monto: 1_000_000 }),
        fila({ bucket: "unidad_venta", monto: -1_000_000 }),
      ],
      []
    );
    expect(r.ingresos.total).toBe(0);
    expect(Number.isFinite(r.ingresos.pct!)).toBe(true);
    // Nada quedó sin explicar, aunque la línea neteara a cero.
    expect(r.ingresos.pct).toBe(100);
  });

  it("la cancelación no esconde el residuo: $2M facturados, $1M sin clasificar", () => {
    const r = armarCobertura(
      [
        fila({ bucket: "unidad_venta", monto: 1_000_000 }),
        fila({ bucket: "unidad_venta", monto: -1_000_000 }),
        fila({ clave: "99999999", muestra: "RARO", monto: 1_000_000 }),
      ],
      []
    );
    // Magnitud facturada = 3M; sin clasificar = 1M → 66.67% de cobertura.
    expect(r.ingresos.pct).toBe(66.67);
    expect(r.ingresos.pendiente).toBe(1_000_000);
  });

  it("sin nada facturado no se reporta 0% de cobertura: se reporta que no aplica", () => {
    const r = armarCobertura([], []);
    expect(r.ingresos.pct).toBeNull();
    expect(r.egresos.pct).toBeNull();
  });

  it("los clusters se ordenan por peso ABSOLUTO", () => {
    // Una nota de crédito de $40M sin clasificar importa tanto como un ingreso
    // de $40M sin clasificar; ordenar con signo la mandaría al final.
    const r = armarCobertura(
      [
        fila({ clave: "1", muestra: "chico", monto: 5_000 }),
        fila({ clave: "2", muestra: "NC grande", monto: -40_000_000 }),
        fila({ clave: "3", muestra: "grande", monto: 1_000_000 }),
      ],
      []
    );
    expect(r.clusters.map((c) => c.muestra)).toEqual(["NC grande", "grande", "chico"]);
  });

  it("recorta la cola larga pero reporta cuántos clusters hay de verdad", () => {
    const filas = Array.from({ length: 120 }, (_, i) =>
      fila({ clave: String(i), muestra: `C${i}`, monto: 1_000 - i })
    );
    const r = armarCobertura(filas, [], { maxClusters: 10 });
    expect(r.clusters).toHaveLength(10);
    // Un recorte silencioso se lee como «ya no hay más trabajo»: se dice.
    expect(r.clustersTotales).toBe(120);
    // …y el monto pendiente sigue siendo el TOTAL, no el de los 10 mostrados.
    expect(r.ingresos.pendiente).toBe(filas.reduce((s, f) => s + f.monto, 0));
  });

  it("un CFDI cuenta en UN bucket: el reporte no lo duplica", () => {
    // La factura de taller con refacciones ya viene resuelta como «servicio»
    // desde el SQL (el CASE toma la primera coincidencia); aquí se fija que el
    // armado no la vuelve a sumar en refacciones.
    const r = armarCobertura([fila({ bucket: "servicio", monto: 200_000, facturas: 3 })], []);
    expect(r.ingresos.total).toBe(200_000);
    expect(r.ingresos.lineas).toHaveLength(1);
    expect(r.ingresos.lineas[0].facturas).toBe(3);
  });

  it("la nómina sin NominaCosto derivado sale como pendiente", () => {
    const r = armarCobertura(
      [
        fila({ bucket: "nomina", tipo: "NOMINA", monto: 900_000, facturas: 300 }),
        fila({ tipo: "NOMINA", clave: "84111505", muestra: "RECIBO", monto: 100_000, facturas: 40 }),
      ],
      []
    );
    expect(r.nomina.cubierto).toBe(900_000);
    expect(r.nomina.pendiente).toBe(100_000);
    expect(r.nomina.pct).toBe(90);
  });
});
