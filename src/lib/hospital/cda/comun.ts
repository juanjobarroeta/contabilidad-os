// ─────────────────────────────────────────────────────────────────────────────
// Piezas que comparten la cabecera y las secciones del CDA: fechas en el
// formato de HL7 (aaaammddhhiiss±hhmm, hora de la Ciudad de México), arcos
// de OID propios (registrado o temporal 2.25.<uuid>), nombres partidos en
// given/family, y los átomos XML repetidos (id, códigos, párrafos, tablas).
// Sin Prisma y sin imports del hub: corre desde vitest y desde scripts.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash, randomUUID } from "node:crypto";
import { partesLocales } from "../tz";
import { el, type XmlAtributos, type XmlNodo } from "../xml";

// ── Fechas ──────────────────────────────────────────────────────────────────

const dos = (n: number) => String(n).padStart(2, "0");

/** Instante → «20260905143000-0600» (TS de HL7 con el reloj de piso y su offset). */
export function fechaHoraCda(d: Date): string {
  const p = partesLocales(d);
  const comoUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s);
  const offsetMin = Math.round((comoUtc - Math.floor(d.getTime() / 1000) * 1000) / 60_000);
  const signo = offsetMin < 0 ? "-" : "+";
  const abs = Math.abs(offsetMin);
  return `${p.y}${dos(p.m)}${dos(p.d)}${dos(p.h)}${dos(p.min)}${dos(p.s)}${signo}${dos(Math.floor(abs / 60))}${dos(abs % 60)}`;
}

/** Instante → «19920314» (sólo el día local: nacimiento). */
export function fechaCda(d: Date): string {
  const p = partesLocales(d);
  return `${p.y}${dos(p.m)}${dos(p.d)}`;
}

/** «2026-09-05 14:30» para la narrativa. */
export function fechaLegible(d: Date, conHora = true): string {
  const p = partesLocales(d);
  const dia = `${p.y}-${dos(p.m)}-${dos(p.d)}`;
  return conHora ? `${dia} ${dos(p.h)}:${dos(p.min)}` : dia;
}

// ── Identificadores ─────────────────────────────────────────────────────────

/**
 * Espacio de nombres fijo de HospitalOS para derivar UUID v5 (RFC 4122 §4.3)
 * deterministas por empresa cuando no hay OID registrado ante la DGIS.
 */
const ESPACIO_HOSPITALOS = "3f5c1d7e-2b4a-4c8e-9a1f-7d2e6b8c0a11";

function bytesDeUuid(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ""), "hex");
}

