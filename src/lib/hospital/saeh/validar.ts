// ─────────────────────────────────────────────────────────────────────────────
// SAEH — las reglas del diccionario de datos de la GIIS-B002-05-09 v5.9.
//
// Cada regla es una función chica que deja `{ campo, mensaje }` en errores (la
// DGIS rechazaría el registro) o en advertencias (se exporta, pero conviene
// revisar). `campo` es el nombre del campo en nuestra hoja/paciente/episodio
// para que el satélite lo señale; el mensaje nombra la variable de la GIIS.
// Corre sobre el registro ya construido (registro.ts) más la fuente, y sólo
// consulta catálogos a través de CatalogoSaeh (memoizado / en memoria).
// ─────────────────────────────────────────────────────────────────────────────

import { motivoRestriccionCie, type FilaCie } from "../cie";
import { validarCurp } from "../curp";
import { diasEntre, partesLocales } from "../tz";
import type { CatalogoSaeh } from "./catalogo";
import {
  CLUES_TIPO_CONSULTA_EXTERNA, CLUES_TIPO_HOSPITALIZACION, CURP_GENERICA, DERECHOHABIENCIA_GIIS, DIU_CIE9, ENTIDAD_POR_ABREVIATURA, FECHA_DESCONOCIDA,
  PAIS_MEXICO, PALABRAS_INVALIDAS_OTRO_METODO, PALABRAS_INVALIDAS_PROCEDENCIA, SERVICIOS_GINECO_SIN_EDAD, SERVICIOS_NEONATALES, SERVICIO_GERIATRIA,
  SERVICIOS_TERAPIA_INTENSIVA, SERVICIOS_TERAPIA_INTERMEDIA, TIPOLOGIAS_CONSULTA_EXTERNA_CON_EGRESOS,
  causaExternaOpcional, esAborto, esCausaExterna, esCesareaCie9, esComorbilidadSustantiva, esEsterilizacionHombre, esEsterilizacionMujer, esHisterectomia,
  esParto, esServicioGineco, esServicioPediatrico, esTraumatismo, esTumor, validaComoAfeccionPrincipal, categoriaCie, mesesDeEdad, entidadDeCurp,
} from "./codigos";
import type { ContextoSaeh } from "./contexto";
import { aplicaBloqueObstetrico, claveLocalidad, claveMunicipio, diagnosticosDelRegistro, esMujerEnEdadFertil, nombresDeMedico, type RegistroSaeh } from "./registro";
import { normalizarCedula, perdidaAlNormalizar, tiempoQuirofanoValido } from "./texto";

export interface ProblemaSaeh {
  campo: string;
  mensaje: string;
}

export interface ValidacionSaeh {
  errores: ProblemaSaeh[];
  advertencias: ProblemaSaeh[];
}

class Reporte implements ValidacionSaeh {
  errores: ProblemaSaeh[] = [];
  advertencias: ProblemaSaeh[] = [];
  error(campo: string, mensaje: string) {
    if (!this.errores.some((e) => e.campo === campo && e.mensaje === mensaje)) this.errores.push({ campo, mensaje });
  }
  aviso(campo: string, mensaje: string) {
    if (!this.advertencias.some((e) => e.campo === campo && e.mensaje === mensaje)) this.advertencias.push({ campo, mensaje });
  }
}

type Ctx = ContextoSaeh & { r: Reporte; reg: RegistroSaeh; catalogo: CatalogoSaeh };

const entero = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const en = (v: number | null, ...opciones: number[]) => v != null && opciones.includes(v);
const lista = (opciones: number[]) => opciones.join(", ");
const CLAVE_CIE10 = /^[A-Z]\d{2}[0-9X]$/;
const CLAVE_CIE9 = /^\d[0-9A-Z]{3}$/;
const CLUES_RE = /^[A-Z]{5}\d{6}$/;

function anioDeFecha(ddmmaaaa: string): number | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(ddmmaaaa);
  return m ? Number(m[3]) : null;
}

// ── Establecimiento y folio (1-2) ────────────────────────────────────────────

async function validarEstablecimiento(c: Ctx) {
  const { r, reg, fuente } = c;
  const est = fuente.establecimiento;
  if (!reg.clues) {
    r.error("clues", "La CLUES del establecimiento no está configurada (HospConfig.clues): la GIIS la exige en cada registro");
    return;
  }
  if (!CLUES_RE.test(reg.clues)) r.error("clues", `La CLUES «${reg.clues}» no tiene el formato de la DGIS (5 letras y 6 dígitos, p. ej. PLSMP000014)`);
  if (!est.enCatalogo) {
    r.aviso("clues", `La CLUES «${reg.clues}» no está en el catálogo ESTABLECIMIENTO DE SALUD cargado: verifica que sea la asignada por la DGIS`);
    return;
  }
  if (!est.enOperacion) r.error("clues", `La CLUES «${reg.clues}» no está EN OPERACIÓN según el catálogo (estatus ${est.estatus ?? "?"})`);
  const consultaExternaValida = est.tipo === CLUES_TIPO_CONSULTA_EXTERNA && !!est.tipologia && TIPOLOGIAS_CONSULTA_EXTERNA_CON_EGRESOS.includes(est.tipologia);
  if (est.tipo !== CLUES_TIPO_HOSPITALIZACION && !consultaExternaValida) {
    r.error("clues", `La CLUES «${reg.clues}» es de tipo ${est.tipo ?? "?"} / tipología ${est.tipologia ?? "?"}: sólo reportan egresos las unidades de HOSPITALIZACIÓN (tipo 2) o de consulta externa CAP, CES, CLI, T, UNE o Z`);
  }
  if (reg.folio && !/^\d{1,8}$/.test(reg.folio)) r.error("folioSaeh", `El folio «${reg.folio}» debe ser numérico de 1 a 8 dígitos`);
}

// ── Datos del paciente (3-24) ────────────────────────────────────────────────

function revisarNombre(c: Ctx, campo: string, variable: string, original: string | null | undefined, normalizado: string, permiteXX = false) {
  const { r } = c;
  if (!normalizado || (normalizado === "XX" && permiteXX && !original?.trim())) {
    if (!permiteXX) r.error(campo, `${variable} es obligatorio`);
    return;
  }
  if (normalizado.length < 2) r.error(campo, `${variable} debe tener al menos 2 caracteres`);
  if (normalizado.length > 50) r.error(campo, `${variable} no puede exceder 50 caracteres (tiene ${normalizado.length})`);
  if (original && perdidaAlNormalizar(original, normalizado)) {
    r.aviso(campo, `${variable} perderá caracteres al exportarse como «${normalizado}» (sólo se admiten A-Z, Ñ, diéresis y - . / ')`);
  }
}

function revisarDescripcion(c: Ctx, campo: string, variable: string, original: string | null | undefined, normalizado: string) {
  const { r } = c;
  if (!normalizado) {
    r.error(campo, `${variable} es obligatoria (texto libre del médico, 2 a 250 caracteres)`);
    return;
  }
  if (normalizado.length < 2) r.error(campo, `${variable} debe tener al menos 2 caracteres`);
  if (!/^[A-ZÑ]/.test(normalizado)) r.error(campo, `${variable} debe iniciar con una letra`);
  if (original && perdidaAlNormalizar(original, normalizado)) {
    r.aviso(campo, `${variable} perderá caracteres al exportarse como «${normalizado.length > 60 ? normalizado.slice(0, 60) + "…" : normalizado}» (sólo 0-9, A-Z y Ñ, máximo 250)`);
  }
}

