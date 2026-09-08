// ─────────────────────────────────────────────────────────────────────────────
// Los TOTALES DE CONTROL que el propio banco imprime en su estado de cuenta.
//
// POR QUÉ IMPORTA. La extracción de movimientos la hace un modelo leyendo el
// documento, y el único candado que teníamos era «saldo inicial + Σ movimientos
// ≈ saldo final». Ese candado tiene un hueco grande: si al modelo se le escapan
// un cargo de $5,000 y un abono de $5,000, la suma cuadra igual y el estado se
// importa con dos movimientos menos, en silencio. Con la extracción POR LOTES
// de páginas el riesgo crece: un lote que falle a medias se nota en el conteo
// mucho antes que en el saldo.
//
// Pero el banco ya nos dio la respuesta, impresa en su propio resumen:
//
//   BBVA:    «Depósitos / Abonos (+)  42   3,376,161.67»
//            «Retiros / Cargos (-)   126   3,620,943.87»
//   Banorte: «+ Total de depósitos    $ 2,140,520.31»
//            «- Total de retiros      $ 2,484,241.80»
//
// BBVA hasta da el CONTEO, que es el control más fuerte que existe: si el banco
// dice 126 retiros y extrajimos 119, faltan siete y se sabe exactamente. Este
// módulo lee esos renglones del texto del PDF y coteja. Es PURO y no adivina:
// un banco cuyo formato no reconoce devuelve `null`, y entonces se dice que no
// hubo con qué cotejar — que no es lo mismo que decir que cuadró.
// ─────────────────────────────────────────────────────────────────────────────

/** Los saldos que el banco imprime en su resumen. */
export interface SaldosEstado {
  inicial: number | null;
  final: number | null;
}

/**
 * Lee los saldos inicial y final del texto del estado. PURA.
 *
 * El modelo a veces los deja en null (caso real: BBVA agosto 2026, el saldo
 * final quedó sin leer y el lote se guardó sin con qué anclar la cuenta). El
 * banco los imprime siempre y en un formato fijo, así que leerlos del texto es
 * determinista y no cuesta una llamada:
 *
 *   BBVA: «Saldo de Liquidación Inicial 322,417.91» … «Saldo Final (+) 77,635.71»
 */
export function leerSaldos(texto: string): SaldosEstado {
  const buscar = (re: RegExp): number | null => {
    const m = texto.match(re);
    return m ? num(m[1]) : null;
  };
  // Cada banco lo dice a su manera y el extractor mete tabuladores y «$»:
  //   BBVA:    «Saldo de Liquidación Inicial 322,417.91» … «Saldo Final (+) 77,635.71»
  //   Banorte: «Saldo inicial del periodo \t$ 395,814.44» … «Saldo actual \t$ 9,766.31»
  const SEP = "[\\s\\t]*\\$?[\\s\\t]*";
  return {
    inicial: buscar(new RegExp(`Saldo[^\\n]{0,40}?Inicial(?:\\s*del\\s*periodo)?\\s*\\(?\\+?\\)?${SEP}([\\d,]+\\.\\d{2})`, "i")),
    final:
      buscar(new RegExp(`Saldo\\s*(?:de\\s*Liquidaci[oó]n\\s*)?Final\\s*\\(?\\+?\\)?${SEP}([\\d,]+\\.\\d{2})`, "i")) ??
      // Banorte no dice «final»: dice «Saldo actual» (y luego repite el
      // disponible, que puede diferir por retenciones — se toma el actual).
      buscar(new RegExp(`Saldo\\s*actual${SEP}([\\d,]+\\.\\d{2})`, "i")),
  };
}

/** Un renglón que aparece repetido, idéntico, dentro del MISMO archivo. */
export interface RepetidoExacto {
  fecha: string;
  descripcion: string;
  monto: number;
  veces: number;
}

/**
 * Renglones idénticos (mismo día, importe, concepto y referencia) dentro del
 * mismo estado.
 *
 * Se REPORTAN, nunca se borran solos: dos cobros iguales el mismo día son de lo
 * más normal —un consultorio con dos pacientes del mismo paquete, una tienda
 * con dos ventas iguales— y borrar uno auténtico es peor que dejar entrar uno
 * de más. Quien decide es el conteo del banco: si además sobran movimientos,
 * estos son los sospechosos; si el conteo cuadra, son reales y nadie los toca.
 */
