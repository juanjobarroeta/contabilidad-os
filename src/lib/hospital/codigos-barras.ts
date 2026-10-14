// ─────────────────────────────────────────────────────────────────────────────
// CÓDIGOS DE BARRAS DE FARMACIA. PURO.
//
// Dos clases de etiqueta llegan al almacén del hospital:
//
//  · EAN-13 / UPC-A llano (la caja de medicamento mexicana típica:
//    «7 502245 840289»). Identifica SÓLO el producto. El lote, la caducidad y
//    el precio máximo al público van impresos con tinta al lado y se leen de la
//    foto, no del código.
//  · GS1-128 / DataMatrix con identificadores de aplicación (material de
//    curación importado, algunos laboratorios): (01) GTIN, (17) caducidad
//    AAMMDD, (10) lote, (21) serie. Ahí el escaneo trae TODO.
//
// Ambos se normalizan a GTIN-14 (el EAN-13 con un cero adelante): es la llave
// con la que el hospital liga un código a su insumo una sola vez.
// ─────────────────────────────────────────────────────────────────────────────

/** Separador de campos variables en GS1 (FNC1 transmitido como ASCII 29). */
const GS = "\u001d";

/** Dígito verificador GS1 (módulo 10, pesos 3-1 desde la derecha) de una cadena de dígitos SIN el verificador. */
export function digitoVerificadorGs1(sinVerificador: string): number {
  let suma = 0;
  for (let i = 0; i < sinVerificador.length; i++) {
    const d = sinVerificador.charCodeAt(sinVerificador.length - 1 - i) - 48;
    suma += d * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (suma % 10)) % 10;
}

/**
 * EAN-8 / UPC-A (12) / EAN-13 / GTIN-14 → GTIN-14 con verificador válido, o
 * null. Un código con el verificador mal leído se rechaza: ligar un código
 * equivocado a un insumo es peor que pedir que se vuelva a escanear.
 */
export function normalizarGtin(codigo: string): string | null {
  const d = codigo.replace(/\s|-/g, "");
  if (!/^\d+$/.test(d) || ![8, 12, 13, 14].includes(d.length)) return null;
  if (digitoVerificadorGs1(d.slice(0, -1)) !== Number(d[d.length - 1])) return null;
  return d.padStart(14, "0");
}

/** GTIN-14 → como se imprime en la caja (EAN-13 si empieza con 0). */
export function gtinParaMostrar(gtin14: string): string {
  return gtin14.startsWith("0") ? gtin14.slice(1) : gtin14;
}

export interface CodigoLeido {
  /** GTIN: producto identificado. GS1: además trae datos del lote. OTRO: no es un código de producto que entendamos. */
  tipo: "GTIN" | "GS1" | "OTRO";
  gtin: string | null;
  lote: string | null;
  /** AAAA-MM-DD. Un día «00» (sólo mes) es el último día de ese mes. */
  caducidad: string | null;
  serie: string | null;
  crudo: string;
}

