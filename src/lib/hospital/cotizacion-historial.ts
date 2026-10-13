// ─────────────────────────────────────────────────────────────────────────────
// HISTORIA DE UNA COTIZACIÓN: de qué paquete o protocolo nació, cómo se movió
// y CUÁNTO se descontó y DÓNDE.
//
// En el hospital una cotización casi nunca sale como la plantilla: para llegar
// a un precio se dejan conceptos en blanco («No cotizado»), se bajan cantidades
// o precios, se agrega algo. Al revisarla después hay que poder contestar
// «¿cuánto valía el paquete, cuánto se le quitó y de dónde?».
//
// Las líneas se comparan a PRECIO DE LISTA/TARIFA (antes de prorratear a un
// total de paquete): el prorrateo mueve todos los importes a la vez y no dice
// nada de lo que una persona cambió. Lo que el total del paquete movió por
// encima de las líneas queda aparte como «ajuste del paquete», así las piezas
// suman exactamente el descuento total.
//
// PURO: sin prisma.
// ─────────────────────────────────────────────────────────────────────────────

/** Una línea congelada de la cotización (a precio de lista/tarifa). */
export interface LineaHistoria {
  servicioId: string | null;
  clave?: string | null;
  categoria: string;
  descripcion: string;
  cantidad: number;
  precioUnitario: number;
  /** null = exento. */
  ivaTasa: number | null;
  /** Concepto mencionado sin precio: no suma. */
  sinCotizar?: boolean;
}

export interface FotoCotizacion {
  lineas: LineaHistoria[];
  /** El total que se cotizó/pactó (con IVA): el del paquete si lo hay. */
  total: number;
}

export type TipoCambio = "QUITADA" | "NO_COTIZADA" | "CANTIDAD" | "PRECIO" | "CANTIDAD_Y_PRECIO" | "AGREGADA" | "IGUAL";

export interface CambioLinea {
  tipo: TipoCambio;
  categoria: string;
  descripcion: string;
  clave: string | null;
  antes: { cantidad: number; precioUnitario: number; total: number } | null;
  despues: { cantidad: number; precioUnitario: number; total: number } | null;
  /** Lo que esta línea le quitó (+) o le sumó (−) al total, con IVA. */
  descuento: number;
}

