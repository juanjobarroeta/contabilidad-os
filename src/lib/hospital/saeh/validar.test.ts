import { describe, expect, it } from "vitest";
import type { FilaCie } from "../cie";
import { digitoVerificadorCurp } from "../curp";
import { fechaLocal } from "../tz";
import { catalogoEnMemoria, filaCatalogo, servicioDeEspecialidad, type FilaCatalogo } from "./catalogo";
import { calcularEdadSaeh, tipoAnestesiaDeTexto, validaComoAfeccionPrincipal } from "./codigos";
import type { EstablecimientoSaeh, FuenteSaeh, MedicoSaeh } from "./contexto";
import type { HojaSaeh, PacienteSaeh } from "./hoja";
import { HOJA_VACIA } from "./hoja";
import { camposDeRegistro } from "./exportar";
import { prepararContexto } from "./prellenar";
import { estadoPorValidacion, validarSaeh, type ValidacionSaeh } from "./validar";
import { vencimientoSeul } from "./vencimiento";

// ── Catálogo en memoria ──────────────────────────────────────────────────────

const cie10 = (clave: string, nombre: string, extra: Partial<FilaCie> = {}): FilaCie => ({
  tipo: "CIE10", clave, codigo: clave.length === 4 ? `${clave.slice(0, 3)}.${clave[3]}` : clave, nombre, nivel: clave.length, capitulo: extra.capitulo ?? null,
  capituloNombre: null, subtipo: null, sexo: extra.sexo ?? null, edadMin: extra.edadMin ?? null, edadMax: extra.edadMax ?? null, activo: extra.activo ?? true,
});
const cie9 = (clave: string, nombre: string, subtipo: string, extra: Partial<FilaCie> = {}): FilaCie => ({
  tipo: "CIE9MC", clave, codigo: `${clave.slice(0, 2)}.${clave.slice(2)}`, nombre, nivel: 4, capitulo: null, capituloNombre: null, subtipo,
  sexo: extra.sexo ?? null, edadMin: extra.edadMin ?? null, edadMax: extra.edadMax ?? null, activo: extra.activo ?? true,
});

const CIE: FilaCie[] = [
  cie10("K219", "ENFERMEDAD DEL REFLUJO GASTROESOFÁGICO SIN ESOFAGITIS", { capitulo: "XI" }),
  cie10("K358", "OTRAS APENDICITIS AGUDAS, Y LAS NO ESPECIFICADAS", { capitulo: "XI" }),
  cie10("J189", "NEUMONÍA, NO ESPECIFICADA", { capitulo: "X" }),
  cie10("I10X", "HIPERTENSIÓN ESENCIAL (PRIMARIA)", { capitulo: "IX", edadMin: 28, edadMax: 43800 }),
  cie10("A09X", "DIARREA Y GASTROENTERITIS DE PRESUNTO ORIGEN INFECCIOSO", { capitulo: "I", activo: false }),
  cie10("A099", "GASTROENTERITIS Y COLITIS DE ORIGEN NO ESPECIFICADO", { capitulo: "I" }),
  cie10("B950", "ESTREPTOCOCO, GRUPO A, COMO CAUSA DE ENFERMEDADES", { capitulo: "I" }),
  cie10("S532", "RUPTURA TRAUMÁTICA DEL LIGAMENTO LATERAL DEL RADIO", { capitulo: "XIX" }),
  cie10("T742", "ABUSO SEXUAL", { capitulo: "XIX" }),
  cie10("W190", "CAÍDA NO ESPECIFICADA, VIVIENDA", { capitulo: "XX" }),
  cie10("V031", "PEATÓN LESIONADO POR COLISIÓN CON AUTOMÓVIL", { capitulo: "XX" }),
  cie10("Y050", "AGRESIÓN SEXUAL CON FUERZA CORPORAL, VIVIENDA", { capitulo: "XX" }),
  cie10("O150", "ECLAMPSIA EN EL EMBARAZO", { capitulo: "XV", sexo: "F", edadMin: 3650, edadMax: 19710 }),
  cie10("O800", "PARTO ÚNICO ESPONTÁNEO, PRESENTACIÓN CEFÁLICA DE VÉRTICE", { capitulo: "XV", sexo: "F", edadMin: 3650, edadMax: 19710 }),
  cie10("O820", "PARTO POR CESÁREA ELECTIVA", { capitulo: "XV", sexo: "F", edadMin: 3650, edadMax: 19710 }),
  cie10("O842", "PARTO MÚLTIPLE, TODOS POR CESÁREA", { capitulo: "XV", sexo: "F", edadMin: 3650, edadMax: 19710 }),
  cie10("O049", "ABORTO MÉDICO COMPLETO O NO ESPECIFICADO, SIN COMPLICACIÓN", { capitulo: "XV", sexo: "F", edadMin: 3650, edadMax: 19710 }),
  cie10("O249", "DIABETES MELLITUS NO ESPECIFICADA, EN EL EMBARAZO", { capitulo: "XV", sexo: "F" }),
  cie10("Z301", "INSERCIÓN DE DISPOSITIVO ANTICONCEPTIVO (INTRAUTERINO)", { capitulo: "XXI" }),
  cie10("Z302", "ESTERILIZACIÓN", { capitulo: "XXI" }),
  cie10("Z303", "EXTRACCIÓN MENSTRUAL", { capitulo: "XXI", sexo: "F" }),
  cie10("Z350", "SUPERVISIÓN DE EMBARAZO CON HISTORIA DE ESTERILIDAD", { capitulo: "XXI", sexo: "F" }),
  cie10("C189", "TUMOR MALIGNO DEL COLON, PARTE NO ESPECIFICADA", { capitulo: "II" }),
  cie10("F200", "ESQUIZOFRENIA PARANOIDE", { capitulo: "V" }),
  cie9("4701", "APENDICECTOMÍA LAPAROSCÓPICA", "Q"),
  cie9("4523", "COLONOSCOPÍA", "D"),
  cie9("4513", "OTRA ENDOSCOPÍA DE INTESTINO DELGADO", "D"),
  cie9("741X", "CESÁREA CLÁSICA BAJA", "Q", { sexo: "F", edadMin: 3650, edadMax: 19710 }),
  cie9("754X", "EXTRACCIÓN MANUAL DE PLACENTA RETENIDA", "Q", { sexo: "F" }),
  cie9("6651", "EXTIRPACIÓN DE AMBAS TROMPAS DE FALOPIO EN UN MISMO ACTO QUIRÚRGICO", "Q", { sexo: "F" }),
  cie9("6373", "VASECTOMÍA", "Q", { sexo: "M" }),
  cie9("697X", "INSERCIÓN DE DISPOSITIVO ANTICONCEPTIVO INTRAUTERINO", "T", { sexo: "F" }),
  cie9("689X", "OTRAS HISTERECTOMÍAS Y LAS NO ESPECIFICADAS", "Q", { sexo: "F" }),
  cie9("3891", "CATETERISMO ARTERIAL", "T"),
];

const clues = (clave: string, nombre: string, datos: Record<string, string>) =>
  filaCatalogo("CLUES", clave, nombre, { padre: datos.entidad, activo: datos.estatus === "1", datos: { ...datos, estatusNombre: datos.estatus === "1" ? "EN OPERACION" : "FUERA DE OPERACION" } });

const FILAS: FilaCatalogo[] = [
  filaCatalogo("PAIS", "142", "MÉXICO"), filaCatalogo("PAIS", "228", "ESTADOS UNIDOS DE AMÉRICA"), filaCatalogo("PAIS", "248", "NO ESPECIFICADO"),
  filaCatalogo("ENTIDAD", "00", "NO ESPECIFICADO"), filaCatalogo("ENTIDAD", "09", "CIUDAD DE MÉXICO"), filaCatalogo("ENTIDAD", "15", "MÉXICO"),
  filaCatalogo("ENTIDAD", "21", "PUEBLA"), filaCatalogo("ENTIDAD", "88", "NO APLICA"), filaCatalogo("ENTIDAD", "99", "SE IGNORA"),
  filaCatalogo("MUNICIPIO", "21114", "PUEBLA", { codigo: "114", padre: "21" }), filaCatalogo("MUNICIPIO", "21140", "SAN ANDRÉS CHOLULA", { codigo: "140", padre: "21" }),
  filaCatalogo("MUNICIPIO", "09016", "MIGUEL HIDALGO", { codigo: "016", padre: "09" }),
  filaCatalogo("LOCALIDAD", "211140001", "HEROICA PUEBLA DE ZARAGOZA", { codigo: "0001", padre: "21114" }),
  filaCatalogo("LOCALIDAD", "211149999", "NO ESPECIFICADO", { codigo: "9999", padre: "21114" }),
  filaCatalogo("LENGUA", "0111", "PAIPAI"),
  filaCatalogo("AFILIACION", "1", "NINGUNA"), filaCatalogo("AFILIACION", "2", "IMSS"), filaCatalogo("AFILIACION", "8", "OTRA"), filaCatalogo("AFILIACION", "10", "IMSS Bienestar"),
  filaCatalogo("AFILIACION", "13", "INSABI", { activo: false }), filaCatalogo("AFILIACION", "99", "SE IGNORA"),
  filaCatalogo("SERVICIO", "108", "GERIATRÍA"), filaCatalogo("SERVICIO", "112", "MEDICINA INTERNA"), filaCatalogo("SERVICIO", "201", "CIRUGÍA GENERAL"),
  filaCatalogo("SERVICIO", "301", "PEDIATRÍA"), filaCatalogo("SERVICIO", "401", "BIOLOGÍA DE LA REPRODUCCIÓN"), filaCatalogo("SERVICIO", "402", "GINECOLOGÍA"),
  filaCatalogo("SERVICIO", "403", "GINECO OBSTETRICIA"), filaCatalogo("SERVICIO", "501", "ANESTESIA"), filaCatalogo("SERVICIO", "514", "PSIQUIATRÍA"),
  filaCatalogo("SERVICIO", "603", "UNIDAD DE TERAPIA INTENSIVA"), filaCatalogo("SERVICIO", "606", "UNIDAD DE TERAPIA INTERMEDIA"), filaCatalogo("SERVICIO", "102", "ANGIOLOGÍA"),
  filaCatalogo("SERVICIO", "599", "OTRA"),
  clues("PLSMP000014", "SOCIEDAD DE BENEFICIENCIA ESPAÑOLA DE PUEBLA A.C.", { tipo: "2", entidad: "21", estatus: "1", municipio: "114", tipologia: "99", institucion: "SMP" }),
  clues("PLSMP000026", "SANATORIO SAGRADO CORAZON DE JESÚS", { tipo: "2", entidad: "21", estatus: "3", municipio: "132", tipologia: "99", institucion: "SMP" }),
  clues("PLSMP000043", "MATERNIDAD SANTA ANITA", { tipo: "2", entidad: "21", estatus: "1", municipio: "140", tipologia: "99", institucion: "SMP" }),
  clues("DFSSA004072", "INSTITUTO NACIONAL DE PSIQUIATRÍA", { tipo: "2", entidad: "09", estatus: "1", municipio: "012", tipologia: "Y", institucion: "SSA" }),
  clues("DFSMP016844", "UNIDAD DE ESPECIALIDADES MÉDICAS ML", { tipo: "1", entidad: "09", estatus: "1", municipio: "016", tipologia: "CLI", institucion: "SMP" }),
  clues("DFSMP016845", "CONSULTORIO", { tipo: "1", entidad: "09", estatus: "1", municipio: "016", tipologia: "CE", institucion: "SMP" }),
];
const catalogo = catalogoEnMemoria(FILAS, CIE);

