// ─────────────────────────────────────────────────────────────────────────────
// ESTADO DE CUENTA BBVA LEÍDO DEL TEXTO DEL PDF. PURO.
//
// La lectura con visión se pierde en los estados largos de BBVA: en CENTRO,
// los siete de enero a julio de 2026 (cuenta de cheques, 143–245 movimientos,
// 21 páginas) salieron con depósitos de menos —enero declaraba 54 y se
// leyeron 49; mayo, $8.1 millones de abonos faltantes— y con años inventados
// (renglones de «2019-03-18» en el estado de marzo 2026). Ninguno pasó sus
// propios controles y los siete quedaron detenidos, fila por fila.
//
// El PDF de BBVA trae capa de texto y un formato fijo:
//
//   05/ENE 05/ENE T20 SPEI RECIBIDOBAJIO 230,000.00
//   1713225TRASPASO ENTRE CUENTAS Ref. 0125683385 030      ← continuación
//   05/ENE 05/ENE P14 INSTITUTO FONACOT 5,022.87 271,515.94 271,515.94
//
// Lo que el texto NO conserva es la columna: un importe no dice si es cargo o
// abono. Por eso el signo se DEDUCE y se COMPRUEBA:
//   1. Una propuesta por código y concepto (T20 recibido → abono, T17 enviado
//      → cargo; «PAGO CUENTA DE TERCERO» puede ser cualquiera de los dos).
//   2. El banco imprime el saldo de operación en el último movimiento de cada
//      día: la suma con signo del día tiene que dar exactamente ese cambio. Si
//      la propuesta no lo da, se busca el conjunto MÍNIMO de signos a voltear
//      —primero entre los ambiguos— que sí lo dé.
//   3. El resultado completo tiene que empatar al centavo con lo que el banco
//      declara: conteo y total de abonos, conteo y total de cargos, y saldo
//      inicial + movimientos = saldo final.
// Si cualquiera de las tres falla, se devuelve null y se usa la visión como
// antes. Nunca se importa una lectura que no cuadra.
// ─────────────────────────────────────────────────────────────────────────────

import { mesEspanol } from "./periodo-declarado";

export interface MovimientoBbva {
  fecha: string; // YYYY-MM-DD (fecha de operación)
  codigo: string;
  descripcion: string;
  monto: number; // con signo: + abono, − cargo
  referencia: string | null;
  saldo: number | null; // saldo de operación impreso, si el renglón lo trae
  sublineas: string[];
  pagina: number | null;
}

export interface LecturaBbva {
  movimientos: MovimientoBbva[];
  /** Lo que el banco declara en el propio documento. */
  declarado: { saldoInicial: number; saldoFinal: number; abonos: number; cargos: number; conteoAbonos: number; conteoCargos: number };
  /** Cuántos signos hubo que voltear contra la propuesta para que cuadraran los días. */
  volteados: number;
}

export type ResultadoBbva = { ok: true; lectura: LecturaBbva } | { ok: false; motivo: string };

const cents = (n: number) => Math.round(n * 100);
const num = (s: string) => Number(s.replace(/,/g, ""));
const IMPORTE = /^\d{1,3}(?:,\d{3})*\.\d{2}$/;

/** ¿Es el formato de estado de cuenta de BBVA con detalle de movimientos? */
export function esEstadoBbva(texto: string): boolean {
  return /Detalle de Movimientos Realizados/i.test(texto) && /BBVA/i.test(texto) && /Saldo de Operaci[oó]n Inicial/i.test(texto);
}

