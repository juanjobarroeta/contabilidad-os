// ─────────────────────────────────────────────────────────────────────────────
// SAEH — el archivo de intercambio EGR-{EE}{III}-{AA}{MM}.TXT.
//
// Texto plano ANSI (Latin-1), encabezado con los nombres de las 82 variables
// —copiado del archivo muestra de la DGIS, con sus dos erratas: la 53 dice
// PRIMERAPELLIDO donde va causaExterna y la 57 dice PROCEDIMIESTOS—, «|» entre
// variables, «&» entre repeticiones, «#» dentro de las compuestas, «||» cuando
// no aplica, LF entre renglones y sin salto final, igual que la muestra. El
// cifrado 3DES (.CIF) y el .ZIP los hace la herramienta de la DGIS.
// ─────────────────────────────────────────────────────────────────────────────

import type { ComorbilidadRegistro, ProcedimientoRegistro, ProductoRegistro, RegistroSaeh } from "./registro";
import { pesoSaeh } from "./texto";

/** Encabezado exacto del archivo muestra EGR-DFSSA-2605.txt (GIIS-B002-05-09 v5.9). */
export const VARIABLES_SAEH: readonly string[] = [
  "CLUES", "FOLIO", "CURPPACIENTE", "NOMBRE", "PRIMERAPELLIDO", "SEGUNDOAPELLIDO", "FECHANACIMIENTO", "PAISORIGEN", "ENTIDADNACIMIENTO", "NACIOHOSPITAL",
  "SEXOCURP", "SEXO", "PESO", "TALLA", "DERECHOHABIENCIA", "GRATUIDAD", "ESTADOCONYUGAL", "SECONSIDERAINDIGENA", "HABLALENGUAINDIGENA", "CUALLENGUA",
  "SECONSIDERAAFROMEXICANO", "ESMIGRANTERETORNADO", "SEIDENTIFICALGBTI", "GENERO", "PAISRESIDENCIA", "ENTIDADRESIDENCIA", "MUNICIPIORESIDENCIA",
  "LOCALIDADRESIDENCIA", "OTRALOCALIDAD", "CODIGOPOSTAL", "FECHAINGRESO", "FECHAEGRESO", "TIPOSERVICIOINGRESO", "CLAVESERVICIOINGRESO",
  "NUMEROSERVICIOSADICIONAL", "CLAVESERVICIOADICIONAL", "CLAVESERVICIOEGRESO", "TERAPIAINTENSIVADIAS", "TERAPIAINTENSIVAHORAS", "TERAPIAINTERMEDIADIAS",
  "TERAPIAINTERMEDIAHORAS", "PROCEDENCIA", "ESPECIFIQUEPROCEDENCIA", "CLUESPROCEDENCIA", "MOTIVOEGRESO", "CLUESREFERIDO", "MUJERFERTIL",
  "DESCRIPCIONAFECCIONPRINCIPAL", "CODIGOCIEAFECCIONPRINCIPAL", "COMORBILIDADES", "TIPOATENCION", "AFECCIONPRINCIPALRESELECCIONADA",
  // Errata de la DGIS: la variable 55 (causaExterna) sale rotulada PRIMERAPELLIDO.
  "PRIMERAPELLIDO",
  "CODIGOCIECAUSAEXTERNA", "MORFOLOGIA", "INFECCIONINTRAHOSPITALARIA",
  // Errata de la DGIS: PROCEDIMIESTOS.
  "PROCEDIMIESTOS",
  "FOLIOLESION", "MINISTERIOPUBLICO", "FOLIOCERTIFICADODEFUNCION", "GESTAS", "PARTOS", "ABORTOS", "CESAREAS", "EXTRACCIONEXPULSION", "EDADGESTACIONAL",
  "TIPOATENCIONOBSTETRICA", "TIPOPARTO", "TIPOPROCABORTO", "PRODUCTOEMBARAZO", "TOTALPRODUCTOS", "PLANIFICACIONFAMILIAR", "OTROMETODO", "PRODUCTOS",
  "TIPOUNIDAD", "TIPOSERVICIO", "PAISNACIMIENTO", "CURPRESPONSABLE", "NOMBRERESPONSABLE", "PRIMERAPELLIDORESPONSABLE", "SEGUNDOAPELLIDORESPONSABLE",
  "CEDULARESPONSABLE",
];