export function duplicadosExactos(
  movimientos: { fecha: Date; descripcion: string; monto: number; referencia?: string | null }[],
): RepetidoExacto[] {
  const vistos = new Map<string, RepetidoExacto>();
  for (const m of movimientos) {
    const fecha = m.fecha.toISOString().slice(0, 10);
    const k = [fecha, m.monto.toFixed(2), m.descripcion.trim().toUpperCase(), (m.referencia ?? "").trim().toUpperCase()].join("|");
    const prev = vistos.get(k);
    if (prev) prev.veces++;
    else vistos.set(k, { fecha, descripcion: m.descripcion, monto: m.monto, veces: 1 });
  }
  return [...vistos.values()].filter((x) => x.veces > 1);
}

/** Un lado del resumen del banco: cuántos movimientos y por cuánto. */
export interface LadoControl {
  /** Conteo declarado por el banco. null cuando el formato no lo imprime. */
  conteo: number | null;
  total: number;
}

export interface ControlesEstado {
  depositos: LadoControl | null;
  retiros: LadoControl | null;
  /** Qué formato se reconoció, para poder decirlo en la advertencia. */
  fuente: "bbva" | "banorte" | null;
}

const num = (s: string): number => Number(s.replace(/,/g, ""));
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Lee los totales de control del texto del estado. PURA. */
export function leerControles(texto: string): ControlesEstado {
  // BBVA: «Depósitos / Abonos (+) 42 3,376,161.67» — conteo y total en la misma
  // línea. Se acepta con o sin acento porque la extracción de texto no siempre
  // conserva los diacríticos.
  const bbvaDep = texto.match(/Dep[oó]sitos\s*\/\s*Abonos\s*\(\+\)\s+(\d+)\s+([\d,]+\.\d{2})/i);
  const bbvaRet = texto.match(/Retiros\s*\/\s*Cargos\s*\(-\)\s+(\d+)\s+([\d,]+\.\d{2})/i);
  if (bbvaDep || bbvaRet) {
    return {
      depositos: bbvaDep ? { conteo: num(bbvaDep[1]), total: num(bbvaDep[2]) } : null,
      retiros: bbvaRet ? { conteo: num(bbvaRet[1]), total: num(bbvaRet[2]) } : null,
      fuente: "bbva",
    };
  }

  // Banorte: «+ Total de depósitos $ 2,140,520.31» — sin conteo. El separador
  // entre etiqueta e importe es un tabulador en el PDF, pero puede venir como
  // espacios según el extractor.
  const banDep = texto.match(/\+\s*Total de dep[oó]sitos\s*[\s\t]*\$?\s*([\d,]+\.\d{2})/i);
  const banRet = texto.match(/-\s*Total de retiros\s*[\s\t]*\$?\s*([\d,]+\.\d{2})/i);
  if (banDep || banRet) {
    // OJO: Banorte deja FUERA de «Total de retiros» las comisiones, su IVA y
    // los intereses cobrados —los declara en renglones aparte— pero en el
    // detalle SÍ son movimientos, cada uno bajando el saldo corrido. Comparar
    // los cargos extraídos contra el renglón pelón acusaba un faltante que no
    // existe (caso real: $42,326.64 de comisiones + IVA en agosto 2026) y
    // enseñaba al usuario a confirmar por encima de las advertencias — que es
    // exactamente como se coló el error de signo de BBVA. Se suman aquí para
    // que el cotejo compare universos iguales.
    const extra = (re: RegExp): number => {
      const m = texto.match(re);
      return m ? num(m[1]) : 0;
    };
    const comisiones = extra(/-\s*Total de comisiones[^$\n]*\$?\s*([\d,]+\.\d{2})/i);
    const ivaComisiones = extra(/-\s*IVA sobre comisiones[^$\n]*\$?\s*([\d,]+\.\d{2})/i);
    const intereses = extra(/-\s*Intereses Cobrados[^$\n]*\$?\s*([\d,]+\.\d{2})/i);
    return {
      depositos: banDep ? { conteo: null, total: num(banDep[1]) } : null,
      retiros: banRet
        ? { conteo: null, total: round2(num(banRet[1]) + comisiones + ivaComisiones + intereses) }
        : null,
      fuente: "banorte",
    };
  }

  return { depositos: null, retiros: null, fuente: null };
}