async function validarIdentidad(c: Ctx) {
  const { r, reg, paciente, edad, fuente } = c;
  const generica = reg.curpPaciente === CURP_GENERICA;

  if (generica) {
    if (!paciente.sinCurp) r.error("paciente.curp", "El paciente no tiene CURP: captúrala o marca sinCurp con su motivo (la DGIS acepta como máximo 40 % de CURP genéricas por carga)");
    else r.aviso("paciente.curp", "Se exportará la CURP genérica XXXX999999XXXXXX99 (la DGIS acepta como máximo 40 % de genéricas por carga)");
  } else {
    const v = validarCurp(reg.curpPaciente);
    if (!v.valida) r.error("paciente.curp", `curpPaciente: ${v.motivo ?? "CURP inválida"}`);
    if (reg.curpResponsable && reg.curpResponsable !== CURP_GENERICA && reg.curpResponsable === reg.curpPaciente) {
      r.error("paciente.curp", "curpPaciente no puede ser igual a curpResponsable");
    }
  }

  revisarNombre(c, "paciente.nombre", "nombre", paciente.nombre, reg.nombre);
  revisarNombre(c, "paciente.apellidoPaterno", "primerApellido", paciente.apellidoPaterno, reg.primerApellido, true);
  revisarNombre(c, "paciente.apellidoMaterno", "segundoApellido", paciente.apellidoMaterno, reg.segundoApellido, true);
  if (!paciente.apellidoPaterno?.trim()) r.aviso("paciente.apellidoPaterno", "Sin primer apellido: se exportará «XX»");

  // Fecha de nacimiento y edad.
  if (!paciente.fechaNacimiento) {
    if (generica) r.aviso("paciente.fechaNacimiento", `Sin fecha de nacimiento: se exportará ${FECHA_DESCONOCIDA} y no se pueden aplicar las reglas por edad`);
    else r.error("paciente.fechaNacimiento", "fechaNacimiento es obligatoria (dd/mm/aaaa)");
  } else {
    if (paciente.fechaNacimiento.getTime() > fuente.episodio.fechaIngreso.getTime() && diasEntre(paciente.fechaNacimiento, fuente.episodio.fechaIngreso) < 0) {
      r.error("paciente.fechaNacimiento", "fechaNacimiento no puede ser posterior a fechaIngreso");
    }
    if (edad && edad.anios > 110) r.error("paciente.fechaNacimiento", `La edad al egreso (${edad.anios} años) no puede ser mayor a 110`);
    if (!generica) {
      const v = validarCurp(reg.curpPaciente);
      if (v.valida && v.fechaNacimiento) {
        const p = partesLocales(paciente.fechaNacimiento);
        const q = v.fechaNacimiento;
        if (p.y !== q.getUTCFullYear() || p.m !== q.getUTCMonth() + 1 || p.d !== q.getUTCDate()) {
          r.error("paciente.fechaNacimiento", "fechaNacimiento no coincide con la fecha que trae la CURP");
        }
      }
    }
  }

  // País y entidad de nacimiento.
  if (!reg.paisOrigen) r.error("paciente.paisNacimientoClave", "paisOrigen es obligatorio (catálogo PAIS; 142 México, 248 no especificado)");
  else if (!(await c.catalogo.fila("PAIS", reg.paisOrigen))) r.error("paciente.paisNacimientoClave", `paisOrigen «${reg.paisOrigen}» no existe en el catálogo PAIS`);
  if (reg.paisOrigen === PAIS_MEXICO) {
    if (!reg.entidadNacimiento) r.error("paciente.entidadNacimientoClave", "entidadNacimiento es obligatoria cuando paisOrigen es 142 México (catálogo ENTIDAD FEDERATIVA; 99 se ignora, 00 no especificado)");
    else if (reg.entidadNacimiento === "88") r.error("paciente.entidadNacimientoClave", "entidadNacimiento 88 (no aplica) sólo va con paisOrigen distinto de México");
    else if (!(await c.catalogo.fila("ENTIDAD", reg.entidadNacimiento))) r.error("paciente.entidadNacimientoClave", `entidadNacimiento «${reg.entidadNacimiento}» no existe en el catálogo ENTIDAD FEDERATIVA`);
    if (!generica) {
      const ent = entidadDeCurp(reg.curpPaciente);
      if (ent === "NE") r.aviso("paciente.paisNacimientoClave", "La CURP dice nacido en el extranjero (NE) y paisOrigen es 142 México: revisa el país de nacimiento");
      else if (ent && reg.entidadNacimiento && !["99", "00"].includes(reg.entidadNacimiento) && ent !== reg.entidadNacimiento) {
        r.error("paciente.entidadNacimientoClave", `entidadNacimiento «${reg.entidadNacimiento}» no coincide con la entidad de la CURP (${ent})`);
      }
    }
  } else if (reg.paisOrigen && !generica) {
    const ent = entidadDeCurp(reg.curpPaciente);
    if (ent && ent !== "NE") r.aviso("paciente.paisNacimientoClave", `La CURP indica nacimiento en la entidad ${ent} (México) y paisOrigen es «${reg.paisOrigen}»: revisa el país de nacimiento`);
  }

  // Nació en el hospital (≤ 3 meses).
  if (edad && mesesDeEdad(edad) <= 3 && !en(reg.nacioHospital, 1, 2)) {
    r.error("nacioHospital", "nacioHospital es obligatorio en menores de 3 meses: 1 sí, 2 no");
  }

  // Sexo.
  if (!en(reg.sexo, 1, 2, 3)) r.error("paciente.sexo", "sexo es obligatorio: 1 hombre, 2 mujer, 3 intersexual");
  if (reg.sexoCURP == null) r.error("paciente.curp", "sexoCURP no se pudo determinar: la posición 11 de la CURP debe ser H, M o X");
  else if (!generica && reg.sexo != null && reg.sexoCURP !== 3 && reg.sexo !== 3 && reg.sexoCURP !== reg.sexo) {
    r.aviso("paciente.sexo", `sexo (${reg.sexo}) difiere del sexo registrado en la CURP (${reg.sexoCURP})`);
  }

  // Peso y talla.
  if (reg.peso == null) r.error("peso", "peso es obligatorio en kilogramos (###.###); 999 si se desconoce");
  else if (reg.peso !== 999) {
    if (reg.peso < 0.5 || reg.peso > 400) r.error("peso", `peso ${reg.peso} fuera del rango 0.5 a 400 kg`);
    else if (edad) {
      if (edad.tipo === 2 && reg.peso > 8) r.error("peso", `peso ${reg.peso} kg no es coherente con una edad en horas (0.5 a 8 kg)`);
      if (edad.tipo === 3 && reg.peso > 12) r.error("peso", `peso ${reg.peso} kg no es coherente con una edad en días (máximo 12 kg)`);
      if (edad.tipo === 4 && reg.peso > 20) r.error("peso", `peso ${reg.peso} kg no es coherente con una edad en meses (máximo 20 kg)`);
      if (edad.tipo === 5 && reg.peso < 5) r.error("peso", `peso ${reg.peso} kg no es coherente con una edad en años (mínimo 5 kg)`);
    }
    if (!/^\d{1,3}(\.\d{1,3})?$/.test(String(reg.peso))) r.error("peso", "peso admite hasta 3 enteros y 3 decimales (###.###)");
  }
  if (reg.talla == null) r.error("talla", "talla es obligatoria en centímetros; 999 si se desconoce");
  else if (reg.talla !== 999 && (reg.talla < 20 || reg.talla > 220)) r.error("talla", `talla ${reg.talla} fuera del rango 20 a 220 cm`);

  // Derechohabiencia y gratuidad.
  if (!reg.derechohabiencia) r.error("paciente.derechohabienciaClave", "derechohabiencia es obligatoria (catálogo AFILIACION: 1 ninguna, 2 IMSS, 3 ISSSTE… 8 otra, 99 se ignora, 0 no especificado)");
  else if (!DERECHOHABIENCIA_GIIS[reg.derechohabiencia]) {
    r.error("paciente.derechohabienciaClave", `derechohabiencia «${reg.derechohabiencia}» no está entre las opciones de la GIIS v5.9 (${Object.keys(DERECHOHABIENCIA_GIIS).join(", ")})`);
  } else {
    const f = await c.catalogo.fila("AFILIACION", reg.derechohabiencia);
    if (f && !f.activo) r.error("paciente.derechohabienciaClave", `derechohabiencia «${reg.derechohabiencia} ${f.nombre}» está dada de baja en el catálogo AFILIACION`);
  }
  if (fuente.establecimiento.entidad === "09" && reg.derechohabiencia === "8" && !en(reg.gratuidad, 1, 2)) {
    r.error("gratuidad", "gratuidad es obligatoria en unidades de la Ciudad de México con derechohabiencia 8 OTRA: 1 sí, 2 no");
  }

  // Estado conyugal.
  if (edad && edad.anios >= 10) {
    if (!en(reg.estadoConyugal, 0, 1, 2, 3, 4, 5, 6, 9)) r.error("paciente.estadoConyugal", "estadoConyugal es obligatorio: 1 soltero, 2 viudo, 3 divorciado, 4 unión libre, 5 casado, 6 separado, 9 se ignora, 0 no especificado");
  } else if (!edad && !en(reg.estadoConyugal, 0, 1, 2, 3, 4, 5, 6, 8, 9)) {
    r.error("paciente.estadoConyugal", "estadoConyugal es obligatorio (catálogo ESTADO CONYUGAL)");
  }

  // Indígena, lengua, afromexicano, migrante, LGBTI, género.
  if (!en(reg.seConsideraIndigena, 1, 2)) r.error("paciente.seConsideraIndigena", "seConsideraIndigena es obligatorio: 1 sí, 2 no");
  if (reg.hablaLenguaIndigena !== 8 && !en(reg.hablaLenguaIndigena, 1, 2)) r.error("paciente.hablaLenguaIndigena", "hablaLenguaIndigena es obligatorio en mayores de un año: 1 sí, 2 no");
  if (reg.hablaLenguaIndigena === 1) {
    if (!reg.cualLengua || reg.cualLengua === "-1") r.error("paciente.lenguaIndigenaClave", "cualLengua es obligatoria cuando hablaLenguaIndigena es 1 sí (catálogo LENGUA_INDIGENA)");
    else if (!(await c.catalogo.fila("LENGUA", reg.cualLengua))) r.error("paciente.lenguaIndigenaClave", `cualLengua «${reg.cualLengua}» no existe en el catálogo LENGUA_INDIGENA`);
  }
  if (!en(reg.seConsideraAfromexicano, 1, 2)) r.error("paciente.seConsideraAfromexicano", "seConsideraAfromexicano es obligatorio: 1 sí, 2 no");
  if (reg.esMigranteRetornado !== 8 && !en(reg.esMigranteRetornado, 1, 2)) r.error("paciente.esMigranteRetornado", "esMigranteRetornado es obligatorio cuando paisOrigen es 142 México: 1 sí, 2 no");
  if (reg.seIdentificaLGBTI !== 8 && !en(reg.seIdentificaLGBTI, 1, 2, 3)) r.error("paciente.seIdentificaLgbti", "seIdentificaLGBTI es obligatorio en mayores de 10 años: 1 sí, 2 no, 3 prefiere no responder");
  if (reg.seIdentificaLGBTI === 1 && !en(reg.genero, 1, 2, 3, 4, 5, 6)) r.error("paciente.genero", "genero es obligatorio cuando seIdentificaLGBTI es 1 sí: 1 mujer trans, 2 hombre trans, 3 no binaria, 4 lesbiana, 5 gay, 6 bisexual");
}

// ── Domicilio (25-30) ────────────────────────────────────────────────────────