/** UUID v5 (SHA-1) de `nombre` dentro de `espacio`. */
export function uuidV5(nombre: string, espacio: string = ESPACIO_HOSPITALOS): string {
  const h = createHash("sha1").update(bytesDeUuid(espacio)).update(nombre, "utf8").digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** UUID → OID del arco 2.25 (ITU-T X.667): el UUID como entero decimal. No requiere registro. */
export function oidDeUuid(uuid: string): string {
  return `2.25.${BigInt(`0x${uuid.replace(/-/g, "")}`).toString(10)}`;
}

export const nuevoUuid = (): string => randomUUID();

export interface Raices {
  /** root del id/setId del documento. Con OID registrado lleva extension; sin él, el 2.25 ES el identificador. */
  documento: string;
  /** El SIRES (author/assignedAuthor/id). */
  sistema: string;
  pacientes: string;
  expedientes: string;
  episodios: string;
  usuarios: string;
  /** true cuando el hospital tiene OID registrado (GIIS-A003): los ids se pueden intercambiar. */
  registrado: boolean;
}

/**
 * Arcos propios. Con `oidRaiz` (HospConfig, registrado ante oid@salud.gob.mx):
 * .1 documentos, .2 pacientes, .2.1 expedientes, .3 episodios, .4 usuarios.
 * Sin él: OIDs 2.25 derivados de un UUID v5 por empresa (estables entre
 * documentos, pero no registrados → el CDA se marca como no intercambiable).
 */
export function raicesDe(oidRaiz: string | null | undefined, companyId: string, idDocumento: string): Raices {
  const raiz = oidRaiz?.trim();
  if (raiz && /^[0-2](\.(0|[1-9][0-9]*))+$/.test(raiz)) {
    return {
      documento: `${raiz}.1`,
      sistema: raiz,
      pacientes: `${raiz}.2`,
      expedientes: `${raiz}.2.1`,
      episodios: `${raiz}.3`,
      usuarios: `${raiz}.4`,
      registrado: true,
    };
  }
  const arco = (sufijo: string) => oidDeUuid(uuidV5(`${companyId}/${sufijo}`));
  return {
    documento: oidDeUuid(idDocumento),
    sistema: arco("sires"),
    pacientes: arco("pacientes"),
    expedientes: arco("expedientes"),
    episodios: arco("episodios"),
    usuarios: arco("usuarios"),
    registrado: false,
  };
}

export function sha256(texto: string): string {
  return createHash("sha256").update(texto, "utf8").digest("hex");
}

// ── Texto ───────────────────────────────────────────────────────────────────

/** Trim; null cuando queda vacío. */
export function limpiar(v: string | null | undefined): string | null {
  const t = v?.trim();
  return t ? t : null;
}

/** Valor de una sección de nota (string, número, lista…) como texto plano; null si no hay nada. */
export function textoDe(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return limpiar(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    const partes = v.map(textoDe).filter((s): s is string => !!s);
    return partes.length ? partes.join("; ") : null;
  }
  if (typeof v === "object") {
    const partes = Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => {
        const t = textoDe(x);
        return t ? `${k}: ${t}` : null;
      })
      .filter((s): s is string => !!s);
    return partes.length ? partes.join("; ") : null;
  }
  return null;
}

