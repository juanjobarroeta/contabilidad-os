// ─────────────────────────────────────────────────────────────────────────────
// Orden Jurídico Nacional (SEGOB): la compilación de legislación ESTATAL y
// MUNICIPAL de las 32 entidades. Cómo se navega (medido el 2026-09-11):
//   - estatal.php?liberado=no&edo=N      → tipos de ordenamiento (ids) y la
//                                          lista de municipios (ids) del estado
//   - despliegaedo.php?edo=N&idPoder=P   → TODOS los ordenamientos del poder
//                                          (título, publicación, reforma, tipo,
//                                          idArchivo) — P: 1 ejecutivo,
//                                          2 legislativo, 3 judicial, 4 autónomos
//   - POST obtenerOrdenamientosMu.php    → ordenamientos de un municipio, por
//     {idEstado, idMunicipio, idTipo}       tipo (idTipo=0 devuelve vacío)
//   - fichaOrdenamiento.php?idArchivo=…  → el archivo (casi siempre PDF, a
//     &ambito=ESTATAL|MUNICIPAL              veces .doc)
// Parsers puros; el script fiscal-catalogo-ojn.ts recorre y escribe
// catalogo/ojn.json. docs/MOTOR-JURIDICO.md (F3).
// ─────────────────────────────────────────────────────────────────────────────

import { clasificarMaterias, type Materia } from "../materias";

export const OJN_BASE = "https://www.ordenjuridico.gob.mx";

/** Estados en el orden del OJN (= INEGI) con su clave de 3 letras del SAT. */
export const ESTADOS: { id: number; nombre: string; sat: string; capital: string }[] = [
  { id: 1, nombre: "Aguascalientes", sat: "AGU", capital: "Aguascalientes" },
  { id: 2, nombre: "Baja California", sat: "BCN", capital: "Mexicali" },
  { id: 3, nombre: "Baja California Sur", sat: "BCS", capital: "La Paz" },
  { id: 4, nombre: "Campeche", sat: "CAM", capital: "Campeche" },
  { id: 5, nombre: "Coahuila de Zaragoza", sat: "COA", capital: "Saltillo" },
  { id: 6, nombre: "Colima", sat: "COL", capital: "Colima" },
  { id: 7, nombre: "Chiapas", sat: "CHP", capital: "Tuxtla Gutiérrez" },
  { id: 8, nombre: "Chihuahua", sat: "CHH", capital: "Chihuahua" },
  { id: 9, nombre: "Ciudad de México", sat: "CMX", capital: "Ciudad de México" },
  { id: 10, nombre: "Durango", sat: "DUR", capital: "Durango" },
  { id: 11, nombre: "Guanajuato", sat: "GUA", capital: "Guanajuato" },
  { id: 12, nombre: "Guerrero", sat: "GRO", capital: "Chilpancingo de los Bravo" },
  { id: 13, nombre: "Hidalgo", sat: "HID", capital: "Pachuca de Soto" },
  { id: 14, nombre: "Jalisco", sat: "JAL", capital: "Guadalajara" },
  { id: 15, nombre: "Estado de México", sat: "MEX", capital: "Toluca" },
  { id: 16, nombre: "Michoacán", sat: "MIC", capital: "Morelia" },
  { id: 17, nombre: "Morelos", sat: "MOR", capital: "Cuernavaca" },
  { id: 18, nombre: "Nayarit", sat: "NAY", capital: "Tepic" },
  { id: 19, nombre: "Nuevo León", sat: "NLE", capital: "Monterrey" },
  { id: 20, nombre: "Oaxaca", sat: "OAX", capital: "Oaxaca de Juárez" },
  { id: 21, nombre: "Puebla", sat: "PUE", capital: "Puebla" },
  { id: 22, nombre: "Querétaro", sat: "QUE", capital: "Querétaro" },
  { id: 23, nombre: "Quintana Roo", sat: "ROO", capital: "Othón P. Blanco" },
  { id: 24, nombre: "San Luis Potosí", sat: "SLP", capital: "San Luis Potosí" },
  { id: 25, nombre: "Sinaloa", sat: "SIN", capital: "Culiacán" },
  { id: 26, nombre: "Sonora", sat: "SON", capital: "Hermosillo" },
  { id: 27, nombre: "Tabasco", sat: "TAB", capital: "Centro" },
  { id: 28, nombre: "Tamaulipas", sat: "TAM", capital: "Victoria" },
  { id: 29, nombre: "Tlaxcala", sat: "TLA", capital: "Tlaxcala" },
  { id: 30, nombre: "Veracruz", sat: "VER", capital: "Xalapa" },
  { id: 31, nombre: "Yucatán", sat: "YUC", capital: "Mérida" },
  { id: 32, nombre: "Zacatecas", sat: "ZAC", capital: "Zacatecas" },
];

