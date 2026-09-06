// ─────────────────────────────────────────────────────────────────────────────
// SAEH — el registro de 82 variables de la GIIS-B002-05-09 ya resuelto.
//
// `construirRegistro` toma la hoja y el paciente efectivos y aplica los «en
// caso contrario, registrar X» del diccionario (8 no aplica, -1, 88, 0, 997/
// 9997…), normaliza textos y traduce nuestros enums. El validador revisa este
// registro (más la fuente) y el exportador lo serializa: una sola lógica para
// los dos. Sin base de datos.
// ─────────────────────────────────────────────────────────────────────────────

import { claveDeCodigoCie } from "../cie";
import {
  CURP_GENERICA, FECHA_DESCONOCIDA, MOTIVO_EGRESO_SAEH, PAIS_MEXICO, SERVICIOS_TERAPIA_INTENSIVA, SERVICIOS_TERAPIA_INTERMEDIA, SEXO_SAEH,
  esObstetrico, mesesDeEdad, sexoCurpDe, type EdadSaeh,
} from "./codigos";
import type { FuenteSaeh, MedicoSaeh } from "./contexto";
import type { HojaSaeh, PacienteSaeh } from "./hoja";
import {
  fechaSaeh, normalizarCedula, normalizarDescripcion, normalizarEspecifique, normalizarNombre, normalizarOtraLocalidad, normalizarOtroMetodo, soloDigitos,
} from "./texto";

export interface ComorbilidadRegistro {
  descripcion: string;
  codigo: string;
}

export interface ProcedimientoRegistro {
  descripcion: string;
  codigo: string;
  tipoAnestesia: number | null;
  quirofano: number | null;
  tiempoQuirofano: string;
  cedula: string;
}

export interface ProductoRegistro {
  condicionNacimiento: number | null;
  condicionNacidoVivo: number | null;
  folioCertificado: string;
  apgar5: number | null;
  reanimacion: number | null;
  alojamientoConjunto: number | null;
  lactanciaExclusiva: number | null;
}

/** Las 82 variables en el orden del diccionario. Texto vacío = campo en blanco; número null = falta. */
export interface RegistroSaeh {
  clues: string;
  folio: string;
  curpPaciente: string;
  nombre: string;
  primerApellido: string;
  segundoApellido: string;
  fechaNacimiento: string;
  paisOrigen: string;
  entidadNacimiento: string;
  nacioHospital: number | null;
  sexoCURP: number | null;
  sexo: number | null;
  peso: number | null;
  talla: number | null;
  derechohabiencia: string;
  gratuidad: number | null;
  estadoConyugal: number | null;
  seConsideraIndigena: number | null;
  hablaLenguaIndigena: number | null;
  cualLengua: string;
  seConsideraAfromexicano: number | null;
  esMigranteRetornado: number | null;
  seIdentificaLGBTI: number | null;
  genero: number | null;
  paisResidencia: string;
  entidadResidencia: string;
  municipioResidencia: string;
  localidadResidencia: string;
  otraLocalidad: string;
  codigoPostal: string;
  fechaIngreso: string;
  fechaEgreso: string;
  tipoServicioIngreso: number | null;
  claveServicioIngreso: string;
  numeroServiciosAdicional: number;
  claveServicioAdicional: string[];
  claveServicioEgreso: string;
  terapiaIntensivaDias: number | null;
  terapiaIntensivaHoras: number | null;
  terapiaIntermediaDias: number | null;
  terapiaIntermediaHoras: number | null;
  procedencia: number | null;
  especifiqueProcedencia: string;
  cluesProcedencia: string;
  motivoEgreso: number | null;
  cluesReferido: string;
  mujerFertil: number | null;
  descripcionAfeccionPrincipal: string;
  codigoCIEAfeccionPrincipal: string;
  comorbilidades: ComorbilidadRegistro[];
  tipoAtencion: number | null;
  afeccionPrincipalReseleccionada: string;
  causaExterna: string;
  codigoCieCausaExterna: string;
  morfologia: string;
  infeccionIntraHospitalaria: number | null;
  procedimientos: ProcedimientoRegistro[];
  folioLesion: string;
  ministerioPublico: number | null;
  folioCertificadoDefuncion: string;
  gestas: number | null;
  partos: number | null;
  abortos: number | null;
  cesareas: number | null;
  extraccionExpulsion: number | null;
  edadGestacional: number | null;
  tipoAtencionObstetrica: number | null;
  tipoParto: number | null;
  tipoProcAborto: number | null;
  productoEmbarazo: number | null;
  totalProductos: number | null;
  planificacionFamiliar: number | null;
  otroMetodo: string;
  productos: ProductoRegistro[];
  tipoUnidad: number | null;
  tipoServicio: number | null;
  paisNacimiento: string;
  curpResponsable: string;
  nombreResponsable: string;
  primerApellidoResponsable: string;
  segundoApellidoResponsable: string;
  cedulaResponsable: string;
}

