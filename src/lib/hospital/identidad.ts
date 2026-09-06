// ─────────────────────────────────────────────────────────────────────────────
// Identidad del paciente (P2, NOM-024 6.5.1 y LFPDPPP): lo que se puede
// CALCULAR y CRUZAR sin salir del hub.
//
//   calcularCurp        — las 16 posiciones del instructivo de RENAPO más la
//                         homoclave SUPUESTA («0» antes de 2000, «A» desde
//                         2000) y el dígito verificador. Es una CURP PROBABLE:
//                         RENAPO asigna la homoclave real para deshacer
//                         homonimias, así que sólo sirve para buscar/pre-llenar
//                         y queda marcada `curpProbable` hasta confirmarla.
//   calcularRfc         — RFC de persona física con el algoritmo del SAT
//                         (Anexo del RCFF): 4 letras con sus reglas, fecha,
//                         homoclave por el mapeo numérico del nombre y dígito.
//   cruzarCurpRfc       — los 10 primeros caracteres de la CURP y del RFC
//                         nacen del mismo nombre y fecha: deben coincidir.
//   compararConRenapo   — captura vs. lo que contestó RENAPO, sin acentos ni
//                         mayúsculas.
//   identidadDePaciente — el bloque `identidad` de la ficha con sus pendientes.
//
// Todo puro (sin Prisma, sin red): se prueba con fixtures y lo pueden usar el
// seed y las rutas.
// ─────────────────────────────────────────────────────────────────────────────

import type { HospCurpOrigen, HospIdentificacionTipo, HospRfcFuente, HospSexo } from "@prisma/client";
import { ENTIDADES_CURP, digitoVerificadorCurp, validarCurp } from "./curp";
import { ESTATUS_CURP, esEstatusActivo } from "./renapo/tipos";
import { partesLocales } from "./tz";

// ── Catálogo de entidades: RENAPO (letras) ↔ DGIS/INEGI (dos dígitos) ────────

export const ENTIDAD_DGIS_POR_CURP: Record<string, string> = {
  NE: "00", AS: "01", BC: "02", BS: "03", CC: "04", CL: "05", CM: "06", CS: "07", CH: "08", DF: "09", DG: "10",
  GT: "11", GR: "12", HG: "13", JC: "14", MC: "15", MN: "16", MS: "17", NT: "18", NL: "19", OC: "20", PL: "21",
  QT: "22", QR: "23", SP: "24", SL: "25", SR: "26", TC: "27", TS: "28", TL: "29", VZ: "30", YN: "31", ZS: "32",
};

export const ENTIDAD_CURP_POR_DGIS: Record<string, string> = Object.fromEntries(
  Object.entries(ENTIDAD_DGIS_POR_CURP).map(([curp, dgis]) => [dgis, curp])
);

/** Clave RENAPO de dos letras a partir de «PL», «21» o «Puebla»; null si no se reconoce. */
export function entidadCurpDe(entrada: string | null | undefined): string | null {
  const v = (entrada ?? "").trim().toUpperCase();
  if (!v) return null;
  if (ENTIDADES_CURP[v]) return v;
  if (/^\d{1,2}$/.test(v)) return ENTIDAD_CURP_POR_DGIS[v.padStart(2, "0")] ?? null;
  const nombre = normalizarNombre(v);
  const alias: Record<string, string> = {
    "DISTRITO FEDERAL": "DF", "CIUDAD DE MEXICO": "DF", CDMX: "DF", MEXICO: "MC", "ESTADO DE MEXICO": "MC",
    "COAHUILA DE ZARAGOZA": "CL", "MICHOACAN DE OCAMPO": "MN", "VERACRUZ DE IGNACIO DE LA LLAVE": "VZ",
    "NACIDO EN EL EXTRANJERO": "NE", EXTRANJERO: "NE", "NO ESPECIFICADO": "NE",
  };
  if (alias[nombre]) return alias[nombre];
  for (const [clave, n] of Object.entries(ENTIDADES_CURP)) if (normalizarNombre(n) === nombre) return clave;
  return null;
}

// ── Normalización de nombres ─────────────────────────────────────────────────