/** AAMMDD de GS1 → AAAA-MM-DD. Siglo: 2000–2049 / 1950–1999 (regla GS1 simplificada, de sobra para caducidades). */
export function fechaGs1(aammdd: string): string | null {
  if (!/^\d{6}$/.test(aammdd)) return null;
  const aa = Number(aammdd.slice(0, 2));
  const mm = Number(aammdd.slice(2, 4));
  let dd = Number(aammdd.slice(4, 6));
  if (mm < 1 || mm > 12) return null;
  const anio = aa >= 50 ? 1900 + aa : 2000 + aa;
  const ultimo = new Date(Date.UTC(anio, mm, 0)).getUTCDate();
  if (dd === 0) dd = ultimo;
  if (dd > ultimo) return null;
  return `${anio}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

/** Longitud fija de los AIs que nos importan; null = variable (hasta GS o fin, máx. 20). */
const AI_FIJO: Record<string, number | null> = {
  "00": 18, "01": 14, "02": 14, "11": 6, "12": 6, "13": 6, "15": 6, "16": 6, "17": 6, "20": 2,
  "10": null, "21": null, "22": null, "30": null, "37": null, "240": null, "241": null, "250": null, "400": null,
};

function siguienteAi(s: string): string | null {
  for (const n of [2, 3]) {
    const ai = s.slice(0, n);
    if (ai in AI_FIJO) return ai;
  }
  return null;
}

/**
 * Lee lo que entrega el escáner: un EAN/UPC llano, una cadena GS1 con
 * paréntesis («(01)07502245840289(17)280731(10)TE26H06»), o la cadena cruda
 * de GS1-128/DataMatrix con FNC1 como ASCII 29 y, a veces, el prefijo de
 * simbología («]C1», «]d2», «]Q3»).
 */
export function leerCodigo(entrada: string): CodigoLeido {
  const crudo = entrada.replace(/[\r\n]+$/g, "");
  const base: CodigoLeido = { tipo: "OTRO", gtin: null, lote: null, caducidad: null, serie: null, crudo };
  let s = crudo.trim().replace(/^\](C1|e0|d2|Q3|J1)/, "");
  if (!s) return base;

  // EAN/UPC/GTIN llano.
  const llano = normalizarGtin(s);
  if (llano) return { ...base, tipo: "GTIN", gtin: llano };

  // Forma con paréntesis → cadena con GS entre campos.
  if (s.includes("(")) {
    const partes = [...s.matchAll(/\((\d{2,4})\)([^(]*)/g)];
    if (partes.length === 0) return base;
    s = partes.map((p) => p[1] + p[2].trim()).join(GS);
  }
  // Un GS1 empieza con un AI conocido (casi siempre 01).
  if (!siguienteAi(s.replace(/^\u001d+/, ""))) return base;

  const out: CodigoLeido = { ...base, tipo: "GS1" };
  let resto = s.replace(/^\u001d+/, "");
  for (let guardia = 0; resto && guardia < 20; guardia++) {
    const ai = siguienteAi(resto);
    if (!ai) return base; // basura a media cadena: mejor no inventar
    resto = resto.slice(ai.length);
    const fijo = AI_FIJO[ai];
    let valor: string;
    if (fijo != null) {
      valor = resto.slice(0, fijo);
      resto = resto.slice(fijo).replace(/^\u001d/, "");
    } else {
      const fin = resto.indexOf(GS);
      valor = (fin < 0 ? resto : resto.slice(0, fin)).slice(0, 30);
      resto = fin < 0 ? "" : resto.slice(fin + 1);
    }
    if (ai === "01" || ai === "02") out.gtin = normalizarGtin(valor);
    else if (ai === "17") out.caducidad = fechaGs1(valor);
    else if (ai === "10") out.lote = valor.trim() || null;
    else if (ai === "21") out.serie = valor.trim() || null;
  }
  if (!out.gtin && !out.lote) return base;
  return out;
}

const MESES: Record<string, number> = {
  ENE: 1, JAN: 1, FEB: 2, MAR: 3, ABR: 4, APR: 4, MAY: 5, JUN: 6, JUL: 7, AGO: 8, AUG: 8,
  SEP: 9, SET: 9, OCT: 10, NOV: 11, DIC: 12, DEC: 12,
};

/**
 * La caducidad como viene IMPRESA en la caja: «JUL 28», «07/2028», «07-28»,
 * «2028-07», «JUL/2028». Devuelve el último día de ese mes (AAAA-MM-DD): una
 * caducidad mes/año vence al terminar el mes. Null si no se entiende.
 */
export function caducidadImpresa(texto: string | null | undefined): string | null {
  const t = (texto ?? "").toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[.]/g, " ").trim();
  if (!t) return null;
  const anioDe = (y: string) => (y.length === 2 ? 2000 + Number(y) : Number(y));
  const mes = (m: number, y: number) => {
    if (m < 1 || m > 12 || y < 2000 || y > 2099) return null;
    const ultimo = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return `${y}-${String(m).padStart(2, "0")}-${String(ultimo).padStart(2, "0")}`;
  };
  let m = /^([A-Z]{3})[A-Z]*[\s/-]*(\d{2}|\d{4})$/.exec(t);
  if (m && MESES[m[1]]) return mes(MESES[m[1]], anioDe(m[2]));
  m = /^(\d{1,2})[\s/-](\d{2}|\d{4})$/.exec(t);
  if (m) return mes(Number(m[1]), anioDe(m[2]));
  m = /^(\d{4})[\s/-](\d{1,2})$/.exec(t);
  if (m) return mes(Number(m[2]), Number(m[1]));
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTEO FÍSICO
// ─────────────────────────────────────────────────────────────────────────────

export interface LineaContada {
  insumoId: string;
  lote: string;
  cantidad: number;
}

export interface LoteSistema {
  id: string;
  insumoId: string;
  lote: string;
  existencia: number;
}

export interface Diferencia {
  insumoId: string;
  lote: string;
  loteId: string | null;
  sistema: number;
  contado: number | null;
  /** contado − sistema; null = el lote no se contó. */
  diferencia: number | null;
}

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
const llave = (insumoId: string, lote: string) => `${insumoId}|${lote.trim().toUpperCase()}`;

/**
 * Contado contra sistema, por lote, de los insumos que SE CONTARON en la
 * sesión. Un lote del sistema de un insumo contado que nadie escaneó sale con
 * `contado: null` — puede faltar físicamente o no haberse llegado a él; al
 * cerrar, el usuario decide si cuenta como cero. Los insumos que no se tocaron
 * no aparecen: un conteo parcial (un anaquel) no debe poner en cero el resto
 * del almacén.
 */
export function diferenciasDeConteo(lineas: LineaContada[], lotes: LoteSistema[]): Diferencia[] {
  const contados = new Map<string, number>();
  for (const l of lineas) contados.set(llave(l.insumoId, l.lote), r6((contados.get(llave(l.insumoId, l.lote)) ?? 0) + l.cantidad));
  const insumosContados = new Set(lineas.map((l) => l.insumoId));
  const out: Diferencia[] = [];
  const vistos = new Set<string>();
  for (const lt of lotes) {
    if (!insumosContados.has(lt.insumoId)) continue;
    const k = llave(lt.insumoId, lt.lote);
    vistos.add(k);
    const contado = contados.has(k) ? contados.get(k)! : null;
    out.push({
      insumoId: lt.insumoId, lote: lt.lote, loteId: lt.id, sistema: r6(lt.existencia), contado,
      diferencia: contado == null ? null : r6(contado - lt.existencia),
    });
  }
  // Lotes contados que el sistema no conoce: entran completos (sobrante).
  for (const l of lineas) {
    const k = llave(l.insumoId, l.lote);
    if (vistos.has(k)) continue;
    vistos.add(k);
    const contado = contados.get(k)!;
    out.push({ insumoId: l.insumoId, lote: l.lote, loteId: null, sistema: 0, contado, diferencia: contado });
  }
  return out;
}

/** Los ajustes que genera cerrar un conteo. Con `faltantesEnCero`, un lote no contado se ajusta a cero. */
export function ajustesDeConteo(difs: Diferencia[], faltantesEnCero: boolean): { insumoId: string; lote: string; loteId: string | null; cantidad: number }[] {
  const out: { insumoId: string; lote: string; loteId: string | null; cantidad: number }[] = [];
  for (const d of difs) {
    const dif = d.diferencia ?? (faltantesEnCero ? -d.sistema : 0);
    if (Math.abs(dif) > 1e-6) out.push({ insumoId: d.insumoId, lote: d.lote, loteId: d.loteId, cantidad: r6(dif) });
  }
  return out;
}

/** ¿El precio al paciente rebasa el precio máximo al público impreso en la caja? */
export function rebasaPrecioMaximo(precioUnitario: number, precioMaximoPublico: number | null | undefined): boolean {
  return precioMaximoPublico != null && precioMaximoPublico > 0 && precioUnitario > precioMaximoPublico + 0.005;
}
