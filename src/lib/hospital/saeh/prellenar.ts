// ─────────────────────────────────────────────────────────────────────────────
// SAEH — prellenado de la hoja desde lo que el expediente ya sabe.
//
// Peso y talla de los signos, afección principal = CIE-10 de egreso con su
// nombre de catálogo, procedimiento = CIE-9-MC del episodio con la anestesia
// de la nota preanestésica y la cédula del cirujano, servicio de ingreso/
// egreso por la especialidad del médico, terapia por las camas de TERAPIA,
// procedencia por el tipo de episodio, subsecuencia por egresos previos;
// en el paciente, país/entidad de nacimiento desde la CURP y la
// nacionalidad, entidad/municipio de residencia desde los textos de la ficha.
// Nunca pisa lo que ya está guardado: rellena sólo lo que viene null.
// ─────────────────────────────────────────────────────────────────────────────

import { calcularEdadSaeh, PAIS_MEXICO, entidadDeCurp, procedenciaPorTipo, tipoAnestesiaDeTexto, tipoServicioPorTipo } from "./codigos";
import type { CatalogoSaeh } from "./catalogo";
import { servicioDeEspecialidad } from "./catalogo";
import type { ContextoSaeh, FuenteSaeh } from "./contexto";
import { hojaDesdeFila, type HojaSaeh, type PacienteSaeh } from "./hoja";
import { construirRegistro, claveMunicipio } from "./registro";
import { tiempoQuirofanoDeMinutos } from "./texto";

const NACIONALIDADES_MEXICANAS = new Set(["MEX", "MX", "MEXICANA", "MEXICANO", "MEXICO", "MÉXICO"]);

/** Servicio de terapia intensiva según la edad (neonatal, pediátrica o de adultos). */
function utiPorEdad(edadDias: number | null, anios: number | null): string {
  if (edadDias != null && edadDias <= 28) return "701";
  if (anios != null && anios < 18) return "605";
  return "603";
}

/** Sociodemográficos del paciente que se pueden proponer desde la ficha y la CURP. */
export async function prellenarPaciente(p: PacienteSaeh, catalogo: CatalogoSaeh): Promise<{ paciente: PacienteSaeh; prellenado: string[] }> {
  const out: PacienteSaeh = { ...p };
  const prellenado: string[] = [];
  const pon = <K extends keyof PacienteSaeh>(k: K, v: PacienteSaeh[K] | null | undefined) => {
    if (out[k] == null && v != null) {
      out[k] = v;
      prellenado.push(k);
    }
  };

  const entidadCurp = entidadDeCurp(p.curp);
  const nacionalidadMexicana = !!p.nacionalidad && NACIONALIDADES_MEXICANAS.has(p.nacionalidad.trim().toUpperCase());
  if (nacionalidadMexicana || (entidadCurp && entidadCurp !== "NE")) pon("paisNacimientoClave", PAIS_MEXICO);

  if (out.paisNacimientoClave === PAIS_MEXICO) {
    if (entidadCurp && entidadCurp !== "NE") pon("entidadNacimientoClave", entidadCurp);
    else if (p.entidadNacimiento) pon("entidadNacimientoClave", (await catalogo.porNombre("ENTIDAD", p.entidadNacimiento))?.clave ?? null);
  } else if (out.paisNacimientoClave && out.paisNacimientoClave !== PAIS_MEXICO) {
    pon("entidadNacimientoClave", "88");
  }

  // Residencia: si la ficha trae estado/municipio/CP mexicanos, reside en México.
  if (p.estado || p.municipio || p.codigoPostal || nacionalidadMexicana) pon("paisResidenciaClave", PAIS_MEXICO);
  if (out.paisResidenciaClave === PAIS_MEXICO) {
    if (p.estado) pon("entidadResidenciaClave", (await catalogo.porNombre("ENTIDAD", p.estado))?.clave ?? null);
    const entidad = out.entidadResidenciaClave;
    if (entidad && /^\d{2}$/.test(entidad) && p.municipio) {
      pon("municipioResidenciaClave", (await catalogo.porNombre("MUNICIPIO", p.municipio, entidad))?.clave ?? null);
    }
    // La ficha no captura localidad: la DGIS pide «9999 – NO ESPECIFICADO» en ese caso.
    if (entidad && claveMunicipio(out.municipioResidenciaClave, entidad)) pon("localidadResidenciaClave", "9999");
  } else if (out.paisResidenciaClave) {
    pon("entidadResidenciaClave", "88");
  }
  return { paciente: out, prellenado };
}