async function validarDomicilio(c: Ctx) {
  const { r, reg, paciente } = c;
  if (!reg.paisResidencia) {
    r.error("paciente.paisResidenciaClave", "paisResidencia es obligatorio (catálogo PAIS; 142 México)");
    return;
  }
  if (!(await c.catalogo.fila("PAIS", reg.paisResidencia))) r.error("paciente.paisResidenciaClave", `paisResidencia «${reg.paisResidencia}» no existe en el catálogo PAIS`);
  if (reg.paisResidencia !== PAIS_MEXICO) return; // 88 / 997 / 9997 / 00000 los pone el registro

  if (!reg.entidadResidencia) r.error("paciente.entidadResidenciaClave", "entidadResidencia es obligatoria cuando paisResidencia es 142 México (99 se ignora, 00 no especificado)");
  else if (reg.entidadResidencia === "88") r.error("paciente.entidadResidenciaClave", "entidadResidencia 88 (no aplica) sólo va con residencia fuera de México");
  else if (!(await c.catalogo.fila("ENTIDAD", reg.entidadResidencia))) r.error("paciente.entidadResidenciaClave", `entidadResidencia «${reg.entidadResidencia}» no existe en el catálogo ENTIDAD FEDERATIVA`);

  const entidadReal = /^(0[1-9]|[12]\d|3[0-2])$/.test(reg.entidadResidencia);
  if (entidadReal) {
    if (!reg.municipioResidencia) r.error("paciente.municipioResidenciaClave", "municipioResidencia es obligatorio (catálogo MUNICIPIO de la entidad)");
    else if (reg.municipioResidencia === "998" || reg.municipioResidencia === "999") {
      r.error("paciente.municipioResidenciaClave", `municipioResidencia ${reg.municipioResidencia} sólo va cuando entidadResidencia es 99 o 00`);
    } else {
      const cm = claveMunicipio(paciente.municipioResidenciaClave, reg.entidadResidencia);
      const fm = cm ? await c.catalogo.fila("MUNICIPIO", cm) : null;
      if (!fm) r.error("paciente.municipioResidenciaClave", `municipioResidencia «${reg.municipioResidencia}» no existe en el catálogo MUNICIPIO para la entidad ${reg.entidadResidencia}`);
      else if (fm.padre && fm.padre !== reg.entidadResidencia) r.error("paciente.municipioResidenciaClave", `municipioResidencia «${reg.municipioResidencia}» pertenece a la entidad ${fm.padre}, no a ${reg.entidadResidencia}`);

      if (!reg.localidadResidencia) r.error("paciente.localidadResidenciaClave", "localidadResidencia es obligatoria (catálogo LOCALIDAD; 9999 no especificado, 9998 se ignora)");
      else if (reg.localidadResidencia !== "9998" && reg.localidadResidencia !== "9999") {
        const cl = claveLocalidad(paciente.localidadResidenciaClave, reg.entidadResidencia, reg.municipioResidencia);
        const fl = cl ? await c.catalogo.fila("LOCALIDAD", cl) : null;
        if (!fl) r.error("paciente.localidadResidenciaClave", `localidadResidencia «${reg.localidadResidencia}» no existe en el catálogo LOCALIDAD para el municipio ${reg.entidadResidencia}${reg.municipioResidencia}`);
      }
    }
  }
  if (reg.localidadResidencia === "9999" && paciente.otraLocalidad && perdidaAlNormalizar(paciente.otraLocalidad, reg.otraLocalidad)) {
    r.aviso("paciente.otraLocalidad", `otraLocalidad perderá caracteres al exportarse como «${reg.otraLocalidad}»`);
  }
  if (reg.localidadResidencia !== "9999" && paciente.otraLocalidad?.trim()) r.aviso("paciente.otraLocalidad", "otraLocalidad sólo se exporta cuando localidadResidencia es 9999 no especificado");

  if (!reg.codigoPostal) r.error("paciente.codigoPostal", "codigoPostal es obligatorio (5 dígitos; 00000 si no está en la hoja, 99999 si se ignora)");
  else if (!/^\d{5}$/.test(reg.codigoPostal)) r.error("paciente.codigoPostal", `codigoPostal «${reg.codigoPostal}» debe tener 5 dígitos`);
}

// ── Estancia (31-46) ─────────────────────────────────────────────────────────

async function revisarServicio(c: Ctx, campo: string, variable: string, clave: string) {
  const { r, reg, edad } = c;
  const f = await c.catalogo.fila("SERVICIO", clave);
  if (!f) {
    r.error(campo, `${variable} «${clave}» no existe en el catálogo SERVICIOS_ESPECIALIDADES`);
    return;
  }
  if (!edad) return;
  if (esServicioPediatrico(clave) && edad.anios >= 18) r.error(campo, `${variable} ${clave} ${f.nombre} es pediátrico: el paciente tiene ${edad.texto}`);
  if (clave === SERVICIO_GERIATRIA && edad.anios < 60) r.error(campo, `${variable} 108 GERIATRÍA exige 60 años o más (el paciente tiene ${edad.texto})`);
  if ((SERVICIOS_NEONATALES as readonly string[]).includes(clave) && edad.dias > 28) r.error(campo, `${variable} ${clave} ${f.nombre} es neonatal (≤ 28 días): el paciente tiene ${edad.texto}`);
  if (esServicioGineco(clave) && !(SERVICIOS_GINECO_SIN_EDAD as readonly string[]).includes(clave)) {
    if (reg.sexo !== 2) r.error(campo, `${variable} ${clave} ${f.nombre} es de ginecoobstetricia: el paciente debe ser mujer`);
    else if (edad.anios < 9 || edad.anios > 59) r.error(campo, `${variable} ${clave} ${f.nombre} exige mujer de 9 a 59 años (tiene ${edad.texto})`);
  }
}

async function revisarClues(c: Ctx, campo: string, variable: string, clues: string) {
  const { r, reg } = c;
  if (!CLUES_RE.test(clues)) {
    r.error(campo, `${variable} «${clues}» no tiene formato de CLUES (5 letras y 6 dígitos)`);
    return;
  }
  if (clues === reg.clues) r.error(campo, `${variable} no puede ser la CLUES de esta misma unidad`);
  const f = await c.catalogo.fila("CLUES", clues);
  if (!f) r.error(campo, `${variable} «${clues}» no existe en el catálogo ESTABLECIMIENTO DE SALUD`);
  else if (f.datos?.estatus !== "1") r.error(campo, `${variable} «${clues} ${f.nombre}» no está EN OPERACIÓN (${f.datos?.estatusNombre ?? "estatus " + String(f.datos?.estatus ?? "?")})`);
}

