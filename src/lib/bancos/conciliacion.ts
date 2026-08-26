// ─────────────────────────────────────────────────────────────────────────────
// Conciliación bancaria — el papel de trabajo que el contador firma cada mes.
//
// OJO con el nombre: en Bancos ya existe una "conciliación" que empareja cada
// movimiento con su CFDI. Eso es conciliación OPERATIVA y responde "¿qué factura
// salda este pago?". Esta es otra pregunta, la del contador: "¿mis libros
// coinciden con el banco, y si no, por qué?".
//
// La arquitectura ayuda: como la cuenta de Bancos del libro se alimenta DE los
// movimientos bancarios (posting.ts los postea con referenciaTipo BANK_TX), las
// partidas en conciliación no son un universo abierto sino dos casos derivables:
//
//   1. Movimientos del banco NO registrados — los UNMATCHED, que postMonth se
//      niega a postear. Están en el estado de cuenta pero no en el libro.
//   2. Asientos en Bancos SIN movimiento bancario — pólizas manuales, el
//      asiento de apertura y los módulos satélite. Están en el libro pero no en
//      el estado de cuenta.
//
// El álgebra, con L = saldo en libros y E = saldo del estado de cuenta:
//
//   L = L_inicial + Σ(asientos con origen bancario) + Σ(asientos sin origen)
//   E = E_inicial + Σ(TODOS los movimientos del estado)
//   ⟹ L = E − Σ(no registrados) + Σ(sin origen) + (L_inicial − E_inicial)
//
// De ahí la propiedad que hace este papel AUTOVERIFICABLE: si el mes está
// completo y consistente, la diferencia residual es EXACTAMENTE el desfase
// heredado del mes anterior. Una diferencia que no coincide con lo heredado
// señala un problema en el mes que se está conciliando, no arrastre.
//
// Módulo PURO: sin Prisma. La capa de I/O arma las entradas y lo llama.
// ─────────────────────────────────────────────────────────────────────────────

/** Diferencia máxima (pesos) que se considera redondeo y no descuadre. */
export const TOLERANCIA_CONCILIACION = 0.5;

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Movimiento del estado de cuenta, con el signo del banco. */
export interface MovimientoParaConciliar {
  id: string;
  fecha: string; // ISO
  descripcion: string;
  /** Firmado: + depósito/abono del banco, − retiro/cargo del banco. */
  monto: number;
  cuentaBancariaId: string;
  /** ¿Llegó al libro? Los UNMATCHED no se postean (ver postMonth). */
  registrado: boolean;
  // Contraparte extraída de la descripción (spei-descripcion.ts). Opcional:
  // el motor no la usa para conciliar — la ARRASTRA para que la mesa enseñe
  // quién pagó en vez de la sintaxis del banco.
  contraparteNombre?: string | null;
  contraparteRfc?: string | null;
  conceptoPago?: string | null;
  claveRastreo?: string | null;
}

/** Asiento del mes en la cuenta contable de Bancos. */
export interface AsientoBancosParaConciliar {
  id: string;
  fecha: string; // ISO
  concepto: string;
  /** Delta firmado sobre Bancos: + CARGO (entra), − ABONO (sale). */
  delta: number;
  fuente: string;
  /** Movimiento bancario que lo originó; null cuando no viene del banco. */
  bankTxId: string | null;
}

/** Saldos que el estado de cuenta declara para una cuenta bancaria. */
export interface SaldoEstadoCuenta {
  cuentaBancariaId: string;
  /** Etiqueta legible para reportar faltantes. */
  etiqueta: string;
  saldoInicial: number | null;
  saldoFinal: number | null;
}

export interface ConciliacionResultado {
  /**
   * ¿El mes está posteado al libro? Sin esto el papel MIENTE por omisión: un mes
   * sin cerrar reporta TODOS sus movimientos como "no registrados", que
   * numéricamente es cierto (no están en el libro) pero no son partidas en
   * conciliación — es trabajo pendiente, no una excepción a investigar.
   */
  mesPosteado: boolean;

  /** Σ de los saldos finales declarados. Null si falta el de alguna cuenta. */
  saldoEstadoCuenta: number | null;
  saldoInicialEstado: number | null;
  /** Cuentas cuyo saldo del estado no se ha capturado — sin ellas no hay cuadre. */
  cuentasSinSaldo: string[];

  /** Partidas en conciliación (1): en el banco, no en el libro. */
  movimientosNoRegistrados: MovimientoParaConciliar[];
  totalNoRegistrados: number;

  /** Partidas en conciliación (2): en el libro, no en el banco. */
  asientosSinMovimiento: AsientoBancosParaConciliar[];
  totalAsientosSinMovimiento: number;

  /** E − Σ(no registrados) + Σ(sin movimiento). Null si falta algún saldo. */
  saldoEsperadoLibros: number | null;
  /** Saldo real del auxiliar de Bancos al cierre del mes. */
  saldoLibros: number;
  saldoInicialLibros: number;

  /** saldoLibros − saldoEsperadoLibros. Null si falta algún saldo del estado. */
  diferencia: number | null;
  /**
   * Desfase que ya venía del mes anterior (L_inicial − E_inicial). Cuando la
   * diferencia coincide con esto, el mes está bien y el problema es arrastre.
   */
  diferenciaHeredada: number | null;
  /** ¿La diferencia cabe en la tolerancia? */
  conciliado: boolean;
  /**
   * ¿La diferencia se explica ÍNTEGRAMENTE por el arrastre del mes anterior?
   * Cuando es true, este mes no introdujo descuadre nuevo.
   */
  explicadaPorArrastre: boolean;
}