// Códigos de BBVA cuyo sentido no admite duda (vistos en los estados de
// CENTRO 2026). Lo que no está aquí se propone por el concepto y, si tampoco,
// queda como ambiguo para que lo decida el saldo: «N06 PAGO CUENTA DE TERCERO»
// y «N03 TRASPASO CUENTAS PROPIAS» van en los dos sentidos.
const ABONO = new Set([
  "T20", // SPEI RECIBIDO
  "T22", // SPEI DEVUELTO (regresa un envío)
  "C02", // DEPOSITO EN EFECTIVO
  "Y45", // COMPENSACION POR RETRASO / MORA SPEI
  "V42", "V45", // VENTAS DEBITO / CREDITO (terminal)
  "I72", // VENTAS TDC INTER
  "K54", // VENTA NAL. AMEX
]);
const CARGO = new Set([
  "T17", // SPEI ENVIADO
  "A15", // compra con tarjeta
  "S39", "S40", // SERV BANCA INTERNET y su IVA
  "G30", "G64", // RECIBO NO. / PAGO SEGURO
  "P13", "P14", // pagos de contribuciones y servicios (SAT, CFE, FONACOT…)
  "X01", // IMSS/INF/AFORE
  "V40", "V41", "V43", "V44", "V46", "V47", // comisiones de terminal y su IVA
  "I73", "I74", // COM / IVA COM VTAS TDC INTER
  "K64", "K65", // COM / IVA COM AMEX
]);

function propuesta(codigo: string, descripcion: string): 1 | -1 | 0 {
  if (ABONO.has(codigo)) return 1;
  if (CARGO.has(codigo)) return -1;
  const d = descripcion.toUpperCase();
  if (/RECIBID|DEPOSITO|DEP\.|ABONO|DEVOLUCION|REEMBOLSO|INTERESES A FAVOR/.test(d)) return 1;
  if (/ENVIADO|COMISION|COM\.|IVA |RETIRO|CHEQUE PAGADO|CARGO|DOMICILIACION|PAGO DE SERVICIO/.test(d)) return -1;
  return 0;
}

const RUIDO = [
  /^No\. (Cuenta|Cliente)\b/i, /^Estado de Cuenta$/i, /^PAGINA \d+ \/ \d+$/i, /^MAESTRA PYME BBVA$/i, /^FECHA SALDO$/i,
  /^OPER LIQ COD\./i, /^BBVA MEXICO, S\.A\./i, /^-- \d+ of \d+ --$/, /^Información Financiera/i, /^La GAT Real/i,
  /^DOMICILIO FISCAL$/i,
];

/**
 * Lee el detalle de movimientos y lo valida contra lo que el banco declara.
 * `anioDe(mes)` da el año de un mes del periodo (un estado de diciembre a
 * enero cruza de año).
 */
