// ─────────────────────────────────────────────────────────────────────────────
// SAEH — lo que contestan GET y PUT /episodios/[id]/saeh: hoja efectiva,
// sociodemográficos del paciente, episodio, médico responsable, edad, el
// registro de 82 variables, la validación y las etiquetas de catálogo de las
// claves que aparecen, para que el satélite no haga otra llamada.
// ─────────────────────────────────────────────────────────────────────────────

import type { HospSaehEstado } from "@prisma/client";
import { nombreCompleto } from "../util";
import type { CatalogoSaeh } from "./catalogo";
import { CODIGOS_SAEH } from "./codigos";
import type { ContextoSaeh } from "./contexto";
import { claveLocalidad, claveMunicipio } from "./registro";
import type { ValidacionSaeh } from "./validar";

export type EtiquetasSaeh = Record<string, Record<string, string>>;

/** Nombres de catálogo de todas las claves presentes en el registro/paciente, por tipo. */
export async function etiquetasDeContexto(ctx: ContextoSaeh, catalogo: CatalogoSaeh): Promise<EtiquetasSaeh> {
  const { registro: r, paciente: p, fuente } = ctx;
  const out: EtiquetasSaeh = {};
  const pon = (tipo: string, clave: string | null | undefined, nombre: string | null | undefined) => {
    if (!clave || !nombre) return;
    (out[tipo] ??= {})[clave] = nombre;
  };
  const fila = async (tipo: Parameters<CatalogoSaeh["fila"]>[0], clave: string | null | undefined, extraClave?: string | null) => {
    if (!clave) return;
    const f = await catalogo.fila(tipo, clave);
    pon(tipo, clave, f?.nombre);
    if (extraClave) pon(tipo, extraClave, f?.nombre);
  };
  const cie = async (tipo: "CIE10" | "CIE9MC", clave: string | null | undefined) => {
    if (!clave) return;
    const f = await catalogo.cie(tipo, clave);
    pon(tipo, clave, f?.nombre);
  };

  await Promise.all([
    fila("PAIS", r.paisOrigen),
    fila("PAIS", r.paisResidencia),
    fila("PAIS", r.paisNacimiento),
    fila("ENTIDAD", r.entidadNacimiento),
    fila("ENTIDAD", r.entidadResidencia),
    fila("MUNICIPIO", claveMunicipio(p.municipioResidenciaClave, r.entidadResidencia), p.municipioResidenciaClave),
    fila("LOCALIDAD", claveLocalidad(p.localidadResidenciaClave, r.entidadResidencia, r.municipioResidencia), p.localidadResidenciaClave),
    fila("LENGUA", r.cualLengua !== "-1" ? r.cualLengua : null),
    fila("AFILIACION", r.derechohabiencia),
    fila("SERVICIO", r.claveServicioIngreso !== "-1" ? r.claveServicioIngreso : null),
    ...r.claveServicioAdicional.map((s) => fila("SERVICIO", s)),
    fila("SERVICIO", r.claveServicioEgreso),
    fila("CLUES", r.clues),
    fila("CLUES", r.cluesProcedencia),
    fila("CLUES", r.cluesReferido),
    cie("CIE10", r.codigoCIEAfeccionPrincipal),
    cie("CIE10", r.afeccionPrincipalReseleccionada),
    cie("CIE10", r.codigoCieCausaExterna),
    ...r.comorbilidades.map((c) => cie("CIE10", c.codigo)),
    ...r.procedimientos.map((pr) => cie("CIE9MC", pr.codigo)),
  ]);
  if (fuente.establecimiento.nombre) pon("CLUES", r.clues, fuente.establecimiento.nombre);
  return out;
}

export interface OpcionesRespuesta {
  /** Estado recién guardado (el PUT lo recalcula sin recargar la fila). */
  estado?: HospSaehEstado;
}