export const TOTAL_VARIABLES = 82;
export const ENCABEZADO_SAEH = VARIABLES_SAEH.join("|");
export const SEPARADOR_CAMPO = "|";
export const SEPARADOR_REPETICION = "&";
export const SEPARADOR_COMPUESTO = "#";

const n = (v: number | null | undefined): string => (v == null ? "" : String(v));
const aNumero = (s: string): number | null => (/^-?\d+(\.\d+)?$/.test(s.trim()) ? Number(s) : null);

// ── Compuestas ───────────────────────────────────────────────────────────────

export function empaquetarComorbilidades(lista: ComorbilidadRegistro[]): string {
  return lista.map((c, i) => [i + 1, c.descripcion, c.codigo].join(SEPARADOR_COMPUESTO)).join(SEPARADOR_REPETICION);
}

export function desempaquetarComorbilidades(texto: string): ComorbilidadRegistro[] {
  if (!texto) return [];
  return texto.split(SEPARADOR_REPETICION).map((t) => {
    const [, descripcion = "", codigo = ""] = t.split(SEPARADOR_COMPUESTO);
    return { descripcion, codigo };
  });
}

export function empaquetarProcedimientos(lista: ProcedimientoRegistro[]): string {
  return lista
    .map((p, i) => [i + 1, p.descripcion, p.codigo, n(p.tipoAnestesia), n(p.quirofano), p.tiempoQuirofano, p.cedula].join(SEPARADOR_COMPUESTO))
    .join(SEPARADOR_REPETICION);
}

export function desempaquetarProcedimientos(texto: string): ProcedimientoRegistro[] {
  if (!texto) return [];
  return texto.split(SEPARADOR_REPETICION).map((t) => {
    const [, descripcion = "", codigo = "", anestesia = "", quirofano = "", tiempo = "", cedula = ""] = t.split(SEPARADOR_COMPUESTO);
    return { descripcion, codigo, tipoAnestesia: aNumero(anestesia), quirofano: aNumero(quirofano), tiempoQuirofano: tiempo, cedula };
  });
}

export function empaquetarProductos(lista: ProductoRegistro[]): string {
  return lista
    .map((p, i) =>
      [i + 1, n(p.condicionNacimiento), n(p.condicionNacidoVivo), p.folioCertificado, n(p.apgar5), n(p.reanimacion), n(p.alojamientoConjunto), n(p.lactanciaExclusiva)].join(SEPARADOR_COMPUESTO)
    )
    .join(SEPARADOR_REPETICION);
}

export function desempaquetarProductos(texto: string): ProductoRegistro[] {
  if (!texto) return [];
  return texto.split(SEPARADOR_REPETICION).map((t) => {
    const [, nac = "", vivo = "", folio = "", apgar = "", rean = "", aloj = "", lact = ""] = t.split(SEPARADOR_COMPUESTO);
    return {
      condicionNacimiento: aNumero(nac),
      condicionNacidoVivo: aNumero(vivo),
      folioCertificado: folio,
      apgar5: aNumero(apgar),
      reanimacion: aNumero(rean),
      alojamientoConjunto: aNumero(aloj),
      lactanciaExclusiva: aNumero(lact),
    };
  });
}

// ── Registro ↔ campos ────────────────────────────────────────────────────────