export interface Comparacion {
  totalOriginal: number;
  totalCotizado: number;
  /** totalOriginal − totalCotizado (positivo = se descontó). */
  descuento: number;
  /** Sobre el total original. */
  descuentoPct: number;
  /** De dónde sale el descuento; suma exactamente `descuento`. */
  porTipo: { quitado: number; cantidad: number; precio: number; agregado: number; ajustePaquete: number };
  /** Descuento por categoría del cargo (sólo líneas). */
  porCategoria: Record<string, number>;
  lineas: CambioLinea[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();

/** Total con IVA de una línea (0 si va «No cotizado»). */
export function totalLinea(l: LineaHistoria): number {
  if (l.sinCotizar) return 0;
  const importe = r2(l.cantidad * l.precioUnitario);
  return r2(importe + (l.ivaTasa == null ? 0 : r2(importe * l.ivaTasa)));
}

/** Suma con IVA de las líneas: lo que valen a lista/tarifa, antes de paquete. */
export function totalLineas(ls: LineaHistoria[]): number {
  return r2(ls.reduce((s, l) => s + totalLinea(l), 0));
}

const llave = (l: LineaHistoria) => (l.servicioId ? `S:${l.servicioId}` : `D:${l.categoria}|${norm(l.descripcion)}`);
const foto = (l: LineaHistoria) => ({ cantidad: l.cantidad, precioUnitario: l.precioUnitario, total: totalLinea(l) });

/**
 * Compara dos fotos (origen contra lo cotizado, o una versión contra la
 * anterior). Empareja por servicio del tarifario o, si no tiene, por
 * categoría + descripción; las repetidas se emparejan en orden.
 */
export function compararCotizacion(antes: FotoCotizacion, despues: FotoCotizacion): Comparacion {
  const pendientes = new Map<string, LineaHistoria[]>();
  for (const l of despues.lineas) {
    const k = llave(l);
    pendientes.set(k, [...(pendientes.get(k) ?? []), l]);
  }

  const lineas: CambioLinea[] = [];
  const porTipo = { quitado: 0, cantidad: 0, precio: 0, agregado: 0, ajustePaquete: 0 };
  const porCategoria: Record<string, number> = {};
  const sumarCategoria = (cat: string, d: number) => {
    if (Math.abs(d) < 0.005) return;
    porCategoria[cat] = r2((porCategoria[cat] ?? 0) + d);
  };

  for (const a of antes.lineas) {
    const cola = pendientes.get(llave(a));
    const d = cola?.shift();
    const ta = totalLinea(a);
    const base = { categoria: a.categoria, descripcion: a.descripcion, clave: a.clave ?? null };
    if (!d) {
      lineas.push({ ...base, tipo: "QUITADA", antes: foto(a), despues: null, descuento: ta });
      porTipo.quitado += ta;
      sumarCategoria(a.categoria, ta);
      continue;
    }
    const td = totalLinea(d);
    if (d.sinCotizar && !a.sinCotizar) {
      lineas.push({ ...base, tipo: "NO_COTIZADA", antes: foto(a), despues: foto(d), descuento: ta });
      porTipo.quitado += ta;
      sumarCategoria(a.categoria, ta);
      continue;
    }
    const cambiaCant = Math.abs(a.cantidad - d.cantidad) > 1e-9;
    const cambiaPrecio = Math.abs(a.precioUnitario - d.precioUnitario) >= 0.005 || (a.ivaTasa ?? -1) !== (d.ivaTasa ?? -1);
    const delta = r2(ta - td); // + = bajó
    if (!cambiaCant && !cambiaPrecio && !a.sinCotizar === !d.sinCotizar) {
      lineas.push({ ...base, tipo: "IGUAL", antes: foto(a), despues: foto(d), descuento: 0 });
      continue;
    }
    // Lo que movió la cantidad, al precio de antes; el resto es precio.
    const porCantidad = a.sinCotizar ? 0 : r2(ta - totalLinea({ ...a, cantidad: d.cantidad }));
    const porPrecio = r2(delta - porCantidad);
    porTipo.cantidad += porCantidad;
    porTipo.precio += porPrecio;
    sumarCategoria(a.categoria, delta);
    lineas.push({
      ...base,
      tipo: cambiaCant && cambiaPrecio ? "CANTIDAD_Y_PRECIO" : cambiaCant ? "CANTIDAD" : "PRECIO",
      antes: foto(a),
      despues: foto(d),
      descuento: delta,
    });
  }
  for (const cola of pendientes.values()) {
    for (const d of cola) {
      const td = totalLinea(d);
      porTipo.agregado -= td;
      sumarCategoria(d.categoria, -td);
      lineas.push({ tipo: "AGREGADA", categoria: d.categoria, descripcion: d.descripcion, clave: d.clave ?? null, antes: null, despues: foto(d), descuento: -td });
    }
  }

  const totalOriginal = r2(antes.total);
  const totalCotizado = r2(despues.total);
  const descuento = r2(totalOriginal - totalCotizado);
  const porLineas = r2(porTipo.quitado + porTipo.cantidad + porTipo.precio + porTipo.agregado);
  porTipo.ajustePaquete = r2(descuento - porLineas);
  for (const k of ["quitado", "cantidad", "precio", "agregado"] as const) porTipo[k] = r2(porTipo[k]);

  return {
    totalOriginal,
    totalCotizado,
    descuento,
    descuentoPct: totalOriginal > 0 ? Math.round((descuento / totalOriginal) * 10000) / 100 : 0,
    porTipo,
    porCategoria,
    lineas,
  };
}

/** Lee las líneas congeladas guardadas como JSON (tolerante a campos faltantes). */
export function lineasDeJson(v: unknown): LineaHistoria[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => {
    const o = (x ?? {}) as Record<string, unknown>;
    return {
      servicioId: typeof o.servicioId === "string" ? o.servicioId : null,
      clave: typeof o.clave === "string" ? o.clave : null,
      categoria: String(o.categoria ?? "OTRO"),
      descripcion: String(o.descripcion ?? ""),
      cantidad: Number(o.cantidad ?? 0),
      precioUnitario: Number(o.precioUnitario ?? 0),
      ivaTasa: o.ivaTasa == null ? null : Number(o.ivaTasa),
      sinCotizar: o.sinCotizar === true,
    };
  });
}