async function validarEstancia(c: Ctx) {
  const { r, reg, fuente, hoy, paciente } = c;
  const ep = fuente.episodio;

  if (!ep.fechaAlta) r.error("episodio.fechaAlta", "fechaEgreso: el episodio no tiene fecha de alta; el egreso se reporta cuando el paciente sale");
  else {
    if (ep.fechaAlta.getTime() < ep.fechaIngreso.getTime()) r.error("episodio.fechaAlta", "fechaEgreso no puede ser anterior a fechaIngreso");
    if (ep.fechaAlta.getTime() > hoy.getTime()) r.error("episodio.fechaAlta", "fechaEgreso no puede ser posterior a la fecha de registro");
    const anios = (ep.fechaAlta.getTime() - ep.fechaIngreso.getTime()) / (365.25 * 86_400_000);
    if (anios > 5 && !fuente.establecimiento.psiquiatrico) r.error("episodio.fechaIngreso", "fechaIngreso no puede exceder cinco años respecto a fechaEgreso (salvo unidades psiquiátricas)");
  }
  if (ep.fechaIngreso.getTime() > hoy.getTime()) r.error("episodio.fechaIngreso", "fechaIngreso no puede ser posterior a la fecha de registro");
  if (paciente.fechaNacimiento && diasEntre(paciente.fechaNacimiento, ep.fechaIngreso) < 0) r.error("episodio.fechaIngreso", "fechaIngreso no puede ser anterior a fechaNacimiento");

  if (!en(reg.tipoServicioIngreso, 1, 2)) r.error("tipoServicioIngreso", "tipoServicioIngreso es obligatorio: 1 normal, 2 corta estancia");
  if (reg.tipoServicioIngreso === 1) {
    if (!reg.claveServicioIngreso || reg.claveServicioIngreso === "-1") r.error("claveServicioIngreso", "claveServicioIngreso es obligatoria con tipoServicioIngreso 1 normal (catálogo SERVICIOS_ESPECIALIDADES)");
    else await revisarServicio(c, "claveServicioIngreso", "claveServicioIngreso", reg.claveServicioIngreso);
    if (reg.numeroServiciosAdicional > 2) r.error("serviciosAdicionales", "claveServicioAdicional admite como máximo 2 servicios");
    const vistos = new Set<string>([reg.claveServicioIngreso]);
    for (const [i, s] of reg.claveServicioAdicional.entries()) {
      await revisarServicio(c, `serviciosAdicionales[${i}]`, "claveServicioAdicional", s);
      if (vistos.has(s)) r.error(`serviciosAdicionales[${i}]`, `claveServicioAdicional «${s}» repite el servicio de ingreso u otro servicio adicional`);
      vistos.add(s);
    }
  } else if (reg.tipoServicioIngreso === 2 && c.hoja.serviciosAdicionales.length) {
    r.aviso("serviciosAdicionales", "Con tipoServicioIngreso 2 corta estancia no se exportan servicios adicionales");
  }

  if (!reg.claveServicioEgreso) r.error("claveServicioEgreso", "claveServicioEgreso es obligatoria (catálogo SERVICIOS_ESPECIALIDADES)");
  else await revisarServicio(c, "claveServicioEgreso", "claveServicioEgreso", reg.claveServicioEgreso);

  // Terapia intensiva / intermedia.
  const servicios = [reg.claveServicioIngreso, ...reg.claveServicioAdicional];
  const diasEstancia = ep.fechaAlta ? Math.max(0, diasEntre(ep.fechaIngreso, ep.fechaAlta)) : null;
  const revisarTerapia = (nombre: "Intensiva" | "Intermedia", aplica: boolean, dias: number | null, horas: number | null, campoDias: string, campoHoras: string) => {
    if (!aplica) return;
    if (dias == null) r.error(campoDias, `terapia${nombre}Dias es obligatorio cuando pasó por ${nombre === "Intensiva" ? "terapia intensiva (602-605, 701)" : "terapia intermedia (606, 703)"}: 0 a 90, o 99 si no está en la hoja`);
    else if (dias !== 99 && (dias < 0 || dias > 90)) r.error(campoDias, `terapia${nombre}Dias ${dias} fuera del rango 0 a 90`);
    if (horas == null) r.error(campoHoras, `terapia${nombre}Horas es obligatorio: 0 a 23, o 99 si no está en la hoja`);
    else if (horas !== 99 && (horas < 0 || horas > 23)) r.error(campoHoras, `terapia${nombre}Horas ${horas} fuera del rango 0 a 23`);
    if (dias === 0 && horas != null && horas !== 99 && horas <= 0) r.error(campoHoras, `terapia${nombre}Horas debe ser mayor a 0 cuando terapia${nombre}Dias es 0`);
  };
  const intensiva = servicios.some((s) => (SERVICIOS_TERAPIA_INTENSIVA as readonly string[]).includes(s));
  const intermedia = servicios.some((s) => (SERVICIOS_TERAPIA_INTERMEDIA as readonly string[]).includes(s));
  revisarTerapia("Intensiva", intensiva, reg.terapiaIntensivaDias, reg.terapiaIntensivaHoras, "terapiaIntensivaDias", "terapiaIntensivaHoras");
  revisarTerapia("Intermedia", intermedia, reg.terapiaIntermediaDias, reg.terapiaIntermediaHoras, "terapiaIntermediaDias", "terapiaIntermediaHoras");
  if (diasEstancia != null) {
    const suma = (reg.terapiaIntensivaDias === 99 ? 0 : reg.terapiaIntensivaDias ?? 0) + (reg.terapiaIntermediaDias === 99 ? 0 : reg.terapiaIntermediaDias ?? 0);
    if (suma > diasEstancia) r.error("terapiaIntensivaDias", `La suma de días en terapia intensiva e intermedia (${suma}) excede los días de estancia (${diasEstancia})`);
  }

  // Procedencia.
  if (!en(reg.procedencia, 1, 2, 3, 4, 5)) r.error("procedencia", "procedencia es obligatoria: 1 consulta externa, 2 urgencias, 3 referido, 4 cunero patológico, 5 otro");
  if (reg.procedencia === 4 && c.edad && mesesDeEdad(c.edad) >= 1) r.error("procedencia", `procedencia 4 cunero patológico exige menor de un mes (tiene ${c.edad.texto})`);
  if (reg.procedencia === 5) {
    if (!reg.especifiqueProcedencia) r.error("especifiqueProcedencia", "especifiqueProcedencia es obligatorio con procedencia 5 otro (sólo letras, sin acentos)");
    else {
      if (reg.especifiqueProcedencia.length < 2) r.error("especifiqueProcedencia", "especifiqueProcedencia debe tener al menos 2 caracteres");
      if (PALABRAS_INVALIDAS_PROCEDENCIA.includes(reg.especifiqueProcedencia)) r.error("especifiqueProcedencia", `especifiqueProcedencia «${reg.especifiqueProcedencia}» es una de las opciones de procedencia: elige la opción, no la escribas`);
      if (c.hoja.especifiqueProcedencia && perdidaAlNormalizar(c.hoja.especifiqueProcedencia, reg.especifiqueProcedencia)) r.aviso("especifiqueProcedencia", `especifiqueProcedencia perderá caracteres al exportarse como «${reg.especifiqueProcedencia}» (sólo letras)`);
    }
  } else if (c.hoja.especifiqueProcedencia?.trim()) r.aviso("especifiqueProcedencia", "especifiqueProcedencia sólo se exporta con procedencia 5 otro");
  if (reg.procedencia === 3) {
    if (!reg.cluesProcedencia) r.error("cluesProcedencia", "cluesProcedencia es obligatoria con procedencia 3 referido (catálogo ESTABLECIMIENTO DE SALUD)");
    else await revisarClues(c, "cluesProcedencia", "cluesProcedencia", reg.cluesProcedencia);
  } else if (c.hoja.cluesProcedencia?.trim()) r.aviso("cluesProcedencia", "cluesProcedencia sólo se exporta con procedencia 3 referido");

  // Motivo de egreso y referencia.
  if (!reg.motivoEgreso) r.error("episodio.motivoEgreso", "motivoEgreso es obligatorio: el episodio no tiene motivo de egreso (se captura al dar el alta)");
  if (reg.motivoEgreso === 4) {
    if (!reg.cluesReferido) r.error("cluesReferido", "cluesReferido es obligatoria con motivoEgreso 4 traslado a otra unidad (catálogo ESTABLECIMIENTO DE SALUD)");
    else await revisarClues(c, "cluesReferido", "cluesReferido", reg.cluesReferido);
  } else if (c.hoja.cluesReferido?.trim()) r.aviso("cluesReferido", "cluesReferido sólo se exporta con motivoEgreso 4 traslado");
}

// ── Afecciones (47-58) ───────────────────────────────────────────────────────

interface OpcionesCie {
  variable: string;
  principal?: boolean;
  sinCapituloXX?: boolean;
  soloCapituloXX?: boolean;
}

async function revisarCie10(c: Ctx, campo: string, clave: string, o: OpcionesCie): Promise<FilaCie | null> {
  const { r, paciente, edad } = c;
  if (!CLAVE_CIE10.test(clave)) {
    r.error(campo, `${o.variable} «${clave}» debe ser una clave CIE-10 de 4 caracteres (p. ej. K219, I10X)`);
    return null;
  }
  const fila = await c.catalogo.cie("CIE10", clave);
  if (!fila) {
    r.error(campo, `${o.variable} «${clave}» no existe en el catálogo DIAGNOSTICO (CIE-10)`);
    return null;
  }
  if (!fila.activo) r.error(campo, `${o.variable} «${fila.codigo} ${fila.nombre}» no es codificable (RUBRICA_TYPE B o categoría con subcategorías): usa una subcategoría vigente`);
  if (o.principal && !validaComoAfeccionPrincipal(clave)) r.error(campo, `${o.variable} «${fila.codigo} ${fila.nombre}» no es válida como afección principal (AF_PRIN = NO)`);
  if (o.sinCapituloXX && esCausaExterna(clave)) r.error(campo, `${o.variable} «${fila.codigo}» es del capítulo XX (causas externas): va en codigoCieCausaExterna, no aquí`);
  if (o.soloCapituloXX && !esCausaExterna(clave)) r.error(campo, `${o.variable} «${fila.codigo}» debe ser del capítulo XX (V01-Y98)`);
  const restriccion = motivoRestriccionCie(fila, { sexo: paciente.sexo }, { etiqueta: o.variable, edadDias: edad?.dias ?? null });
  if (restriccion) r.error(campo, restriccion);
  return fila;
}

async function revisarCie9(c: Ctx, campo: string, clave: string, variable: string): Promise<FilaCie | null> {
  const { r, paciente, edad } = c;
  if (!CLAVE_CIE9.test(clave)) {
    r.error(campo, `${variable} «${clave}» debe ser una clave CIE-9-MC de 4 caracteres (p. ej. 4701, 754X)`);
    return null;
  }
  const fila = await c.catalogo.cie("CIE9MC", clave);
  if (!fila) {
    r.error(campo, `${variable} «${clave}» no existe en el catálogo PROCEDIMIENTO (CIE-9-MC)`);
    return null;
  }
  if (!fila.activo) r.error(campo, `${variable} «${fila.codigo} ${fila.nombre}» no es codificable: usa un procedimiento específico del catálogo`);
  const restriccion = motivoRestriccionCie(fila, { sexo: paciente.sexo }, { etiqueta: variable, edadDias: edad?.dias ?? null });
  if (restriccion) r.error(campo, restriccion);
  return fila;
}