/** Las 82 variables como texto, en el orden del diccionario. */
export function camposDeRegistro(r: RegistroSaeh): string[] {
  const campos = [
    r.clues, r.folio, r.curpPaciente, r.nombre, r.primerApellido, r.segundoApellido, r.fechaNacimiento, r.paisOrigen, r.entidadNacimiento, n(r.nacioHospital),
    n(r.sexoCURP), n(r.sexo), pesoSaeh(r.peso), n(r.talla), r.derechohabiencia, n(r.gratuidad), n(r.estadoConyugal), n(r.seConsideraIndigena), n(r.hablaLenguaIndigena), r.cualLengua,
    n(r.seConsideraAfromexicano), n(r.esMigranteRetornado), n(r.seIdentificaLGBTI), n(r.genero), r.paisResidencia, r.entidadResidencia, r.municipioResidencia,
    r.localidadResidencia, r.otraLocalidad, r.codigoPostal, r.fechaIngreso, r.fechaEgreso, n(r.tipoServicioIngreso), r.claveServicioIngreso,
    String(r.numeroServiciosAdicional), r.claveServicioAdicional.join(SEPARADOR_REPETICION), r.claveServicioEgreso, n(r.terapiaIntensivaDias), n(r.terapiaIntensivaHoras), n(r.terapiaIntermediaDias),
    n(r.terapiaIntermediaHoras), n(r.procedencia), r.especifiqueProcedencia, r.cluesProcedencia, n(r.motivoEgreso), r.cluesReferido, n(r.mujerFertil),
    r.descripcionAfeccionPrincipal, r.codigoCIEAfeccionPrincipal, empaquetarComorbilidades(r.comorbilidades), n(r.tipoAtencion), r.afeccionPrincipalReseleccionada,
    r.causaExterna, r.codigoCieCausaExterna, r.morfologia, n(r.infeccionIntraHospitalaria), empaquetarProcedimientos(r.procedimientos),
    r.folioLesion, n(r.ministerioPublico), r.folioCertificadoDefuncion, n(r.gestas), n(r.partos), n(r.abortos), n(r.cesareas), n(r.extraccionExpulsion), n(r.edadGestacional),
    n(r.tipoAtencionObstetrica), n(r.tipoParto), n(r.tipoProcAborto), n(r.productoEmbarazo), n(r.totalProductos), n(r.planificacionFamiliar), r.otroMetodo, empaquetarProductos(r.productos),
    n(r.tipoUnidad), n(r.tipoServicio), r.paisNacimiento, r.curpResponsable, r.nombreResponsable, r.primerApellidoResponsable, r.segundoApellidoResponsable,
    r.cedulaResponsable,
  ];
  if (campos.length !== TOTAL_VARIABLES) throw new Error(`Registro SAEH con ${campos.length} campos; deben ser ${TOTAL_VARIABLES}`);
  return campos;
}

/** Inverso de camposDeRegistro (para leer un archivo y para las pruebas de ida y vuelta). */
export function registroDeCampos(c: string[]): RegistroSaeh {
  if (c.length !== TOTAL_VARIABLES) throw new Error(`Renglón SAEH con ${c.length} campos; deben ser ${TOTAL_VARIABLES}`);
  let i = 0;
  const s = () => c[i++] ?? "";
  const num = () => aNumero(s());
  return {
    clues: s(), folio: s(), curpPaciente: s(), nombre: s(), primerApellido: s(), segundoApellido: s(), fechaNacimiento: s(), paisOrigen: s(), entidadNacimiento: s(), nacioHospital: num(),
    sexoCURP: num(), sexo: num(), peso: num(), talla: num(), derechohabiencia: s(), gratuidad: num(), estadoConyugal: num(), seConsideraIndigena: num(), hablaLenguaIndigena: num(), cualLengua: s(),
    seConsideraAfromexicano: num(), esMigranteRetornado: num(), seIdentificaLGBTI: num(), genero: num(), paisResidencia: s(), entidadResidencia: s(), municipioResidencia: s(),
    localidadResidencia: s(), otraLocalidad: s(), codigoPostal: s(), fechaIngreso: s(), fechaEgreso: s(), tipoServicioIngreso: num(), claveServicioIngreso: s(),
    numeroServiciosAdicional: num() ?? 0, claveServicioAdicional: (() => { const t = s(); return t ? t.split(SEPARADOR_REPETICION) : []; })(), claveServicioEgreso: s(),
    terapiaIntensivaDias: num(), terapiaIntensivaHoras: num(), terapiaIntermediaDias: num(), terapiaIntermediaHoras: num(), procedencia: num(), especifiqueProcedencia: s(),
    cluesProcedencia: s(), motivoEgreso: num(), cluesReferido: s(), mujerFertil: num(), descripcionAfeccionPrincipal: s(), codigoCIEAfeccionPrincipal: s(),
    comorbilidades: desempaquetarComorbilidades(s()), tipoAtencion: num(), afeccionPrincipalReseleccionada: s(), causaExterna: s(), codigoCieCausaExterna: s(), morfologia: s(),
    infeccionIntraHospitalaria: num(), procedimientos: desempaquetarProcedimientos(s()), folioLesion: s(), ministerioPublico: num(), folioCertificadoDefuncion: s(),
    gestas: num(), partos: num(), abortos: num(), cesareas: num(), extraccionExpulsion: num(), edadGestacional: num(), tipoAtencionObstetrica: num(), tipoParto: num(),
    tipoProcAborto: num(), productoEmbarazo: num(), totalProductos: num(), planificacionFamiliar: num(), otroMetodo: s(), productos: desempaquetarProductos(s()),
    tipoUnidad: num(), tipoServicio: num(), paisNacimiento: s(), curpResponsable: s(), nombreResponsable: s(), primerApellidoResponsable: s(), segundoApellidoResponsable: s(),
    cedulaResponsable: s(),
  };
}