// ── Fixtures ─────────────────────────────────────────────────────────────────

const curp = (base17: string) => base17 + digitoVerificadorCurp(base17);
/** Hombre, 4-abr-1982, Estado de México. */
const CURP_HOMBRE = curp("AARF820404HMCLSR0");
/** Mujer, 21-ago-1993, Puebla. */
const CURP_MUJER = curp("ZALB930821MPLMNT0");
const CURP_MEDICO = curp("VEAA750312HPLGRL0");

const HOY = fechaLocal(2026, 9, 5, 12);

const ESTABLECIMIENTO: EstablecimientoSaeh = {
  clues: "PLSMP000014", institucion: "SMP", nombre: "Haltus Hope", enCatalogo: true, entidad: "21", tipo: "2", tipologia: "99", estatus: "1", enOperacion: true, psiquiatrico: false,
};

const MEDICO: MedicoSaeh = {
  id: "med1", nombre: "Dr. Alonso Vega", especialidad: "Cirugía general", cedula: "5583201", curp: CURP_MEDICO, nombres: "Alonso", apellidoPaterno: "Vega", apellidoMaterno: "Arriaga", paisNacimientoClave: "142",
};

function paciente(extra: Partial<PacienteSaeh> = {}): PacienteSaeh {
  return {
    id: "pac1", nombre: "Fernando", apellidoPaterno: "Alcántara", apellidoMaterno: "Ríos", fechaNacimiento: fechaLocal(1982, 4, 4, 12), sexo: "MASCULINO", curp: CURP_HOMBRE, sinCurp: false,
    nacionalidad: "MEX", entidadNacimiento: "México", municipio: "Puebla", estado: "Puebla",
    paisNacimientoClave: null, entidadNacimientoClave: null, estadoConyugal: 5, seConsideraIndigena: false, hablaLenguaIndigena: false, lenguaIndigenaClave: null,
    seConsideraAfromexicano: false, esMigranteRetornado: false, seIdentificaLgbti: 2, genero: null, paisResidenciaClave: null, entidadResidenciaClave: null,
    municipioResidenciaClave: null, localidadResidenciaClave: null, otraLocalidad: null, derechohabienciaClave: "1", codigoPostal: "72000",
    ...extra,
  };
}

function mujer(extra: Partial<PacienteSaeh> = {}): PacienteSaeh {
  return paciente({ id: "pac2", nombre: "Beatriz", apellidoPaterno: "Zamora", apellidoMaterno: "Luna", fechaNacimiento: fechaLocal(1993, 8, 21, 12), sexo: "FEMENINO", curp: CURP_MUJER, entidadNacimiento: "Puebla", ...extra });
}

type FuenteExtra = Partial<Omit<FuenteSaeh, "episodio" | "paciente">> & { episodio?: Partial<FuenteSaeh["episodio"]>; paciente?: PacienteSaeh; hoja?: Partial<HojaSaeh> };

/** Hospitalización por apendicitis con apendicectomía laparoscópica, alta por mejoría. */
function fuente(extra: FuenteExtra = {}): FuenteSaeh {
  const { episodio, hoja, ...resto } = extra;
  return {
    episodio: {
      id: "ep1", companyId: "c1", folio: "HOSP-2026-0413", tipo: "HOSPITALIZACION", estado: "ALTA", fechaIngreso: fechaLocal(2026, 9, 2, 13), fechaAlta: fechaLocal(2026, 9, 4, 13, 30),
      motivoEgreso: "CURACION", diagnosticoIngresoCie10: "K35.8", diagnosticoEgresoCie10: "K35.8", procedimientoCie9: "47.01", medicoId: "med1", pacienteId: "pac1",
      ...episodio,
    },
    paciente: extra.paciente ?? paciente(),
    medico: MEDICO,
    medicoResponsable: null,
    fila: hoja ? filaDe(hoja) : null,
    signos: { peso: 82.5, talla: 176 },
    notas: { tipoAnestesiaTexto: "General balanceada", hayPostoperatoria: true },
    areas: ["HOSPITALIZACION", "QUIROFANO"],
    pasoPorUrgencias: false,
    minutosQuirofano: 75,
    horasTerapia: null,
    subsecuente: false,
    establecimiento: ESTABLECIMIENTO,
    ...resto,
  };
}

/** Una HospEgresoSaeh mínima con los campos de la hoja (lo demás no lo usa prellenar). */
function filaDe(hoja: Partial<HojaSaeh>): FuenteSaeh["fila"] {
  const h = { ...HOJA_VACIA, ...hoja };
  return {
    id: "saeh1", companyId: "c1", episodioId: "ep1", createdAt: HOY, updatedAt: HOY, folioSaeh: null, estado: "PENDIENTE", validacion: null, exportadoAt: null, exportadoArchivo: null,
    ...h,
    peso: h.peso as never,
    comorbilidades: h.comorbilidades as never,
    procedimientos: h.procedimientos as never,
    productos: h.productos as never,
  } as unknown as FuenteSaeh["fila"];
}

/** Hoja mínima completa para el caso base (lo que el prellenado no puede saber). */
const HOJA_BASE: Partial<HojaSaeh> = { infeccionIntrahospitalaria: 2, procedencia: 1 };

async function validar(f: FuenteSaeh) {
  const ctx = await prepararContexto(f, catalogo, HOY);
  const v = await validarSaeh(ctx, catalogo);
  return { ctx, v, reg: ctx.registro };
}

const mensajes = (v: ValidacionSaeh, campo?: string) => v.errores.filter((e) => !campo || e.campo === campo).map((e) => e.mensaje);
const avisos = (v: ValidacionSaeh, campo?: string) => v.advertencias.filter((e) => !campo || e.campo === campo).map((e) => e.mensaje);
const campos = (v: ValidacionSaeh) => [...new Set(v.errores.map((e) => e.campo))];

// ── Pruebas ──────────────────────────────────────────────────────────────────