async function validarAfecciones(c: Ctx) {
  const { r, reg, hoja, edad } = c;
  const fertilAplica = esMujerEnEdadFertil(reg.sexo, edad);
  if (fertilAplica && !en(reg.mujerFertil, 1, 2, 3)) r.error("mujerFertil", "mujerFertil es obligatorio en mujeres de 9 a 59 años: 1 embarazo, 2 puerperio, 3 ni embarazada ni en puerperio");
  if (!fertilAplica && hoja.mujerFertil != null && hoja.mujerFertil !== -1) r.aviso("mujerFertil", "mujerFertil se exporta como -1: no es mujer de 9 a 59 años");

  revisarDescripcion(c, "descripcionAfeccionPrincipal", "descripcionAfeccionPrincipal", hoja.descripcionAfeccionPrincipal, reg.descripcionAfeccionPrincipal);
  if (!reg.codigoCIEAfeccionPrincipal) r.error("codigoAfeccionPrincipal", "codigoCIEAfeccionPrincipal es obligatorio (CIE-10 a 4 caracteres; se propone el diagnóstico de egreso del episodio)");
  else await revisarCie10(c, "codigoAfeccionPrincipal", reg.codigoCIEAfeccionPrincipal, { variable: "codigoCIEAfeccionPrincipal", principal: true, sinCapituloXX: true });

  if (hoja.comorbilidades.length > 6) r.error("comorbilidades", "comorbilidades admite como máximo 6");
  const vistas = new Set<string>();
  for (const [i, cm] of reg.comorbilidades.entries()) {
    const campo = `comorbilidades[${i}]`;
    revisarDescripcion(c, `${campo}.descripcion`, `descripcionComorbilidad ${i + 1}`, hoja.comorbilidades[i]?.descripcion, cm.descripcion);
    await revisarCie10(c, `${campo}.codigo`, cm.codigo, { variable: `codigoCieComorbilidad ${i + 1}`, sinCapituloXX: true });
    if (vistas.has(cm.codigo)) r.error(`${campo}.codigo`, `codigoCieComorbilidad «${cm.codigo}» está repetido`);
    if (cm.codigo === reg.codigoCIEAfeccionPrincipal) r.error(`${campo}.codigo`, `codigoCieComorbilidad «${cm.codigo}» es la misma afección principal`);
    if (reg.afeccionPrincipalReseleccionada && cm.codigo === reg.afeccionPrincipalReseleccionada && reg.afeccionPrincipalReseleccionada !== reg.codigoCIEAfeccionPrincipal) {
      r.error(`${campo}.codigo`, `codigoCieComorbilidad «${cm.codigo}» repite la afeccionPrincipalReseleccionada`);
    }
    vistas.add(cm.codigo);
  }

  if (!en(reg.tipoAtencion, 1, 2)) r.error("tipoAtencion", "tipoAtencion es obligatorio: 1 primera vez, 2 subsecuente");
  if (reg.afeccionPrincipalReseleccionada && reg.afeccionPrincipalReseleccionada !== reg.codigoCIEAfeccionPrincipal) {
    await revisarCie10(c, "afeccionReseleccionada", reg.afeccionPrincipalReseleccionada, { variable: "afeccionPrincipalReseleccionada", principal: true, sinCapituloXX: true });
  }

  // Aborto y parto: exclusivos entre sí y con mujerFertil 1 o 2.
  const dx = diagnosticosDelRegistro(reg);
  const hayAborto = dx.some(esAborto);
  const hayParto = dx.some(esParto);
  if (hayAborto && hayParto) r.error("codigoAfeccionPrincipal", "No pueden coexistir códigos de aborto (O00-O08) y de parto (O80-O84) entre la afección principal, las comorbilidades y la reseleccionada");
  const abortos = dx.filter(esAborto);
  const partos = dx.filter(esParto);
  if (abortos.length > 1) r.error("comorbilidades", `Sólo puede registrarse un código de aborto (O00-O08) en todo el registro; hay ${abortos.length}`);
  if (partos.length > 1) r.error("comorbilidades", `Sólo puede registrarse un código de parto (O80-O84) en todo el registro; hay ${partos.length}`);
  if ((hayAborto || hayParto) && fertilAplica && !en(reg.mujerFertil, 1, 2)) r.error("mujerFertil", "Con un código de aborto o parto, mujerFertil debe ser 1 embarazo o 2 puerperio");
  if ((hayAborto || hayParto) && !fertilAplica) r.error("codigoAfeccionPrincipal", "Un código de aborto o parto exige paciente mujer de 9 a 59 años");

  // Esterilización Z302 ↔ procedimiento.
  const procs = reg.procedimientos.map((p) => p.codigo);
  if (dx.includes("Z302")) {
    if (reg.sexo === 1 && !procs.some(esEsterilizacionHombre)) r.error("procedimientos", "Con Z302 esterilización en hombre debe registrarse un procedimiento del grupo 637 (vasectomía)");
    if (reg.sexo === 2 && !procs.some(esEsterilizacionMujer)) r.error("procedimientos", "Con Z302 esterilización en mujer debe registrarse un procedimiento de los grupos 662, 663, 665 o el 6663 (OTB)");
  }
  if (reg.sexo === 1 && procs.some(esEsterilizacionHombre) && !dx.includes("Z302")) r.error("procedimientos", "Un procedimiento del grupo 637 (vasectomía) exige el código Z302 esterilización entre los diagnósticos");
  if (reg.sexo === 2 && procs.some((p) => /^66[23]/.test(p) || p === "6663") && !dx.includes("Z302")) r.error("procedimientos", "Un procedimiento de los grupos 662, 663 o 6663 exige el código Z302 esterilización entre los diagnósticos");

  // Causa externa.
  const hayTrauma = dx.some(esTraumatismo);
  const opcional = dx.some(causaExternaOpcional);
  if (hayTrauma) {
    if (!reg.causaExterna) r.error("causaExterna", "causaExterna es obligatoria cuando hay un diagnóstico del capítulo XIX (traumatismos y envenenamientos): describe cómo ocurrió la lesión");
    if (!reg.codigoCieCausaExterna) r.error("codigoCausaExterna", "codigoCieCausaExterna es obligatorio con un diagnóstico del capítulo XIX (código del capítulo XX, V01-Y98)");
  } else if (!opcional && (reg.causaExterna || reg.codigoCieCausaExterna)) {
    r.error("codigoCausaExterna", "causaExterna y codigoCieCausaExterna sólo van con diagnósticos del capítulo XIX (obligatorio) o del capítulo V / O04-O07, O20, O267, O429, O468-O469, O68, O710, O713-O719 (opcional)");
  }
  if (reg.causaExterna) revisarDescripcion(c, "causaExterna", "causaExterna", hoja.causaExterna, reg.causaExterna);
  if (reg.codigoCieCausaExterna) await revisarCie10(c, "codigoCausaExterna", reg.codigoCieCausaExterna, { variable: "codigoCieCausaExterna", soloCapituloXX: true });
  if (reg.causaExterna && !reg.codigoCieCausaExterna) r.error("codigoCausaExterna", "codigoCieCausaExterna es obligatorio cuando se describe la causaExterna");
  if (reg.codigoCieCausaExterna && !reg.causaExterna) r.error("causaExterna", "causaExterna es obligatoria cuando se registra codigoCieCausaExterna");

  // Morfología (sólo tumores).
  const tumor = [reg.codigoCIEAfeccionPrincipal, reg.afeccionPrincipalReseleccionada].some((k) => k && esTumor(k));
  if (reg.morfologia) {
    if (!tumor) r.error("morfologia", "morfologia sólo se registra cuando la afección principal o la reseleccionada es un tumor (capítulo II, C00-D48)");
    if (!/^M\d{4}\/\d$/.test(reg.morfologia) && !/^M\d{4,9}$/.test(reg.morfologia)) r.error("morfologia", `morfologia «${reg.morfologia}» debe iniciar con M (código CIE-O, p. ej. M8140/3)`);
    else r.aviso("morfologia", "morfologia no se cruza con el catálogo MORFOLOGIA (no está cargado): verifica el código CIE-O");
  }

  if (!en(reg.infeccionIntraHospitalaria, 1, 2)) r.error("infeccionIntrahospitalaria", "infeccionIntraHospitalaria es obligatorio: 1 sí, 2 no");
}

// ── Procedimientos (59-65) ───────────────────────────────────────────────────

async function validarProcedimientos(c: Ctx) {
  const { r, reg, hoja } = c;
  if (hoja.procedimientos.length > 8) r.error("procedimientos", "procedimientos admite como máximo 8");
  const codigos = reg.procedimientos.map((p) => p.codigo);
  for (const [i, p] of reg.procedimientos.entries()) {
    const campo = `procedimientos[${i}]`;
    const n = i + 1;
    revisarDescripcion(c, `${campo}.descripcion`, `descripcionProcedimiento ${n}`, hoja.procedimientos[i]?.descripcion, p.descripcion);
    await revisarCie9(c, `${campo}.codigo`, p.codigo, `codigoCieProcedimiento ${n}`);
    if (!en(p.tipoAnestesia, 1, 2, 3, 4, 5, 6)) r.error(`${campo}.tipoAnestesia`, `tipoAnestesia ${n} es obligatorio: 1 general, 2 regional, 3 sedación, 4 local, 5 combinada, 6 no usó`);
    if (!en(p.quirofano, 1, 2)) r.error(`${campo}.quirofano`, `quirofanoDentroFuera ${n} es obligatorio: 1 dentro, 2 fuera`);
    if (p.quirofano === 1) {
      if (!p.tiempoQuirofano) r.error(`${campo}.tiempoQuirofano`, `tiempoQuirofano ${n} es obligatorio dentro de quirófano: HH:MM de 00:01 a 48:00, o 99:99 si no está en la hoja`);
      else if (!tiempoQuirofanoValido(p.tiempoQuirofano)) r.error(`${campo}.tiempoQuirofano`, `tiempoQuirofano ${n} «${p.tiempoQuirofano}» debe ser HH:MM entre 00:01 y 48:00 (o 99:99)`);
      if (!p.cedula) r.error(`${campo}.cedula`, `cedulaProfesional ${n} es obligatoria dentro de quirófano (6 a 14 caracteres; la de especialidad si la hay)`);
      else if (p.cedula.length < 6 || p.cedula.length > 14) r.error(`${campo}.cedula`, `cedulaProfesional ${n} «${p.cedula}» debe tener de 6 a 14 caracteres`);
      const original = hoja.procedimientos[i]?.cedula;
      if (original && normalizarCedula(original) !== original.trim().toUpperCase()) r.aviso(`${campo}.cedula`, `cedulaProfesional ${n} se exportará como «${p.cedula}»`);
    } else {
      if (hoja.procedimientos[i]?.tiempoQuirofano?.trim()) r.aviso(`${campo}.tiempoQuirofano`, `tiempoQuirofano ${n} sólo se exporta con quirófano 1 dentro`);
      if (hoja.procedimientos[i]?.cedula?.trim()) r.aviso(`${campo}.cedula`, `cedulaProfesional ${n} sólo se exporta con quirófano 1 dentro`);
    }
  }

  // Cesárea ↔ parto por cesárea.
  const dx = diagnosticosDelRegistro(reg);
  if (codigos.some(esCesareaCie9)) {
    if (!en(reg.productoEmbarazo, 1, 2, 3)) r.error("productoEmbarazo", "Con un procedimiento de cesárea (740-744, 749) productoEmbarazo debe ser 1 único, 2 gemelar o 3 tres o más");
    if (reg.tipoParto !== 3) r.error("tipoParto", "Con un procedimiento de cesárea (740-744, 749) tipoParto debe ser 3 cesárea");
    if (!dx.some((k) => categoriaCie(k) === "O82" || k === "O842")) r.error("codigoAfeccionPrincipal", "Con un procedimiento de cesárea debe registrarse un diagnóstico O82x (parto único por cesárea) u O842 (parto múltiple por cesárea)");
  }
  if (codigos.includes(DIU_CIE9) && codigos.some(esHisterectomia)) r.error("procedimientos", "No puede registrarse 697X (inserción de DIU) junto con una histerectomía (683-687, 689)");
}