// ── Archivo ──────────────────────────────────────────────────────────────────

export const lineaDeCampos = (campos: string[]) => campos.join(SEPARADOR_CAMPO);
export const camposDeLinea = (linea: string) => linea.split(SEPARADOR_CAMPO);

/** Renglón del archivo para un registro. */
export function lineaSaeh(r: RegistroSaeh): string {
  return lineaDeCampos(camposDeRegistro(r));
}

/** Texto completo: encabezado + un renglón por egreso, LF, sin salto final (como la muestra). */
export function textoArchivoSaeh(registros: RegistroSaeh[]): string {
  return [ENCABEZADO_SAEH, ...registros.map(lineaSaeh)].join("\n");
}

/** Bytes ANSI (Latin-1) del archivo. */
export function bytesArchivoSaeh(registros: RegistroSaeh[]): Buffer {
  return Buffer.from(textoArchivoSaeh(registros), "latin1");
}

/**
 * Nombre del archivo: EGR-{EE}{III}-{AA}{MM}.TXT, con EE las dos letras de
 * entidad de la CLUES e III la institución (SMP para privados).
 */
export function nombreArchivoSaeh(clues: string | null | undefined, institucion: string | null | undefined, anio: number, mes: number): string {
  const ee = (clues ?? "").toUpperCase().slice(0, 2).padEnd(2, "X");
  const iii = ((institucion ?? "").toUpperCase() || (clues ?? "").toUpperCase().slice(2, 5) || "SMP").slice(0, 3).padEnd(3, "X");
  return `EGR-${ee}${iii}-${String(anio % 100).padStart(2, "0")}${String(mes).padStart(2, "0")}.TXT`;
}

export interface ArchivoSaehLeido {
  encabezado: string[];
  registros: RegistroSaeh[];
  lineas: string[];
}

/** Lee un archivo de intercambio (bytes Latin-1) a registros; valida encabezado y número de campos. */
export function parsearArchivoSaeh(bytes: Buffer | Uint8Array): ArchivoSaehLeido {
  const texto = Buffer.from(bytes).toString("latin1").replace(/\r\n/g, "\n");
  const lineas = texto.split("\n").filter((l, i, arr) => !(i === arr.length - 1 && l === ""));
  if (!lineas.length) throw new Error("Archivo vacío");
  const encabezado = camposDeLinea(lineas[0]);
  if (encabezado.length !== TOTAL_VARIABLES) throw new Error(`Encabezado con ${encabezado.length} variables; deben ser ${TOTAL_VARIABLES}`);
  const registros = lineas.slice(1).map((l, i) => {
    const campos = camposDeLinea(l);
    if (campos.length !== TOTAL_VARIABLES) throw new Error(`Renglón ${i + 2} con ${campos.length} campos; deben ser ${TOTAL_VARIABLES}`);
    return registroDeCampos(campos);
  });
  return { encabezado, registros, lineas };
}

/** Folio SAEH: AAMM + consecutivo de 4 dígitos (8 dígitos, único por CLUES y fecha de egreso). */
export function formatearFolioSaeh(anio: number, mes: number, consecutivo: number): string {
  return `${String(anio % 100).padStart(2, "0")}${String(mes).padStart(2, "0")}${String(consecutivo).padStart(4, "0")}`;
}

export function prefijoFolioSaeh(anio: number, mes: number): string {
  return `${String(anio % 100).padStart(2, "0")}${String(mes).padStart(2, "0")}`;
}

/** Siguiente consecutivo dado lo ya emitido con ese prefijo AAMM. */
export function siguienteConsecutivoSaeh(folios: (string | null | undefined)[], anio: number, mes: number): number {
  const prefijo = prefijoFolioSaeh(anio, mes);
  let mayor = 0;
  for (const f of folios) {
    if (!f || !f.startsWith(prefijo) || f.length !== 8) continue;
    const nn = Number(f.slice(4));
    if (Number.isFinite(nn) && nn > mayor) mayor = nn;
  }
  return mayor + 1;
}