export interface ConciliarArgs {
  saldos: SaldoEstadoCuenta[];
  movimientos: MovimientoParaConciliar[];
  asientos: AsientoBancosParaConciliar[];
  /** Saldo del auxiliar de Bancos al INICIO del mes (del libro). */
  saldoInicialLibros: number;
  /** ¿El periodo contable está POSTED/CLOSED? */
  mesPosteado?: boolean;
  tolerancia?: number;
}

/**
 * Arma el papel de conciliación de un mes para TODAS las cuentas bancarias de
 * la empresa a la vez.
 *
 * Es a nivel empresa y no por cuenta porque el catálogo tiene UNA cuenta
 * contable de Bancos: su auxiliar es la suma de todos los bancos. Conciliar
 * cuenta por cuenta contra una porción inventada de esa cuenta daría una cifra
 * que no existe en ningún libro. El detalle por banco sí se conserva en las
 * partidas, que traen su cuentaBancariaId.
 */
export function conciliarBancos(args: ConciliarArgs): ConciliacionResultado {
  const tolerancia = args.tolerancia ?? TOLERANCIA_CONCILIACION;

  const cuentasSinSaldo = args.saldos
    .filter((s) => s.saldoFinal == null)
    .map((s) => s.etiqueta);
  const faltanSaldos = args.saldos.length === 0 || cuentasSinSaldo.length > 0;

  const saldoEstadoCuenta = faltanSaldos
    ? null
    : r2(args.saldos.reduce((s, c) => s + (c.saldoFinal ?? 0), 0));
  // El inicial se reporta aparte: puede faltar aunque el final esté, y sólo
  // sirve para explicar el arrastre.
  const saldoInicialEstado = args.saldos.some((s) => s.saldoInicial == null)
    ? null
    : r2(args.saldos.reduce((s, c) => s + (c.saldoInicial ?? 0), 0));

  const movimientosNoRegistrados = args.movimientos
    .filter((m) => !m.registrado)
    .sort((a, b) => (a.fecha === b.fecha ? a.id.localeCompare(b.id) : a.fecha.localeCompare(b.fecha)));
  const totalNoRegistrados = r2(movimientosNoRegistrados.reduce((s, m) => s + m.monto, 0));

  const asientosSinMovimiento = args.asientos
    .filter((a) => !a.bankTxId)
    .sort((a, b) => (a.fecha === b.fecha ? a.id.localeCompare(b.id) : a.fecha.localeCompare(b.fecha)));
  const totalAsientosSinMovimiento = r2(asientosSinMovimiento.reduce((s, a) => s + a.delta, 0));

  const saldoInicialLibros = r2(args.saldoInicialLibros);
  const saldoLibros = r2(saldoInicialLibros + args.asientos.reduce((s, a) => s + a.delta, 0));

  const saldoEsperadoLibros =
    saldoEstadoCuenta == null
      ? null
      : r2(saldoEstadoCuenta - totalNoRegistrados + totalAsientosSinMovimiento);

  const diferencia = saldoEsperadoLibros == null ? null : r2(saldoLibros - saldoEsperadoLibros);
  const diferenciaHeredada =
    saldoInicialEstado == null ? null : r2(saldoInicialLibros - saldoInicialEstado);

  const conciliado = diferencia != null && Math.abs(diferencia) <= tolerancia;
  const explicadaPorArrastre =
    diferencia != null &&
    diferenciaHeredada != null &&
    Math.abs(diferencia - diferenciaHeredada) <= tolerancia;

  return {
    mesPosteado: args.mesPosteado ?? false,
    saldoEstadoCuenta,
    saldoInicialEstado,
    cuentasSinSaldo,
    movimientosNoRegistrados,
    totalNoRegistrados,
    asientosSinMovimiento,
    totalAsientosSinMovimiento,
    saldoEsperadoLibros,
    saldoLibros,
    saldoInicialLibros,
    diferencia,
    diferenciaHeredada,
    conciliado,
    explicadaPorArrastre,
  };
}

/**
 * Frase que explica el estado de la conciliación en el idioma del contador.
 * Se usa igual en la pantalla y en la exportación, para que no diverjan.
 */
export function resumenConciliacion(r: ConciliacionResultado): string {
  // Un mes sin cerrar no tiene "partidas en conciliación": tiene trabajo
  // pendiente. Decirlo primero evita que 27 movimientos normales se lean como
  // 27 excepciones que hay que investigar.
  if (!r.mesPosteado && r.movimientosNoRegistrados.length > 0) {
    return `El mes todavía no se ha cerrado, así que sus ${r.movimientosNoRegistrados.length} movimiento(s) aún no llegan al libro. Ciérralo en «Cierres mensuales» y vuelve: lo que siga apareciendo aquí sí serán partidas en conciliación.`;
  }
  if (r.saldoEstadoCuenta == null) {
    const cuentas = r.cuentasSinSaldo.length > 0 ? `: ${r.cuentasSinSaldo.join(", ")}` : "";
    return `Falta capturar el saldo del estado de cuenta${cuentas}. Sin él no hay contra qué conciliar.`;
  }
  if (r.conciliado) {
    const partidas = r.movimientosNoRegistrados.length + r.asientosSinMovimiento.length;
    return partidas === 0
      ? "Conciliado: el libro y el banco coinciden, sin partidas pendientes."
      : `Conciliado: el libro y el banco coinciden una vez consideradas ${partidas} partida(s) en conciliación.`;
  }
  const monto = Math.abs(r.diferencia ?? 0).toLocaleString("es-MX", {
    style: "currency",
    currency: "MXN",
  });
  if (r.explicadaPorArrastre) {
    return `Diferencia de ${monto}, heredada del mes anterior. Este mes no introdujo descuadre nuevo: concilia primero el mes previo.`;
  }
  return `Diferencia de ${monto} sin explicar. Revisa las partidas en conciliación y el saldo capturado del estado de cuenta.`;
}
