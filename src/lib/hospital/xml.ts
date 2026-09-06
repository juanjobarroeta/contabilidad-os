// ─────────────────────────────────────────────────────────────────────────────
// Serializador XML mínimo y seguro para los documentos de intercambio (CDA R2).
//
// Sin dependencias: un árbol de nodos → texto XML bien formado, con escape de
// texto y atributos, elementos vacíos autocerrados y sangría opcional. Es
// deliberadamente pequeño: no parsea, sólo escribe.
// ─────────────────────────────────────────────────────────────────────────────

export type XmlAtributos = Record<string, string | number | boolean | null | undefined>;

export interface XmlNodo {
  tag: string;
  atributos?: XmlAtributos;
  hijos?: Array<XmlNodo | string | null | undefined | false>;
}

/** Atajo para construir nodos: `el("id", { root: "..." })`, `el("title", {}, ["Texto"])`. */
export function el(tag: string, atributos: XmlAtributos = {}, hijos: XmlNodo["hijos"] = []): XmlNodo {
  return { tag, atributos, hijos };
}

/** Escapa texto de contenido (& < >). */
export function escaparTexto(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escapa un valor de atributo (además " y '). */
export function escaparAtributo(v: string): string {
  return escaparTexto(v).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** Quita caracteres de control que XML 1.0 no admite (conserva tab, LF, CR). */
export function limpiarTextoXml(v: string): string {
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "");
}

export interface OpcionesXml {
  /** Sangría por nivel; "" o undefined = compacto. */
  sangria?: string;
  /** Anteponer la declaración `<?xml version="1.0" encoding="UTF-8"?>`. */
  declaracion?: boolean;
}

export function serializarXml(nodo: XmlNodo, opciones: OpcionesXml = {}): string {
  const sangria = opciones.sangria ?? "";
  const salto = sangria ? "\n" : "";
  const partes: string[] = [];
  if (opciones.declaracion) partes.push(`<?xml version="1.0" encoding="UTF-8"?>${salto}`);
  escribir(nodo, 0);
  return partes.join("");

  function escribir(n: XmlNodo, nivel: number) {
    const pad = sangria.repeat(nivel);
    const atributos = Object.entries(n.atributos ?? {})
      .filter(([, v]) => v !== null && v !== undefined && v !== false)
      .map(([k, v]) => ` ${k}="${escaparAtributo(limpiarTextoXml(String(v)))}"`)
      .join("");
    const hijos = (n.hijos ?? []).filter((h): h is XmlNodo | string => h !== null && h !== undefined && h !== false);
    if (hijos.length === 0) {
      partes.push(`${pad}<${n.tag}${atributos}/>${salto}`);
      return;
    }
    const soloTexto = hijos.every((h) => typeof h === "string");
    if (soloTexto) {
      partes.push(`${pad}<${n.tag}${atributos}>${hijos.map((h) => escaparTexto(limpiarTextoXml(h as string))).join("")}</${n.tag}>${salto}`);
      return;
    }
    partes.push(`${pad}<${n.tag}${atributos}>${salto}`);
    for (const h of hijos) {
      if (typeof h === "string") partes.push(`${pad}${sangria}${escaparTexto(limpiarTextoXml(h))}${salto}`);
      else escribir(h, nivel + 1);
    }
    partes.push(`${pad}</${n.tag}>${salto}`);
  }
}