// ── Claves de municipio y localidad: el paciente puede traer código corto o clave completa ──

/** «21114» o «114» → «114» (3 dígitos, como va en el archivo). Valores especiales (997/998/999) pasan tal cual. */
export function codigoMunicipio(valor: string | null | undefined): string {
  const v = (valor ?? "").trim();
  if (!v) return "";
  if (/^\d{5}$/.test(v)) return v.slice(2);
  if (/^\d{1,3}$/.test(v)) return v.padStart(3, "0");
  return v;
}

/** Clave completa entidad+municipio para el catálogo («21» + «114» → «21114»). */
export function claveMunicipio(valor: string | null | undefined, entidad: string | null | undefined): string | null {
  const v = (valor ?? "").trim();
  if (/^\d{5}$/.test(v)) return v;
  const cod = codigoMunicipio(v);
  return /^\d{3}$/.test(cod) && entidad && /^\d{2}$/.test(entidad) ? `${entidad}${cod}` : null;
}

/** «211140001» o «1» → «0001» (4 dígitos). */
export function codigoLocalidad(valor: string | null | undefined): string {
  const v = (valor ?? "").trim();
  if (!v) return "";
  if (/^\d{9}$/.test(v)) return v.slice(5);
  if (/^\d{1,4}$/.test(v)) return v.padStart(4, "0");
  return v;
}