export interface CotejoControles {
  /** null = el banco no imprimió controles legibles: no hubo con qué cotejar. */
  cuadra: boolean | null;
  advertencias: string[];
  /** Lo observado en la extracción, para poder enseñarlo junto a lo declarado. */
  observado: {
    depositos: { conteo: number; total: number };
    retiros: { conteo: number; total: number };
  };
}

/** Centavo de holgura: el banco redondea y nosotros también. */
const TOLERANCIA = 0.02;

/**
 * Coteja los movimientos extraídos contra lo que el banco declara.
 *
 * OJO CON LOS SIGNOS: se comparan los dos lados POR SEPARADO a propósito. Un
 * cargo leído como abono deja la suma neta mal por el doble, pero además rompe
 * los dos lados a la vez — y así se ve, en vez de esconderse en un neto.
 */
export function cotejarControles(
  controles: ControlesEstado,
  movimientos: { monto: number }[],
): CotejoControles {
  const dep = movimientos.filter((m) => m.monto > 0);
  const ret = movimientos.filter((m) => m.monto < 0);
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const observado = {
    depositos: { conteo: dep.length, total: r2(dep.reduce((s, m) => s + m.monto, 0)) },
    retiros: { conteo: ret.length, total: r2(Math.abs(ret.reduce((s, m) => s + m.monto, 0))) },
  };

  if (!controles.depositos && !controles.retiros) {
    return { cuadra: null, advertencias: [], observado };
  }

  const advertencias: string[] = [];
  const revisar = (
    etiqueta: "depósitos" | "retiros",
    declarado: LadoControl | null,
    visto: { conteo: number; total: number },
  ) => {
    if (!declarado) return;
    if (declarado.conteo !== null && declarado.conteo !== visto.conteo) {
      const faltan = declarado.conteo - visto.conteo;
      advertencias.push(
        faltan > 0
          ? `El banco declara ${declarado.conteo} ${etiqueta} y se extrajeron ${visto.conteo}: faltan ${faltan}.`
          : `El banco declara ${declarado.conteo} ${etiqueta} y se extrajeron ${visto.conteo}: sobran ${-faltan} (¿movimientos duplicados entre páginas?).`,
      );
    }
    const dif = r2(visto.total - declarado.total);
    if (Math.abs(dif) > TOLERANCIA) {
      advertencias.push(
        `El total de ${etiqueta} no coincide: el banco dice ${fmt(declarado.total)} y los movimientos extraídos suman ${fmt(visto.total)} (diferencia ${fmt(dif)}).`,
      );
    }
  };

  revisar("depósitos", controles.depositos, observado.depositos);
  revisar("retiros", controles.retiros, observado.retiros);

  // Cuando a los depósitos les FALTA y a los retiros les SOBRA, no falta ningún
  // movimiento: hay renglones leídos del lado equivocado. Decirlo por su nombre
  // le ahorra al usuario buscar movimientos que sí están (caso real: cuatro
  // «N06 PAGO CUENTA DE TERCERO» de BBVA, un código que el banco usa en las dos
  // columnas y que sólo la posición distingue).
  if (controles.depositos && controles.retiros) {
    const faltanDep = r2(controles.depositos.total - observado.depositos.total);
    const sobranRet = r2(observado.retiros.total - controles.retiros.total);
    if (faltanDep > TOLERANCIA && sobranRet > TOLERANCIA) {
      const cuantos =
        controles.depositos.conteo !== null ? controles.depositos.conteo - observado.depositos.conteo : null;
      advertencias.push(
        `Parece un problema de SIGNO, no de movimientos faltantes: ${
          cuantos && cuantos > 0 ? `${cuantos} depósito${cuantos === 1 ? "" : "s"}` : "algunos depósitos"
        } por ${fmt(faltanDep)} se leyeron como cargos. Hay códigos que el banco usa en las dos columnas.`,
      );
    }
  }

  return { cuadra: advertencias.length === 0, advertencias, observado };
}

function fmt(n: number): string {
  return n.toLocaleString("es-MX", { style: "currency", currency: "MXN" });
}