/** Objeto JSON (secciones, contenido) como diccionario; null si no es un objeto. */
export function objeto(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

const PREFIJOS = /^(dr\.?|dra\.?|lic\.?|enf\.?|mtro\.?|mtra\.?|ing\.?|qfb\.?|psic\.?)\s+/i;

/**
 * «Dr. Alonso Vega Ruiz» → prefijo «Dr.», nombres «Alonso», apellidos
 * [«Vega», «Ruiz»]. Heurística para quien no tiene los campos separados
 * (tutor, destinatario, médico sin nombres/apellidos capturados): con cuatro
 * o más palabras las dos primeras son nombres; con tres, una.
 */
export function partirNombre(nombreCompleto: string): { prefijo: string | null; nombres: string; apellidos: string[] } {
  let resto = nombreCompleto.trim().replace(/\s+/g, " ");
  let prefijo: string | null = null;
  const m = PREFIJOS.exec(resto);
  if (m) {
    prefijo = m[1].replace(/\.?$/, ".");
    prefijo = prefijo.charAt(0).toUpperCase() + prefijo.slice(1);
    resto = resto.slice(m[0].length);
  }
  const palabras = resto.split(" ").filter(Boolean);
  if (palabras.length <= 1) return { prefijo, nombres: palabras[0] ?? "", apellidos: [] };
  if (palabras.length === 2) return { prefijo, nombres: palabras[0], apellidos: [palabras[1]] };
  if (palabras.length === 3) return { prefijo, nombres: palabras[0], apellidos: [palabras[1], palabras[2]] };
  return { prefijo, nombres: palabras.slice(0, 2).join(" "), apellidos: [palabras[2], palabras.slice(3).join(" ")] };
}

/** Texto sin acentos y en mayúsculas para casar catálogos («Cuñada» → «CUNADA»). */
export function claveTexto(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

// ── Átomos XML ──────────────────────────────────────────────────────────────

export interface Codigo {
  code: string;
  displayName?: string | null;
}

/** `<tag code codeSystem codeSystemName displayName>` con hijos opcionales (originalText…). */
export function codigo(tag: string, c: Codigo, codeSystem: string, codeSystemName: string, hijos: XmlNodo["hijos"] = []): XmlNodo {
  return el(tag, { code: c.code, codeSystem, codeSystemName, displayName: c.displayName ?? undefined }, hijos);
}

/** Código sin valor conocido: `<tag nullFlavor="UNK"><originalText>…</originalText></tag>`. */
export function codigoNulo(tag: string, nullFlavor: "UNK" | "OTH" | "NI" | "NA", originalText?: string | null, extra: XmlAtributos = {}): XmlNodo {
  return el(tag, { nullFlavor, ...extra }, originalText ? [el("originalText", {}, [originalText])] : []);
}

export function idNodo(root: string, extension?: string | null, assigningAuthorityName?: string | null): XmlNodo {
  return el("id", { root, extension: extension ?? undefined, assigningAuthorityName: assigningAuthorityName ?? undefined });
}

export function idNulo(root: string | null, nullFlavor: "UNK" | "NA" | "NI", assigningAuthorityName?: string | null): XmlNodo {
  return el("id", { root: root ?? undefined, nullFlavor, assigningAuthorityName: assigningAuthorityName ?? undefined });
}

/** `<name><prefix/><given/><family/><family/></name>` a partir de campos separados. */
export function nodoNombre(p: { prefijo?: string | null; nombres: string; apellidoPaterno?: string | null; apellidoMaterno?: string | null }): XmlNodo {
  return el("name", {}, [
    p.prefijo ? el("prefix", {}, [p.prefijo]) : null,
    el("given", {}, [p.nombres]),
    limpiar(p.apellidoPaterno) ? el("family", {}, [p.apellidoPaterno!.trim()]) : null,
    limpiar(p.apellidoMaterno) ? el("family", {}, [p.apellidoMaterno!.trim()]) : null,
  ]);
}

/** `<name>` de un nombre en una sola cadena (heurística de partirNombre). */
export function nodoNombreLibre(nombreCompleto: string): XmlNodo {
  const { prefijo, nombres, apellidos } = partirNombre(nombreCompleto);
  return nodoNombre({ prefijo, nombres: nombres || nombreCompleto.trim(), apellidoPaterno: apellidos[0] ?? null, apellidoMaterno: apellidos[1] ?? null });
}

/** `<telecom value="tel:…"/>` y `<telecom value="mailto:…"/>` con lo que haya. */
export function telecoms(telefono: string | null | undefined, email: string | null | undefined): XmlNodo[] {
  const out: XmlNodo[] = [];
  const tel = telefono?.replace(/[^\d+]/g, "");
  if (tel && /^\+?\d{6,15}$/.test(tel)) out.push(el("telecom", { value: `tel:${tel}` }));
  const mail = email?.trim();
  if (mail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) out.push(el("telecom", { value: `mailto:${mail}` }));
  return out;
}

// ── Narrativa (StrucDoc) ────────────────────────────────────────────────────

export function parrafo(texto: string): XmlNodo {
  return el("paragraph", {}, [texto]);
}

/** Texto libre → un `<paragraph>` por renglón no vacío. */
export function parrafos(texto: string | null | undefined, etiqueta?: string): XmlNodo[] {
  const t = limpiar(texto);
  if (!t) return [];
  const renglones = t.split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
  return renglones.map((r, i) => (etiqueta && i === 0 ? el("paragraph", {}, [el("content", { styleCode: "Bold" }, [`${etiqueta}: `]), r]) : parrafo(r)));
}

/** Tabla con encabezado: cada celda es texto o un nodo ya construido. */
export function tabla(encabezados: string[], filas: Array<Array<string | XmlNodo | null | undefined>>): XmlNodo {
  return el("table", { width: "100%", border: "1" }, [
    el("thead", {}, [el("tr", {}, encabezados.map((h) => el("th", {}, [h])))]),
    el("tbody", {}, filas.map((f) => el("tr", {}, f.map((c) => el("td", {}, [c == null ? "—" : c]))))),
  ]);
}

export function lista(items: string[]): XmlNodo {
  return el("list", {}, items.map((i) => el("item", {}, [i])));
}

/** Contenido de `<text>`: lo que haya o el aviso «Sin … registrado». */
export function narrativa(nodos: XmlNodo[], sinDatos: string): XmlNodo[] {
  return nodos.length ? nodos : [parrafo(sinDatos)];
}