/** MAYÚSCULAS sin acentos ni diéresis (la Ñ se conserva); puntuación y dígitos → espacio. */
export function normalizarNombre(s: string | null | undefined): string {
  return (s ?? "")
    .toUpperCase()
    .replace(/Ñ/g, "\u0001")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\u0001/g, "Ñ")
    .replace(/[^A-ZÑ&\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const PARTICULAS = new Set(["DA", "DAS", "DE", "DEL", "DER", "DI", "DIE", "DD", "EL", "LA", "LAS", "LE", "LES", "LO", "LOS", "MAC", "MC", "VAN", "VON", "Y"]);
const NOMBRES_OMITIDOS = new Set(["MARIA", "MA", "JOSE", "J"]);

const palabras = (s: string | null | undefined) => normalizarNombre(s).split(" ").filter(Boolean);

/**
 * La palabra que RENAPO y el SAT usan del apellido o del nombre: sin
 * preposiciones/artículos («DE LA O» → «O») y, en nombres compuestos, sin el
 * MARIA/JOSE inicial («MARIA FERNANDA» → «FERNANDA»).
 */
export function palabraSignificativa(texto: string | null | undefined, esNombre = false): string {
  let ps = palabras(texto);
  if (esNombre && ps.length > 1 && NOMBRES_OMITIDOS.has(ps[0])) ps = ps.slice(1);
  while (ps.length > 1 && PARTICULAS.has(ps[0])) ps = ps.slice(1);
  return ps[0] ?? "";
}

const VOCALES = "AEIOU";
const esVocal = (c: string) => VOCALES.includes(c);
const esConsonante = (c: string) => /^[B-DF-HJ-NP-TV-ZÑ]$/.test(c);
const letra = (c: string | undefined) => (!c || c === "Ñ" ? "X" : c);
const primeraVocalInterna = (p: string) => [...p.slice(1)].find(esVocal) ?? "X";
const primeraConsonanteInterna = (p: string) => letra([...p.slice(1)].find(esConsonante) ?? "X");

// Palabras que RENAPO y el SAT no dejan aparecer al frente de la clave.
const ANTISONANTES_CURP = new Set(
  "BACA BAKA BUEI BUEY CACA CACO CAGA CAGO CAKA CAKO COGE COGI COJA COJE COJI COJO COLA CULO FALO FETO GETA GUEI GUEY JETA JOTO KACA KACO KAGA KAGO KAKA KAKO KOGE KOGI KOJA KOJE KOJI KOJO KOLA KULO LILO LOCA LOCO LOKA LOKO MAME MAMO MEAR MEAS MEON MIAR MION MOCO MOKO MULA MULO NACA NACO PEDA PEDO PENE PIPI PITO POPO PUTA PUTO QULO RATA ROBA ROBE ROBO RUIN SENO TETA VACA VAGA VAGO VAKA VUEI VUEY WUEI WUEY".split(" ")
);
const ANTISONANTES_RFC = new Set(
  "BUEI BUEY CACA CACO CAGA CAGO CAKA CAKO COGE COJA COJE COJI COJO CULO FETO GUEY JOTO KACA KACO KAGA KAGO KOGE KOJO KAKA KULO MAME MAMO MEAR MEAS MEON MION MOCO MULA PEDA PEDO PENE PUTA PUTO QULO RATA RUIN".split(" ")
);

// ── Fecha y sexo ─────────────────────────────────────────────────────────────

export type PartesFecha = { y: number; m: number; d: number };

/** «AAAA-MM-DD» o Date (día LOCAL); null si no es fecha real. */
export function partesFechaNacimiento(f: Date | string | null | undefined): PartesFecha | null {
  let p: PartesFecha | null = null;
  if (f instanceof Date) {
    if (Number.isNaN(f.getTime())) return null;
    const l = partesLocales(f);
    p = { y: l.y, m: l.m, d: l.d };
  } else if (typeof f === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(f.trim());
    if (!m) return null;
    p = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  }
  if (!p) return null;
  const check = new Date(Date.UTC(p.y, p.m - 1, p.d));
  if (check.getUTCFullYear() !== p.y || check.getUTCMonth() !== p.m - 1 || check.getUTCDate() !== p.d) return null;
  return p;
}

export const fechaIso = (p: PartesFecha) => `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
const aammdd = (p: PartesFecha) => `${String(p.y % 100).padStart(2, "0")}${String(p.m).padStart(2, "0")}${String(p.d).padStart(2, "0")}`;

export type SexoCurp = "H" | "M" | "X";

/** «H», «M» o «X» desde el vocabulario de RENAPO, del padrón o del catálogo HospSexo. */
export function sexoCurpDe(s: string | null | undefined): SexoCurp | null {
  const v = normalizarNombre(s);
  if (v === "H" || v === "HOMBRE" || v === "MASCULINO") return "H";
  if (v === "M" || v === "MUJER" || v === "FEMENINO") return "M";
  if (v === "X" || v === "OTRO" || v === "NO BINARIO") return "X";
  return null;
}

export function sexoPacienteDe(s: SexoCurp | null | undefined): HospSexo | null {
  return s === "H" ? "MASCULINO" : s === "M" ? "FEMENINO" : s === "X" ? "OTRO" : null;
}

// ── CURP ─────────────────────────────────────────────────────────────────────

export interface DatosCurp {
  nombres: string;
  primerApellido: string;
  segundoApellido?: string | null;
  fechaNacimiento: Date | string;
  sexo: SexoCurp | HospSexo | string;
  /** Clave RENAPO («PL»), DGIS («21») o nombre de la entidad. */
  entidadClave: string;
}

export type ResultadoCalculoCurp =
  | { ok: true; curp: string; base: string; homoclaveSupuesta: string; probable: true }
  | { ok: false; error: string };

/** Las 4 letras iniciales de la CURP (con la regla de antisonantes de RENAPO). */
export function letrasCurp(nombres: string, primerApellido: string, segundoApellido?: string | null): { letras: string; consonantes: string } {
  const pat = palabraSignificativa(primerApellido);
  const mat = palabraSignificativa(segundoApellido);
  const nom = palabraSignificativa(nombres, true);
  let letras = letra(pat[0]) + (pat ? primeraVocalInterna(pat) : "X") + letra(mat[0]) + letra(nom[0]);
  if (ANTISONANTES_CURP.has(letras)) letras = letras[0] + "X" + letras.slice(2);
  const consonantes = (pat ? primeraConsonanteInterna(pat) : "X") + (mat ? primeraConsonanteInterna(mat) : "X") + (nom ? primeraConsonanteInterna(nom) : "X");
  return { letras, consonantes };
}

export function calcularCurp(d: DatosCurp): ResultadoCalculoCurp {
  if (!palabras(d.primerApellido).length) return { ok: false, error: "El primer apellido es obligatorio para calcular la CURP" };
  if (!palabras(d.nombres).length) return { ok: false, error: "El nombre es obligatorio para calcular la CURP" };
  const fecha = partesFechaNacimiento(d.fechaNacimiento);
  if (!fecha) return { ok: false, error: "La fecha de nacimiento no es válida (AAAA-MM-DD)" };
  const sexo = sexoCurpDe(d.sexo);
  if (!sexo) return { ok: false, error: "El sexo debe ser H o M" };
  if (sexo === "X") return { ok: false, error: "RENAPO sólo asigna CURP con sexo H o M; captura el sexo registral" };
  const entidad = entidadCurpDe(d.entidadClave);
  if (!entidad) return { ok: false, error: `Entidad de nacimiento no reconocida: «${d.entidadClave}»` };

  const { letras, consonantes } = letrasCurp(d.nombres, d.primerApellido, d.segundoApellido);
  const homoclaveSupuesta = fecha.y >= 2000 ? "A" : "0";
  const base = letras + aammdd(fecha) + sexo + entidad + consonantes + homoclaveSupuesta;
  const curp = base + digitoVerificadorCurp(base);
  const r = validarCurp(curp);
  if (!r.valida) return { ok: false, error: r.motivo ?? "CURP inválida" };
  return { ok: true, curp, base: base.slice(0, 16), homoclaveSupuesta, probable: true };
}

// ── RFC de persona física ────────────────────────────────────────────────────

const RFC_DICT = "0123456789ABCDEFGHIJKLMN&OPQRSTUVWXYZ Ñ";
const VALOR_HOMOCLAVE: Record<string, string> = {
  " ": "00", "0": "00", "1": "01", "2": "02", "3": "03", "4": "04", "5": "05", "6": "06", "7": "07", "8": "08", "9": "09",
  "&": "10", A: "11", B: "12", C: "13", D: "14", E: "15", F: "16", G: "17", H: "18", I: "19", J: "21", K: "22", L: "23",
  M: "24", N: "25", O: "26", P: "27", Q: "28", R: "29", S: "32", T: "33", U: "34", V: "35", W: "36", X: "37", Y: "38",
  Z: "39", Ñ: "40",
};
const ALFABETO_HOMOCLAVE = "123456789ABCDEFGHIJKLMNPQRSTUVWXYZ";

/** Dígito verificador del SAT sobre los 12 primeros caracteres (PF) o 11 ajustados (PM). */
export function digitoVerificadorRfc(rfcSinDigito: string): string {
  const cuerpo = rfcSinDigito.toUpperCase().padStart(12, " ");
  let suma = 0;
  for (let i = 0; i < 12; i++) {
    const v = RFC_DICT.indexOf(cuerpo[i]);
    suma += (v < 0 ? 0 : v) * (13 - i);
  }
  const mod = suma % 11;
  if (mod === 0) return "0";
  return 11 - mod === 10 ? "A" : String(11 - mod);
}

/** Homoclave del SAT: mapeo numérico del nombre completo y suma de pares. */
export function homoclaveRfc(nombreCompleto: string): string {
  const texto = normalizarNombre(nombreCompleto);
  let numeros = "0";
  for (const c of texto) numeros += VALOR_HOMOCLAVE[c] ?? "00";
  let suma = 0;
  for (let i = 0; i < numeros.length - 1; i++) {
    suma += Number(numeros.slice(i, i + 2)) * Number(numeros[i + 1]);
  }
  const residuo = suma % 1000;
  return ALFABETO_HOMOCLAVE[Math.floor(residuo / 34)] + ALFABETO_HOMOCLAVE[residuo % 34];
}

/** Las 4 letras del RFC de persona física con las reglas del SAT. */
export function letrasRfc(nombres: string, primerApellido: string, segundoApellido?: string | null): string {
  const pat = palabraSignificativa(primerApellido);
  const mat = palabraSignificativa(segundoApellido);
  const nom = palabraSignificativa(nombres, true);
  const l = (c: string | undefined) => (!c || c === "Ñ" ? "X" : c);
  let letras: string;
  if (!mat) {
    // Sin apellido materno: dos del paterno y dos del nombre.
    letras = l(pat[0]) + l(pat[1]) + l(nom[0]) + l(nom[1]);
  } else if (pat.length <= 2) {
    // Apellido paterno de una o dos letras: una de cada apellido y dos del nombre.
    letras = l(pat[0]) + l(mat[0]) + l(nom[0]) + l(nom[1]);
  } else {
    letras = l(pat[0]) + primeraVocalInterna(pat) + l(mat[0]) + l(nom[0]);
  }
  if (ANTISONANTES_RFC.has(letras)) letras = letras.slice(0, 3) + "X";
  return letras;
}

export interface DatosRfc {
  nombres: string;
  primerApellido: string;
  segundoApellido?: string | null;
  fechaNacimiento: Date | string;
}

export type ResultadoCalculoRfc =
  | { ok: true; rfc: string; letras: string; homoclave: string; digito: string }
  | { ok: false; error: string };

export function calcularRfc(d: DatosRfc): ResultadoCalculoRfc {
  if (!palabras(d.primerApellido).length) return { ok: false, error: "El primer apellido es obligatorio para calcular el RFC" };
  if (!palabras(d.nombres).length) return { ok: false, error: "El nombre es obligatorio para calcular el RFC" };
  const fecha = partesFechaNacimiento(d.fechaNacimiento);
  if (!fecha) return { ok: false, error: "La fecha de nacimiento no es válida (AAAA-MM-DD)" };
  const letras = letrasRfc(d.nombres, d.primerApellido, d.segundoApellido);
  const homoclave = homoclaveRfc(`${d.primerApellido} ${d.segundoApellido ?? ""} ${d.nombres}`);
  const sinDigito = letras + aammdd(fecha) + homoclave;
  const digito = digitoVerificadorRfc(sinDigito);
  return { ok: true, rfc: sinDigito + digito, letras, homoclave, digito };
}

// ── Cruces ───────────────────────────────────────────────────────────────────

/** RFC genéricos del SAT: extranjeros sin RFC y público en general. */
export const RFC_GENERICOS = new Set(["XEXX010101000", "XAXX010101000"]);

export type CruceCurpRfc = "COINCIDE" | "DIFIERE" | "SIN_RFC" | "NO_APLICA";

/**
 * Los 10 primeros caracteres (letras + fecha) de CURP y RFC salen del mismo
 * nombre y fecha. Una X en cualquiera de los dos vale como comodín: RENAPO y
 * el SAT sustituyen letras distintas cuando la clave forma una palabra
 * antisonante o falta el segundo apellido. NO_APLICA = sin CURP, RFC genérico
 * o RFC de persona moral.
 */
export function cruzarCurpRfc(curp: string | null | undefined, rfc: string | null | undefined): CruceCurpRfc {
  const r = (rfc ?? "").trim().toUpperCase();
  const c = (curp ?? "").trim().toUpperCase();
  if (!r) return "SIN_RFC";
  if (!c || r.length !== 13 || RFC_GENERICOS.has(r)) return "NO_APLICA";
  // Sin segundo apellido (X en la posición 3 de la CURP) el SAT arma las
  // letras 3-4 con el nombre: sólo se cruzan las dos primeras y la fecha.
  const sinSegundoApellido = c[2] === "X";
  for (let i = 0; i < 10; i++) {
    if (sinSegundoApellido && (i === 2 || i === 3)) continue;
    if (r[i] === c[i]) continue;
    if (i < 4 && (r[i] === "X" || c[i] === "X")) continue;
    return "DIFIERE";
  }
  return "COINCIDE";
}

export interface NombreCapturado {
  nombres: string | null | undefined;
  primerApellido: string | null | undefined;
  segundoApellido?: string | null;
  /** «AAAA-MM-DD» o Date; se compara sólo si ambos lados lo traen. */
  fechaNacimiento?: Date | string | null;
  sexo?: string | null;
}

export interface DiferenciaRenapo {
  campo: "nombres" | "primerApellido" | "segundoApellido" | "fechaNacimiento" | "sexo";
  captura: string | null;
  renapo: string | null;
}

/** Captura vs. RENAPO sin acentos, mayúsculas ni espacios repetidos. */
export function compararConRenapo(captura: NombreCapturado, renapo: NombreCapturado): { coincide: boolean; diferencias: DiferenciaRenapo[] } {
  const diferencias: DiferenciaRenapo[] = [];
  const cmp = (campo: DiferenciaRenapo["campo"], a: string | null | undefined, b: string | null | undefined) => {
    if (normalizarNombre(a) !== normalizarNombre(b)) diferencias.push({ campo, captura: a?.trim() || null, renapo: b?.trim() || null });
  };
  cmp("nombres", captura.nombres, renapo.nombres);
  cmp("primerApellido", captura.primerApellido, renapo.primerApellido);
  cmp("segundoApellido", captura.segundoApellido, renapo.segundoApellido);
  const fa = partesFechaNacimiento(captura.fechaNacimiento);
  const fb = partesFechaNacimiento(renapo.fechaNacimiento);
  if (fa && fb && fechaIso(fa) !== fechaIso(fb)) diferencias.push({ campo: "fechaNacimiento", captura: fechaIso(fa), renapo: fechaIso(fb) });
  const sa = sexoCurpDe(captura.sexo);
  const sb = sexoCurpDe(renapo.sexo);
  if (sa && sb && sa !== sb) diferencias.push({ campo: "sexo", captura: sa, renapo: sb });
  return { coincide: diferencias.length === 0, diferencias };
}

// ── Nombre completo → partes (médicos capturados como «Dr. Alonso Vega») ─────

const TITULOS = new Set(["DR", "DRA", "LIC", "ENF", "MTRO", "MTRA", "ING", "PSIC", "QFB", "MC", "MSC", "PHD", "PROF"]);
// Segundos nombres frecuentes: «Ana Sofía Bermúdez» es nombre compuesto, no dos apellidos.
const SEGUNDOS_NOMBRES = new Set(
  "ALBERTO ALEJANDRO ALEJANDRA ANGEL ANGELES ANTONIO ANTONIA ARTURO BEATRIZ CARLOS CARMEN CRISTINA DANIEL DANIELA EDUARDO ELENA ENRIQUE ERNESTO EUGENIA FERNANDA FERNANDO FRANCISCO GABRIEL GABRIELA GUADALUPE IGNACIO ISABEL JAVIER JESUS JOSE JOSEFINA JUAN LAURA LUIS LUISA MANUEL MARIA MIGUEL PABLO PAOLA PATRICIA RAFAEL ROBERTO SOFIA TERESA VICTORIA".split(" ")
);

export interface PartesNombre {
  nombres: string;
  apellidoPaterno: string;
  apellidoMaterno: string | null;
}

/**
 * Divide un nombre completo en nombres y apellidos. Heurística: quita títulos
 * («Dr.», «Lic.»), pega las partículas a la palabra que sigue («de la Cruz»)
 * y reparte: 2 palabras → nombre + paterno; 3 → nombre + paterno + materno
 * salvo que la segunda sea un segundo nombre frecuente; 4+ → todo menos las
 * dos últimas es nombre. Devuelve null cuando no hay al menos nombre y apellido.
 */
export function dividirNombre(nombreCompleto: string | null | undefined): PartesNombre | null {
  const crudo = (nombreCompleto ?? "").replace(/\s+/g, " ").trim();
  if (!crudo) return null;
  const tokens = crudo.split(" ").filter((t) => !TITULOS.has(normalizarNombre(t)));
  const grupos: string[] = [];
  let pendiente: string[] = [];
  for (const t of tokens) {
    if (PARTICULAS.has(normalizarNombre(t)) && grupos.length + pendiente.length > 0) {
      pendiente.push(t);
      continue;
    }
    grupos.push([...pendiente, t].join(" "));
    pendiente = [];
  }
  if (pendiente.length) grupos.push(pendiente.join(" "));
  if (grupos.length < 2) return null;
  if (grupos.length === 2) return { nombres: grupos[0], apellidoPaterno: grupos[1], apellidoMaterno: null };
  if (grupos.length === 3) {
    if (SEGUNDOS_NOMBRES.has(normalizarNombre(grupos[1]))) return { nombres: `${grupos[0]} ${grupos[1]}`, apellidoPaterno: grupos[2], apellidoMaterno: null };
    return { nombres: grupos[0], apellidoPaterno: grupos[1], apellidoMaterno: grupos[2] };
  }
  return { nombres: grupos.slice(0, -2).join(" "), apellidoPaterno: grupos[grupos.length - 2], apellidoMaterno: grupos[grupos.length - 1] };
}

// ── El bloque `identidad` de la ficha ────────────────────────────────────────

export interface PacienteIdentidadEntrada {
  curp: string | null;
  sinCurp: boolean;
  sinCurpMotivo: string | null;
  curpValidada: boolean;
  curpOrigen: HospCurpOrigen | null;
  curpEstatus: string | null;
  curpVerificadaAt: Date | null;
  curpVerificadaFuente: string | null;
  curpVerificadaRef: string | null;
  renapoCoincide: boolean | null;
  curpProbable: boolean;
  rfc: string | null;
  rfcFuente: HospRfcFuente | null;
  identificacionTipo: HospIdentificacionTipo | null;
  identificacionNumero: string | null;
  identificacionVigencia: Date | null;
  avisoPrivacidadVersion: string | null;
  avisoPrivacidadAceptadoAt: Date | null;
}

export interface IdentidadPacienteResumen {
  curp: {
    valor: string | null;
    origen: HospCurpOrigen | null;
    estatus: string | null;
    estatusDescripcion: string | null;
    /** null = no se ha consultado a RENAPO. */
    activa: boolean | null;
    verificadaAt: Date | null;
    fuente: string | null;
    referencia: string | null;
    coincide: boolean | null;
    probable: boolean;
    validadaLocalmente: boolean;
    sinCurp: boolean;
    sinCurpMotivo: string | null;
  };
  rfc: { valor: string | null; fuente: HospRfcFuente | null; generico: boolean; cruceCurp: CruceCurpRfc };
  identificacion: { tipo: HospIdentificacionTipo | null; numero: string | null; vigencia: Date | null; vencida: boolean };
  avisoPrivacidad: { version: string | null; aceptadoAt: Date | null; vigente: boolean };
  pendientes: string[];
}

export function identidadDePaciente(
  p: PacienteIdentidadEntrada,
  config: { avisoPrivacidadVersion: string | null } | null | undefined,
  hoy: Date = new Date()
): IdentidadPacienteResumen {
  const pendientes: string[] = [];
  const estatus = p.curpEstatus?.trim().toUpperCase() || null;
  const verificada = p.curpOrigen === "RENAPO" && !!p.curpVerificadaAt;
  const activa = verificada && estatus ? esEstatusActivo(estatus) : null;

  if (!p.curp && !(p.sinCurp && p.sinCurpMotivo?.trim())) pendientes.push("Sin CURP ni motivo registrado para no tenerla (NOM-024)");
  if (p.curp && !verificada) pendientes.push("CURP sin verificar en RENAPO");
  if (p.curp && p.curpProbable) pendientes.push("CURP calculada (homoclave supuesta): confirmar con RENAPO o con un documento");
  if (verificada && estatus && activa === false) pendientes.push(`CURP dada de baja en RENAPO (${estatus}: ${ESTATUS_CURP[estatus]?.descripcion ?? "estatus desconocido"})`);
  if (verificada && p.renapoCoincide === false) pendientes.push("Los datos capturados no coinciden con los de RENAPO");

  const rfc = p.rfc?.trim().toUpperCase() || null;
  const cruceCurp = cruzarCurpRfc(p.curp, rfc);
  if (cruceCurp === "DIFIERE") pendientes.push("El RFC no coincide con la CURP (10 primeros caracteres)");

  const vencida = !!p.identificacionVigencia && p.identificacionVigencia.getTime() < hoy.getTime();
  if (!p.identificacionTipo) pendientes.push("Sin identificación oficial registrada");
  else if (vencida) pendientes.push("Identificación vencida");

  const versionVigente = config?.avisoPrivacidadVersion?.trim() || null;
  const avisoVigente = !!p.avisoPrivacidadAceptadoAt && (!versionVigente || p.avisoPrivacidadVersion === versionVigente);
  if (!p.avisoPrivacidadAceptadoAt) pendientes.push("Aviso de privacidad sin firma");
  else if (!avisoVigente) pendientes.push(`Aviso de privacidad firmado en una versión anterior (${p.avisoPrivacidadVersion ?? "sin versión"}; vigente ${versionVigente})`);

  return {
    curp: {
      valor: p.curp,
      origen: p.curpOrigen,
      estatus,
      estatusDescripcion: estatus ? (ESTATUS_CURP[estatus]?.descripcion ?? null) : null,
      activa,
      verificadaAt: p.curpVerificadaAt,
      fuente: p.curpVerificadaFuente,
      referencia: p.curpVerificadaRef,
      coincide: p.renapoCoincide,
      probable: p.curpProbable,
      validadaLocalmente: p.curpValidada,
      sinCurp: p.sinCurp,
      sinCurpMotivo: p.sinCurpMotivo,
    },
    rfc: { valor: rfc, fuente: p.rfcFuente, generico: !!rfc && RFC_GENERICOS.has(rfc), cruceCurp },
    identificacion: { tipo: p.identificacionTipo, numero: p.identificacionNumero, vigencia: p.identificacionVigencia, vencida },
    avisoPrivacidad: { version: p.avisoPrivacidadVersion, aceptadoAt: p.avisoPrivacidadAceptadoAt, vigente: avisoVigente },
    pendientes,
  };
}