export async function armarRespuestaHoja(ctx: ContextoSaeh, validacion: ValidacionSaeh, catalogo: CatalogoSaeh, opciones: OpcionesRespuesta = {}) {
  const { fuente, hoja, paciente, edad, registro } = ctx;
  const fila = fuente.fila;
  const medico = fuente.medicoResponsable ?? fuente.medico;
  const etiquetas = await etiquetasDeContexto(ctx, catalogo);
  return {
    hoja: {
      ...hoja,
      guardada: !!fila,
      folioSaeh: fila?.folioSaeh ?? null,
      estado: opciones.estado ?? fila?.estado ?? "PENDIENTE",
      exportadoAt: fila?.exportadoAt ?? null,
      exportadoArchivo: fila?.exportadoArchivo ?? null,
      updatedAt: fila?.updatedAt ?? null,
    },
    prellenado: ctx.prellenado,
    paciente: {
      id: paciente.id,
      nombreCompleto: nombreCompleto(paciente),
      nombre: paciente.nombre,
      apellidoPaterno: paciente.apellidoPaterno,
      apellidoMaterno: paciente.apellidoMaterno,
      curp: paciente.curp,
      sinCurp: paciente.sinCurp,
      sexo: paciente.sexo,
      fechaNacimiento: paciente.fechaNacimiento,
      nacionalidad: paciente.nacionalidad,
      paisNacimientoClave: paciente.paisNacimientoClave,
      entidadNacimientoClave: paciente.entidadNacimientoClave,
      estadoConyugal: paciente.estadoConyugal,
      seConsideraIndigena: paciente.seConsideraIndigena,
      hablaLenguaIndigena: paciente.hablaLenguaIndigena,
      lenguaIndigenaClave: paciente.lenguaIndigenaClave,
      seConsideraAfromexicano: paciente.seConsideraAfromexicano,
      esMigranteRetornado: paciente.esMigranteRetornado,
      seIdentificaLgbti: paciente.seIdentificaLgbti,
      genero: paciente.genero,
      paisResidenciaClave: paciente.paisResidenciaClave,
      entidadResidenciaClave: paciente.entidadResidenciaClave,
      municipioResidenciaClave: paciente.municipioResidenciaClave,
      localidadResidenciaClave: paciente.localidadResidenciaClave,
      otraLocalidad: paciente.otraLocalidad,
      derechohabienciaClave: paciente.derechohabienciaClave,
      codigoPostal: paciente.codigoPostal,
      /** Textos libres de la ficha que sirvieron para proponer claves. */
      textos: { entidadNacimiento: paciente.entidadNacimiento, estado: paciente.estado, municipio: paciente.municipio },
    },
    pacientePrellenado: ctx.pacientePrellenado,
    episodio: {
      id: fuente.episodio.id,
      folio: fuente.episodio.folio,
      tipo: fuente.episodio.tipo,
      estado: fuente.episodio.estado,
      fechaIngreso: fuente.episodio.fechaIngreso,
      fechaAlta: fuente.episodio.fechaAlta,
      motivoEgreso: fuente.episodio.motivoEgreso,
      motivoEgresoSaeh: registro.motivoEgreso,
      diagnosticoIngresoCie10: fuente.episodio.diagnosticoIngresoCie10,
      diagnosticoEgresoCie10: fuente.episodio.diagnosticoEgresoCie10,
      procedimientoCie9: fuente.episodio.procedimientoCie9,
      medicoId: fuente.episodio.medicoId,
      areas: fuente.areas,
      pasoPorUrgencias: fuente.pasoPorUrgencias,
      subsecuente: fuente.subsecuente,
    },
    medicoResponsable: medico
      ? {
          id: medico.id,
          nombre: medico.nombre,
          especialidad: medico.especialidad,
          cedula: medico.cedula,
          curp: medico.curp,
          nombres: medico.nombres,
          apellidoPaterno: medico.apellidoPaterno,
          apellidoMaterno: medico.apellidoMaterno,
          paisNacimientoClave: medico.paisNacimientoClave,
        }
      : null,
    establecimiento: fuente.establecimiento,
    edad: edad ? { tipo: edad.tipo, valor: edad.valor, anios: edad.anios, dias: edad.dias, texto: edad.texto } : null,
    registro,
    validacion,
    catalogos: { etiquetas, codigos: CODIGOS_SAEH },
  };
}