describe("prellenado de la hoja SAEH", () => {
  it("propone peso/talla, afección principal, procedimiento con anestesia y cédula, servicios y procedencia", async () => {
    const { ctx, reg } = await validar(fuente({ hoja: HOJA_BASE }));
    expect(ctx.hoja.peso).toBe(82.5);
    expect(ctx.hoja.talla).toBe(176);
    expect(ctx.hoja.codigoAfeccionPrincipal).toBe("K358");
    expect(ctx.hoja.descripcionAfeccionPrincipal).toMatch(/APENDICITIS/);
    expect(ctx.hoja.tipoServicioIngreso).toBe(1);
    expect(ctx.hoja.claveServicioIngreso).toBe("201");
    expect(ctx.hoja.claveServicioEgreso).toBe("201");
    expect(ctx.hoja.tipoAtencion).toBe(1);
    expect(ctx.hoja.medicoResponsableId).toBe("med1");
    expect(ctx.hoja.procedimientos).toEqual([
      { codigo: "4701", descripcion: "APENDICECTOMÍA LAPAROSCÓPICA", tipoAnestesia: 1, quirofano: 1, tiempoQuirofano: "01:15", cedula: "5583201" },
    ]);
    expect(ctx.prellenado).toEqual(expect.arrayContaining(["peso", "talla", "codigoAfeccionPrincipal", "procedimientos", "claveServicioIngreso"]));
    expect(ctx.prellenado).not.toContain("procedencia");
    // Paciente: país y entidad de nacimiento desde la CURP (MC = 15), residencia desde los textos de la ficha.
    expect(ctx.paciente.paisNacimientoClave).toBe("142");
    expect(ctx.paciente.entidadNacimientoClave).toBe("15");
    expect(ctx.paciente.paisResidenciaClave).toBe("142");
    expect(ctx.paciente.entidadResidenciaClave).toBe("21");
    expect(ctx.paciente.municipioResidenciaClave).toBe("21114");
    expect(ctx.paciente.localidadResidenciaClave).toBe("9999");
    expect(ctx.pacientePrellenado).toEqual(expect.arrayContaining(["paisNacimientoClave", "entidadNacimientoClave", "entidadResidenciaClave", "municipioResidenciaClave"]));
    // Registro: claves cortas, sexoCURP de la posición 11, no-aplica automáticos.
    expect(reg.municipioResidencia).toBe("114");
    expect(reg.localidadResidencia).toBe("9999");
    expect(reg.sexoCURP).toBe(1);
    expect(reg.sexo).toBe(1);
    expect(reg.mujerFertil).toBe(-1);
    expect(reg.nacioHospital).toBe(8);
    expect(reg.esMigranteRetornado).toBe(2);
    expect(reg.genero).toBe(-1);
    expect(reg.cualLengua).toBe("-1");
    expect(reg.ministerioPublico).toBe(-1);
    expect(reg.edadGestacional).toBe(88);
    expect(reg.extraccionExpulsion).toBe(-1);
    expect(reg.totalProductos).toBe(0);
    expect(reg.gestas).toBe(0);
    expect(reg.tipoUnidad).toBe(-1);
    expect(reg.gratuidad).toBe(8);
    expect(reg.afeccionPrincipalReseleccionada).toBe("K358");
    expect(reg.fechaIngreso).toBe("02/09/2026");
    expect(reg.fechaEgreso).toBe("04/09/2026");
    expect(reg.motivoEgreso).toBe(1);
    expect(reg.curpResponsable).toBe(CURP_MEDICO);
    expect(reg.nombreResponsable).toBe("ALONSO");
    expect(reg.segundoApellidoResponsable).toBe("ARRIAGA");
  });

  it("nunca pisa lo guardado", async () => {
    const { ctx } = await validar(fuente({ hoja: { ...HOJA_BASE, peso: 70, claveServicioIngreso: "112", procedimientos: [{ codigo: "4523", descripcion: null, tipoAnestesia: 3, quirofano: 2, tiempoQuirofano: null, cedula: null }] } }));
    expect(ctx.hoja.peso).toBe(70);
    expect(ctx.hoja.claveServicioIngreso).toBe("112");
    expect(ctx.hoja.procedimientos[0].codigo).toBe("4523");
    expect(ctx.hoja.procedimientos[0].descripcion).toBe("COLONOSCOPÍA");
    expect(ctx.prellenado).not.toContain("peso");
  });

  it("ambulatorio → corta estancia con clave -1; urgencias → procedencia 2; hospitalización sin pista → 5 otro", async () => {
    const amb = await validar(fuente({ episodio: { tipo: "AMBULATORIO", diagnosticoEgresoCie10: "K21.9", procedimientoCie9: "45.13" }, notas: { tipoAnestesiaTexto: "Sedación", hayPostoperatoria: false }, areas: ["ENDOSCOPIA"] }));
    expect(amb.reg.tipoServicioIngreso).toBe(2);
    expect(amb.reg.claveServicioIngreso).toBe("-1");
    expect(amb.reg.numeroServiciosAdicional).toBe(0);
    expect(amb.reg.procedimientos[0]).toMatchObject({ codigo: "4513", tipoAnestesia: 3, quirofano: 2, tiempoQuirofano: "", cedula: "" });
    expect(amb.ctx.hoja.procedencia).toBe(5);
    expect(mensajes(amb.v, "especifiqueProcedencia")).toHaveLength(1);
    const urg = await validar(fuente({ pasoPorUrgencias: true }));
    expect(urg.ctx.hoja.procedencia).toBe(2);
  });

  it("terapia intensiva: servicio adicional y estancia a partir de los traslados", async () => {
    const { ctx, reg, v } = await validar(fuente({ hoja: HOJA_BASE, areas: ["HOSPITALIZACION", "TERAPIA", "QUIROFANO"], horasTerapia: 30 }));
    expect(ctx.hoja.serviciosAdicionales).toEqual(["603"]);
    expect(reg.terapiaIntensivaDias).toBe(1);
    expect(reg.terapiaIntensivaHoras).toBe(6);
    expect(mensajes(v, "terapiaIntensivaDias")).toEqual([]);
  });

  it("subsecuencia → tipoAtencion 2", async () => {
    const { reg } = await validar(fuente({ subsecuente: true }));
    expect(reg.tipoAtencion).toBe(2);
  });
});

describe("validación SAEH — caso completo", () => {
  it("una hospitalización bien capturada no tiene errores y queda COMPLETO", async () => {
    const { v, reg } = await validar(fuente({ hoja: HOJA_BASE }));
    expect(v.errores).toEqual([]);
    expect(estadoPorValidacion(v)).toBe("COMPLETO");
    expect(camposDeRegistro(reg)).toHaveLength(82);
    // Quitar acentos y mayúsculas no amerita aviso; perder letras sí.
    expect(avisos(v, "paciente.apellidoPaterno")).toEqual([]);
    const conDigitos = await validar(fuente({ paciente: paciente({ nombre: "Fernando 2do" }), hoja: HOJA_BASE }));
    expect(avisos(conDigitos.v, "paciente.nombre")[0]).toMatch(/perderá caracteres.*«FERNANDO DO»/);
  });

  it("marca lo obligatorio que falta con el nombre del campo", async () => {
    const { v } = await validar(
      fuente({
        paciente: paciente({ seConsideraIndigena: null, seConsideraAfromexicano: null, derechohabienciaClave: null, estadoConyugal: null, codigoPostal: null, seIdentificaLgbti: null }),
        hoja: { procedencia: 1 },
      })
    );
    expect(campos(v)).toEqual(
      expect.arrayContaining([
        "paciente.seConsideraIndigena", "paciente.seConsideraAfromexicano", "paciente.derechohabienciaClave", "paciente.estadoConyugal", "paciente.codigoPostal",
        "paciente.seIdentificaLgbti", "infeccionIntrahospitalaria",
      ])
    );
    expect(estadoPorValidacion(v)).toBe("PENDIENTE");
  });
});

