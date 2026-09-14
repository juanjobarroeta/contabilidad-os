// ─────────────────────────────────────────────────────────────────────────────
// Citas escritas EN PROSA: «el artículo 486 del Código de Procedimientos
// Familiares del Estado de Chihuahua».
//
// El extractor de citas sólo reconocía la forma corta («Art. 486 CPF»), porque
// nació para el copiloto contable, donde todo tiene siglas conocidas (LISR,
// CFF, RMF). El jurídico casi nunca las tiene: de los 1 715 ordenamientos
// cargados, la mayoría se nombra completo. Consecuencia: esas afirmaciones no
// pasaban por el verificador y tampoco salían marcadas en la respuesta, que es
// justo donde el abogado necesita saber si algo está respaldado.
//
// Aquí se reconocen por el TÍTULO del ordenamiento contra el catálogo cargado.
// Todo es puro: el índice se arma una vez desde los JSON del catálogo.
// ─────────────────────────────────────────────────────────────────────────────

export interface EntradaIndice {
  clave: string;
  titulo: string;
  /** El título normalizado: sin acentos, sin «del estado de», en minúsculas. */
  normalizado: string;
  entidad?: string | null;
}

export interface CitaProsa {
  /** Normalizada como el resto del pipeline: «ART. 486 CHH-C-PROCEDIMIENTOS-FAMILIARES-CH». */
  cita: string;
  clave: string;
  articulo: string;
  titulo: string;
  textoEnRespuesta: string;
  inicio: number;
  fin: number;
}

/** Minúsculas, sin acentos, sin puntuación ni palabras de relleno. Puro. */
export function normalizarTitulo(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9ñ ]/g, " ")
    .replace(/\b(del|de la|de los|de las|de|el|la|los|las|para)\b/g, " ")
    .replace(/\bestado\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** El índice de títulos a claves. Puro: recibe el catálogo ya leído. */
export function construirIndice(entradas: { clave: string; titulo: string; entidad?: string | null }[]): EntradaIndice[] {
  const out: EntradaIndice[] = [];
  const vistos = new Set<string>();
  for (const e of entradas) {
    const normalizado = normalizarTitulo(e.titulo);
    // Títulos muy cortos («Ley de Ingresos») aparecerían en cualquier frase.
    if (normalizado.split(" ").length < 3) continue;
    const llave = `${normalizado}|${e.entidad ?? ""}`;
    if (vistos.has(llave)) continue;
    vistos.add(llave);
    out.push({ clave: e.clave, titulo: e.titulo, normalizado, entidad: e.entidad ?? null });
  }
  // El título más largo primero: «Código de Procedimientos Civiles y Familiares»
  // debe ganarle a «Código de Procedimientos Civiles».
  return out.sort((a, b) => b.normalizado.length - a.normalizado.length);
}

// «artículo 486 del …», «arts. 27 de la …», «artículo 1934, fracción II, del …».
// La cola se captura larga y luego se resuelve por el título más largo que
// encaje; el barrido controla dónde sigue para no tragarse la cita siguiente.
const RE_ARTICULO_PROSA = /\bart(?:[íi]culos?|s?\.)\s*(\d+[0-9A-Za-z-]*(?:\s+[Bb]is)?)\s*(?:,?\s*fracci[óo]n(?:es)?\s+[IVXLC]+\s*)?,?\s*(?:de|del)\s+(?:la|el|los|las)?\s*([^,;.()\n]{10,140})/gi;

/**
 * Las citas en prosa de un texto, resueltas contra el catálogo. Sólo devuelve
 * las que casan con un ordenamiento REAL: si el copiloto se inventa el nombre
 * de una ley, aquí no aparece (y el verificador la seguirá tratando como no
 * verificable, que es lo correcto).
 */
export function citasEnProsa(texto: string, indice: EntradaIndice[]): CitaProsa[] {
  const out: CitaProsa[] = [];
  const re = new RegExp(RE_ARTICULO_PROSA.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(texto)) !== null) {
    const articulo = m[1].replace(/\s+bis$/i, " Bis");
    const cola = normalizarTitulo(m[2]);
    const entrada = cola ? indice.find((e) => cola.startsWith(e.normalizado) || e.normalizado.startsWith(cola)) : undefined;
    if (!entrada) {
      // Sin ordenamiento reconocido: se sigue justo después del número, no al
      // final de la cola, para no perder la cita que venga en la misma frase.
      re.lastIndex = m.index + m[0].indexOf(m[1]) + m[1].length;
      continue;
    }
    // La cita termina donde termina SU título: lo que siga («y el artículo 7 del
    // Código…») es otra cita y tiene que poder encontrarse. El corte se busca
    // palabra por palabra —el título normalizado tiene menos palabras que el
    // escrito, porque se le quitan «del», «la», «de»—, nunca por un margen fijo.
    const enCola = m[2].trim().split(/\s+/);
    let corte = m[0].length;
    for (let k = 1; k <= enCola.length; k++) {
      const prefijo = enCola.slice(0, k).join(" ");
      if (normalizarTitulo(prefijo) === entrada.normalizado) {
        corte = m[0].indexOf(m[2]) + prefijo.length;
        break;
      }
    }
    const inicio = m.index;
    const fin = inicio + corte;
    out.push({
      cita: `ART. ${articulo.toUpperCase()} ${entrada.clave}`,
      clave: entrada.clave,
      articulo,
      titulo: entrada.titulo,
      textoEnRespuesta: texto.slice(inicio, fin).trim(),
      inicio,
      fin,
    });
    re.lastIndex = fin;
  }
  return out;
}