/** Ciudades grandes además de la capital (los municipios que un constructor pisa). */
export const MUNICIPIOS_PRINCIPALES: Record<string, string[]> = {
  BCN: ["Tijuana", "Ensenada"],
  BCS: ["Los Cabos"],
  CAM: ["Carmen"],
  COA: ["Torreón", "Monclova"],
  COL: ["Manzanillo"],
  CHP: ["Tapachula"],
  CHH: ["Juárez"],
  GUA: ["León", "Irapuato", "Celaya"],
  GRO: ["Acapulco de Juárez"],
  JAL: ["Zapopan", "Tlaquepaque", "Tonalá", "Puerto Vallarta"],
  MEX: ["Ecatepec de Morelos", "Naucalpan de Juárez", "Tlalnepantla de Baz", "Nezahualcóyotl", "Metepec", "Huixquilucan", "Atizapán de Zaragoza"],
  MIC: ["Uruapan"],
  NLE: ["San Pedro Garza García", "San Nicolás de los Garza", "Guadalupe", "Apodaca", "Santa Catarina", "General Escobedo"],
  PUE: ["San Andrés Cholula", "San Pedro Cholula", "Tehuacán", "Atlixco", "Cuautlancingo"],
  QUE: ["Corregidora", "El Marqués", "San Juan del Río"],
  ROO: ["Benito Juárez", "Solidaridad", "Tulum"],
  SIN: ["Mazatlán", "Ahome"],
  SON: ["Cajeme", "Nogales"],
  TAM: ["Reynosa", "Matamoros", "Tampico", "Nuevo Laredo"],
  VER: ["Veracruz", "Boca del Río", "Coatzacoalcos"],
  YUC: ["Progreso"],
  DUR: ["Gómez Palacio", "Lerdo"],
  AGU: ["Jesús María"],
  HID: ["Mineral de la Reforma", "Tulancingo de Bravo"],
  MOR: ["Jiutepec", "Cuautla"],
  NAY: ["Bahía de Banderas"],
  OAX: ["Santa Cruz Xoxocotlán"],
  SLP: ["Soledad de Graciano Sánchez"],
  TAB: ["Cárdenas"],
  TLA: ["Apizaco"],
  ZAC: ["Guadalupe", "Fresnillo"],
};

export interface OrdenamientoOjn {
  idArchivo: string;
  titulo: string;
  fechaPublicacion: string | null; // YYYY-MM-DD
  ultimaReforma: string | null;
  tipo: string; // "Ley" | "Código" | "Reglamento" | "Acuerdo" | …
}

const ENTIDADES: Record<string, string> = { aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú", ntilde: "ñ", Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú", Ntilde: "Ñ", uuml: "ü" };

function decode(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&(aacute|eacute|iacute|oacute|uacute|ntilde|Aacute|Eacute|Iacute|Oacute|Uacute|Ntilde|uuml);/g, (_, e: string) => ENTIDADES[e] ?? "");
}