describe("validación SAEH — identidad y sociodemográficos", () => {
  it("CURP: genérica sólo con sinCurp (aviso); sin CURP y sin motivo es error; dígito verificador", async () => {
    const generica = await validar(fuente({ paciente: paciente({ curp: null, sinCurp: true }), hoja: HOJA_BASE }));
    expect(generica.reg.curpPaciente).toBe("XXXX999999XXXXXX99");
    expect(generica.reg.sexoCURP).toBe(0);
    expect(mensajes(generica.v, "paciente.curp")).toEqual([]);
    expect(avisos(generica.v, "paciente.curp")[0]).toMatch(/40 %/);
    const sinMotivo = await validar(fuente({ paciente: paciente({ curp: null, sinCurp: false }), hoja: HOJA_BASE }));
    expect(mensajes(sinMotivo.v, "paciente.curp")[0]).toMatch(/no tiene CURP/);
    const mala = await validar(fuente({ paciente: paciente({ curp: CURP_HOMBRE.slice(0, 17) + (CURP_HOMBRE[17] === "9" ? "0" : "9") }), hoja: HOJA_BASE }));
    expect(mensajes(mala.v, "paciente.curp")[0]).toMatch(/dígito verificador/);
  });

  it("CURP del paciente igual a la del responsable es error", async () => {
    const { v } = await validar(fuente({ paciente: paciente({ curp: CURP_MEDICO }), hoja: HOJA_BASE }));
    expect(mensajes(v, "paciente.curp")).toEqual(expect.arrayContaining([expect.stringMatching(/curpResponsable/)]));
  });

  it("fecha de nacimiento: coherente con la CURP, ≤ ingreso, edad ≤ 110", async () => {
    const otra = await validar(fuente({ paciente: paciente({ fechaNacimiento: fechaLocal(1983, 4, 4, 12) }), hoja: HOJA_BASE }));
    expect(mensajes(otra.v, "paciente.fechaNacimiento")[0]).toMatch(/no coincide con la fecha que trae la CURP/);
    const vieja = await validar(fuente({ paciente: paciente({ curp: null, sinCurp: true, fechaNacimiento: fechaLocal(1900, 1, 1, 12) }), hoja: HOJA_BASE }));
    expect(mensajes(vieja.v, "paciente.fechaNacimiento")[0]).toMatch(/110/);
    const futura = await validar(fuente({ paciente: paciente({ curp: null, sinCurp: true, fechaNacimiento: fechaLocal(2026, 9, 3, 12) }), hoja: HOJA_BASE }));
    expect(mensajes(futura.v, "episodio.fechaIngreso")).toEqual(expect.arrayContaining([expect.stringMatching(/anterior a fechaNacimiento/)]));
  });

  it("entidad de nacimiento debe coincidir con la CURP; extranjero lleva 88", async () => {
    const mal = await validar(fuente({ paciente: paciente({ paisNacimientoClave: "142", entidadNacimientoClave: "21" }), hoja: HOJA_BASE }));
    expect(mensajes(mal.v, "paciente.entidadNacimientoClave")[0]).toMatch(/no coincide con la entidad de la CURP \(15\)/);
    const extranjero = await validar(fuente({ paciente: paciente({ curp: null, sinCurp: true, paisNacimientoClave: "228", esMigranteRetornado: null }), hoja: HOJA_BASE }));
    expect(extranjero.reg.entidadNacimiento).toBe("88");
    expect(extranjero.reg.esMigranteRetornado).toBe(8);
    expect(mensajes(extranjero.v, "paciente.entidadNacimientoClave")).toEqual([]);
    const paisMalo = await validar(fuente({ paciente: paciente({ paisNacimientoClave: "999" }), hoja: HOJA_BASE }));
    expect(mensajes(paisMalo.v, "paciente.paisNacimientoClave")[0]).toMatch(/no existe en el catálogo PAIS/);
  });

  it("peso y talla: rangos generales y por tipo de edad; 999 se acepta", async () => {
    const flaco = await validar(fuente({ hoja: { ...HOJA_BASE, peso: 3 } }));
    expect(mensajes(flaco.v, "peso")[0]).toMatch(/mínimo 5 kg/);
    const desconocido = await validar(fuente({ hoja: { ...HOJA_BASE, peso: 999, talla: 999 } }));
    expect(mensajes(desconocido.v, "peso")).toEqual([]);
    expect(mensajes(desconocido.v, "talla")).toEqual([]);
    const alto = await validar(fuente({ hoja: { ...HOJA_BASE, talla: 250 } }));
    expect(mensajes(alto.v, "talla")[0]).toMatch(/20 a 220/);
    const gordo = await validar(fuente({ hoja: { ...HOJA_BASE, peso: 401 } }));
    expect(mensajes(gordo.v, "peso")[0]).toMatch(/0.5 a 400/);
  });

  it("derechohabiencia: sólo las opciones de la GIIS y activas en el catálogo", async () => {
    const insabi = await validar(fuente({ paciente: paciente({ derechohabienciaClave: "13" }), hoja: HOJA_BASE }));
    expect(mensajes(insabi.v, "paciente.derechohabienciaClave")[0]).toMatch(/no está entre las opciones/);
    const bienestar = await validar(fuente({ paciente: paciente({ derechohabienciaClave: "10" }), hoja: HOJA_BASE }));
    expect(mensajes(bienestar.v, "paciente.derechohabienciaClave")[0]).toMatch(/no está entre las opciones/);
  });

  it("gratuidad sólo en la Ciudad de México con derechohabiencia 8", async () => {
    const cdmx: EstablecimientoSaeh = { ...ESTABLECIMIENTO, clues: "DFSMP016844", entidad: "09", tipo: "1", tipologia: "CLI" };
    const { v, reg } = await validar(fuente({ establecimiento: cdmx, paciente: paciente({ derechohabienciaClave: "8" }), hoja: HOJA_BASE }));
    expect(reg.gratuidad).toBeNull();
    expect(mensajes(v, "gratuidad")[0]).toMatch(/gratuidad/);
    const puebla = await validar(fuente({ paciente: paciente({ derechohabienciaClave: "8" }), hoja: HOJA_BASE }));
    expect(puebla.reg.gratuidad).toBe(8);
  });

  it("lengua indígena exige la clave del catálogo; menores de un año no aplica", async () => {
    const sinLengua = await validar(fuente({ paciente: paciente({ hablaLenguaIndigena: true }), hoja: HOJA_BASE }));
    expect(mensajes(sinLengua.v, "paciente.lenguaIndigenaClave")[0]).toMatch(/cualLengua/);
    const conLengua = await validar(fuente({ paciente: paciente({ hablaLenguaIndigena: true, lenguaIndigenaClave: "0111" }), hoja: HOJA_BASE }));
    expect(mensajes(conLengua.v, "paciente.lenguaIndigenaClave")).toEqual([]);
    expect(conLengua.reg.cualLengua).toBe("0111");
  });

  it("menores de 10 años: estado conyugal y LGBTI no aplican (8); ≤ 3 meses pide nacioHospital", async () => {
    const bebe = await validar(
      fuente({
        paciente: paciente({ curp: null, sinCurp: true, fechaNacimiento: fechaLocal(2026, 8, 1, 12), estadoConyugal: null, seIdentificaLgbti: null, hablaLenguaIndigena: null }),
        hoja: { ...HOJA_BASE, peso: 4.2, talla: 55, procedimientos: [] },
        episodio: { procedimientoCie9: null, diagnosticoEgresoCie10: "J18.9", diagnosticoIngresoCie10: "J18.9" },
        signos: { peso: 4.2, talla: 55 },
      })
    );
    expect(bebe.ctx.edad?.tipo).toBe(4);
    expect(bebe.reg.estadoConyugal).toBe(8);
    expect(bebe.reg.seIdentificaLGBTI).toBe(8);
    expect(bebe.reg.hablaLenguaIndigena).toBe(8);
    expect(mensajes(bebe.v, "paciente.estadoConyugal")).toEqual([]);
    expect(mensajes(bebe.v, "nacioHospital")[0]).toMatch(/menores de 3 meses/);
    const adultoNoAplica = await validar(fuente({ paciente: paciente({ estadoConyugal: 8 }), hoja: HOJA_BASE }));
    expect(mensajes(adultoNoAplica.v, "paciente.estadoConyugal")).toHaveLength(1);
  });

  it("LGBTI sí exige género", async () => {
    const { v } = await validar(fuente({ paciente: paciente({ seIdentificaLgbti: 1, genero: null }), hoja: HOJA_BASE }));
    expect(mensajes(v, "paciente.genero")[0]).toMatch(/genero es obligatorio/);
  });
});

describe("validación SAEH — domicilio", () => {
  it("municipio y localidad deben existir y colgar de la entidad", async () => {
    const otraEntidad = await validar(fuente({ paciente: paciente({ entidadResidenciaClave: "21", municipioResidenciaClave: "016", localidadResidenciaClave: "9999" }), hoja: HOJA_BASE }));
    expect(mensajes(otraEntidad.v, "paciente.municipioResidenciaClave")[0]).toMatch(/no existe en el catálogo MUNICIPIO para la entidad 21/);
    const localidadMala = await validar(fuente({ paciente: paciente({ entidadResidenciaClave: "21", municipioResidenciaClave: "21114", localidadResidenciaClave: "0002" }), hoja: HOJA_BASE }));
    expect(mensajes(localidadMala.v, "paciente.localidadResidenciaClave")[0]).toMatch(/no existe en el catálogo LOCALIDAD/);
    const buena = await validar(fuente({ paciente: paciente({ entidadResidenciaClave: "21", municipioResidenciaClave: "114", localidadResidenciaClave: "211140001" }), hoja: HOJA_BASE }));
    expect(mensajes(buena.v, "paciente.localidadResidenciaClave")).toEqual([]);
    expect(buena.reg.municipioResidencia).toBe("114");
    expect(buena.reg.localidadResidencia).toBe("0001");
  });

  it("residencia fuera de México: 88 / 997 / 9997 / 00000 automáticos", async () => {
    const { v, reg } = await validar(fuente({ paciente: paciente({ paisResidenciaClave: "228", codigoPostal: null }), hoja: HOJA_BASE }));
    expect(reg.entidadResidencia).toBe("88");
    expect(reg.municipioResidencia).toBe("997");
    expect(reg.localidadResidencia).toBe("9997");
    expect(reg.codigoPostal).toBe("00000");
    expect(mensajes(v, "paciente.codigoPostal")).toEqual([]);
  });

  it("entidad 99 se ignora → municipio 998 y localidad 9998; código postal de 5 dígitos", async () => {
    const { v, reg } = await validar(fuente({ paciente: paciente({ entidadResidenciaClave: "99", codigoPostal: "7200" }), hoja: HOJA_BASE }));
    expect(reg.municipioResidencia).toBe("998");
    expect(reg.localidadResidencia).toBe("9998");
    expect(mensajes(v, "paciente.codigoPostal")[0]).toMatch(/5 dígitos/);
  });
});