// ── Lesión y defunción (66-68) ───────────────────────────────────────────────

function motivoFolioCertificadoDefuncion(folio: string, entidadClues: string | null, anioEgreso: number | null, mesEgreso: number | null): string | null {
  if (/^\d{9}$/.test(folio)) {
    const yy = Number(folio.slice(0, 2));
    const tercero = folio[2];
    if (anioEgreso != null) {
      const anio = 2000 + yy;
      const maximo = mesEgreso === 12 ? anioEgreso + 1 : anioEgreso;
      if (anio < anioEgreso - 4 || anio > maximo) return `el folio impreso «${folio}» corresponde al año 20${folio.slice(0, 2)}: sólo se aceptan los cuatro años anteriores y el del egreso`;
    }
    if (yy === 22 && !((tercero === "0" || tercero === "1") && Number(folio) <= 221650000)) return `el folio impreso «${folio}» de 2022 debe tener tercer dígito 0 o 1 y ser ≤ 221650000`;
    else if (yy === 23 && !((tercero === "0" || tercero === "1") && Number(folio) <= 231110000)) return `el folio impreso «${folio}» de 2023 debe tener tercer dígito 0 o 1 y ser ≤ 231110000`;
    else if (yy !== 22 && yy !== 23 && tercero !== "0") return `el folio impreso «${folio}» debe tener 0 como tercer dígito`;
    return null;
  }
  if (/^[0-9]{2}[MU]\d{5}E\d{8}$/.test(folio)) {
    if (entidadClues && folio.slice(0, 2) !== entidadClues) return `el folio electrónico «${folio}» debe iniciar con la entidad de la CLUES (${entidadClues})`;
    return null;
  }
  return `«${folio}» debe ser un folio impreso de 9 dígitos o electrónico de 17 caracteres (EE + M/U + 5 dígitos + E + 8 dígitos)`;
}

function validarLesionYDefuncion(c: Ctx) {
  const { r, reg, hoja, fuente } = c;
  const dx = diagnosticosDelRegistro(reg);
  const hayTrauma = dx.some(esTraumatismo);
  const opcional = dx.some(causaExternaOpcional);
  if (hayTrauma && !reg.folioLesion) r.error("folioLesion", "folioLesion es obligatorio con un diagnóstico del capítulo XIX: folio de la hoja de lesiones (1 a 8 dígitos; 0 si se desconoce)");
  if (reg.folioLesion && !/^\d{1,8}$/.test(reg.folioLesion)) r.error("folioLesion", `folioLesion «${reg.folioLesion}» debe ser numérico de 1 a 8 dígitos`);
  if (reg.folioLesion && !hayTrauma && !opcional) r.error("folioLesion", "folioLesion sólo va con diagnósticos del capítulo XIX (obligatorio) o del capítulo V / O04-O07, O20, O267, O429, O468-O469, O68, O710, O713-O719 (opcional)");

  if (reg.motivoEgreso === 5) {
    if (!en(reg.ministerioPublico, 1, 2)) r.error("ministerioPublico", "ministerioPublico es obligatorio en defunciones: 1 sí se envió al MP, 2 no");
    if (reg.ministerioPublico === 2) {
      if (!reg.folioCertificadoDefuncion) r.error("folioCertificadoDefuncion", "folioCertificadoDefuncion es obligatorio en defunción sin Ministerio Público (impreso 9 dígitos o electrónico 17 caracteres)");
      else {
        const anio = anioDeFecha(reg.fechaEgreso);
        const mes = fuente.episodio.fechaAlta ? partesLocales(fuente.episodio.fechaAlta).m : null;
        const motivo = motivoFolioCertificadoDefuncion(reg.folioCertificadoDefuncion, fuente.establecimiento.entidad, anio, mes);
        if (motivo) r.error("folioCertificadoDefuncion", `folioCertificadoDefuncion: ${motivo}`);
      }
    } else if (hoja.folioCertificadoDefuncion?.trim()) r.aviso("folioCertificadoDefuncion", "folioCertificadoDefuncion sólo se exporta con ministerioPublico 2 no");
  } else {
    if (hoja.ministerioPublico != null && hoja.ministerioPublico !== -1) r.aviso("ministerioPublico", "ministerioPublico se exporta como -1: el egreso no es defunción");
    if (hoja.folioCertificadoDefuncion?.trim()) r.aviso("folioCertificadoDefuncion", "folioCertificadoDefuncion sólo se exporta en defunciones");
  }
}

// ── Historia ginecobstétrica y atención obstétrica (69-89) ───────────────────

function motivoFolioProducto(p: { condicionNacimiento: number | null; condicionNacidoVivo: number | null; folioCertificado: string }, entidadClues: string | null, aborto: boolean): string | null {
  const f = p.folioCertificado;
  if (!f) return aborto ? "folioCertificado es obligatorio (999999999 si no se cuenta con el dato)" : "folioCertificado es obligatorio";
  if (aborto && f === "999999999") return null;
  if (p.condicionNacimiento === 1) {
    // Certificado de muerte fetal.
    if (/^\d{9}$/.test(f)) return f[2] === "1" ? null : `el folio impreso de muerte fetal «${f}» debe tener 1 como tercer dígito`;
    if (/^[0-9]{2}F\d{5}E\d{8}$/.test(f)) return entidadClues && f.slice(0, 2) !== entidadClues ? `el folio electrónico «${f}» debe iniciar con la entidad de la CLUES (${entidadClues})` : null;
    return `«${f}» debe ser folio de Certificado de Muerte Fetal impreso (9 dígitos, tercer dígito 1) o electrónico (EE + F + 5 dígitos + E + 8 dígitos)`;
  }
  if (p.condicionNacidoVivo === 3) {
    // Nació vivo y murió: certificado de defunción.
    if (/^\d{9}$/.test(f)) return null;
    if (/^[0-9]{2}[MU]\d{5}E\d{8}$/.test(f)) return entidadClues && f.slice(0, 2) !== entidadClues ? `el folio electrónico «${f}» debe iniciar con la entidad de la CLUES (${entidadClues})` : null;
    return `«${f}» debe ser folio de Certificado de Defunción impreso (9 dígitos) o electrónico (EE + M/U + 5 dígitos + E + 8 dígitos)`;
  }
  // Certificado de nacimiento.
  if (/^\d{9}$/.test(f) || /^\d{5}E\d{8}$/.test(f)) return null;
  return `«${f}» debe ser folio de Certificado de Nacimiento impreso (9 dígitos) o electrónico (5 dígitos + E + 8 dígitos)`;
}