/** Clave completa entidad+municipio+localidad para el catálogo. */
export function claveLocalidad(valor: string | null | undefined, entidad: string | null | undefined, municipio: string | null | undefined): string | null {
  const v = (valor ?? "").trim();
  if (/^\d{9}$/.test(v)) return v;
  const cod = codigoLocalidad(v);
  const mun = codigoMunicipio(municipio);
  return /^\d{4}$/.test(cod) && entidad && /^\d{2}$/.test(entidad) && /^\d{3}$/.test(mun) ? `${entidad}${mun}${cod}` : null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const siNo = (b: boolean | null | undefined): number | null => (b == null ? null : b ? 1 : 2);
const clave = (codigo: string | null | undefined): string => (codigo ? claveDeCodigoCie(codigo) : "");

/** Claves de diagnóstico que disparan reglas: principal, comorbilidades y reseleccionada. */
export function diagnosticosDelRegistro(r: Pick<RegistroSaeh, "codigoCIEAfeccionPrincipal" | "comorbilidades" | "afeccionPrincipalReseleccionada">): string[] {
  const out = [r.codigoCIEAfeccionPrincipal, ...r.comorbilidades.map((c) => c.codigo), r.afeccionPrincipalReseleccionada].filter(Boolean);
  return [...new Set(out)];
}

export function esMujerEnEdadFertil(sexo: number | null, edad: EdadSaeh | null): boolean {
  return sexo === 2 && !!edad && edad.anios >= 9 && edad.anios <= 59;
}

export function aplicaBloqueObstetrico(diagnosticos: string[]): boolean {
  return diagnosticos.some(esObstetrico);
}

/** Nombres y apellidos del médico: los capturados o, si faltan, separados del nombre completo («Dr. Alonso Vega» → ALONSO / VEGA). */
export function nombresDeMedico(m: MedicoSaeh | null): { nombres: string; primerApellido: string; segundoApellido: string; inferido: boolean } {
  if (!m) return { nombres: "", primerApellido: "", segundoApellido: "", inferido: false };
  if (m.nombres?.trim() || m.apellidoPaterno?.trim()) {
    return { nombres: normalizarNombre(m.nombres), primerApellido: normalizarNombre(m.apellidoPaterno), segundoApellido: normalizarNombre(m.apellidoMaterno), inferido: false };
  }
  const palabras = normalizarNombre(m.nombre.replace(/^\s*(DR|DRA|DOCTOR|DOCTORA|LIC|MTRO|MTRA)\.?\s+/i, ""))
    .split(" ")
    .filter(Boolean);
  if (palabras.length < 2) return { nombres: palabras.join(" "), primerApellido: "", segundoApellido: "", inferido: true };
  if (palabras.length === 2) return { nombres: palabras[0], primerApellido: palabras[1], segundoApellido: "", inferido: true };
  return { nombres: palabras.slice(0, -2).join(" "), primerApellido: palabras[palabras.length - 2], segundoApellido: palabras[palabras.length - 1], inferido: true };
}

export interface ArgsRegistro {
  fuente: FuenteSaeh;
  hoja: HojaSaeh;
  paciente: PacienteSaeh;
  edad: EdadSaeh | null;
  /** Folio SAEH a escribir (el guardado si no se pasa). */
  folio?: string | null;
}

/** Hoja + paciente + episodio → las 82 variables con los «no aplica» del diccionario ya puestos. */
export function construirRegistro({ fuente, hoja, paciente, edad, folio }: ArgsRegistro): RegistroSaeh {
  const { episodio, establecimiento } = fuente;
  const curp = (paciente.curp ?? "").trim().toUpperCase();
  const curpPaciente = paciente.sinCurp || !curp ? CURP_GENERICA : curp;
  const generica = curpPaciente === CURP_GENERICA;
  const anios = edad?.anios ?? null;
  const menorDe = (n: number) => anios != null && anios < n;

  const paisOrigen = paciente.paisNacimientoClave ?? "";
  const esMexicano = paisOrigen === PAIS_MEXICO;
  const paisResidencia = paciente.paisResidenciaClave ?? "";
  const resideEnMexico = paisResidencia === PAIS_MEXICO;
  const entidadResidencia = resideEnMexico ? (paciente.entidadResidenciaClave ?? "") : "88";
  const municipioResidencia = !resideEnMexico ? "997" : entidadResidencia === "99" ? "998" : entidadResidencia === "00" ? "999" : codigoMunicipio(paciente.municipioResidenciaClave);
  const localidadResidencia = !resideEnMexico ? "9997" : municipioResidencia === "998" ? "9998" : municipioResidencia === "999" ? "9999" : codigoLocalidad(paciente.localidadResidenciaClave);

  const sexo = paciente.sexo ? SEXO_SAEH[paciente.sexo] : null;
  const mujerFertilAplica = esMujerEnEdadFertil(sexo, edad);
  const derechohabiencia = paciente.derechohabienciaClave ?? "";
  const lgbti = menorDe(10) ? 8 : paciente.seIdentificaLgbti;
  const hablaLengua = menorDe(1) ? 8 : siNo(paciente.hablaLenguaIndigena);

  const tipoServicioIngreso = hoja.tipoServicioIngreso;
  const cortaEstancia = tipoServicioIngreso === 2;
  const adicionales = cortaEstancia ? [] : hoja.serviciosAdicionales.map((s) => s.trim()).filter(Boolean).slice(0, 2);
  const claveServicioIngreso = cortaEstancia ? "-1" : (hoja.claveServicioIngreso ?? "");
  const servicios = [claveServicioIngreso, ...adicionales];
  const hayIntensiva = servicios.some((s) => (SERVICIOS_TERAPIA_INTENSIVA as readonly string[]).includes(s));
  const hayIntermedia = servicios.some((s) => (SERVICIOS_TERAPIA_INTERMEDIA as readonly string[]).includes(s));

  const procedencia = hoja.procedencia;
  const motivoEgreso = episodio.motivoEgreso ? MOTIVO_EGRESO_SAEH[episodio.motivoEgreso] : null;
  const mujerFertil = mujerFertilAplica ? hoja.mujerFertil : -1;

  const codigoPrincipal = clave(hoja.codigoAfeccionPrincipal);
  const comorbilidades: ComorbilidadRegistro[] = hoja.comorbilidades.slice(0, 6).map((c) => ({ descripcion: normalizarDescripcion(c.descripcion), codigo: clave(c.codigo) }));
  const reseleccionada = clave(hoja.afeccionReseleccionada) || codigoPrincipal;
  const diagnosticos = diagnosticosDelRegistro({ codigoCIEAfeccionPrincipal: codigoPrincipal, comorbilidades, afeccionPrincipalReseleccionada: reseleccionada });

  const procedimientos: ProcedimientoRegistro[] = hoja.procedimientos.slice(0, 8).map((p) => {
    const dentro = p.quirofano === 1;
    return {
      descripcion: normalizarDescripcion(p.descripcion),
      codigo: clave(p.codigo),
      tipoAnestesia: p.tipoAnestesia,
      quirofano: p.quirofano,
      tiempoQuirofano: dentro ? (p.tiempoQuirofano ?? "").trim() : "",
      cedula: dentro ? normalizarCedula(p.cedula) : "",
    };
  });

  const defuncion = motivoEgreso === 5;
  const ministerioPublico = defuncion ? hoja.ministerioPublico : -1;

  // Historia ginecobstétrica: sólo mujeres de 9 a 59 años; si no, ceros.
  const go = (v: number | null) => (mujerFertilAplica ? v : 0);

  // Resolución del embarazo e información del producto: sólo con diagnóstico obstétrico.
  const obstetrico = aplicaBloqueObstetrico(diagnosticos);
  const extraccionExpulsion = !obstetrico ? -1 : mujerFertil === 1 ? 2 : mujerFertil === 2 ? hoja.extraccionExpulsion : -1;
  const pideEdadGestacional = obstetrico && (mujerFertil === 1 || (mujerFertil === 2 && extraccionExpulsion === 1));
  const edadGestacional = pideEdadGestacional ? hoja.edadGestacional : 88;
  const tipoAtencionObstetrica = obstetrico && extraccionExpulsion === 1 ? hoja.tipoAtencionObstetrica : -1;
  const parto = tipoAtencionObstetrica === 2;
  const aborto = tipoAtencionObstetrica === 1;
  const planificacionFamiliar = obstetrico && extraccionExpulsion === 1 ? hoja.planificacionFamiliar : -1;
  const productos: ProductoRegistro[] = (parto ? hoja.productos.slice(0, 6) : aborto ? hoja.productos.slice(0, 1) : []).map((p) => ({
    condicionNacimiento: p.condicionNacimiento,
    condicionNacidoVivo: p.condicionNacidoVivo,
    folioCertificado: (p.folioCertificado ?? "").trim().toUpperCase(),
    apgar5: p.apgar5,
    reanimacion: p.reanimacion,
    alojamientoConjunto: p.alojamientoConjunto,
    lactanciaExclusiva: p.lactanciaExclusiva,
  }));

  const psiq = establecimiento.psiquiatrico;
  const tipoUnidad = psiq ? hoja.tipoUnidadPsiq : -1;
  const tipoServicio = psiq && (tipoUnidad === 1 || tipoUnidad === 2) ? hoja.tipoServicioPsiq : -1;

  const medico = fuente.medicoResponsable ?? fuente.medico;
  const paisNacimiento = medico?.paisNacimientoClave?.trim() || PAIS_MEXICO;
  const curpMedico = (medico?.curp ?? "").trim().toUpperCase();
  const curpResponsable = curpMedico || (paisNacimiento !== PAIS_MEXICO ? CURP_GENERICA : "");
  const nombresMedico = nombresDeMedico(medico);

  return {
    clues: establecimiento.clues ?? "",
    folio: (folio ?? fuente.fila?.folioSaeh ?? "").trim(),
    curpPaciente,
    nombre: normalizarNombre(paciente.nombre),
    primerApellido: normalizarNombre(paciente.apellidoPaterno) || "XX",
    segundoApellido: normalizarNombre(paciente.apellidoMaterno) || "XX",
    fechaNacimiento: paciente.fechaNacimiento ? fechaSaeh(paciente.fechaNacimiento) : generica ? FECHA_DESCONOCIDA : "",
    paisOrigen,
    entidadNacimiento: !paisOrigen ? (paciente.entidadNacimientoClave ?? "") : esMexicano ? (paciente.entidadNacimientoClave ?? "") : "88",
    nacioHospital: edad && mesesDeEdad(edad) <= 3 ? hoja.nacioHospital : 8,
    sexoCURP: sexoCurpDe(curpPaciente),
    sexo,
    peso: hoja.peso,
    talla: hoja.talla,
    derechohabiencia,
    gratuidad: establecimiento.entidad === "09" && derechohabiencia === "8" ? hoja.gratuidad : 8,
    estadoConyugal: menorDe(10) ? 8 : paciente.estadoConyugal,
    seConsideraIndigena: siNo(paciente.seConsideraIndigena),
    hablaLenguaIndigena: hablaLengua,
    cualLengua: hablaLengua === 1 ? (paciente.lenguaIndigenaClave ?? "") : "-1",
    seConsideraAfromexicano: siNo(paciente.seConsideraAfromexicano),
    esMigranteRetornado: !paisOrigen ? siNo(paciente.esMigranteRetornado) : esMexicano ? siNo(paciente.esMigranteRetornado) : 8,
    seIdentificaLGBTI: lgbti,
    genero: lgbti === 1 ? paciente.genero : -1,
    paisResidencia,
    entidadResidencia: !paisResidencia ? (paciente.entidadResidenciaClave ?? "") : entidadResidencia,
    municipioResidencia: !paisResidencia ? codigoMunicipio(paciente.municipioResidenciaClave) : municipioResidencia,
    localidadResidencia: !paisResidencia ? codigoLocalidad(paciente.localidadResidenciaClave) : localidadResidencia,
    otraLocalidad: localidadResidencia === "9999" ? normalizarOtraLocalidad(paciente.otraLocalidad) : "",
    codigoPostal: !paisResidencia || resideEnMexico ? (paciente.codigoPostal ?? "").trim() : "00000",
    fechaIngreso: fechaSaeh(episodio.fechaIngreso),
    fechaEgreso: fechaSaeh(episodio.fechaAlta),
    tipoServicioIngreso,
    claveServicioIngreso,
    numeroServiciosAdicional: adicionales.length,
    claveServicioAdicional: adicionales,
    claveServicioEgreso: hoja.claveServicioEgreso ?? "",
    terapiaIntensivaDias: hayIntensiva ? hoja.terapiaIntensivaDias : 0,
    terapiaIntensivaHoras: hayIntensiva ? hoja.terapiaIntensivaHoras : 0,
    terapiaIntermediaDias: hayIntermedia ? hoja.terapiaIntermediaDias : 0,
    terapiaIntermediaHoras: hayIntermedia ? hoja.terapiaIntermediaHoras : 0,
    procedencia,
    especifiqueProcedencia: procedencia === 5 ? normalizarEspecifique(hoja.especifiqueProcedencia) : "",
    cluesProcedencia: procedencia === 3 ? (hoja.cluesProcedencia ?? "").trim().toUpperCase() : "",
    motivoEgreso,
    cluesReferido: motivoEgreso === 4 ? (hoja.cluesReferido ?? "").trim().toUpperCase() : "",
    mujerFertil,
    descripcionAfeccionPrincipal: normalizarDescripcion(hoja.descripcionAfeccionPrincipal),
    codigoCIEAfeccionPrincipal: codigoPrincipal,
    comorbilidades,
    tipoAtencion: hoja.tipoAtencion,
    afeccionPrincipalReseleccionada: reseleccionada,
    causaExterna: normalizarDescripcion(hoja.causaExterna),
    codigoCieCausaExterna: clave(hoja.codigoCausaExterna),
    morfologia: (hoja.morfologia ?? "").trim().toUpperCase(),
    infeccionIntraHospitalaria: hoja.infeccionIntrahospitalaria,
    procedimientos,
    folioLesion: soloDigitos(hoja.folioLesion),
    ministerioPublico,
    folioCertificadoDefuncion: defuncion && ministerioPublico === 2 ? (hoja.folioCertificadoDefuncion ?? "").trim().toUpperCase() : "",
    gestas: go(hoja.gestas),
    partos: go(hoja.partos),
    abortos: go(hoja.abortos),
    cesareas: go(hoja.cesareas),
    extraccionExpulsion,
    edadGestacional,
    tipoAtencionObstetrica,
    tipoParto: parto ? hoja.tipoParto : -1,
    tipoProcAborto: aborto ? hoja.tipoProcAborto : -1,
    productoEmbarazo: parto ? hoja.productoEmbarazo : -1,
    totalProductos: parto ? hoja.totalProductos : 0,
    planificacionFamiliar,
    otroMetodo: planificacionFamiliar === 11 ? normalizarOtroMetodo(hoja.otroMetodo) : "",
    productos,
    tipoUnidad,
    tipoServicio,
    paisNacimiento,
    curpResponsable,
    nombreResponsable: nombresMedico.nombres,
    primerApellidoResponsable: nombresMedico.primerApellido,
    segundoApellidoResponsable: nombresMedico.segundoApellido || (nombresMedico.primerApellido ? "XX" : ""),
    cedulaResponsable: normalizarCedula(medico?.cedula),
  };
}