describe("validación SAEH — establecimiento y estancia", () => {
  it("CLUES: fuera del catálogo avisa; fuera de operación o de consulta externa sin egresos es error", async () => {
    const desconocida = await validar(fuente({ establecimiento: { ...ESTABLECIMIENTO, clues: "PLSMP001234", enCatalogo: false }, hoja: HOJA_BASE }));
    expect(mensajes(desconocida.v, "clues")).toEqual([]);
    expect(avisos(desconocida.v, "clues")[0]).toMatch(/no está en el catálogo/);
    const cerrada = await validar(fuente({ establecimiento: { ...ESTABLECIMIENTO, clues: "PLSMP000026", estatus: "3", enOperacion: false }, hoja: HOJA_BASE }));
    expect(mensajes(cerrada.v, "clues")[0]).toMatch(/EN OPERACIÓN/);
    const consultorio = await validar(fuente({ establecimiento: { ...ESTABLECIMIENTO, clues: "DFSMP016845", entidad: "09", tipo: "1", tipologia: "CE" }, hoja: HOJA_BASE }));
    expect(mensajes(consultorio.v, "clues")[0]).toMatch(/sólo reportan egresos/);
    const sinClues = await validar(fuente({ establecimiento: { ...ESTABLECIMIENTO, clues: null, enCatalogo: false }, hoja: HOJA_BASE }));
    expect(mensajes(sinClues.v, "clues")[0]).toMatch(/no está configurada/);
  });

  it("fechas: egreso antes del ingreso, egreso futuro, estancia mayor a cinco años", async () => {
    const invertida = await validar(fuente({ episodio: { fechaAlta: fechaLocal(2026, 9, 1, 10) }, hoja: HOJA_BASE }));
    expect(mensajes(invertida.v, "episodio.fechaAlta")[0]).toMatch(/anterior a fechaIngreso/);
    const futura = await validar(fuente({ episodio: { fechaAlta: fechaLocal(2026, 9, 6, 10) }, hoja: HOJA_BASE }));
    expect(mensajes(futura.v, "episodio.fechaAlta")[0]).toMatch(/posterior a la fecha de registro/);
    const larga = await validar(fuente({ episodio: { fechaIngreso: fechaLocal(2020, 1, 1, 10) }, hoja: HOJA_BASE }));
    expect(mensajes(larga.v, "episodio.fechaIngreso")[0]).toMatch(/cinco años/);
    const sinAlta = await validar(fuente({ episodio: { fechaAlta: null, estado: "HOSPITALIZADO" }, hoja: HOJA_BASE }));
    expect(mensajes(sinAlta.v, "episodio.fechaAlta")[0]).toMatch(/no tiene fecha de alta/);
  });

  it("servicios: catálogo, edad y sexo, sin repetir, máximo dos adicionales", async () => {
    const pediatrico = await validar(fuente({ hoja: { ...HOJA_BASE, claveServicioIngreso: "301" } }));
    expect(mensajes(pediatrico.v, "claveServicioIngreso")[0]).toMatch(/pediátrico/);
    const geriatria = await validar(fuente({ hoja: { ...HOJA_BASE, claveServicioEgreso: "108" } }));
    expect(mensajes(geriatria.v, "claveServicioEgreso")[0]).toMatch(/60 años/);
    const gineco = await validar(fuente({ hoja: { ...HOJA_BASE, claveServicioIngreso: "401" } }));
    expect(mensajes(gineco.v, "claveServicioIngreso")[0]).toMatch(/debe ser mujer/);
    const inexistente = await validar(fuente({ hoja: { ...HOJA_BASE, claveServicioIngreso: "777" } }));
    expect(mensajes(inexistente.v, "claveServicioIngreso")[0]).toMatch(/no existe/);
    const repetido = await validar(fuente({ hoja: { ...HOJA_BASE, serviciosAdicionales: ["201", "112"] } }));
    expect(mensajes(repetido.v, "serviciosAdicionales[0]")[0]).toMatch(/repite/);
    const tres = await validar(fuente({ hoja: { ...HOJA_BASE, serviciosAdicionales: ["112", "102", "603"] } }));
    expect(tres.reg.claveServicioAdicional).toHaveLength(2);
  });

  it("terapia intensiva exige días/horas y no puede exceder la estancia", async () => {
    const sinDatos = await validar(fuente({ hoja: { ...HOJA_BASE, serviciosAdicionales: ["603"] } }));
    expect(mensajes(sinDatos.v, "terapiaIntensivaDias")[0]).toMatch(/obligatorio/);
    expect(mensajes(sinDatos.v, "terapiaIntensivaHoras")[0]).toMatch(/obligatorio/);
    const excedida = await validar(fuente({ hoja: { ...HOJA_BASE, serviciosAdicionales: ["603"], terapiaIntensivaDias: 5, terapiaIntensivaHoras: 2 } }));
    expect(mensajes(excedida.v, "terapiaIntensivaDias")[0]).toMatch(/excede los días de estancia \(2\)/);
    const ceroHoras = await validar(fuente({ hoja: { ...HOJA_BASE, serviciosAdicionales: ["606"], terapiaIntermediaDias: 0, terapiaIntermediaHoras: 0 } }));
    expect(mensajes(ceroHoras.v, "terapiaIntermediaHoras")[0]).toMatch(/mayor a 0/);
    const sinTerapia = await validar(fuente({ hoja: { ...HOJA_BASE, terapiaIntensivaDias: 3 } }));
    expect(sinTerapia.reg.terapiaIntensivaDias).toBe(0);
  });

  it("procedencia 5 exige texto que no sea una opción; 3 exige CLUES distinta y en operación", async () => {
    const otro = await validar(fuente({ hoja: { ...HOJA_BASE, procedencia: 5, especifiqueProcedencia: "Consulta externa" } }));
    expect(mensajes(otro.v, "especifiqueProcedencia")[0]).toMatch(/es una de las opciones/);
    const otroOk = await validar(fuente({ hoja: { ...HOJA_BASE, procedencia: 5, especifiqueProcedencia: "Vía pública" } }));
    expect(mensajes(otroOk.v, "especifiqueProcedencia")).toEqual([]);
    expect(otroOk.reg.especifiqueProcedencia).toBe("VIA PUBLICA");
    const referidoSin = await validar(fuente({ hoja: { ...HOJA_BASE, procedencia: 3 } }));
    expect(mensajes(referidoSin.v, "cluesProcedencia")[0]).toMatch(/obligatoria/);
    const referidoMismo = await validar(fuente({ hoja: { ...HOJA_BASE, procedencia: 3, cluesProcedencia: "PLSMP000014" } }));
    expect(mensajes(referidoMismo.v, "cluesProcedencia")[0]).toMatch(/misma unidad/);
    const referidoCerrado = await validar(fuente({ hoja: { ...HOJA_BASE, procedencia: 3, cluesProcedencia: "PLSMP000026" } }));
    expect(mensajes(referidoCerrado.v, "cluesProcedencia")[0]).toMatch(/EN OPERACIÓN/);
    const referidoOk = await validar(fuente({ hoja: { ...HOJA_BASE, procedencia: 3, cluesProcedencia: "PLSMP000043" } }));
    expect(mensajes(referidoOk.v, "cluesProcedencia")).toEqual([]);
  });

  it("traslado (motivo 4) exige cluesReferido", async () => {
    const sin = await validar(fuente({ episodio: { motivoEgreso: "TRASLADO" }, hoja: HOJA_BASE }));
    expect(sin.reg.motivoEgreso).toBe(4);
    expect(mensajes(sin.v, "cluesReferido")[0]).toMatch(/obligatoria/);
    const con = await validar(fuente({ episodio: { motivoEgreso: "TRASLADO" }, hoja: { ...HOJA_BASE, cluesReferido: "PLSMP000043" } }));
    expect(mensajes(con.v, "cluesReferido")).toEqual([]);
    const sinMotivo = await validar(fuente({ episodio: { motivoEgreso: null }, hoja: HOJA_BASE }));
    expect(mensajes(sinMotivo.v, "episodio.motivoEgreso")).toHaveLength(1);
  });
});