function validarObstetricia(c: Ctx) {
  const { r, reg, hoja, edad, fuente } = c;
  const fertilAplica = esMujerEnEdadFertil(reg.sexo, edad);
  const dx = diagnosticosDelRegistro(reg);

  // Historia GO.
  if (fertilAplica) {
    const revisarConteo = (campo: "gestas" | "partos" | "abortos" | "cesareas") => {
      const v = reg[campo];
      if (v == null) r.error(campo, `${campo} es obligatorio en mujeres de 9 a 59 años (0 a 25)`);
      else if (v < 0 || v > 25) r.error(campo, `${campo} ${v} fuera del rango 0 a 25`);
    };
    revisarConteo("gestas");
    revisarConteo("partos");
    revisarConteo("abortos");
    revisarConteo("cesareas");
    if (reg.gestas != null && reg.partos != null && reg.abortos != null && reg.cesareas != null) {
      const suma = reg.partos + reg.abortos + reg.cesareas;
      if (reg.mujerFertil === 1 && reg.gestas !== suma + 1) r.error("gestas", `Con mujerFertil 1 embarazo, gestas (${reg.gestas}) debe ser partos + abortos + cesáreas + 1 (${suma + 1})`);
      if (reg.mujerFertil === 2 && (reg.gestas < 1 || reg.gestas !== suma)) r.error("gestas", `Con mujerFertil 2 puerperio, gestas (${reg.gestas}) debe ser ≥ 1 e igual a partos + abortos + cesáreas (${suma})`);
      if (reg.mujerFertil === 3 && reg.gestas !== suma) r.error("gestas", `Con mujerFertil 3, gestas (${reg.gestas}) debe ser igual a partos + abortos + cesáreas (${suma})`);
    }
  } else {
    for (const campo of ["gestas", "partos", "abortos", "cesareas"] as const) {
      if (hoja[campo] != null && hoja[campo] !== 0) r.aviso(campo, `${campo} se exporta como 0: no es mujer de 9 a 59 años`);
    }
  }

  const obstetrico = aplicaBloqueObstetrico(dx);
  if (!obstetrico) {
    const capturados = (["extraccionExpulsion", "edadGestacional", "tipoAtencionObstetrica", "tipoParto", "tipoProcAborto", "productoEmbarazo", "planificacionFamiliar"] as const).filter(
      (k) => hoja[k] != null && hoja[k] !== -1 && !(k === "edadGestacional" && hoja[k] === 88)
    );
    if (capturados.length || hoja.productos.length || (hoja.totalProductos ?? 0) > 0) {
      r.aviso("tipoAtencionObstetrica", "El bloque de atención obstétrica sólo se exporta con un diagnóstico O00-O08, O10-O26, O29-O84, O85-O92 u O98-O99; se exportará como no aplica");
    }
    return;
  }

  if (!en(reg.mujerFertil, 1, 2)) {
    r.error("mujerFertil", "Con diagnóstico obstétrico, mujerFertil debe ser 1 embarazo o 2 puerperio");
    return;
  }
  if (reg.mujerFertil === 2 && !en(reg.extraccionExpulsion, 1, 2)) r.error("extraccionExpulsion", "extraccionExpulsion es obligatorio en puerperio: 1 sí hubo extracción o expulsión del producto en este evento, 2 no");

  if (reg.edadGestacional !== 88) {
    if (reg.edadGestacional == null) r.error("edadGestacional", "edadGestacional es obligatoria: semanas 1 a 45, o 99 si se ignora");
    else if (reg.edadGestacional !== 99 && (reg.edadGestacional < 1 || reg.edadGestacional > 45)) r.error("edadGestacional", `edadGestacional ${reg.edadGestacional} fuera del rango 1 a 45 semanas (99 se ignora)`);
  }

  const eg = reg.edadGestacional != null && reg.edadGestacional >= 1 && reg.edadGestacional <= 45 ? reg.edadGestacional : null;
  if (reg.extraccionExpulsion === 1) {
    if (!en(reg.tipoAtencionObstetrica, 1, 2)) r.error("tipoAtencionObstetrica", "tipoAtencionObstetrica es obligatorio con extracción/expulsión: 1 aborto, 2 parto");
    if (eg != null && eg <= 21) {
      const excepcion = reg.afeccionPrincipalReseleccionada === "Z303";
      if (reg.tipoAtencionObstetrica !== 1 && !excepcion) r.error("tipoAtencionObstetrica", `Con edadGestacional ${eg} semanas (1-21) tipoAtencionObstetrica debe ser 1 aborto`);
      if (reg.tipoAtencionObstetrica === 1 && !dx.some(esAborto)) r.error("codigoAfeccionPrincipal", "Un aborto (1-21 semanas) exige un código O00-O08 entre los diagnósticos");
    }
    if (eg != null && eg >= 22) {
      const comorb = reg.comorbilidades.map((k) => k.codigo);
      const z303 = reg.afeccionPrincipalReseleccionada === "Z303";
      const o04 = comorb.some((k) => categoriaCie(k) === "O04");
      const excepcionAborto = z303 && o04 && ((comorb.includes("T742") && categoriaCie(reg.codigoCieCausaExterna) === "Y05") || comorb.some((k) => categoriaCie(k) !== "O04" && k !== "T742" && esComorbilidadSustantiva(k)));
      if (excepcionAborto) {
        if (reg.tipoAtencionObstetrica !== 1) r.error("tipoAtencionObstetrica", "Con Z303, O04 y abuso sexual (T742/Y05) u otra comorbilidad sustantiva, tipoAtencionObstetrica debe ser 1 aborto aunque la edad gestacional sea ≥ 22 semanas");
      } else {
        if (reg.tipoAtencionObstetrica !== 2) r.error("tipoAtencionObstetrica", `Con edadGestacional ${eg} semanas (22-45) tipoAtencionObstetrica debe ser 2 parto`);
        if (reg.tipoAtencionObstetrica === 2 && !dx.some(esParto)) r.error("codigoAfeccionPrincipal", "Un parto (22-45 semanas) exige un código O80-O84 entre los diagnósticos");
      }
    }
  } else if (hoja.tipoAtencionObstetrica != null && hoja.tipoAtencionObstetrica !== -1) {
    r.aviso("tipoAtencionObstetrica", "tipoAtencionObstetrica se exporta como -1: no hubo extracción ni expulsión en este evento");
  }

  const parto = reg.tipoAtencionObstetrica === 2;
  const aborto = reg.tipoAtencionObstetrica === 1;
  if (parto) {
    if ((reg.partos ?? 0) < 1 && (reg.cesareas ?? 0) < 1) r.error("partos", "Con tipoAtencionObstetrica 2 parto, partos o cesareas debe ser al menos 1 (incluye el evento actual)");
    if (!en(reg.tipoParto, 1, 2, 3, 9)) r.error("tipoParto", "tipoParto es obligatorio en parto: 1 eutócico, 2 distócico vaginal, 3 cesárea, 9 no especificado");
    const eutocico = dx.some((k) => ["O800", "O809", "O839", "O840"].includes(k));
    const distocico = dx.some((k) => categoriaCie(k) === "O81" || ["O801", "O808", "O830", "O831", "O832", "O838", "O841"].includes(k));
    const cesarea = dx.some((k) => categoriaCie(k) === "O82" || k === "O842");
    if (eutocico && reg.tipoParto !== 1) r.error("tipoParto", "Los diagnósticos O800, O809, O839 u O840 exigen tipoParto 1 eutócico");
    if (distocico && reg.tipoParto !== 2) r.error("tipoParto", "Los diagnósticos O81x, O801, O808, O830-O832, O838 u O841 exigen tipoParto 2 distócico vaginal");
    if (cesarea && reg.tipoParto !== 3) r.error("tipoParto", "Los diagnósticos O82x u O842 exigen tipoParto 3 cesárea");
    if (!en(reg.productoEmbarazo, 1, 2, 3)) r.error("productoEmbarazo", "productoEmbarazo es obligatorio en parto: 1 único, 2 gemelar, 3 tres o más");
    if (dx.some((k) => ["O80", "O81", "O82", "O83"].includes(categoriaCie(k))) && reg.productoEmbarazo !== 1) r.error("productoEmbarazo", "Los diagnósticos O80-O83 (parto único) exigen productoEmbarazo 1 único");
    if (dx.some((k) => categoriaCie(k) === "O84") && !en(reg.productoEmbarazo, 2, 3)) r.error("productoEmbarazo", "Un diagnóstico O84 (parto múltiple) exige productoEmbarazo 2 gemelar o 3 tres o más");
    if (reg.totalProductos == null) r.error("totalProductos", "totalProductos es obligatorio en parto (1 a 6)");
    else {
      if (reg.totalProductos < 1 || reg.totalProductos > 6) r.error("totalProductos", `totalProductos ${reg.totalProductos} fuera del rango 1 a 6`);
      if (reg.productoEmbarazo === 1 && reg.totalProductos !== 1) r.error("totalProductos", "Con productoEmbarazo 1 único, totalProductos debe ser 1");
      if (reg.productoEmbarazo === 2 && reg.totalProductos !== 2) r.error("totalProductos", "Con productoEmbarazo 2 gemelar, totalProductos debe ser 2");
      if (reg.productoEmbarazo === 3 && reg.totalProductos < 3) r.error("totalProductos", "Con productoEmbarazo 3 tres o más, totalProductos debe ser ≥ 3");
      if (reg.productos.length !== reg.totalProductos) r.error("productos", `Deben registrarse tantos productos como totalProductos (${reg.totalProductos}); hay ${reg.productos.length}`);
    }
  }
  if (aborto) {
    if ((reg.abortos ?? 0) < 1) r.error("abortos", "Con tipoAtencionObstetrica 1 aborto, abortos debe ser al menos 1 (incluye el evento actual)");
    if (!en(reg.tipoProcAborto, 1, 2, 3, 4, 5, 6, 9)) r.error("tipoProcAborto", "tipoProcAborto es obligatorio en aborto: 1 LUI, 2 AMEU, 3 medicamento, 4 DyE, 5 laparotomía exploratoria, 6 quirúrgico no especificado, 9 no especificado");
    if (hoja.productos.length > 1) r.error("productos", "En aborto se admite como máximo un producto");
  }

  // Planificación familiar.
  if (reg.extraccionExpulsion === 1) {
    if (!en(reg.planificacionFamiliar, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13)) r.error("planificacionFamiliar", "planificacionFamiliar es obligatorio tras el evento obstétrico: 0 ninguno, 1 hormonal oral… 5 DIU, 10 OTB, 11 otro método, 12 inyectable trimestral, 13 implante doble varilla");
    const procs = reg.procedimientos.map((p) => p.codigo);
    if (reg.planificacionFamiliar === 5 || reg.planificacionFamiliar === 8) {
      if (!dx.includes("Z301")) r.error("planificacionFamiliar", "DIU (5 u 8) exige el código Z301 entre los diagnósticos");
      if (!procs.includes(DIU_CIE9)) r.error("procedimientos", "DIU (5 u 8) exige el procedimiento 697X inserción de dispositivo intrauterino");
      if (procs.some(esHisterectomia)) r.error("procedimientos", "DIU (5 u 8) no puede coexistir con una histerectomía (683-687, 689)");
    }
    if (reg.planificacionFamiliar === 10) {
      if (!dx.includes("Z302")) r.error("planificacionFamiliar", "OTB (10) exige el código Z302 esterilización entre los diagnósticos");
      if (!procs.some(esEsterilizacionMujer)) r.error("procedimientos", "OTB (10) exige un procedimiento de los grupos 662, 663, 665 o el 6663");
    }
    if (reg.planificacionFamiliar === 11) {
      if (!reg.otroMetodo) r.error("otroMetodo", "otroMetodo es obligatorio con planificacionFamiliar 11 otro método");
      else if (PALABRAS_INVALIDAS_OTRO_METODO.includes(reg.otroMetodo)) r.error("otroMetodo", `otroMetodo «${reg.otroMetodo}» es una de las opciones de planificacionFamiliar: elige la opción, no la escribas`);
      else if (hoja.otroMetodo && perdidaAlNormalizar(hoja.otroMetodo, reg.otroMetodo)) r.aviso("otroMetodo", `otroMetodo perderá caracteres al exportarse como «${reg.otroMetodo}»`);
    } else if (hoja.otroMetodo?.trim()) r.aviso("otroMetodo", "otroMetodo sólo se exporta con planificacionFamiliar 11 otro método");
  }

  // Información del producto.
  for (const [i, p] of reg.productos.entries()) {
    const campo = `productos[${i}]`;
    const n = i + 1;
    if (aborto) {
      if (p.condicionNacimiento !== 1) r.error(`${campo}.condicionNacimiento`, `condicionNacimiento ${n} debe ser 1 muerte fetal en aborto`);
    } else if (!en(p.condicionNacimiento, 1, 2)) r.error(`${campo}.condicionNacimiento`, `condicionNacimiento ${n} es obligatorio: 1 muerte fetal, 2 nacido vivo`);
    const muerteFetal = p.condicionNacimiento === 1;
    if (muerteFetal) {
      if (p.condicionNacidoVivo !== 3) r.error(`${campo}.condicionNacidoVivo`, `condicionNacidoVivo ${n} debe ser 3 muerto cuando condicionNacimiento es 1 muerte fetal`);
      if (p.apgar5 !== 88) r.error(`${campo}.apgar5`, `apgar5Minutos ${n} debe ser 88 no aplica en muerte fetal`);
      if (p.reanimacion !== 8) r.error(`${campo}.reanimacion`, `reanimacionNeonatal ${n} debe ser 8 no aplica en muerte fetal`);
      if (p.alojamientoConjunto !== 8) r.error(`${campo}.alojamientoConjunto`, `alojamientoConjunto ${n} debe ser 8 no aplica en muerte fetal`);
      if (p.lactanciaExclusiva !== 8) r.error(`${campo}.lactanciaExclusiva`, `lactanciaExclusiva ${n} debe ser 8 no aplica en muerte fetal`);
    } else {
      if (!en(p.condicionNacidoVivo, 1, 2, 3)) r.error(`${campo}.condicionNacidoVivo`, `condicionNacidoVivo ${n} es obligatorio: 1 vivo alta, 2 vivo hospitalizado, 3 muerto`);
      if (p.apgar5 == null || p.apgar5 < 0 || p.apgar5 > 10) r.error(`${campo}.apgar5`, `apgar5Minutos ${n} es obligatorio de 0 a 10`);
      if (!en(p.reanimacion, 1, 2)) r.error(`${campo}.reanimacion`, `reanimacionNeonatal ${n} es obligatorio: 1 sí, 2 no`);
      if (!en(p.alojamientoConjunto, 1, 2)) r.error(`${campo}.alojamientoConjunto`, `alojamientoConjunto ${n} es obligatorio: 1 sí, 2 no`);
      if (!en(p.lactanciaExclusiva, 1, 2)) r.error(`${campo}.lactanciaExclusiva`, `lactanciaExclusiva ${n} es obligatorio: 1 sí, 2 no`);
    }
    const motivo = motivoFolioProducto(p, fuente.establecimiento.entidad, aborto);
    if (motivo) r.error(`${campo}.folioCertificado`, `folioCertificado ${n}: ${motivo}`);
  }
}

