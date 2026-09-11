// ─────────────────────────────────────────────────────────────────────────────
// El código agrupador que el XML de Contabilidad Electrónica EMITE por cuenta,
// y si ese código existe en el Anexo 24. Puro.
//
// Existía dos veces, con dos resultados: el chequeo del cierre decía «350
// cuentas sin código agrupador» y el barrido del catálogo, sobre la misma
// empresa, encontraba 4. Dos números para lo mismo es peor que un número malo,
// porque no hay forma de saber cuál creer. Aquí se calcula UNA vez.
//
// Diferencias que había y que esta función zanja:
//   · `.trim()` — un código guardado con espacios no está en el Anexo 24 si no
//     se recorta, y sí lo está si se recorta.
//   · `??` vs `||` — `subcuenta` vacía (cadena vacía, no null) ganaba con `??`
//     y dejaba el código en blanco; el número propio de la cuenta es el que
//     emite el XML cuando no hay subcuenta.
// ─────────────────────────────────────────────────────────────────────────────

import { CODIGOS_AGRUPADOR_SAT } from "./codigo-agrupador-sat";

export interface CuentaConAgrupador {
  cuentaSAT: string;
  subcuenta?: string | null;
  codAgrup?: string | null;
}

/** El número de la cuenta tal como lo escribe el catálogo (NumCta). */
export function codigoDeCuenta(c: CuentaConAgrupador): string {
  const sub = (c.subcuenta ?? "").trim();
  return sub !== "" ? sub : (c.cuentaSAT ?? "").trim();
}

/** El CodAgrup que saldría en el XML: el declarado o, a falta de él, el número. */
export function agrupadorEmitido(c: CuentaConAgrupador): string {
  const declarado = (c.codAgrup ?? "").trim();
  return declarado !== "" ? declarado : codigoDeCuenta(c);
}

/**
 * ¿Ese código existe de verdad en el Anexo 24?
 *
 * Se pregunta al XSD del SAT y NO al mapa de nombres. Son dos cosas distintas
 * que se habían vuelto una: el XSD dice qué acepta el SAT, el mapa dice cómo
 * se llama cada cuenta en pantalla. Mientras la validez dependió del mapa, un
 * nombre que faltaba bloqueaba un cierre — y faltaban cuatro códigos de equipo
 * de transporte que el SAT trae desde siempre, con siete empresas trabadas
 * detrás y un mensaje que decía «cuenta sin código agrupador» sobre cuentas
 * que lo tenían bien puesto.
 */
export function esAgrupadorOficial(codigo: string | null | undefined): boolean {
  const cod = (codigo ?? "").trim();
  return cod !== "" && CODIGOS_AGRUPADOR_SAT.has(cod);
}

/**
 * La cuenta emitiría un CodAgrup que el SAT no reconoce — la CE se rechaza.
 * Es el MISMO criterio para el chequeo del cierre y para el barrido que rellena
 * los agrupadores desde los catálogos ya presentados.
 */
export function sinAgrupadorValido(c: CuentaConAgrupador): boolean {
  return !esAgrupadorOficial(agrupadorEmitido(c));
}