describe("validación SAEH — afecciones y procedimientos", () => {
  it("afección principal: 4 caracteres, codificable, válida como principal, coherente con sexo y edad", async () => {
    const corta = await validar(fuente({ hoja: { ...HOJA_BASE, codigoAfeccionPrincipal: "K35" } }));
    expect(mensajes(corta.v, "codigoAfeccionPrincipal")[0]).toMatch(/4 caracteres/);
    const inactiva = await validar(fuente({ hoja: { ...HOJA_BASE, codigoAfeccionPrincipal: "A09X" } }));
    expect(mensajes(inactiva.v, "codigoAfeccionPrincipal")[0]).toMatch(/no es codificable/);
    const agente = await validar(fuente({ hoja: { ...HOJA_BASE, codigoAfeccionPrincipal: "B950" } }));
    expect(mensajes(agente.v, "codigoAfeccionPrincipal")[0]).toMatch(/AF_PRIN/);
    const externa = await validar(fuente({ hoja: { ...HOJA_BASE, codigoAfeccionPrincipal: "W190" } }));
    expect(mensajes(externa.v, "codigoAfeccionPrincipal")).toEqual(expect.arrayContaining([expect.stringMatching(/capítulo XX/)]));
    const mujerCodigo = await validar(fuente({ hoja: { ...HOJA_BASE, codigoAfeccionPrincipal: "O150" } }));
    expect(mensajes(mujerCodigo.v, "codigoAfeccionPrincipal")).toEqual(expect.arrayContaining([expect.stringMatching(/exclusivo de sexo femenino/)]));
    const conPunto = await validar(fuente({ hoja: { ...HOJA_BASE, codigoAfeccionPrincipal: "K21.9" } }));
    expect(conPunto.reg.codigoCIEAfeccionPrincipal).toBe("K219");
    expect(mensajes(conPunto.v, "codigoAfeccionPrincipal")).toEqual([]);
    expect(validaComoAfeccionPrincipal("K219")).toBe(true);
    expect(validaComoAfeccionPrincipal("Z000")).toBe(false);
  });

  it("edad: un código con límite inferior no aplica al recién nacido", async () => {
    const { v } = await validar(
      fuente({
        paciente: paciente({ curp: null, sinCurp: true, fechaNacimiento: fechaLocal(2026, 8, 30, 12), estadoConyugal: null, seIdentificaLgbti: null, hablaLenguaIndigena: null }),
        hoja: { ...HOJA_BASE, codigoAfeccionPrincipal: "I10X", nacioHospital: 2, peso: 3.5, talla: 50, procedimientos: [] },
        episodio: { procedimientoCie9: null },
        signos: { peso: 3.5, talla: 50 },
      })
    );
    expect(mensajes(v, "codigoAfeccionPrincipal")[0]).toMatch(/no aplica a la edad/);
  });

  it("comorbilidades: máximo 6, sin capítulo XX, sin repetir, distintas de la principal, con descripción", async () => {
    const c = (codigo: string) => ({ codigo, descripcion: null });
    const muchas = await validar(fuente({ hoja: { ...HOJA_BASE, comorbilidades: ["J189", "I10X", "A099", "C189", "F200", "Z302", "K219"].map(c) } }));
    expect(mensajes(muchas.v, "comorbilidades")[0]).toMatch(/máximo 6/);
    const externa = await validar(fuente({ hoja: { ...HOJA_BASE, comorbilidades: [c("W190")] } }));
    expect(mensajes(externa.v, "comorbilidades[0].codigo")).toEqual(expect.arrayContaining([expect.stringMatching(/capítulo XX/)]));
    const repetida = await validar(fuente({ hoja: { ...HOJA_BASE, comorbilidades: [c("J189"), c("J189")] } }));
    expect(mensajes(repetida.v, "comorbilidades[1].codigo")[0]).toMatch(/repetido/);
    const principal = await validar(fuente({ hoja: { ...HOJA_BASE, comorbilidades: [c("K358")] } }));
    expect(mensajes(principal.v, "comorbilidades[0].codigo")[0]).toMatch(/misma afección principal/);
    const ok = await validar(fuente({ hoja: { ...HOJA_BASE, comorbilidades: [c("J189"), c("I10X")] } }));
    expect(ok.v.errores).toEqual([]);
    expect(ok.reg.comorbilidades[0].descripcion).toBe("NEUMONIA NO ESPECIFICADA");
  });

  it("causa externa y folio de lesión son obligatorios con capítulo XIX y prohibidos sin él", async () => {
    const trauma = await validar(fuente({ episodio: { diagnosticoEgresoCie10: "S53.2" }, hoja: { ...HOJA_BASE, procedimientos: [] } }));
    expect(campos(trauma.v)).toEqual(expect.arrayContaining(["causaExterna", "codigoCausaExterna", "folioLesion"]));
    const completo = await validar(
      fuente({ episodio: { diagnosticoEgresoCie10: "S53.2" }, hoja: { ...HOJA_BASE, causaExterna: "Caída en su domicilio", codigoCausaExterna: "W19.0", folioLesion: "0", procedimientos: [] } })
    );
    expect(completo.v.errores).toEqual([]);
    expect(completo.reg.causaExterna).toBe("CAIDA EN SU DOMICILIO");
    expect(completo.reg.codigoCieCausaExterna).toBe("W190");
    const noXX = await validar(fuente({ episodio: { diagnosticoEgresoCie10: "S53.2" }, hoja: { ...HOJA_BASE, causaExterna: "Caída", codigoCausaExterna: "K219", folioLesion: "12", procedimientos: [] } }));
    expect(mensajes(noXX.v, "codigoCausaExterna")[0]).toMatch(/capítulo XX/);
    const indebida = await validar(fuente({ hoja: { ...HOJA_BASE, causaExterna: "Caída", codigoCausaExterna: "W190", folioLesion: "5" } }));
    expect(mensajes(indebida.v, "codigoCausaExterna")[0]).toMatch(/sólo van con diagnósticos del capítulo XIX/);
    expect(mensajes(indebida.v, "folioLesion")[0]).toMatch(/sólo va con/);
    const mental = await validar(fuente({ episodio: { diagnosticoEgresoCie10: "F20.0" }, hoja: { ...HOJA_BASE, causaExterna: "Agresión", codigoCausaExterna: "Y050", procedimientos: [] } }));
    expect(mensajes(mental.v, "codigoCausaExterna")).toEqual([]);
  });

  it("morfología sólo con tumores y con formato CIE-O", async () => {
    const sinTumor = await validar(fuente({ hoja: { ...HOJA_BASE, morfologia: "M8140/3" } }));
    expect(mensajes(sinTumor.v, "morfologia")[0]).toMatch(/sólo se registra/);
    const tumor = await validar(fuente({ episodio: { diagnosticoEgresoCie10: "C18.9" }, hoja: { ...HOJA_BASE, morfologia: "M8140/3" } }));
    expect(mensajes(tumor.v, "morfologia")).toEqual([]);
    expect(avisos(tumor.v, "morfologia")[0]).toMatch(/MORFOLOGIA/);
    const formato = await validar(fuente({ episodio: { diagnosticoEgresoCie10: "C18.9" }, hoja: { ...HOJA_BASE, morfologia: "8140" } }));
    expect(mensajes(formato.v, "morfologia")[0]).toMatch(/iniciar con M/);
  });

  it("procedimientos: máximo 8, catálogo, anestesia 1-6, quirófano 1|2, tiempo y cédula dentro de quirófano", async () => {
    const p = (extra: Partial<HojaSaeh["procedimientos"][number]>) => ({ codigo: "4701", descripcion: null, tipoAnestesia: 1, quirofano: 1, tiempoQuirofano: "01:00", cedula: "5583201", ...extra });
    const nueve = await validar(fuente({ hoja: { ...HOJA_BASE, procedimientos: Array.from({ length: 9 }, () => p({})) } }));
    expect(mensajes(nueve.v, "procedimientos")[0]).toMatch(/máximo 8/);
    const anestesia = await validar(fuente({ hoja: { ...HOJA_BASE, procedimientos: [p({ tipoAnestesia: 7 })] } }));
    expect(mensajes(anestesia.v, "procedimientos[0].tipoAnestesia")[0]).toMatch(/1 general/);
    const sinTiempo = await validar(fuente({ hoja: { ...HOJA_BASE, procedimientos: [p({ tiempoQuirofano: null })] } }));
    expect(mensajes(sinTiempo.v, "procedimientos[0].tiempoQuirofano")[0]).toMatch(/obligatorio/);
    const tiempoMalo = await validar(fuente({ hoja: { ...HOJA_BASE, procedimientos: [p({ tiempoQuirofano: "50:00" })] } }));
    expect(mensajes(tiempoMalo.v, "procedimientos[0].tiempoQuirofano")[0]).toMatch(/00:01 y 48:00/);
    const sinCedula = await validar(fuente({ hoja: { ...HOJA_BASE, procedimientos: [p({ cedula: null })] } }));
    expect(mensajes(sinCedula.v, "procedimientos[0].cedula")[0]).toMatch(/obligatoria/);
    const cedulaCorta = await validar(fuente({ hoja: { ...HOJA_BASE, procedimientos: [p({ cedula: "123" })] } }));
    expect(cedulaCorta.reg.procedimientos[0].cedula).toBe("000123");
    expect(mensajes(cedulaCorta.v, "procedimientos[0].cedula")).toEqual([]);
    const fuera = await validar(fuente({ hoja: { ...HOJA_BASE, procedimientos: [p({ codigo: "3891", quirofano: 2, tiempoQuirofano: "01:00", cedula: "5583201" })] } }));
    expect(fuera.reg.procedimientos[0].tiempoQuirofano).toBe("");
    expect(fuera.reg.procedimientos[0].cedula).toBe("");
    expect(avisos(fuera.v, "procedimientos[0].cedula")[0]).toMatch(/sólo se exporta/);
    const inexistente = await validar(fuente({ hoja: { ...HOJA_BASE, procedimientos: [p({ codigo: "9999" })] } }));
    expect(mensajes(inexistente.v, "procedimientos[0].codigo")[0]).toMatch(/no existe en el catálogo PROCEDIMIENTO/);
    const sexo = await validar(fuente({ hoja: { ...HOJA_BASE, procedimientos: [p({ codigo: "754X" })] } }));
    expect(mensajes(sexo.v, "procedimientos[0].codigo")[0]).toMatch(/exclusivo de sexo femenino/);
  });

  it("esterilización: Z302 y vasectomía se exigen mutuamente en hombres", async () => {
    const soloZ = await validar(fuente({ episodio: { diagnosticoEgresoCie10: "Z30.2", procedimientoCie9: null }, hoja: { ...HOJA_BASE, procedimientos: [] } }));
    expect(mensajes(soloZ.v, "procedimientos")[0]).toMatch(/637/);
    const soloVasectomia = await validar(fuente({ episodio: { procedimientoCie9: "63.73" }, hoja: HOJA_BASE }));
    expect(mensajes(soloVasectomia.v, "procedimientos")[0]).toMatch(/Z302/);
    const ambos = await validar(fuente({ episodio: { diagnosticoEgresoCie10: "Z30.2", procedimientoCie9: "63.73" }, hoja: HOJA_BASE }));
    expect(mensajes(ambos.v, "procedimientos")).toEqual([]);
  });
});

describe("validación SAEH — defunción", () => {
  it("ministerio público obligatorio; folio del certificado sólo sin MP, impreso o electrónico", async () => {
    const sinMp = await validar(fuente({ episodio: { motivoEgreso: "DEFUNCION" }, hoja: HOJA_BASE }));
    expect(mensajes(sinMp.v, "ministerioPublico")[0]).toMatch(/obligatorio en defunciones/);
    const conMp = await validar(fuente({ episodio: { motivoEgreso: "DEFUNCION" }, hoja: { ...HOJA_BASE, ministerioPublico: 1, folioCertificadoDefuncion: "260123456" } }));
    expect(conMp.v.errores).toEqual([]);
    expect(conMp.reg.folioCertificadoDefuncion).toBe("");
    const sinFolio = await validar(fuente({ episodio: { motivoEgreso: "DEFUNCION" }, hoja: { ...HOJA_BASE, ministerioPublico: 2 } }));
    expect(mensajes(sinFolio.v, "folioCertificadoDefuncion")[0]).toMatch(/obligatorio/);
    const impreso = await validar(fuente({ episodio: { motivoEgreso: "DEFUNCION" }, hoja: { ...HOJA_BASE, ministerioPublico: 2, folioCertificadoDefuncion: "260123456" } }));
    expect(impreso.v.errores).toEqual([]);
    const tercerDigito = await validar(fuente({ episodio: { motivoEgreso: "DEFUNCION" }, hoja: { ...HOJA_BASE, ministerioPublico: 2, folioCertificadoDefuncion: "251123456" } }));
    expect(mensajes(tercerDigito.v, "folioCertificadoDefuncion")[0]).toMatch(/tercer dígito/);
    const viejo = await validar(fuente({ episodio: { motivoEgreso: "DEFUNCION" }, hoja: { ...HOJA_BASE, ministerioPublico: 2, folioCertificadoDefuncion: "190123456" } }));
    expect(mensajes(viejo.v, "folioCertificadoDefuncion")[0]).toMatch(/cuatro años anteriores/);
    const electronico = await validar(fuente({ episodio: { motivoEgreso: "DEFUNCION" }, hoja: { ...HOJA_BASE, ministerioPublico: 2, folioCertificadoDefuncion: "21M12345E12345678" } }));
    expect(electronico.v.errores).toEqual([]);
    const otraEntidad = await validar(fuente({ episodio: { motivoEgreso: "DEFUNCION" }, hoja: { ...HOJA_BASE, ministerioPublico: 2, folioCertificadoDefuncion: "09M12345E12345678" } }));
    expect(mensajes(otraEntidad.v, "folioCertificadoDefuncion")[0]).toMatch(/entidad de la CLUES \(21\)/);
    const noDefuncion = await validar(fuente({ hoja: { ...HOJA_BASE, ministerioPublico: 1 } }));
    expect(noDefuncion.reg.ministerioPublico).toBe(-1);
    expect(avisos(noDefuncion.v, "ministerioPublico")).toHaveLength(1);
  });
});