export function leerEstadoBbva(texto: string, periodo: { inicio: string; fin: string }): ResultadoBbva {
  const decl = (re: RegExp) => { const m = re.exec(texto); return m ? m : null; };
  const ini = decl(/Saldo de Operaci[oó]n Inicial\s+(-?[\d,]+\.\d{2})/i);
  const fin = decl(/Saldo de Operaci[oó]n Final\s+(-?[\d,]+\.\d{2})/i) ?? decl(/Saldo Final \(\+\)\s+(-?[\d,]+\.\d{2})/i);
  const totCar = decl(/TOTAL IMPORTE CARGOS\s+([\d,]+\.\d{2})\s+TOTAL MOVIMIENTOS CARGOS\s+(\d+)/i);
  const totAbo = decl(/TOTAL IMPORTE ABONOS\s+([\d,]+\.\d{2})\s+TOTAL MOVIMIENTOS ABONOS\s+(\d+)/i);
  if (!ini || !fin || !totCar || !totAbo) return { ok: false, motivo: "El texto no trae saldos y totales declarados completos." };
  const declarado = {
    saldoInicial: num(ini[1]), saldoFinal: num(fin[1]),
    cargos: num(totCar[1]), conteoCargos: Number(totCar[2]), abonos: num(totAbo[1]), conteoAbonos: Number(totAbo[2]),
  };

  const yIni = Number(periodo.inicio.slice(0, 4)), mIni = Number(periodo.inicio.slice(5, 7));
  const yFin = Number(periodo.fin.slice(0, 4));
  const anioDe = (mes: number) => (yIni === yFin ? yIni : mes >= mIni ? yIni : yFin);

  // ── 1. Renglones ───────────────────────────────────────────────────────────
  const inicioDetalle = texto.search(/Detalle de Movimientos Realizados/i);
  const finDetalle = texto.search(/Total de Movimientos\s*\n\s*TOTAL IMPORTE CARGOS/i);
  if (inicioDetalle < 0 || finDetalle < inicioDetalle) return { ok: false, motivo: "No se encontró el detalle de movimientos completo." };
  const antes = texto.slice(0, inicioDetalle);
  let pagina = (antes.match(/-- \d+ of \d+ --/g)?.length ?? 0) + 1;
  const lineas = texto.slice(inicioDetalle, finDetalle).split(/\r?\n/);
  const LINEA = /^(\d{2})\/([A-Z]{3})\s+\d{2}\/[A-Z]{3}\s+([A-Z0-9]{3})\s+(.*)$/;
  const movs: (MovimientoBbva & { monto: number; abs: number })[] = [];
  let saltar = 0;
  for (const raw of lineas) {
    const linea = raw.trim();
    if (/^-- \d+ of \d+ --$/.test(linea)) { pagina++; continue; }
    // El domicilio fiscal del cliente que BBVA imprime al pie: no es del movimiento.
    if (/^DOMICILIO FISCAL$/i.test(linea)) { saltar = 3; continue; }
    if (saltar > 0) { saltar--; continue; }
    if (!linea || RUIDO.some((r) => r.test(linea))) continue;
    const m = LINEA.exec(linea);
    if (!m) {
      const ult = movs[movs.length - 1];
      if (ult) ult.sublineas.push(linea);
      continue;
    }
    const [, dd, mmm, codigo, resto] = m;
    const mes = mesEspanol(mmm);
    if (mes == null) return { ok: false, motivo: `Mes ilegible «${mmm}».` };
    const tokens = resto.split(/\s+/);
    const numeros: string[] = [];
    while (tokens.length && IMPORTE.test(tokens[tokens.length - 1])) numeros.unshift(tokens.pop()!);
    if (numeros.length < 1 || numeros.length > 3) return { ok: false, motivo: `Renglón sin importe legible: «${linea.slice(0, 60)}».` };
    const descripcion = tokens.join(" ").trim();
    const fecha = `${anioDe(mes)}-${String(mes).padStart(2, "0")}-${dd}`;
    const abs = num(numeros[0]);
    movs.push({ fecha, codigo, descripcion, monto: 0, abs, referencia: null, saldo: numeros.length >= 2 ? num(numeros[1]) : null, sublineas: [], pagina });
  }
  for (const mv of movs) {
    const ref = mv.sublineas.map((s) => /Ref\.\s*([^\s]+(?:\s+\d{3})?)/.exec(s)).find(Boolean);
    mv.referencia = ref ? ref[1].trim() : null;
  }
  if (movs.length !== declarado.conteoAbonos + declarado.conteoCargos) {
    return { ok: false, motivo: `Se leyeron ${movs.length} renglones y el banco declara ${declarado.conteoAbonos + declarado.conteoCargos}.` };
  }

  // ── 2. Signos: propuesta + cuadre diario contra el saldo impreso ──────────
  const signos = movs.map((mv) => propuesta(mv.codigo, mv.descripcion));
  let volteados = 0;
  let saldoPrevio = cents(declarado.saldoInicial);
  let desde = 0;
  for (let i = 0; i < movs.length; i++) {
    if (movs[i].saldo == null) continue;
    // Tramo [desde, i]: termina en un renglón con saldo impreso.
    const tramo = Array.from({ length: i - desde + 1 }, (_, k) => desde + k);
    const objetivo = cents(movs[i].saldo!) - saldoPrevio;
    const r = resolverTramo(tramo.map((j) => ({ abs: cents(movs[j].abs), signo: signos[j] })), objetivo);
    if (!r) return { ok: false, motivo: `Los movimientos del ${movs[i].fecha} no cuadran con el saldo impreso.` };
    tramo.forEach((j, k) => { if (signos[j] !== 0 && signos[j] !== r[k]) volteados++; signos[j] = r[k]; });
    saldoPrevio = cents(movs[i].saldo!);
    desde = i + 1;
  }
  if (desde < movs.length) {
    // Cola sin saldo impreso: la cierra el saldo final declarado.
    const tramo = Array.from({ length: movs.length - desde }, (_, k) => desde + k);
    const r = resolverTramo(tramo.map((j) => ({ abs: cents(movs[j].abs), signo: signos[j] })), cents(declarado.saldoFinal) - saldoPrevio);
    if (!r) return { ok: false, motivo: "Los últimos movimientos no cuadran con el saldo final." };
    tramo.forEach((j, k) => { if (signos[j] !== 0 && signos[j] !== r[k]) volteados++; signos[j] = r[k]; });
  }
  movs.forEach((mv, i) => { mv.monto = signos[i] * mv.abs; });

  // ── 3. Contra lo declarado, al centavo ─────────────────────────────────────
  const abonos = movs.filter((m) => m.monto > 0), cargos = movs.filter((m) => m.monto < 0);
  const suma = (xs: { abs: number }[]) => xs.reduce((s, m) => s + cents(m.abs), 0);
  if (abonos.length !== declarado.conteoAbonos || cargos.length !== declarado.conteoCargos) return { ok: false, motivo: "El conteo de abonos/cargos no empata con el declarado." };
  if (suma(abonos) !== cents(declarado.abonos) || suma(cargos) !== cents(declarado.cargos)) return { ok: false, motivo: "Los totales de abonos/cargos no empatan con los declarados." };
  if (cents(declarado.saldoInicial) + suma(abonos) - suma(cargos) !== cents(declarado.saldoFinal)) return { ok: false, motivo: "Saldo inicial + movimientos no da el saldo final." };

  return { ok: true, lectura: { movimientos: movs.map(({ abs: _abs, ...m }) => m), declarado, volteados } };
}