/** La hoja efectiva: lo guardado más lo que el expediente permite proponer. */
export async function prellenarHoja(
  fuente: FuenteSaeh,
  guardada: HojaSaeh,
  catalogo: CatalogoSaeh,
  edad: { dias: number; anios: number } | null
): Promise<{ hoja: HojaSaeh; prellenado: string[] }> {
  const { episodio, medico } = fuente;
  const hoja: HojaSaeh = { ...guardada, serviciosAdicionales: [...guardada.serviciosAdicionales], comorbilidades: [...guardada.comorbilidades], procedimientos: [...guardada.procedimientos], productos: [...guardada.productos] };
  const prellenado: string[] = [];
  const pon = <K extends keyof HojaSaeh>(k: K, v: HojaSaeh[K] | null | undefined) => {
    if (hoja[k] == null && v != null) {
      hoja[k] = v;
      prellenado.push(k);
    }
  };

  // Signos vitales → peso/talla.
  pon("peso", fuente.signos.peso);
  pon("talla", fuente.signos.talla);

  // Servicios: tipo por episodio, clave por especialidad del médico tratante.
  const tipoServicio = tipoServicioPorTipo(episodio.tipo);
  pon("tipoServicioIngreso", tipoServicio.tipoServicioIngreso);
  const servicios = await catalogo.servicios();
  const servicioMedico = servicioDeEspecialidad(medico?.especialidad, servicios);
  if (hoja.tipoServicioIngreso === 2) pon("claveServicioIngreso", "-1");
  else pon("claveServicioIngreso", servicioMedico);
  pon("claveServicioEgreso", servicioMedico);

  // Pasó por terapia: servicio adicional de UTI y su estancia.
  if (hoja.tipoServicioIngreso === 1 && fuente.areas.includes("TERAPIA") && guardada.serviciosAdicionales.length === 0) {
    const uti = utiPorEdad(edad?.dias ?? null, edad?.anios ?? null);
    if (uti !== hoja.claveServicioIngreso) {
      hoja.serviciosAdicionales = [uti];
      prellenado.push("serviciosAdicionales");
    }
    if (fuente.horasTerapia != null) {
      const horas = Math.round(fuente.horasTerapia);
      pon("terapiaIntensivaDias", Math.min(90, Math.floor(horas / 24)));
      pon("terapiaIntensivaHoras", Math.floor(horas / 24) === 0 ? Math.max(1, horas % 24) : horas % 24);
    }
  }

  // Procedencia: urgencias si pasó por ahí; si no, la regla por tipo de episodio.
  pon("procedencia", fuente.pasoPorUrgencias ? 2 : procedenciaPorTipo(episodio.tipo));

  // Afección principal = CIE-10 de egreso (o de ingreso si aún no hay egreso codificado).
  const dx = episodio.diagnosticoEgresoCie10 ?? episodio.diagnosticoIngresoCie10;
  if (dx) {
    const fila = await catalogo.cie("CIE10", dx);
    pon("codigoAfeccionPrincipal", fila?.clave ?? dx.replace(/\./g, "").toUpperCase());
    pon("descripcionAfeccionPrincipal", fila?.nombre ?? episodio.diagnosticoEgresoCie10 ?? null);
  }
  if (hoja.codigoAfeccionPrincipal && !hoja.descripcionAfeccionPrincipal) {
    pon("descripcionAfeccionPrincipal", (await catalogo.cie("CIE10", hoja.codigoAfeccionPrincipal))?.nombre ?? null);
  }
  for (const c of hoja.comorbilidades) {
    if (!c.descripcion) c.descripcion = (await catalogo.cie("CIE10", c.codigo))?.nombre ?? null;
  }
  pon("tipoAtencion", fuente.subsecuente ? 2 : 1);

  // Procedimiento del episodio con anestesia, quirófano, tiempo y cédula.
  if (guardada.procedimientos.length === 0 && episodio.procedimientoCie9) {
    const fila = await catalogo.cie("CIE9MC", episodio.procedimientoCie9);
    const quirurgico = fila?.subtipo === "Q";
    const dentro = quirurgico || fuente.areas.includes("QUIROFANO") || fuente.notas.hayPostoperatoria;
    hoja.procedimientos = [
      {
        codigo: fila?.clave ?? episodio.procedimientoCie9.replace(/\./g, "").toUpperCase(),
        descripcion: fila?.nombre ?? null,
        tipoAnestesia: tipoAnestesiaDeTexto(fuente.notas.tipoAnestesiaTexto),
        quirofano: dentro ? 1 : 2,
        tiempoQuirofano: dentro ? (fuente.minutosQuirofano ? tiempoQuirofanoDeMinutos(fuente.minutosQuirofano) : "99:99") : null,
        cedula: dentro ? (medico?.cedula ?? null) : null,
      },
    ];
    prellenado.push("procedimientos");
  }
  for (const p of hoja.procedimientos) {
    if (!p.descripcion) p.descripcion = (await catalogo.cie("CIE9MC", p.codigo))?.nombre ?? null;
  }

  // Responsable de la atención: el médico tratante del episodio.
  pon("medicoResponsableId", episodio.medicoId);

  return { hoja, prellenado };
}

/**
 * Fuente → contexto completo: paciente y hoja efectivos, edad como la cuenta
 * la DGIS y el registro de 82 variables listo para validar o exportar.
 */
export async function prepararContexto(fuente: FuenteSaeh, catalogo: CatalogoSaeh, hoy: Date = new Date()): Promise<ContextoSaeh> {
  const { paciente, prellenado: pacientePrellenado } = await prellenarPaciente(fuente.paciente, catalogo);
  const egreso = fuente.episodio.fechaAlta ?? hoy;
  const edad = paciente.fechaNacimiento ? calcularEdadSaeh(paciente.fechaNacimiento, fuente.episodio.fechaIngreso, egreso) : null;
  const { hoja, prellenado } = await prellenarHoja(fuente, hojaDesdeFila(fuente.fila), catalogo, edad);
  const registro = construirRegistro({ fuente, hoja, paciente, edad });
  return { fuente, hoja, prellenado, paciente, pacientePrellenado, edad, registro, hoy };
}
