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
    return {
      depositos: banDep ? { conteo: null, total: num(banDep[1]) } : null,
      retiros: banRet ? { conteo: null, total: num(banRet[1]) } : null,
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

  return { cuadra: advertencias.length === 0, advertencias, observado };
}

function fmt(n: number): string {
  return n.toLocaleString("es-MX", { style: "currency", currency: "MXN" });
}