describe("validación SAEH — obstetricia", () => {
  const PRODUCTO_VIVO = { condicionNacimiento: 2, condicionNacidoVivo: 1, folioCertificado: "026234790", apgar5: 9, reanimacion: 2, alojamientoConjunto: 1, lactanciaExclusiva: 1 };
  /** Parto eutócico atendido por ginecoobstetricia. */
  const parto = (hoja: Partial<HojaSaeh> = {}, pac: Partial<PacienteSaeh> = {}) =>
    fuente({
      paciente: mujer(pac),
      medico: { ...MEDICO, especialidad: "Ginecología y obstetricia" },
      episodio: { diagnosticoEgresoCie10: "O80.0", diagnosticoIngresoCie10: "O80.0", procedimientoCie9: null, pacienteId: "pac2" },
      notas: { tipoAnestesiaTexto: null, hayPostoperatoria: false },
      areas: ["HOSPITALIZACION"],
      signos: { peso: 68, talla: 162 },
      hoja: {
        ...HOJA_BASE, mujerFertil: 2, gestas: 1, partos: 1, abortos: 0, cesareas: 0, extraccionExpulsion: 1, edadGestacional: 39, tipoAtencionObstetrica: 2, tipoParto: 1,
        productoEmbarazo: 1, totalProductos: 1, planificacionFamiliar: 0, productos: [PRODUCTO_VIVO], ...hoja,
      },
    });

  it("un parto eutócico completo no tiene errores", async () => {
    const { v, reg } = await validar(parto());
    expect(v.errores).toEqual([]);
    expect(reg.mujerFertil).toBe(2);
    expect(reg.claveServicioIngreso).toBe("403");
    expect(reg.productos).toHaveLength(1);
    expect(reg.gestas).toBe(1);
  });

  it("mujer de 9 a 59 años exige mujerFertil e historia ginecobstétrica; con diagnóstico obstétrico debe ser 1 o 2", async () => {
    const sin = await validar(fuente({ paciente: mujer(), episodio: { pacienteId: "pac2" }, hoja: HOJA_BASE }));
    expect(mensajes(sin.v, "mujerFertil")[0]).toMatch(/obligatorio en mujeres de 9 a 59/);
    expect(campos(sin.v)).toEqual(expect.arrayContaining(["gestas", "partos", "abortos", "cesareas"]));
    const tres = await validar(parto({ mujerFertil: 3 }));
    expect(mensajes(tres.v, "mujerFertil")).toEqual(expect.arrayContaining([expect.stringMatching(/1 embarazo o 2 puerperio/)]));
    const hombreObstetrico = await validar(fuente({ episodio: { diagnosticoEgresoCie10: "O80.0" }, hoja: { ...HOJA_BASE, mujerFertil: 2 } }));
    expect(mensajes(hombreObstetrico.v, "codigoAfeccionPrincipal")).toEqual(expect.arrayContaining([expect.stringMatching(/mujer de 9 a 59/)]));
  });

  it("gestas = partos + abortos + cesáreas (+1 en embarazo)", async () => {
    const mal = await validar(parto({ gestas: 3 }));
    expect(mensajes(mal.v, "gestas")[0]).toMatch(/igual a partos \+ abortos \+ cesáreas \(1\)/);
    const embarazo = await validar(parto({ mujerFertil: 1, gestas: 1, partos: 0, extraccionExpulsion: 2 }, {}));
    // Embarazo actual sin extracción: la GIIS obliga extraccionExpulsion 2 y gestas = suma + 1.
    expect(embarazo.reg.extraccionExpulsion).toBe(2);
    expect(embarazo.reg.tipoAtencionObstetrica).toBe(-1);
    expect(mensajes(embarazo.v, "gestas")).toEqual([]);
    const embarazoMal = await validar(parto({ mujerFertil: 1, gestas: 2, partos: 0 }));
    expect(mensajes(embarazoMal.v, "gestas")[0]).toMatch(/\+ 1 \(1\)/);
  });

  it("edad gestacional manda: 1-21 semanas es aborto con O00-O08; 22-45 es parto con O80-O84", async () => {
    const abortoConParto = await validar(parto({ edadGestacional: 12 }));
    expect(mensajes(abortoConParto.v, "tipoAtencionObstetrica")[0]).toMatch(/debe ser 1 aborto/);
    const abortoOk = await validar(
      parto({ edadGestacional: 12, tipoAtencionObstetrica: 1, tipoProcAborto: 2, partos: 0, abortos: 1, productos: [], codigoAfeccionPrincipal: "O049", descripcionAfeccionPrincipal: "Aborto completo" })
    );
    expect(abortoOk.v.errores).toEqual([]);
    expect(abortoOk.reg.tipoParto).toBe(-1);
    expect(abortoOk.reg.totalProductos).toBe(0);
    expect(abortoOk.reg.productos).toEqual([]);
    const abortoSinCodigo = await validar(parto({ edadGestacional: 12, tipoAtencionObstetrica: 1, tipoProcAborto: 2, abortos: 1, partos: 0, productos: [] }));
    expect(mensajes(abortoSinCodigo.v, "codigoAfeccionPrincipal")).toEqual(expect.arrayContaining([expect.stringMatching(/O00-O08/)]));
    const egMala = await validar(parto({ edadGestacional: 50 }));
    expect(mensajes(egMala.v, "edadGestacional")[0]).toMatch(/1 a 45/);
    const egIgnorada = await validar(parto({ edadGestacional: 99 }));
    expect(mensajes(egIgnorada.v, "edadGestacional")).toEqual([]);
  });

  it("tipo de parto y producto coherentes con la CIE; totalProductos = productos capturados", async () => {
    const cesareaComoEutocico = await validar(parto({ tipoParto: 3 }));
    expect(mensajes(cesareaComoEutocico.v, "tipoParto")[0]).toMatch(/exigen tipoParto 1 eutócico/);
    const gemelar = await validar(parto({ productoEmbarazo: 2, totalProductos: 2, productos: [PRODUCTO_VIVO, PRODUCTO_VIVO] }));
    expect(mensajes(gemelar.v, "productoEmbarazo")[0]).toMatch(/O80-O83 \(parto único\)/);
    const faltaProducto = await validar(parto({ productos: [] }));
    expect(mensajes(faltaProducto.v, "productos")[0]).toMatch(/tantos productos como totalProductos \(1\); hay 0/);
    const cesarea = await validar(
      parto({
        codigoAfeccionPrincipal: "O842", descripcionAfeccionPrincipal: "Parto múltiple por cesárea", tipoParto: 3, productoEmbarazo: 2, totalProductos: 2, cesareas: 1, partos: 0,
        productos: [PRODUCTO_VIVO, PRODUCTO_VIVO],
        procedimientos: [{ codigo: "741X", descripcion: null, tipoAnestesia: 2, quirofano: 1, tiempoQuirofano: "01:30", cedula: "5583201" }],
      })
    );
    expect(cesarea.v.errores).toEqual([]);
    const cesareaSinCodigo = await validar(parto({ procedimientos: [{ codigo: "741X", descripcion: null, tipoAnestesia: 2, quirofano: 1, tiempoQuirofano: "01:30", cedula: "5583201" }] }));
    expect(mensajes(cesareaSinCodigo.v, "tipoParto")).toEqual(expect.arrayContaining([expect.stringMatching(/cesárea.*tipoParto debe ser 3/)]));
    expect(mensajes(cesareaSinCodigo.v, "codigoAfeccionPrincipal")).toEqual(expect.arrayContaining([expect.stringMatching(/O82x/)]));
  });

  it("producto: muerte fetal lleva 3 / 88 / 8 y folio de muerte fetal; nacido vivo lleva Apgar 0-10 y folio de nacimiento", async () => {
    const fetal = await validar(parto({ productos: [{ ...PRODUCTO_VIVO, condicionNacimiento: 1 }] }));
    expect(campos(fetal.v)).toEqual(
      expect.arrayContaining(["productos[0].condicionNacidoVivo", "productos[0].apgar5", "productos[0].reanimacion", "productos[0].alojamientoConjunto", "productos[0].lactanciaExclusiva", "productos[0].folioCertificado"])
    );
    const fetalOk = await validar(parto({ productos: [{ condicionNacimiento: 1, condicionNacidoVivo: 3, folioCertificado: "261012345", apgar5: 88, reanimacion: 8, alojamientoConjunto: 8, lactanciaExclusiva: 8 }] }));
    expect(fetalOk.v.errores).toEqual([]);
    const apgar = await validar(parto({ productos: [{ ...PRODUCTO_VIVO, apgar5: 11 }] }));
    expect(mensajes(apgar.v, "productos[0].apgar5")[0]).toMatch(/0 a 10/);
    const folioElectronico = await validar(parto({ productos: [{ ...PRODUCTO_VIVO, folioCertificado: "26012E03426895" }] }));
    expect(mensajes(folioElectronico.v, "productos[0].folioCertificado")).toEqual([]);
    const folioMalo = await validar(parto({ productos: [{ ...PRODUCTO_VIVO, folioCertificado: "ABC" }] }));
    expect(mensajes(folioMalo.v, "productos[0].folioCertificado")[0]).toMatch(/Certificado de Nacimiento/);
  });

  it("planificación familiar: DIU exige Z301 y 697X; OTB exige Z302 y 662/663/665/6663; 11 exige texto que no sea opción", async () => {
    const diu = await validar(parto({ planificacionFamiliar: 5 }));
    expect(mensajes(diu.v, "planificacionFamiliar")[0]).toMatch(/Z301/);
    expect(mensajes(diu.v, "procedimientos")[0]).toMatch(/697X/);
    const diuOk = await validar(
      parto({ planificacionFamiliar: 5, comorbilidades: [{ codigo: "Z301", descripcion: null }], procedimientos: [{ codigo: "697X", descripcion: null, tipoAnestesia: 6, quirofano: 2, tiempoQuirofano: null, cedula: null }] })
    );
    expect(diuOk.v.errores).toEqual([]);
    const otb = await validar(parto({ planificacionFamiliar: 10 }));
    expect(mensajes(otb.v, "planificacionFamiliar")[0]).toMatch(/Z302/);
    const otro = await validar(parto({ planificacionFamiliar: 11, otroMetodo: "Preservativo" }));
    expect(mensajes(otro.v, "otroMetodo")[0]).toMatch(/es una de las opciones/);
    const otroOk = await validar(parto({ planificacionFamiliar: 11, otroMetodo: "Método del ritmo" }));
    expect(mensajes(otroOk.v, "otroMetodo")).toEqual([]);
    expect(otroOk.reg.otroMetodo).toBe("METODO DEL RITMO");
  });

  it("sin diagnóstico obstétrico el bloque se exporta como no aplica y sólo avisa", async () => {
    const { v, reg } = await validar(fuente({ hoja: { ...HOJA_BASE, extraccionExpulsion: 1, edadGestacional: 39, tipoAtencionObstetrica: 2, totalProductos: 1 } }));
    expect(v.errores).toEqual([]);
    expect(reg.extraccionExpulsion).toBe(-1);
    expect(reg.edadGestacional).toBe(88);
    expect(reg.tipoAtencionObstetrica).toBe(-1);
    expect(reg.totalProductos).toBe(0);
    expect(avisos(v, "tipoAtencionObstetrica")[0]).toMatch(/sólo se exporta/);
  });
});

