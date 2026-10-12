import { describe, expect, it } from "vitest";
import { emparejar, fichas, indexar, limpiarLectura, normalizar, totalPropio, type ServicioTarifa } from "./cotizacion-competencia";

const s = (id: string, nombre: string, precio = 10, ivaTasa: number | null = 0.16): ServicioTarifa => ({ id, clave: id.toUpperCase(), nombre, categoria: "INSUMO", precio, ivaTasa });

const TARIFA = [
  s("j3", "Jeringa de plástico 3 ml"),
  s("j5", "Jeringa de plástico 5 ml"),
  s("j20", "Jeringa de plástico 20 ml sin aguja"),
  s("cef", "Ceftriaxona 1 g IV", 180, 0),
  s("hab", "Habitación estándar", 2500),
  s("qx", "Derecho de quirófano", 6000),
  s("hq", "Hora subsecuente de quirófano", 1500),
  s("gm", "Guante mediano estéril desechable"),
  s("gg", "Guante grande estéril desechable"),
];
const idx = indexar(TARIFA);

describe("normalización", () => {
  it("quita acentos, conserva Ñ y decimales, separa puntuación", () => {
    expect(normalizar("Pañal  GEL, Sol. 0,9% (Baxter)")).toBe("PAÑAL GEL SOL 0.9 BAXTER");
    expect(normalizar("TUBO 8.0MM 10x10")).toBe("TUBO 8.0 MM 10 X 10");
    expect(fichas("JERINGAS de plástico 3 ML")).toEqual(["JERINGA", "PLASTICO", "3", "ML"]);
  });
});

describe("emparejar", () => {
  it("la presentación cuenta: 3 ml no es 5 ml", () => {
    expect(emparejar("JERINGA DE PLASTICO 3 ML", idx).servicioId).toBe("j3");
    expect(emparejar("JERINGA DE PLASTICO 20ML SIN AGUJA", idx).servicioId).toBe("j20");
    expect(emparejar("JERINGA DE PLASTICO 10 ML CON AGUJA", idx).servicioId).toBeNull();
  });

  it("acentos y mayúsculas no importan", () => {
    expect(emparejar("HABITACION ESTANDAR", idx).servicioId).toBe("hab");
    expect(emparejar("CEFTRIAXONA 1 G IV PISA", idx).servicioId).toBe("cef");
  });

  it("si dos quedan parejos no se da por firme, pero van de candidatos", () => {
    const r = emparejar("GUANTE ESTERIL DESECHABLE AMBIDERM", idx);
    expect(r.servicioId).toBeNull();
    expect(r.candidatos.map((c) => c.id).sort()).toEqual(["gg", "gm"]);
  });

  it("sin nada en común no propone", () => {
    expect(emparejar("KIT DE BIENVENIDA", idx)).toEqual({ candidatos: [], servicioId: null });
  });
});

describe("limpiarLectura", () => {
  it("normaliza tipos, grupos y descarta renglones vacíos", () => {
    const l = limpiarLectura({
      procedimiento: "MIOMECTOMIA LAPAROSCOPICA",
      total: "$25,700.00",
      totalIncluyeIva: true,
      renglones: [
        { cantidad: 3, descripcion: "JERINGA  DE PLASTICO 3 ML", grupo: "insumos", precioUnitario: null },
        { cantidad: "2", descripcion: "SOLUCION HARTMAN 1000 ML", grupo: "Soluciones" },
        { cantidad: 1, descripcion: "  ", grupo: "INSUMOS" },
        { descripcion: "KIT DE BIENVENIDA", grupo: "lo que sea" },
      ],
    });
    expect(l.total).toBe(25700);
    expect(l.renglones).toEqual([
      { cantidad: 3, descripcion: "JERINGA DE PLASTICO 3 ML", grupo: "INSUMOS", precioUnitario: null, importe: null },
      { cantidad: 2, descripcion: "SOLUCION HARTMAN 1000 ML", grupo: "SOLUCIONES", precioUnitario: null, importe: null },
      { cantidad: 1, descripcion: "KIT DE BIENVENIDA", grupo: "OTRO", precioUnitario: null, importe: null },
    ]);
  });

  it("basura → lectura vacía", () => {
    expect(limpiarLectura(null).renglones).toEqual([]);
  });
});

describe("totalPropio", () => {
  it("suma con IVA por servicio y cuenta los que no tienen precio", () => {
    const r = totalPropio([
      { cantidad: 3, servicio: TARIFA[0] },
      { cantidad: 3, servicio: TARIFA[3] },
      { cantidad: 1, servicio: null },
    ]);
    expect(r).toEqual({ total: 34.8 + 540, conPrecio: 2, sinPrecio: 1 });
  });
});
