// ─────────────────────────────────────────────────────────────────────────────
// Libro diario, auxiliar de cuenta y balance general — capa de LECTURA pura.
//
// Las pólizas NO son una tabla: son la MISMA agrupación derivada que usan los
// XML del Anexo 24 (clavePoliza/numerarPolizas en coe-polizas.ts), así el
// folio (NumUnIdenPol) que el contador ve en pantalla es idéntico al del XML
// que recibiría el SAT. Cero esquema nuevo; postMonth puede regenerar
// CFDI/NOMINA/BANCO sin que cambie el folio de nada preservado.
//
// Todo aquí es puro (sin Prisma) para poder probarse; las rutas API cablean
// AccountingEntry → estos tipos.
// ─────────────────────────────────────────────────────────────────────────────

import { clavePoliza, numerarPolizas } from "./coe-polizas";
import type { BalanzaRow } from "./posting";

export interface EntryForLibro {
  id: string;
  fecha: string; // YYYY-MM-DD
  concepto: string;
  tipo: "CARGO" | "ABONO";
  monto: number;
  referencia: string | null;
  referenciaTipo: string | null;
  fuente: string;
  numCta: string;
  desCta: string;
}

export interface PolizaVista {
  folio: string; // NumUnIdenPol — idéntico al XML de Pólizas del Periodo
  fecha: string;
  concepto: string;
  fuente: string;
  referencia: string | null;
  referenciaTipo: string | null;
  totalCargos: number;
  totalAbonos: number;
  cuadrada: boolean;
  transacciones: Array<{
    entryId: string;
    numCta: string;
    desCta: string;
    concepto: string;
    cargo: number;
    abono: number;
  }>;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Agrupa los asientos del periodo en pólizas para el libro diario. */
export function libroDiario(entries: EntryForLibro[]): PolizaVista[] {
  const num = numerarPolizas(entries.map((e) => ({ ...e, concepto: e.concepto })));
  const grupos = new Map<string, EntryForLibro[]>();
  for (const e of entries) {
    const k = clavePoliza(e);
    const arr = grupos.get(k) ?? [];
    arr.push(e);
    grupos.set(k, arr);
  }
  const claves = [...grupos.keys()].sort((a, b) =>
    num.get(a)!.localeCompare(num.get(b)!, undefined, { numeric: true })
  );
  return claves.map((clave) => {
    const items = grupos.get(clave)!;
    const totalCargos = r2(items.filter((e) => e.tipo === "CARGO").reduce((s, e) => s + e.monto, 0));
    const totalAbonos = r2(items.filter((e) => e.tipo === "ABONO").reduce((s, e) => s + e.monto, 0));
    return {
      folio: num.get(clave)!,
      fecha: items[0].fecha,
      concepto: items[0].concepto || "Asiento contable",
      fuente: items[0].fuente,
      referencia: items[0].referencia,
      referenciaTipo: items[0].referenciaTipo,
      totalCargos,
      totalAbonos,
      cuadrada: Math.abs(totalCargos - totalAbonos) < 0.01,
      transacciones: items.map((e) => ({
        entryId: e.id,
        numCta: e.numCta,
        desCta: e.desCta,
        concepto: e.concepto || "Movimiento",
        cargo: e.tipo === "CARGO" ? e.monto : 0,
        abono: e.tipo === "ABONO" ? e.monto : 0,
      })),
    };
  });
}

export interface MovimientoAuxiliar {
  entryId: string;
  fecha: string;
  folioPoliza: string;
  concepto: string;
  fuente: string;
  referencia: string | null;
  referenciaTipo: string | null;
  cargo: number;
  abono: number;
  /** Saldo corrido CON SIGNO (cargos positivos) partiendo del saldo inicial. */
  saldo: number;
}

export interface AuxiliarCuenta {
  saldoInicial: number;
  movimientos: MovimientoAuxiliar[];
  totalCargos: number;
  totalAbonos: number;
  saldoFinal: number;
}

/**
 * Auxiliar de una cuenta: movimientos del periodo con saldo corrido, partiendo
 * del saldo inicial acumulado (mismo convenio con signo que BalanzaRow:
 * cargos suman, abonos restan).
 */
export function auxiliarCuenta(entries: EntryForLibro[], saldoInicial: number): AuxiliarCuenta {
  const num = numerarPolizas(entries);
  const ordenados = [...entries].sort((a, b) =>
    a.fecha === b.fecha ? a.id.localeCompare(b.id) : a.fecha.localeCompare(b.fecha)
  );
  let saldo = saldoInicial;
  const movimientos: MovimientoAuxiliar[] = ordenados.map((e) => {
    const cargo = e.tipo === "CARGO" ? e.monto : 0;
    const abono = e.tipo === "ABONO" ? e.monto : 0;
    saldo = r2(saldo + cargo - abono);
    return {
      entryId: e.id,
      fecha: e.fecha,
      folioPoliza: num.get(clavePoliza(e)) ?? "—",
      concepto: e.concepto,
      fuente: e.fuente,
      referencia: e.referencia,
      referenciaTipo: e.referenciaTipo,
      cargo,
      abono,
      saldo,
    };
  });
  return {
    saldoInicial: r2(saldoInicial),
    movimientos,
    totalCargos: r2(ordenados.reduce((s, e) => s + (e.tipo === "CARGO" ? e.monto : 0), 0)),
    totalAbonos: r2(ordenados.reduce((s, e) => s + (e.tipo === "ABONO" ? e.monto : 0), 0)),
    saldoFinal: r2(saldo),
  };
}

export interface BalanceGeneral {
  activo: Array<{ cuenta: string; nombre: string; monto: number }>;
  pasivo: Array<{ cuenta: string; nombre: string; monto: number }>;
  capital: Array<{ cuenta: string; nombre: string; monto: number }>;
  totalActivo: number;
  totalPasivo: number;
  totalCapital: number;
  /** Resultado del ejercicio EN CURSO (ingresos − costos − gastos acumulados)
   *  aún sin traspasar a capital — se presenta como renglón virtual para que
   *  la ecuación contable cuadre antes del cierre anual. */
  resultadoEnCurso: number;
  /** ACTIVO − (PASIVO + CAPITAL + resultado en curso). ≈0 cuando el libro cuadra. */
  descuadre: number;
}

/**
 * Balance general puro desde la balanza acumulada. Convenio de signo de
 * BalanzaRow.saldoFinal: cargos positivos — activo queda positivo, pasivo y
 * capital negativos (se presentan en valor de presentación: pasivo/capital
 * con signo invertido).
 */
export function balanceGeneralDesdeBalanza(rows: BalanzaRow[]): BalanceGeneral {
  const detalle = (tipo: string, invertir: boolean) =>
    rows
      .filter((r) => r.tipo === tipo && r.nivel >= 3 && Math.abs(r.saldoFinal) >= 0.01)
      .map((r) => ({
        cuenta: r.subcuenta ?? r.cuentaSAT,
        nombre: r.nombre,
        monto: r2(invertir ? -r.saldoFinal : r.saldoFinal),
      }));

  const activo = detalle("ACTIVO", false);
  const pasivo = detalle("PASIVO", true);
  const capital = detalle("CAPITAL", true);
  const sum = (xs: { monto: number }[]) => r2(xs.reduce((s, x) => s + x.monto, 0));

  // Resultado en curso: cuentas de resultados aún no traspasadas a capital.
  // saldoFinal firmado (cargos +): ingresos quedan negativos, gastos positivos.
  const resultadoEnCurso = r2(
    -rows
      .filter((r) => ["INGRESO", "GASTO", "COSTO"].includes(r.tipo) && r.nivel >= 3)
      .reduce((s, r) => s + r.saldoFinal, 0)
  );

  const totalActivo = sum(activo);
  const totalPasivo = sum(pasivo);
  const totalCapital = sum(capital);
  return {
    activo,
    pasivo,
    capital,
    totalActivo,
    totalPasivo,
    totalCapital,
    resultadoEnCurso,
    descuadre: r2(totalActivo - (totalPasivo + totalCapital + resultadoEnCurso)),
  };
}
