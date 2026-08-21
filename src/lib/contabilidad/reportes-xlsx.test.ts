import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { toXlsx } from "@/lib/export/xlsx";
import {
  clavePeriodo,
  etiquetaPeriodo,
  hojaAuxiliar,
  hojaBalanceGeneral,
  hojaBalanza,
  hojaEstadoResultados,
  hojaLibroDiario,
} from "./reportes-xlsx";
import type { BalanzaRow, EstadoResultados } from "./posting";
import type { AuxiliarCuenta, BalanceGeneral, PolizaVista } from "./libro";

/** Escribe la hoja y la lee de vuelta como matriz — así se ve el archivo real. */
function celdas(hoja: Parameters<typeof toXlsx>[0][number]): unknown[][] {
  const wb = XLSX.read(toXlsx([hoja]), { type: "buffer", cellDates: true });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: null });
}

const balanzaRow = (over: Partial<BalanzaRow>): BalanzaRow => ({
  cuentaSAT: "102", subcuenta: "102.01", nombre: "Bancos nacionales", tipo: "ACTIVO",
  naturaleza: "D", nivel: 3,
  cargos: 0, abonos: 0, saldo: 0, saldoInicial: 0, saldoFinal: 0, ...over,
});

describe("etiquetas de periodo", () => {
  it("etiquetaPeriodo es legible y clavePeriodo ordena", () => {
    expect(etiquetaPeriodo(2025, 7)).toBe("julio 2025");
    expect(clavePeriodo(2025, 7)).toBe("2025-07");
    // Ordenable: el mes de un dígito lleva cero.
    expect([clavePeriodo(2025, 10), clavePeriodo(2025, 7)].sort()).toEqual(["2025-07", "2025-10"]);
  });
});

describe("hojaBalanza", () => {
  it("los importes salen como números sumables, no como texto", () => {
    const filas = celdas(
      hojaBalanza([balanzaRow({ cargos: 1500.5, abonos: 300.25, saldoFinal: 1200.25 })])
    );
    expect(typeof filas[1][6]).toBe("number");
    expect(filas[1][6]).toBe(1500.5);
    expect(filas[1][8]).toBe(1200.25);
  });

  it("conserva una fila por cuenta con su encabezado", () => {
    const filas = celdas(hojaBalanza([balanzaRow({}), balanzaRow({ subcuenta: "201.01", nombre: "Proveedores" })]));
    expect(filas[0][0]).toBe("Cuenta");
    expect(filas).toHaveLength(3);
    expect(filas[2][2]).toBe("Proveedores");
  });

  it("una balanza vacía sigue produciendo encabezados", () => {
    expect(celdas(hojaBalanza([]))[0][0]).toBe("Cuenta");
  });
});

describe("hojaEstadoResultados", () => {
  const er: EstadoResultados = {
    ingresos: [{ seccion: "INGRESOS", cuentaSAT: "401", subcuenta: "401.01", nombre: "Ventas", monto: 1000 }],
    costos: [{ seccion: "COSTOS", cuentaSAT: "501", subcuenta: "501.01", nombre: "Costo de venta", monto: 400 }],
    gastos: [{ seccion: "GASTOS", cuentaSAT: "601", subcuenta: "601.01", nombre: "Sueldos", monto: 200 }],
    totalIngresos: 1000, totalCostos: 400, totalGastos: 200,
    utilidadBruta: 600, utilidadAntesImpuestos: 400,
  };

  it("presenta las tres secciones con sus totales", () => {
    const texto = celdas(hojaEstadoResultados(er)).map((f) => f.join("|")).join("\n");
    expect(texto).toMatch(/INGRESOS/);
    expect(texto).toMatch(/COSTOS/);
    expect(texto).toMatch(/GASTOS/);
    expect(texto).toMatch(/Utilidad bruta/);
    expect(texto).toMatch(/Utilidad antes de impuestos/);
  });

  it("los totales son los del motor, no recalculados aquí", () => {
    const filas = celdas(hojaEstadoResultados(er));
    const bruta = filas.find((f) => f[2] === "Utilidad bruta");
    const antes = filas.find((f) => f[2] === "Utilidad antes de impuestos");
    expect(bruta?.[3]).toBe(600);
    expect(antes?.[3]).toBe(400);
  });
});

