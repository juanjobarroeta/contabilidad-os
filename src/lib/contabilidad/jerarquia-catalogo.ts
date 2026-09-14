// ─────────────────────────────────────────────────────────────────────────────
// QUÉ CUENTAS DEL CATÁLOGO PROPIO SON ACUMULATIVAS (tienen subcuentas).
//
// El catálogo que la empresa presenta al SAT trae mayor, subcuenta y detalle,
// y los asientos van al DETALLE: una cuenta con subcuentas acumula lo de sus
// hijas, no recibe pólizas.
//
// La jerarquía viene, en este orden, de:
//
//   1. Lo DECLARADO: el XML del Anexo 24 trae SubCtaDe (el código del padre)
//      y se guarda en ChartAccount.padreCodigo. Es exacto para cualquier
//      numeración, así que manda cuando está.
//   2. Lo INFERIDO de los códigos, para catálogos importados antes de guardar
//      SubCtaDe o subidos en CSV/Excel sin esa columna:
//        · con separador:  102.01.001 · 2110-002-000 · 1000-0001-0000
//          (los grupos finales en cero son relleno: 2110-002-000 es «2110-002»)
//        · numérico fijo de 9 o 12 dígitos en grupos de 3: 115001001 → 115.001.001
//        · numérico corto sin separador (10010): el prefijo manda
//      y se exige que la hija esté en un nivel MAYOR: sin eso, «101» del
//      catálogo starter (nivel 2) saldría como padre de «101001000» (nivel 2).
//
// Visto en CENTRO DE PROCEDIMIENTOS: la cola de decisiones ofrecía «501001000
// Farmacia Intrahospitalaria» junto a sus seis hijas como candidatas iguales,
// y 131 de sus 2 312 cuentas con agrupador son acumulativas. Puro y probado.
// ─────────────────────────────────────────────────────────────────────────────

export interface CuentaJerarquia {
  codigo: string;
  nivel: number;
  /** SubCtaDe del XML (código del padre), si el catálogo lo trajo. */
  padreCodigo?: string | null;
}

const SEPARADOR = /[.-]/;
const FIJO = /^\d{9}$|^\d{12}$/;

/** Segmentos jerárquicos de un código; [] si el código está vacío. */
export function segmentosDeCodigo(codigo: string): string[] {
  const c = codigo.trim();
  if (!c) return [];
  if (SEPARADOR.test(c)) {
    const segs = c.split(SEPARADOR).filter((s) => s.length > 0);
    // Grupos finales en cero son relleno de ancho fijo, no un nivel más.
    while (segs.length > 1 && /^0+$/.test(segs[segs.length - 1])) segs.pop();
    return segs;
  }
  if (FIJO.test(c)) {
    const segs = c.match(/\d{3}/g) ?? [];
    while (segs.length > 1 && /^0+$/.test(segs[segs.length - 1])) segs.pop();
    return segs;
  }
  return [c];
}

const clave = (segs: string[]) => segs.join(" ");

/** Claves de ancestro posibles de un código, del padre directo hacia arriba. */
function prefijosDe(codigo: string): string[] {
  const segs = segmentosDeCodigo(codigo);
  if (segs.length > 1) {
    return Array.from({ length: segs.length - 1 }, (_, i) => clave(segs.slice(0, segs.length - 1 - i)));
  }
  // Numérico corto: todo prefijo propio es un ancestro posible, del más largo al más corto.
  if (segs.length === 1 && !SEPARADOR.test(codigo) && !FIJO.test(codigo.trim())) {
    return Array.from({ length: segs[0].length - 1 }, (_, i) => clave([segs[0].slice(0, segs[0].length - 1 - i)]));
  }
  return [];
}

/**
 * El padre de cada cuenta: el declarado si existe en el catálogo; si no, el
 * ancestro más cercano que se infiere del código y está en un nivel menor.
 */
export function padreDeCadaCuenta(cuentas: readonly CuentaJerarquia[]): Map<string, string> {
  const porCodigo = new Map<string, CuentaJerarquia>();
  const porClave = new Map<string, CuentaJerarquia>();
  for (const c of cuentas) {
    porCodigo.set(c.codigo, c);
    porClave.set(clave(segmentosDeCodigo(c.codigo)), c);
  }
  const padre = new Map<string, string>();
  for (const c of cuentas) {
    const declarado = c.padreCodigo?.trim();
    if (declarado && declarado !== c.codigo && porCodigo.has(declarado)) {
      padre.set(c.codigo, declarado);
      continue;
    }
    for (const p of prefijosDe(c.codigo)) {
      const cand = porClave.get(p);
      if (cand && cand.nivel < c.nivel && cand.codigo !== c.codigo) {
        padre.set(c.codigo, cand.codigo);
        break;
      }
    }
  }
  return padre;
}

/**
 * Los códigos que tienen al menos una subcuenta → cuántas cuentas cuelgan de
 * cada uno (directas e indirectas).
 */
export function padresDelCatalogo(cuentas: readonly CuentaJerarquia[]): Map<string, number> {
  const padre = padreDeCadaCuenta(cuentas);
  const conteo = new Map<string, number>();
  for (const [hijo] of padre) {
    // Sube por la cadena de padres; un ciclo accidental no puede colgar el conteo.
    let actual: string | undefined = padre.get(hijo);
    const vistos = new Set<string>([hijo]);
    while (actual && !vistos.has(actual)) {
      conteo.set(actual, (conteo.get(actual) ?? 0) + 1);
      vistos.add(actual);
      actual = padre.get(actual);
    }
  }
  return conteo;
}

/** ¿`padre` tiene a `hijo` debajo (directa o indirectamente)? */
export function esAncestro(padre: CuentaJerarquia, hijo: CuentaJerarquia): boolean {
  if (hijo.nivel <= padre.nivel) return false;
  const a = segmentosDeCodigo(padre.codigo);
  const b = segmentosDeCodigo(hijo.codigo);
  if (a.length === 0 || b.length === 0) return false;
  if (a.length === 1 && b.length === 1) return b[0].length > a[0].length && b[0].startsWith(a[0]);
  if (b.length <= a.length) return false;
  return a.every((s, i) => b[i] === s);
}