function ddmmyyyy(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = s.match(/(\d{2})-(\d{2})-(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/** Filas de despliegaedo.php o de obtenerOrdenamientosMu.php (mismo formato). */
export function parsearListado(html: string): OrdenamientoOjn[] {
  const out: OrdenamientoOjn[] = [];
  for (const tr of html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) ?? []) {
    const id = tr.match(/idArchivo=(\d+)/)?.[1];
    if (!id) continue;
    const celdas = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => decode(m[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim());
    if (celdas.length < 4) continue;
    const [titulo, pub, ref, tipo] = celdas;
    out.push({ idArchivo: id, titulo, fechaPublicacion: ddmmyyyy(pub), ultimaReforma: /sin reforma/i.test(ref) ? null : ddmmyyyy(ref), tipo });
  }
  return out;
}

/** Ids de tipo de ordenamiento («Ley (135)» → 4) y municipios de la página estatal.php. */
export function parsearSelectores(html: string): { tipos: Record<string, string>; municipios: { id: string; nombre: string }[] } {
  const tipos: Record<string, string> = {};
  const municipios: { id: string; nombre: string }[] = [];
  const selects = [...html.matchAll(/<select[^>]*>([\s\S]*?)<\/select>/gi)].map((m) => m[1]);
  for (const s of selects) {
    for (const o of s.matchAll(/<option[^>]*value=["']?(\d+)["']?[^>]*>\s*([^<]+)/gi)) {
      const etiqueta = decode(o[2]).trim();
      const tipo = etiqueta.match(/^(.+?)\s*\(\d+\)$/);
      if (tipo) tipos[tipo[1].trim()] = o[1];
      else if (/^Todos los Municipios$/i.test(etiqueta)) continue;
      else if (s.includes("Todos los Municipios")) municipios.push({ id: o[1], nombre: etiqueta });
    }
  }
  return { tipos, municipios };
}

/** Archivo del ordenamiento desde su ficha. */
export function parsearFicha(html: string): { url: string | null; estatus: string | null } {
  // El archivo es el href del propio sitio que termina en pdf/doc/docx/rtf. Hay dos
  // layouts: «/Documentos/Estatal/Baja California/wo1.pdf» (con espacios, sin
  // codificar) y el viejo «/Estatal/BAJA%20CALIFORNIA%20SUR/Leyes/BCSLEY07.pdf»
  // (ya codificado). Se toma la URL entera entre comillas y se normaliza.
  const hrefs = [...html.matchAll(/href=(?:"([^"]+)"|'([^']+)'|([^\s>"']+))/gi)].map((m) => decode(m[1] ?? m[2] ?? m[3]).trim());
  const crudo = hrefs.find((h) => /^https?:\/\/[^/]*ordenjuridico\.gob\.mx\/.*\.(pdf|docx?|rtf)$/i.test(h) || /\/Documentos\//i.test(h)) ?? null;
  let url: string | null = null;
  if (crudo) {
    let limpia = crudo.replace("/./", "/");
    try { limpia = decodeURI(limpia); } catch { /* ya venía con % sueltos: se codifica tal cual */ }
    url = encodeURI(limpia);
  }
  const estatus = decode(html.replace(/<[^>]+>/g, " ")).match(/Estatus:\s*([A-Za-zÁÉÍÓÚáéíóú ]+?)\s+Tipo:/)?.[1]?.trim() ?? null;
  return { url, estatus };
}

/** Lo que un constructor o un urbanista cita: por TIPO (ley, código, reglamento) y por título. */
export const RE_CONSTRUCCION_URBANO =
  /Construcci|Edificaci|Desarrollo Urbano|Asentamientos Humanos|Ordenamiento Territorial|Fraccionamiento|Condominio|Obra[s]? P[úu]blica|Imagen Urbana|Zonificaci|Uso[s]? de[l]? Suelo|Protecci[óo]n Civil|Vivienda|Anuncios|Estacionamiento|Centro Hist[óo]rico|Agua Potable|Alcantarillado|Drenaje|Bomberos|Infraestructura|Movilidad|Catastr|Vialidad|Urbaniz|Medio Ambiente|Equilibrio Ecol/i;
const TIPOS_NORMATIVOS = /^(Ley|C[óo]digo|Reglamento|Constituci[óo]n)/i;

export function esNormativoDeConstruccion(o: Pick<OrdenamientoOjn, "titulo" | "tipo">): boolean {
  return TIPOS_NORMATIVOS.test(o.tipo) && RE_CONSTRUCCION_URBANO.test(o.titulo) && !/Interior|Org[áa]nico|Interno/i.test(o.titulo);
}

export function slug(s: string, max: number): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/\b(LEY|CODIGO|REGLAMENTO|DE|DEL|DE LA|DE LOS|DE LAS|LA|LAS|LOS|EL|Y|PARA|EN|POR|SOBRE|ESTADO|LIBRE|SOBERANO|MUNICIPIO|MUNICIPAL)\b/g, " ")
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");
}

export interface EntradaOjn {
  clave: string;
  titulo: string;
  url: string | null;
  ambito: "ESTATAL" | "MUNICIPAL";
  entidad: string;
  municipio: string | null;
  tipo: string;
  idArchivo: string;
  fechaPublicacion: string | null;
  ultimaReforma: string | null;
  vigenciaFallback: string | null;
  materias: Materia[];
  excluida: string | null;
}

const TIPO_ABREV: Record<string, string> = { Ley: "L", Código: "C", Codigo: "C", Reglamento: "R", Constitución: "CONST" };

export function entradaDesde(o: OrdenamientoOjn, ctx: { sat: string; municipio: string | null }, archivo: { url: string | null; estatus: string | null }): EntradaOjn {
  const t = TIPO_ABREV[o.tipo] ?? o.tipo.slice(0, 3).toUpperCase();
  const clave = [ctx.sat, ctx.municipio ? `M-${slug(ctx.municipio, 14)}` : null, t, slug(o.titulo, 28)].filter(Boolean).join("-");
  let excluida: string | null = null;
  if (!archivo.url) excluida = "La ficha no trae archivo.";
  else if (!/\.(pdf|docx?)$/i.test(archivo.url)) excluida = `Formato ${archivo.url.split(".").pop()?.slice(0, 8)} (se ingieren PDF, DOCX y DOC).`;
  else if (archivo.estatus && !/vigente/i.test(archivo.estatus)) excluida = `Estatus: ${archivo.estatus}`;
  const materias = clasificarMaterias(clave, o.titulo);
  return {
    clave,
    titulo: o.titulo,
    url: archivo.url,
    ambito: ctx.municipio ? "MUNICIPAL" : "ESTATAL",
    entidad: ctx.sat,
    municipio: ctx.municipio,
    tipo: o.tipo,
    idArchivo: o.idArchivo,
    fechaPublicacion: o.fechaPublicacion,
    ultimaReforma: o.ultimaReforma,
    vigenciaFallback: o.ultimaReforma ?? o.fechaPublicacion,
    materias: materias.includes("construccion") || materias.includes("urbano") ? materias : [...materias, "construccion"],
    excluida,
  };
}
