// ─────────────────────────────────────────────────────────────────────────────
// Estados financieros → hojas de Excel.
//
// PURO: convierte lo que ya devuelven los motores (balanza, estado de
// resultados, balance general, libro diario, auxiliar) en hojas. No consulta
// nada ni recalcula contabilidad — si una cifra sale mal aquí, salía mal antes.
//
// Vive aparte de las rutas porque el paquete mensual arma las mismas hojas en
// un solo libro: la definición de "cómo se ve la balanza en Excel" existe una
// vez, no una por endpoint.
//
// Los importes van como NÚMERO, nunca como texto formateado: quien recibe el
// archivo lo primero que hace es sumar una columna.
// ─────────────────────────────────────────────────────────────────────────────

import type { HojaXlsx, XlsxRow } from "@/lib/export/xlsx";
import type { BalanzaRow, EstadoResultados } from "./posting";
import type { AuxiliarCuenta, BalanceGeneral, PolizaVista } from "./libro";

const MES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

/** "julio 2025" — para títulos de hoja y nombres de archivo. */
export function etiquetaPeriodo(year: number, month: number): string {
  return `${MES[month - 1] ?? month} ${year}`;
}

/** "2025-07" — para nombres de archivo que deben ordenar bien. */
export function clavePeriodo(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

export function hojaBalanza(rows: BalanzaRow[]): HojaXlsx {
  return {
    nombre: "Balanza",
    headers: [
      "Cuenta", "Subcuenta", "Nombre", "Tipo", "Nivel",
      "Saldo inicial", "Cargos", "Abonos", "Saldo final",
    ],
    anchos: [10, 12, 44, 10, 6, 15, 15, 15, 15],
    rows: rows.map((r) => [
      r.cuentaSAT, r.subcuenta, r.nombre, r.tipo, r.nivel,
      r.saldoInicial, r.cargos, r.abonos, r.saldoFinal,
    ]),
  };
}

export function hojaEstadoResultados(er: EstadoResultados): HojaXlsx {
  const rows: XlsxRow[] = [];
  const seccion = (titulo: string, filas: EstadoResultados["ingresos"], total: number) => {
    rows.push([titulo, null, null, null]);
    for (const f of filas) rows.push(["", f.subcuenta ?? f.cuentaSAT, f.nombre, f.monto]);
    rows.push(["", "", `Total ${titulo.toLowerCase()}`, total]);
    rows.push([null, null, null, null]);
  };

  seccion("INGRESOS", er.ingresos, er.totalIngresos);
  seccion("COSTOS", er.costos, er.totalCostos);
  rows.push(["", "", "Utilidad bruta", er.utilidadBruta]);
  rows.push([null, null, null, null]);
  seccion("GASTOS", er.gastos, er.totalGastos);
  rows.push(["", "", "Utilidad antes de impuestos", er.utilidadAntesImpuestos]);

  return {
    nombre: "Estado de resultados",
    headers: ["Sección", "Cuenta", "Concepto", "Importe"],
    anchos: [14, 12, 48, 16],
    rows,
  };
}

export function hojaBalanceGeneral(bg: BalanceGeneral): HojaXlsx {
  const rows: XlsxRow[] = [];
  const seccion = (titulo: string, filas: BalanceGeneral["activo"], total: number) => {
    rows.push([titulo, null, null, null]);
    for (const f of filas) rows.push(["", f.cuenta, f.nombre, f.monto]);
    rows.push(["", "", `Total ${titulo.toLowerCase()}`, total]);
    rows.push([null, null, null, null]);
  };

  seccion("ACTIVO", bg.activo, bg.totalActivo);
  seccion("PASIVO", bg.pasivo, bg.totalPasivo);
  seccion("CAPITAL", bg.capital, bg.totalCapital);
  // El resultado en curso va como renglón virtual: sin él la ecuación no cuadra
  // hasta el cierre anual, y quien revisa el archivo cree que hay un error.
  rows.push(["", "", "Resultado del ejercicio en curso", bg.resultadoEnCurso]);
  rows.push(["", "", "Suma pasivo + capital + resultado", bg.totalPasivo + bg.totalCapital + bg.resultadoEnCurso]);
  rows.push(["", "", "Descuadre (activo − suma)", bg.descuadre]);

  return {
    nombre: "Balance general",
    headers: ["Sección", "Cuenta", "Concepto", "Importe"],
    anchos: [14, 12, 48, 16],
    rows,
  };
}

/**
 * Libro diario: una fila por MOVIMIENTO, con el folio de póliza repetido.
 *
 * Un renglón por póliza sería más corto pero inservible — el auditor filtra por
 * cuenta, y para eso la cuenta tiene que estar en la fila.
 */
export function hojaLibroDiario(polizas: PolizaVista[]): HojaXlsx {
  const rows: XlsxRow[] = [];
  for (const p of polizas) {
    for (const t of p.transacciones) {
      rows.push([
        p.folio, p.fecha, p.concepto, t.numCta, t.desCta, t.concepto,
        t.cargo, t.abono, p.fuente, p.referenciaTipo, p.referencia,
      ]);
    }
  }
  return {
    nombre: "Libro diario",
    headers: [
      "Póliza", "Fecha", "Concepto póliza", "Cuenta", "Nombre cuenta",
      "Concepto movimiento", "Cargo", "Abono", "Fuente", "Tipo ref.", "Referencia",
    ],
    anchos: [16, 12, 40, 12, 34, 40, 14, 14, 12, 12, 38],
    rows,
  };
}

export function hojaAuxiliar(aux: AuxiliarCuenta, cuenta: string, nombreCuenta: string): HojaXlsx {
  // El saldo inicial y los totales van en la MISMA columna que el saldo corrido
  // para que la columna se lea de arriba abajo sin saltos.
  const rows: XlsxRow[] = [
    ["", "", `${cuenta} — ${nombreCuenta}`, "", "", "", "", null],
    ["", "", "Saldo inicial", "", "", "", "", aux.saldoInicial],
    ...aux.movimientos.map((m): XlsxRow => [
      m.fecha, m.folioPoliza, m.concepto, m.fuente, m.referencia, m.cargo, m.abono, m.saldo,
    ]),
    ["", "", "Totales", "", "", aux.totalCargos, aux.totalAbonos, aux.saldoFinal],
  ];
  return {
    nombre: `Auxiliar ${cuenta}`,
    headers: ["Fecha", "Póliza", "Concepto", "Fuente", "Referencia", "Cargo", "Abono", "Saldo"],
    anchos: [12, 16, 44, 12, 38, 14, 14, 15],
    rows,
  };
}