describe("validación SAEH — psiquiátrico y responsable", () => {
  it("unidad psiquiátrica exige tipoUnidad/tipoServicio; las demás exportan -1", async () => {
    const psiq: EstablecimientoSaeh = { ...ESTABLECIMIENTO, clues: "DFSSA004072", entidad: "09", tipologia: "Y", psiquiatrico: true };
    const sin = await validar(fuente({ establecimiento: psiq, hoja: HOJA_BASE }));
    expect(mensajes(sin.v, "tipoUnidadPsiq")[0]).toMatch(/obligatorio en unidades psiquiátricas/);
    const continuo = await validar(fuente({ establecimiento: psiq, hoja: { ...HOJA_BASE, tipoUnidadPsiq: 1, tipoServicioPsiq: 1 } }));
    expect(mensajes(continuo.v, "tipoServicioPsiq")[0]).toMatch(/paidopsiquiatría exige menor de 18/);
    const ok = await validar(fuente({ establecimiento: psiq, hoja: { ...HOJA_BASE, tipoUnidadPsiq: 1, tipoServicioPsiq: 2 } }));
    expect(mensajes(ok.v, "tipoServicioPsiq")).toEqual([]);
    expect(ok.reg.tipoUnidad).toBe(1);
    const general = await validar(fuente({ hoja: { ...HOJA_BASE, tipoUnidadPsiq: 1 } }));
    expect(general.reg.tipoUnidad).toBe(-1);
    expect(avisos(general.v, "tipoUnidadPsiq")).toHaveLength(1);
  });

  it("responsable: CURP, nombres y apellidos separados y cédula; extranjero puede llevar genérica", async () => {
    const sinCurp = await validar(fuente({ medico: { ...MEDICO, curp: null }, hoja: HOJA_BASE }));
    expect(mensajes(sinCurp.v, "medicoResponsable.curp")[0]).toMatch(/curpResponsable es obligatoria/);
    const sinCedula = await validar(fuente({ medico: { ...MEDICO, cedula: null }, hoja: HOJA_BASE }));
    expect(mensajes(sinCedula.v, "medicoResponsable.cedula")[0]).toMatch(/cedulaResponsable es obligatoria/);
    const soloNombre = await validar(fuente({ medico: { ...MEDICO, nombres: null, apellidoPaterno: null, apellidoMaterno: null }, hoja: HOJA_BASE }));
    expect(soloNombre.reg.nombreResponsable).toBe("ALONSO");
    expect(soloNombre.reg.primerApellidoResponsable).toBe("VEGA");
    expect(soloNombre.reg.segundoApellidoResponsable).toBe("XX");
    expect(avisos(soloNombre.v, "medicoResponsable.nombres")[0]).toMatch(/se infieren/);
    const extranjero = await validar(fuente({ medico: { ...MEDICO, curp: null, paisNacimientoClave: "228" }, hoja: HOJA_BASE }));
    expect(extranjero.reg.curpResponsable).toBe("XXXX999999XXXXXX99");
    expect(mensajes(extranjero.v, "medicoResponsable.curp")).toEqual([]);
    const genericaMexicano = await validar(fuente({ medico: { ...MEDICO, curp: "XXXX999999XXXXXX99" }, hoja: HOJA_BASE }));
    expect(mensajes(genericaMexicano.v, "medicoResponsable.curp")[0]).toMatch(/sólo se admite para médicos nacidos fuera/);
    const sinMedico = await validar(fuente({ medico: null, episodio: { medicoId: null }, hoja: HOJA_BASE }));
    expect(mensajes(sinMedico.v, "medicoResponsableId")[0]).toMatch(/Falta el médico responsable/);
    // El responsable guardado en la hoja manda sobre el tratante.
    const otro = await validar(fuente({ medicoResponsable: { ...MEDICO, id: "med2", nombres: "Claudia", apellidoPaterno: "Rentería", apellidoMaterno: "Aguirre", cedula: "6120944" }, hoja: HOJA_BASE }));
    expect(otro.reg.nombreResponsable).toBe("CLAUDIA");
    expect(otro.reg.cedulaResponsable).toBe("6120944");
  });
});

describe("edad como la cuenta la DGIS", () => {
  it("años al egreso; menores de un año al ingreso en horas, días o meses", () => {
    const adulto = calcularEdadSaeh(fechaLocal(1982, 4, 4, 12), fechaLocal(2026, 9, 2), fechaLocal(2026, 9, 4));
    expect(adulto).toMatchObject({ tipo: 5, valor: 44, anios: 44 });
    const bebe = calcularEdadSaeh(fechaLocal(2026, 8, 1, 12), fechaLocal(2026, 9, 2), fechaLocal(2026, 9, 4));
    expect(bebe).toMatchObject({ tipo: 4, valor: 1, anios: 0 });
    const recien = calcularEdadSaeh(fechaLocal(2026, 8, 30, 12), fechaLocal(2026, 9, 2), fechaLocal(2026, 9, 4));
    expect(recien).toMatchObject({ tipo: 3, valor: 3, dias: 3 });
    const horas = calcularEdadSaeh(fechaLocal(2026, 9, 2, 3), fechaLocal(2026, 9, 2, 13), fechaLocal(2026, 9, 4));
    expect(horas).toMatchObject({ tipo: 2, valor: 10 });
    // Cumple un año durante la estancia: cuenta al egreso.
    const cumple = calcularEdadSaeh(fechaLocal(2025, 9, 3, 12), fechaLocal(2026, 9, 2), fechaLocal(2026, 9, 4));
    expect(cumple).toMatchObject({ tipo: 5, valor: 1 });
  });

  it("anestesia de la nota preanestésica → código", () => {
    expect(tipoAnestesiaDeTexto("General balanceada")).toBe(1);
    expect(tipoAnestesiaDeTexto("Bloqueo peridural")).toBe(2);
    expect(tipoAnestesiaDeTexto("Sedación consciente")).toBe(3);
    expect(tipoAnestesiaDeTexto("Anestesia local con lidocaína")).toBe(4);
    expect(tipoAnestesiaDeTexto("Mixta: general + peridural")).toBe(5);
    expect(tipoAnestesiaDeTexto("Sin anestesia")).toBe(6);
    expect(tipoAnestesiaDeTexto("ASA I")).toBeNull();
  });

  it("especialidad del médico → servicio DGIS", () => {
    const servicios = FILAS.filter((f) => f.tipo === "SERVICIO");
    expect(servicioDeEspecialidad("Cirugía general", servicios)).toBe("201");
    expect(servicioDeEspecialidad("Anestesiología", servicios)).toBe("501");
    expect(servicioDeEspecialidad("Ginecología y obstetricia", servicios)).toBe("403");
    expect(servicioDeEspecialidad("Medicina interna y geriatría", servicios)).toBe("MEDICINA INTERNA".length > "GERIATRIA".length ? "112" : "108");
    expect(servicioDeEspecialidad("Homeopatía", servicios)).toBeNull();
  });
});

describe("vencimiento SEUL", () => {
  it("último día hábil del mes siguiente a las 20:00", () => {
    const v = vencimientoSeul(2026, 9, fechaLocal(2026, 9, 5, 12));
    expect(v.fecha).toBe("2026-10-30"); // el 31 de octubre de 2026 es sábado
    expect(v.hora).toBe("20:00");
    expect(v.vencido).toBe(false);
    expect(v.diasRestantes).toBe(55);
    expect(v.texto).toMatch(/viernes 30 de octubre de 2026, 20:00 h/);
    expect(vencimientoSeul(2026, 12, fechaLocal(2027, 1, 1)).fecha).toBe("2027-01-29"); // 31-ene-2027 es domingo
    expect(vencimientoSeul(2025, 4, fechaLocal(2025, 6, 1)).vencido).toBe(true);
  });
});
