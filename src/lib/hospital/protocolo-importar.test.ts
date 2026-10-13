import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { indexar } from "./cotizacion-competencia";
import { categoriaDeSeccion, emparejarTabla, hojasDeArchivo, leerHoja, leerTablas, type Hoja } from "./protocolo-importar";

const _ = null;
// Forma de la hoja «Rinoplastia» del hospital: título, bloque sin sección, INSUMOS con encabezado repetido,
// columna «CUENTA REAL» a la derecha, TOTAL C/IVA sin descripción y PAQUETE abajo.
const rino: Hoja = {
  nombre: "Rinoplastia",
  filas: [
    [_, "PROCEDIMIENTO: RINOPLASTIA PRIMARIA ", _, _, _, _],
    [_, "DESCRIPCIÓN", "CANTIDAD", "PRECIO", "IMPORTE", "CUENTA REAL"],
    [_, "Sala de quirófano por hora", 2, 4280.21, 8560.42, 17120.84],
    [_, "Oxígeno por hora", 6, 212.04, 1272.24, 1272.24],
    [_, "INSUMOS", _, _, _, _],
    [_, "DESCRIPCIÓN", "CANTIDAD", "PRECIO", "IMPORTE", _],
    [_, "Jeringa desechable 10ml", 1, 24.04, 24.04, 24.04],
    [_, "Paquete de cabeza y cuello", 1, _, 0, 0],
    [_, "TOTAL INSUMOS ", _, _, 24.04, _],
    [_, "HOSPITALIZACION", _, _, _, _],
    [_, "Habitación estandar estancia ambulatoria ", 1, 2477.75, 2477.75, 2477.75],
    [_, _, _, "TOTAL C/IVA", 12334.45, 35672.04],
    [_, _, _, _, "PAQUETE ", 18000],
  ],
};

describe("leerHoja", () => {
  it("título, secciones, precios, total, paquete y quirófano", () => {
    const t = leerHoja(rino);
    expect(t).toMatchObject({ clave: "RINOPLASTIA", nombre: "Rinoplastia primaria", totalConIva: 12334.45, precioPaquete: 18000, tipoEpisodio: "AMBULATORIO", quirofanoMinutos: 120 });
    expect(t.renglones.map((r) => [r.descripcion, r.cantidad, r.precio, r.categoria])).toEqual([
      ["Sala de quirófano por hora", 2, 4280.21, "QUIROFANO"],
      ["Oxígeno por hora", 6, 212.04, "QUIROFANO"],
      ["Jeringa desechable 10ml", 1, 24.04, "MATERIAL"],
      ["Paquete de cabeza y cuello", 1, null, "MATERIAL"],
      ["Habitación estandar estancia ambulatoria", 1, 2477.75, "HABITACION"],
    ]);
  });

  it("sin título usa la hoja; estancia completa = hospitalización; lo que sigue al gran total no entra", () => {
    const t = leerHoja({
      nombre: "ABCESO Y TRAQUEOTOMII",
      filas: [
        [_, _, "QUIRÓFANO", _, _, _],
        [_, _, "DESCRIPCIÓN", "CANTIDAD", "PRECIO", "IMPORTE"],
        [_, _, "Sala de quirófano por hora", 3, 4280.21, 12840.63],
        [_, _, "HOSPITALIZACION", _, _, _],
        [_, _, "DESCRIPCIÓN", "CANTIDAD", "PRECIO", "IMPORTE"],
        [_, _, "Habitación estándar estancia completa ", 3, 4605.2, 13815.6],
        [_, _, _, _, _, 38798.48],
        [_, _, "BH", 335.58, _, _],
      ],
    });
    expect(t).toMatchObject({ nombre: "Abceso y traqueotomii", tipoEpisodio: "HOSPITALIZACION", estanciaNoches: 3, quirofanoMinutos: 180 });
    expect(t.renglones.map((r) => r.descripcion)).toEqual(["Sala de quirófano por hora", "Habitación estándar estancia completa"]);
  });

  it("dos hojas con el mismo título se distinguen por la hoja", () => {
    const otra = { ...rino, nombre: "Rinoplastia AMB" };
    expect(leerTablas([rino, otra]).map((t) => [t.clave, t.nombre])).toEqual([
      ["RINOPLASTIA", "Rinoplastia primaria · Rinoplastia"],
      ["RINOPLASTIA-AMB", "Rinoplastia primaria · Rinoplastia AMB"],
    ]);
  });
});

describe("categoriaDeSeccion", () => {
  it("normaliza las secciones de la hoja", () => {
    expect(["QUIRÓFANO", "INSUMOS", "MEDICAMENTOS", "HOSPITALIZACION", "LABORATORIO CLÍNICO", null].map(categoriaDeSeccion))
      .toEqual(["QUIROFANO", "MATERIAL", "FARMACIA", "HABITACION", "ESTUDIO", "QUIROFANO"]);
  });
});

describe("emparejarTabla", () => {
  it("liga con el tarifario lo que gana con claridad", () => {
    const indice = indexar([
      { id: "qx", clave: "QX01", nombre: "Sala de quirófano por hora", categoria: "QUIROFANO", precio: 3689.84, ivaTasa: 0.16 },
      { id: "j10", clave: "J10", nombre: "Jeringa desechable 10 ml", categoria: "MATERIAL", precio: 20.72, ivaTasa: 0.16 },
    ]);
    const p = emparejarTabla(leerHoja(rino), indice);
    expect(p.map((x) => x.servicioId)).toEqual(["qx", null, "j10", null, null]);
  });
});

describe("hojasDeArchivo", () => {
  it("lee un xlsx de verdad", () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rino.filas), "Rinoplastia");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const [t] = leerTablas(hojasDeArchivo(buf));
    expect(t).toMatchObject({ nombre: "Rinoplastia primaria", precioPaquete: 18000 });
    expect(t.renglones).toHaveLength(5);
  });
});
