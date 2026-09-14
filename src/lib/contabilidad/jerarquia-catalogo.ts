// ─────────────────────────────────────────────────────────────────────────────
// QUÉ CUENTAS DEL CATÁLOGO PROPIO SON ACUMULATIVAS (tienen subcuentas).
//
// El catálogo que la empresa presenta al SAT trae mayor, subcuenta y detalle,
// y los asientos van al DETALLE: una cuenta con subcuentas acumula lo de sus
// hijas, no recibe pólizas. El importador no guarda el SubCtaDe del XML, así
// que la jerarquía se lee de los códigos, que la traen de una de tres formas:
//
//   · con separador:  102.01.001 · 2110-002-000 · 1000-0001-0000
//     (los grupos finales en cero son relleno: 2110-002-000 es «2110-002»)
//   · numérico fijo de 9 o 12 dígitos en grupos de 3: 115001001 → 115.001.001
//   · numérico corto sin separador (10010): el prefijo manda
//
// Y se exige que la hija esté en un nivel MAYOR: sin eso, «101» del catálogo
// starter (nivel 2) saldría como padre de «101001000» (también nivel 2).
//
// Visto en CENTRO DE PROCEDIMIENTOS: la cola de decisiones ofrecía «501001000
// Farmacia Intrahospitalaria» junto a sus seis hijas como candidatas iguales,
// y 131 de sus 2 312 cuentas con agrupador son acumulativas. Puro y probado.
// ─────────────────────────────────────────────────────────────────────────────

export interface CuentaJerarquia {
  codigo: string;
  nivel: number;
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

/** Todas las claves de ancestro posibles de un código (del más alto al padre directo). */
function prefijosDe(codigo: string): string[] {
  const segs = segmentosDeCodigo(codigo);
  if (segs.length > 1) return segs.slice(0, -1).map((_, i) => clave(segs.slice(0, i + 1)));
  // Numérico corto: todo prefijo propio es un ancestro posible.
  if (segs.length === 1 && !SEPARADOR.test(codigo) && !FIJO.test(codigo.trim())) {
    return Array.from({ length: segs[0].length - 1 }, (_, i) => clave([segs[0].slice(0, i + 1)]));
  }
  return [];
}

/**
 * Los códigos que tienen al menos una subcuenta (una cuenta de nivel mayor
 * cuyo código desciende del suyo) → cuántas cuentas cuelgan de cada uno.
 * Dos pases sobre el catálogo, sin cuadráticos.
 */
export function padresDelCatalogo(cuentas: readonly CuentaJerarquia[]): Map<string, number> {
  // clave de prefijo → nivel mínimo de las cuentas que lo tienen como ancestro
  const nivelMinimoDeHijas = new Map<string, number>();
  for (const c of cuentas) {
    for (const p of prefijosDe(c.codigo)) {
      const v = nivelMinimoDeHijas.get(p);
      if (v === undefined || c.nivel < v) nivelMinimoDeHijas.set(p, c.nivel);
    }
  }
  const codigoPorClave = new Map<string, string>();
  const padres = new Map<string, number>();
  for (const c of cuentas) {
    const k = clave(segmentosDeCodigo(c.codigo));
    const nivelHijas = nivelMinimoDeHijas.get(k);
    if (nivelHijas !== undefined && nivelHijas > c.nivel) {
      padres.set(c.codigo, 0);
      codigoPorClave.set(k, c.codigo);
    }
  }
  if (padres.size === 0) return padres;
  for (const c of cuentas) {
    for (const p of prefijosDe(c.codigo)) {
      const cod = codigoPorClave.get(p);
      if (cod !== undefined && cod !== c.codigo) padres.set(cod, (padres.get(cod) ?? 0) + 1);
    }
  }
  return padres;
}

/** ¿`padre` tiene a `hijo` debajo? */
export function esAncestro(padre: CuentaJerarquia, hijo: CuentaJerarquia): boolean {
  if (hijo.nivel <= padre.nivel) return false;
  const a = segmentosDeCodigo(padre.codigo);
  const b = segmentosDeCodigo(hijo.codigo);
  if (a.length === 0 || b.length === 0) return false;
  if (a.length === 1 && b.length === 1) return b[0].length > a[0].length && b[0].startsWith(a[0]);
  if (b.length <= a.length) return false;
  return a.every((s, i) => b[i] === s);
}