/**
 * Signos (+1/−1) para un tramo cuya suma debe dar `objetivo` (centavos),
 * cambiando lo menos posible la propuesta. Los ambiguos (0) se deciden
 * primero; sólo si no basta se voltean propuestas, el menor número posible.
 * Devuelve null si no hay solución (o el tramo es demasiado grande para
 * buscarla con seguridad).
 */
export function resolverTramo(items: { abs: number; signo: 1 | -1 | 0 }[], objetivo: number): (1 | -1)[] | null {
  const base = items.map((it) => (it.signo === 0 ? 1 : it.signo) as 1 | -1);
  const sumaBase = items.reduce((s, it, i) => s + base[i] * it.abs, 0);
  let falta = objetivo - sumaBase; // voltear i cambia la suma en −2·base[i]·abs
  if (falta === 0 && items.every((it) => it.signo !== 0)) return base;
  // Candidatos a voltear: primero los ambiguos (su «propuesta» era arbitraria).
  const orden = items.map((_, i) => i).sort((a, b) => Number(items[b].signo === 0) - Number(items[a].signo === 0));
  const ambiguos = orden.filter((i) => items[i].signo === 0);
  const delta = (i: number) => -2 * base[i] * items[i].abs;
  // Búsqueda por tamaño de conjunto: 0, 1, 2… volteos. Los ambiguos cuentan
  // gratis (su signo nunca estuvo propuesto), así que se exploran todos sus
  // subconjuntos con cada combinación pequeña de volteos firmes.
  if (ambiguos.length > 18) return null;
  const firmes = orden.filter((i) => items[i].signo !== 0);
  const subAmb = new Map<number, number[]>();
  for (let mask = 0; mask < 1 << ambiguos.length; mask++) {
    let s = 0; const sel: number[] = [];
    for (let b = 0; b < ambiguos.length; b++) if (mask & (1 << b)) { s += delta(ambiguos[b]); sel.push(ambiguos[b]); }
    if (!subAmb.has(s)) subAmb.set(s, sel);
  }
  const aplicar = (sel: number[]) => { const r = base.slice(); for (const i of sel) r[i] = (r[i] === 1 ? -1 : 1); return r; };
  for (let k = 0; k <= Math.min(3, firmes.length); k++) {
    const combos = function* (start: number, left: number, acc: number[]): Generator<number[]> {
      if (left === 0) { yield acc; return; }
      for (let i = start; i < firmes.length; i++) yield* combos(i + 1, left - 1, [...acc, firmes[i]]);
    };
    for (const sel of combos(0, k, [])) {
      const resto = falta - sel.reduce((s, i) => s + delta(i), 0);
      const amb = subAmb.get(resto);
      if (amb) return aplicar([...sel, ...amb]);
    }
    if (firmes.length > 60 && k >= 2) break; // un día enorme: no se fuerza
  }
  return null;
}