describe("hojaBalanceGeneral", () => {
  const bg: BalanceGeneral = {
    activo: [{ cuenta: "102.01", nombre: "Bancos", monto: 1000 }],
    pasivo: [{ cuenta: "201.01", nombre: "Proveedores", monto: 300 }],
    capital: [{ cuenta: "301.01", nombre: "Capital social", monto: 500 }],
    totalActivo: 1000, totalPasivo: 300, totalCapital: 500,
    resultadoEnCurso: 200, descuadre: 0,
  };

  it("incluye el resultado en curso y el descuadre", () => {
    // Sin el renglón virtual la ecuación no cuadra antes del cierre y quien
    // revisa el archivo cree que el libro está mal.
    const filas = celdas(hojaBalanceGeneral(bg));
    const resultado = filas.find((f) => f[2] === "Resultado del ejercicio en curso");
    const suma = filas.find((f) => f[2] === "Suma pasivo + capital + resultado");
    const desc = filas.find((f) => f[2] === "Descuadre (activo − suma)");
    expect(resultado?.[3]).toBe(200);
    expect(suma?.[3]).toBe(1000); // 300 + 500 + 200 = activo
    expect(desc?.[3]).toBe(0);
  });
});

describe("hojaLibroDiario", () => {
  const poliza: PolizaVista = {
    folio: "Eg/2025/07/001", fecha: "2025-07-15", concepto: "Pago proveedor",
    fuente: "CFDI", referencia: "UUID-1", referenciaTipo: "CFDI",
    totalCargos: 100, totalAbonos: 100, cuadrada: true,
    transacciones: [
      { entryId: "e1", numCta: "201.01", desCta: "Proveedores", concepto: "Pago", cargo: 100, abono: 0 },
      { entryId: "e2", numCta: "102.01", desCta: "Bancos", concepto: "Pago", cargo: 0, abono: 100 },
    ],
  };

  it("emite una fila por MOVIMIENTO, no por póliza", () => {
    // Una fila por póliza sería más corta e inservible: el auditor filtra por
    // cuenta, y para eso la cuenta tiene que estar en la fila.
    const filas = celdas(hojaLibroDiario([poliza]));
    expect(filas).toHaveLength(3); // encabezado + 2 movimientos
    expect(filas[1][3]).toBe("201.01");
    expect(filas[2][3]).toBe("102.01");
  });

  it("repite el folio de póliza en cada movimiento del grupo", () => {
    const filas = celdas(hojaLibroDiario([poliza]));
    expect(filas[1][0]).toBe("Eg/2025/07/001");
    expect(filas[2][0]).toBe("Eg/2025/07/001");
  });

  it("cargos y abonos cuadran con los totales de la póliza", () => {
    const filas = celdas(hojaLibroDiario([poliza])).slice(1);
    const cargos = filas.reduce((s, f) => s + Number(f[6] ?? 0), 0);
    const abonos = filas.reduce((s, f) => s + Number(f[7] ?? 0), 0);
    expect(cargos).toBe(poliza.totalCargos);
    expect(abonos).toBe(poliza.totalAbonos);
  });
});

describe("hojaAuxiliar", () => {
  const aux: AuxiliarCuenta = {
    saldoInicial: 500,
    movimientos: [
      {
        entryId: "e1", fecha: "2025-07-03", folioPoliza: "Ig/2025/07/001", concepto: "Cobro",
        fuente: "BANCO", referencia: null, referenciaTipo: null, cargo: 200, abono: 0, saldo: 700,
      },
    ],
    totalCargos: 200, totalAbonos: 0, saldoFinal: 700,
  };

  it("el saldo inicial, el corrido y el final caen en la MISMA columna", () => {
    // Si no, la columna de saldo se lee con saltos y no sirve para revisar.
    const filas = celdas(hojaAuxiliar(aux, "102.01", "Bancos nacionales"));
    const col = filas[0].indexOf("Saldo");
    expect(filas.find((f) => f[2] === "Saldo inicial")?.[col]).toBe(500);
    expect(filas.find((f) => f[1] === "Ig/2025/07/001")?.[col]).toBe(700);
    expect(filas.find((f) => f[2] === "Totales")?.[col]).toBe(700);
  });

  it("identifica la cuenta dentro del archivo", () => {
    const texto = celdas(hojaAuxiliar(aux, "102.01", "Bancos nacionales")).map((f) => f.join("|")).join("\n");
    expect(texto).toMatch(/102\.01 — Bancos nacionales/);
  });

  it("el nombre de pestaña lleva la cuenta y es válido para Excel", () => {
    const hoja = hojaAuxiliar(aux, "102.01", "Bancos");
    expect(hoja.nombre).toContain("102.01");
    expect(hoja.nombre.length).toBeLessThanOrEqual(31);
  });
});