// ── Psiquiátricos (90-91) ────────────────────────────────────────────────────

function validarPsiquiatrico(c: Ctx) {
  const { r, reg, hoja, edad, fuente } = c;
  if (!fuente.establecimiento.psiquiatrico) {
    if ((hoja.tipoUnidadPsiq != null && hoja.tipoUnidadPsiq !== -1) || (hoja.tipoServicioPsiq != null && hoja.tipoServicioPsiq !== -1)) {
      r.aviso("tipoUnidadPsiq", "tipoUnidad/tipoServicio se exportan como -1: la CLUES no es de unidad psiquiátrica (tipología Y, HPSIQ o HPSIQMF)");
    }
    return;
  }
  if (!en(reg.tipoUnidad, 1, 2, 3)) r.error("tipoUnidadPsiq", "tipoUnidad es obligatorio en unidades psiquiátricas: 1 hospital continuo, 2 hospital parcial, 3 unidad de cuidados especiales");
  if (reg.tipoUnidad === 1) {
    if (!en(reg.tipoServicio, 1, 2, 3, 4, 5, 8, 9)) r.error("tipoServicioPsiq", "tipoServicio es obligatorio en hospital continuo: 1 paidopsiquiatría, 2 psiquiatría, 3 psicogeriatría, 4 desintoxicación, 5 villa psiquiátrica, 8 otros, 9 no especificado");
    if (reg.tipoServicio === 1 && edad && edad.anios >= 18) r.error("tipoServicioPsiq", "tipoServicio 1 paidopsiquiatría exige menor de 18 años");
    if (reg.tipoServicio === 3 && edad && edad.anios < 60) r.error("tipoServicioPsiq", "tipoServicio 3 psicogeriatría exige 60 años o más");
  } else if (reg.tipoUnidad === 2 && !en(reg.tipoServicio, 1, 2, 3, 4, 9)) {
    r.error("tipoServicioPsiq", "tipoServicio es obligatorio en hospital parcial: 1 día, 2 noche, 3 fin de semana, 4 otros, 9 no especificado");
  }
}

// ── Profesional responsable (92-97) ──────────────────────────────────────────

async function validarResponsable(c: Ctx) {
  const { r, reg, fuente } = c;
  const medico = fuente.medicoResponsable ?? fuente.medico;
  if (!medico) {
    r.error("medicoResponsableId", "Falta el médico responsable de la atención (curpResponsable, nombre, apellidos y cédula)");
    return;
  }
  const pais = reg.paisNacimiento;
  if (!(await c.catalogo.fila("PAIS", pais))) r.error("medicoResponsable.paisNacimientoClave", `paisNacimiento «${pais}» del médico no existe en el catálogo PAIS`);

  if (!reg.curpResponsable) r.error("medicoResponsable.curp", `curpResponsable es obligatoria: captura la CURP del médico ${medico.nombre} en su ficha`);
  else if (reg.curpResponsable === CURP_GENERICA) {
    if (pais === PAIS_MEXICO) r.error("medicoResponsable.curp", "curpResponsable genérica sólo se admite para médicos nacidos fuera de México");
    else r.aviso("medicoResponsable.curp", "curpResponsable se exporta como genérica (médico nacido fuera de México)");
  } else {
    const v = validarCurp(reg.curpResponsable);
    if (!v.valida) r.error("medicoResponsable.curp", `curpResponsable: ${v.motivo ?? "CURP inválida"}`);
  }

  const nombres = nombresDeMedico(medico);
  if (nombres.inferido && (nombres.nombres || nombres.primerApellido)) {
    r.aviso("medicoResponsable.nombres", `El médico no tiene nombres y apellidos separados: se infieren de «${medico.nombre}» como ${nombres.nombres} / ${nombres.primerApellido || "?"} / ${nombres.segundoApellido || "XX"}; captúralos en su ficha`);
  }
  if (!reg.nombreResponsable) r.error("medicoResponsable.nombres", "nombreResponsable es obligatorio (nombres del médico, 2 a 50 caracteres)");
  else revisarNombre(c, "medicoResponsable.nombres", "nombreResponsable", medico.nombres ?? medico.nombre, reg.nombreResponsable);
  if (!reg.primerApellidoResponsable) r.error("medicoResponsable.apellidoPaterno", "primerApellidoResponsable es obligatorio (2 a 50 caracteres)");
  else revisarNombre(c, "medicoResponsable.apellidoPaterno", "primerApellidoResponsable", medico.apellidoPaterno, reg.primerApellidoResponsable);
  if (reg.segundoApellidoResponsable && reg.segundoApellidoResponsable !== "XX") revisarNombre(c, "medicoResponsable.apellidoMaterno", "segundoApellidoResponsable", medico.apellidoMaterno, reg.segundoApellidoResponsable);

  if (!reg.cedulaResponsable) r.error("medicoResponsable.cedula", `cedulaResponsable es obligatoria (6 a 14 caracteres): captura la cédula del médico ${medico.nombre}`);
  else if (reg.cedulaResponsable.length < 6 || reg.cedulaResponsable.length > 14) r.error("medicoResponsable.cedula", `cedulaResponsable «${reg.cedulaResponsable}» debe tener de 6 a 14 caracteres`);
  else if (medico.cedula && normalizarCedula(medico.cedula) !== medico.cedula.trim().toUpperCase()) r.aviso("medicoResponsable.cedula", `cedulaResponsable se exportará como «${reg.cedulaResponsable}»`);
}

// ── Entrada ──────────────────────────────────────────────────────────────────

/** Todas las reglas del diccionario sobre un contexto ya preparado (prellenar.ts). */
export async function validarSaeh(ctx: ContextoSaeh, catalogo: CatalogoSaeh): Promise<ValidacionSaeh> {
  const r = new Reporte();
  const c: Ctx = { ...ctx, r, reg: ctx.registro, catalogo };
  await validarEstablecimiento(c);
  await validarIdentidad(c);
  await validarDomicilio(c);
  await validarEstancia(c);
  await validarAfecciones(c);
  await validarProcedimientos(c);
  validarLesionYDefuncion(c);
  validarObstetricia(c);
  validarPsiquiatrico(c);
  await validarResponsable(c);
  return { errores: r.errores, advertencias: r.advertencias };
}

/** Estado de la hoja según la validación. */
export function estadoPorValidacion(v: ValidacionSaeh): "COMPLETO" | "PENDIENTE" {
  return v.errores.length ? "PENDIENTE" : "COMPLETO";
}
