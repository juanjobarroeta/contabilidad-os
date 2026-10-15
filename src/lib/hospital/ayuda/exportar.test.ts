import { beforeAll, describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { exportacionDelModelo, firmarExportacion, hojasDeResultado, leerExportacion, xlsxDeResultado } from "./exportar";

beforeAll(() => { process.env.AUTH_SECRET ??= "secreto-de-prueba"; });

describe("enlace firmado", () => {
  it("ida y vuelta; alterado o vencido no sirve", () => {
    const qs = new URLSearchParams(firmarExportacion({ companyId: "c1", userId: "u1", herramienta: "insumos_por_caducar", parametros: { dias: 90 } }, 1000));
    expect(leerExportacion(qs.get("d"), qs.get("t"), 2000)).toEqual({ companyId: "c1", userId: "u1", herramienta: "insumos_por_caducar", parametros: { dias: 90 } });
    const otra = new URLSearchParams(firmarExportacion({ companyId: "c2", userId: "u1", herramienta: "insumos_por_caducar", parametros: {} }, 1000));
    expect(leerExportacion(otra.get("d"), qs.get("t"), 2000)).toBeNull();
    expect(leerExportacion(qs.get("d"), qs.get("t"), 1000 + 25 * 3600e3)).toBeNull();
    expect(leerExportacion(null, null)).toBeNull();
  });
});

describe("lo que pide el modelo", () => {
  it("sólo herramientas conocidas y parámetros planos", () => {
    expect(exportacionDelModelo({ herramienta: "insumos_por_caducar", parametros: { dias: 30, x: { a: 1 } } })).toEqual({ herramienta: "insumos_por_caducar", parametros: { dias: 30 } });
    expect(exportacionDelModelo({ herramienta: "borrar_todo" })).toBeNull();
    expect(exportacionDelModelo(null)).toBeNull();
  });
});

describe("hojas del Excel", () => {
  it("lotes por caducar: una hoja con títulos en español", () => {
    const h = hojasDeResultado({ dias: 90, lotes: [{ clave: "A1", nombre: "Paracetamol", lote: "L1", caducidad: "2026-11-01", diasParaCaducar: 17, existencia: 30, unidad: "pz" }] });
    expect(h).toHaveLength(1);
    expect(h[0].nombre).toBe("Lotes");
    expect(h[0].filas[0]).toMatchObject({ Clave: "A1", "Días para caducar": 17, Existencia: 30 });
  });
  it("inventario: una fila por lote con los datos del insumo; listas dentro de objetos", () => {
    const h = hojasDeResultado({
      encontrados: 1,
      insumos: [{ clave: "A1", nombre: "Paracetamol", existencia: 50, bajoMinimo: false, lotes: [{ lote: "L1", existencia: 20 }, { lote: "L2", existencia: 30 }] }],
      facturasRecibidas: { porProveedor: [{ proveedor: "X", totalConIva: 100 }], total: 100 },
    });
    expect(h.map((x) => x.nombre)).toEqual(["Inventario", "Facturas recibidas"]);
    expect(h[0].filas).toHaveLength(2);
    expect(h[0].filas[1]).toMatchObject({ Clave: "A1", Lote: "L2", Existencia: 30, "Bajo mínimo": "No" });
  });
  it("arma un XLSX legible (y uno vacío dice «Sin resultados»)", () => {
    const wb = XLSX.read(xlsxDeResultado({ lotes: [{ clave: "A1", existencia: 3 }] }));
    expect(wb.SheetNames).toEqual(["Lotes"]);
    const vacio = XLSX.read(xlsxDeResultado({ lotes: [] }));
    expect(vacio.SheetNames).toEqual(["Resultado"]);
  });
});
