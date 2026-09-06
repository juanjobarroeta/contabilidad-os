// ─────────────────────────────────────────────────────────────────────────────
// Paquete de admisión: los documentos que el paciente firma al ingresar, con
// su texto legal resuelto y su hash, listos para HospFirma.
//
//   documentosAdmisionRequeridos — qué tipos exige el episodio según su tipo y
//                                  su pagador (puro).
//   crearDocumentoConPlantilla   — un HospDocumento del paciente (y del
//                                  episodio, si aplica) con textoFirmado,
//                                  hashContenido, firmasRequeridas y versión.
//   paqueteAdmision              — crea lo que falta del paquete estándar y
//                                  devuelve todos los documentos del paciente y
//                                  del episodio con sus firmas.
//   listarDocumentosPaciente     — documentos del paciente (episodioId null) +
//                                  los del episodio pedido.
// ─────────────────────────────────────────────────────────────────────────────

import type { HospDocumentoTipo, HospEpisodioTipo, HospPagadorTipo, Prisma, PrismaClient } from "@prisma/client";
import { PLANTILLAS_DOCUMENTO, TIPOS_ADMISION, TIPOS_CONSENTIMIENTO, errorContenido } from "./documentos";
import { HospitalError } from "./errores";
import { documentoConFirmas, type DocumentoSerializado } from "./firmas";
import { firmasRequeridasPara, hashContenidoDocumento, plantillaVigente, renderizarPlantilla, type ContextoPlantilla, type PlantillasConfig } from "./plantillas-legales";
import { claveDia } from "./tz";
import { nombreCompleto } from "./util";

type Db = PrismaClient | Prisma.TransactionClient;

/** Tipos que viven en el paciente (episodioId null) aunque los pida un episodio. */
export const TIPOS_NIVEL_PACIENTE: readonly HospDocumentoTipo[] = ["AVISO_PRIVACIDAD", "IDENTIFICACION", "CONSTANCIA_CURP"];

/**
 * El paquete estándar: aviso de privacidad siempre; consentimiento de datos
 * cuando hay un tercero pagador (transferencia LFPDPPP art. 36); contrato y
 * compromiso de pago en todo ingreso; cesión de derechos con aseguradora;
 * consentimiento de ingreso en hospitalización y cirugía ambulatoria
 * (NOM-004 10.1.1); identificación oficial.
 */
export function documentosAdmisionRequeridos(a: { tipoEpisodio: HospEpisodioTipo; pagadorTipo: HospPagadorTipo | null | undefined }): HospDocumentoTipo[] {
  const docs: HospDocumentoTipo[] = ["AVISO_PRIVACIDAD"];
  if (a.pagadorTipo && a.pagadorTipo !== "PARTICULAR") docs.push("CONSENTIMIENTO_DATOS");
  docs.push("CONTRATO_SERVICIOS", "COMPROMISO_PAGO");
  if (a.pagadorTipo === "ASEGURADORA") docs.push("CESION_DERECHOS");
  if (a.tipoEpisodio === "HOSPITALIZACION" || a.tipoEpisodio === "AMBULATORIO") docs.push("CONSENTIMIENTO_HOSPITALIZACION");
  docs.push("IDENTIFICACION");
  return docs;
}

/** Contenido mínimo NOM-004 del consentimiento de ingreso cuando el hospital no captura el suyo. */
export function contenidoDefaultConsentimientoIngreso(a: { establecimiento: string; procedimiento?: string | null; diagnostico?: string | null }): Record<string, unknown> {
  const acto = a.procedimiento?.trim() || (a.diagnostico?.trim() ? `el tratamiento de ${a.diagnostico.trim()}` : "el tratamiento indicado por el médico tratante");
  return {
    establecimiento: a.establecimiento,
    procedimiento: `Ingreso hospitalario para ${acto}`,
    riesgos: "Infección asociada a la atención, reacciones adversas a medicamentos, caídas, complicaciones propias del padecimiento y de los procedimientos que requiera.",
    beneficios: "Vigilancia médica y de enfermería continua, tratamiento, estudios y procedimientos en el propio establecimiento.",
    alternativas: "Manejo ambulatorio o atención en otra unidad, cuando el padecimiento lo permita; no recibir el tratamiento, con los riesgos de su evolución natural.",
    autorizaProcedimientosAdicionales: true,
  };
}

// ── Contexto para las plantillas ─────────────────────────────────────────────

const fechaLarga = (d: Date) => {
  const [y, m, dd] = claveDia(d).split("-");
  const meses = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
  return `${Number(dd)} de ${meses[Number(m) - 1]} de ${y}`;
};

const domicilioDe = (p: { domicilio: string | null; calle: string | null; numeroExterior: string | null; numeroInterior: string | null; colonia: string | null; municipio: string | null; estado: string | null; codigoPostal: string | null }) => {
  const partes = [
    [p.calle, p.numeroExterior, p.numeroInterior ? `int. ${p.numeroInterior}` : null].filter(Boolean).join(" "),
    p.colonia,
    p.municipio,
    p.estado,
    p.codigoPostal ? `C.P. ${p.codigoPostal}` : null,
  ].filter((s) => s && s.trim());
  return partes.length ? partes.join(", ") : p.domicilio?.trim() || null;
};

export interface DatosContexto {
  companyId: string;
  pacienteId: string;
  episodioId?: string | null;
  contenido?: Record<string, unknown> | null;
  ahora?: Date;
}

export async function contextoPlantilla(db: Db, a: DatosContexto) {
  const ahora = a.ahora ?? new Date();
  const [paciente, company, config, episodio] = await Promise.all([
    db.hospPaciente.findUnique({
      where: { id: a.pacienteId },
      select: {
        id: true, companyId: true, nombre: true, apellidoPaterno: true, apellidoMaterno: true, curp: true, rfc: true, expedienteNumero: true, fechaNacimiento: true, telefono: true, email: true,
        domicilio: true, calle: true, numeroExterior: true, numeroInterior: true, colonia: true, municipio: true, estado: true, codigoPostal: true,
      },
    }),
    db.company.findUnique({ where: { id: a.companyId }, select: { razonSocial: true, nombreComercial: true, rfc: true, domicilioFiscal: true, codigoPostal: true, email: true, telefono: true } }),
    db.hospConfig.findUnique({ where: { companyId: a.companyId } }),
    a.episodioId
      ? db.hospEpisodio.findUnique({
          where: { id: a.episodioId },
          select: { id: true, companyId: true, pacienteId: true, folio: true, tipo: true, estado: true, fechaIngreso: true, diagnostico: true, diagnosticoCie10: true, procedimiento: true, medico: { select: { nombre: true } }, pagador: { select: { id: true, nombre: true, tipo: true } } },
        })
      : Promise.resolve(null),
  ]);
  if (!paciente || paciente.companyId !== a.companyId) throw new HospitalError(404, "Paciente no encontrado");
  if (a.episodioId && (!episodio || episodio.companyId !== a.companyId)) throw new HospitalError(404, "Episodio no encontrado");
  if (episodio && episodio.pacienteId !== paciente.id) throw new HospitalError(409, `El episodio ${episodio.folio} no es de este paciente`);
  if (!company) throw new HospitalError(404, "Empresa no encontrada");

  const pagador = episodio?.pagador ?? (await db.hospPaciente.findUnique({ where: { id: paciente.id }, select: { pagador: { select: { id: true, nombre: true, tipo: true } } } }))?.pagador ?? null;
  const contacto = [company.email, company.telefono].filter(Boolean).join(" · ") || null;
  const ctx: ContextoPlantilla = {
    paciente: {
      nombreCompleto: nombreCompleto(paciente),
      curp: paciente.curp,
      rfc: paciente.rfc,
      domicilio: domicilioDe(paciente),
      expedienteNumero: paciente.expedienteNumero,
      fechaNacimiento: paciente.fechaNacimiento ? claveDia(paciente.fechaNacimiento) : null,
      telefono: paciente.telefono,
      email: paciente.email,
    },
    hospital: {
      razonSocial: config?.nombreHospital ? `${company.razonSocial} (${config.nombreHospital})` : company.razonSocial,
      nombreComercial: config?.nombreHospital ?? company.nombreComercial ?? null,
      rfc: company.rfc,
      clues: config?.clues ?? null,
      licenciaSanitaria: config?.licenciaSanitaria ?? null,
      responsableSanitario: config?.responsableSanitario ? `${config.responsableSanitario}${config.responsableSanitarioCedula ? ` (céd. ${config.responsableSanitarioCedula})` : ""}` : null,
      responsableSanitarioCedula: config?.responsableSanitarioCedula ?? null,
      domicilio: company.domicilioFiscal ?? (company.codigoPostal ? `C.P. ${company.codigoPostal}` : null),
      contacto,
      avisoPrivacidadUrl: config?.avisoPrivacidadUrl ?? null,
    },
    episodio: episodio
      ? {
          folio: episodio.folio,
          fechaIngreso: fechaLarga(episodio.fechaIngreso),
          tipo: episodio.tipo,
          medico: episodio.medico?.nombre ?? null,
          diagnostico: [episodio.diagnosticoCie10, episodio.diagnostico].filter(Boolean).join(" ") || null,
          procedimiento: episodio.procedimiento,
        }
      : null,
    pagador: pagador ? { nombre: pagador.nombre, tipo: pagador.tipo } : null,
    fecha: fechaLarga(ahora),
    contenido: a.contenido ?? null,
  };
  return { ctx, paciente, episodio, pagador, config, plantillas: (config?.plantillasDocumentos ?? null) as PlantillasConfig | null };
}

// ── Crear un documento con plantilla ─────────────────────────────────────────

export interface CrearDocumentoArgs {
  companyId: string;
  pacienteId: string;
  episodioId?: string | null;
  tipo: HospDocumentoTipo;
  nombre?: string | null;
  contenido?: Record<string, unknown> | null;
  /** Fija la versión declarada; si no coincide con la vigente, 409. */
  plantillaVersion?: string | null;
  requerido?: boolean;
  user?: { id?: string | null } | null;
  ahora?: Date;
}

/**
 * Registra un documento del paciente. Con plantilla: textoFirmado, hash,
 * firmasRequeridas y versión listos para firmar; sin plantilla (identificación,
 * póliza…): PENDIENTE a la espera del archivo.
 */
export async function crearDocumentoConPlantilla(db: Db, a: CrearDocumentoArgs): Promise<{ documento: DocumentoSerializado; advertencias: string[] }> {
  const ahora = a.ahora ?? new Date();
  const { ctx, episodio, plantillas } = await contextoPlantilla(db, { companyId: a.companyId, pacienteId: a.pacienteId, episodioId: a.episodioId, contenido: a.contenido, ahora });
  if (episodio && episodio.estado === "CANCELADO") throw new HospitalError(409, `El episodio ${episodio.folio} está cancelado`);

  let contenido = a.contenido ?? null;
  if (a.tipo === "CONSENTIMIENTO_HOSPITALIZACION" && !contenido) {
    contenido = contenidoDefaultConsentimientoIngreso({ establecimiento: ctx.hospital.nombreComercial ?? ctx.hospital.razonSocial, procedimiento: ctx.episodio?.procedimiento, diagnostico: ctx.episodio?.diagnostico });
    ctx.contenido = contenido;
  }
  const motivo = errorContenido(a.tipo, contenido, false);
  if (motivo) throw new HospitalError(400, motivo);

  const vigente = plantillaVigente(a.tipo, plantillas);
  if (a.plantillaVersion && vigente && a.plantillaVersion.trim() !== vigente.version) {
    throw new HospitalError(409, `La versión ${a.plantillaVersion} de ${a.tipo} ya no es la vigente (${vigente.version}); recarga la plantilla`);
  }
  const render = renderizarPlantilla(a.tipo, ctx, plantillas);
  const requeridas = firmasRequeridasPara(a.tipo);
  const nombre = a.nombre?.trim() || render?.titulo || PLANTILLAS_DOCUMENTO[a.tipo].titulo;

  const doc = await db.hospDocumento.create({
    data: {
      companyId: a.companyId,
      pacienteId: a.pacienteId,
      episodioId: TIPOS_NIVEL_PACIENTE.includes(a.tipo) && !TIPOS_CONSENTIMIENTO.includes(a.tipo) ? null : (a.episodioId ?? null),
      tipo: a.tipo,
      nombre,
      estado: "PENDIENTE",
      requerido: a.requerido ?? true,
      subidoPorUserId: a.user?.id ?? null,
      contenido: contenido === null ? undefined : (contenido as Prisma.InputJsonValue),
      ...(render
        ? {
            plantillaVersion: render.version,
            textoFirmado: render.texto,
            hashContenido: hashContenidoDocumento(render.texto, contenido),
            firmasRequeridas: requeridas,
          }
        : { firmasRequeridas: requeridas }),
    },
    omit: { archivo: true },
    include: { firmas: true },
  });
  return { documento: documentoConFirmas(doc), advertencias: render?.advertencias ?? [] };
}

// ── El paquete estándar ──────────────────────────────────────────────────────

export interface PaqueteAdmisionArgs {
  episodioId: string;
  user?: { id?: string | null } | null;
  ahora?: Date;
}

export async function paqueteAdmision(db: PrismaClient, a: PaqueteAdmisionArgs) {
  const ahora = a.ahora ?? new Date();
  const episodio = await db.hospEpisodio.findUnique({
    where: { id: a.episodioId },
    select: { id: true, companyId: true, pacienteId: true, folio: true, tipo: true, estado: true, procedimiento: true, diagnostico: true, pagador: { select: { tipo: true } } },
  });
  if (!episodio) throw new HospitalError(404, "Episodio no encontrado");
  if (episodio.estado === "CANCELADO") throw new HospitalError(409, `El episodio ${episodio.folio} está cancelado`);

  const config = await db.hospConfig.findUnique({ where: { companyId: episodio.companyId }, select: { plantillasDocumentos: true, nombreHospital: true } });
  const plantillas = (config?.plantillasDocumentos ?? null) as PlantillasConfig | null;
  const existentes = await db.hospDocumento.findMany({
    where: { pacienteId: episodio.pacienteId, OR: [{ episodioId: null }, { episodioId: episodio.id }] },
    omit: { archivo: true },
    include: { firmas: true },
  });

  const requeridos = documentosAdmisionRequeridos({ tipoEpisodio: episodio.tipo, pagadorTipo: episodio.pagador?.tipo ?? null });
  const creados: string[] = [];
  const completados: string[] = [];
  const omitidos: Array<{ tipo: HospDocumentoTipo; motivo: string }> = [];
  const advertencias: string[] = [];

  for (const tipo of requeridos) {
    const delEpisodio = existentes.filter((d) => d.tipo === tipo && d.episodioId === episodio.id);
    const delPaciente = existentes.filter((d) => d.tipo === tipo && d.episodioId === null);

    if (tipo === "AVISO_PRIVACIDAD") {
      const version = plantillaVigente(tipo, plantillas)!.version;
      const vigente = [...delPaciente, ...existentes.filter((d) => d.tipo === tipo && d.episodioId !== null)].find((d) => (d.estado === "FIRMADO" && d.plantillaVersion === version) || (d.estado !== "FIRMADO" && d.plantillaVersion === version));
      if (vigente) {
        omitidos.push({ tipo, motivo: vigente.estado === "FIRMADO" ? `Aviso de privacidad v${version} ya firmado` : `Aviso de privacidad v${version} ya registrado, pendiente de firma` });
        continue;
      }
    } else if (tipo === "IDENTIFICACION") {
      const recibida = [...delEpisodio, ...delPaciente].find((d) => d.estado !== "PENDIENTE");
      const pendiente = [...delEpisodio, ...delPaciente][0];
      if (recibida || pendiente) {
        omitidos.push({ tipo, motivo: recibida ? "Identificación ya recibida" : "Identificación ya registrada, pendiente de archivo" });
        continue;
      }
    } else if (tipo === "CONSENTIMIENTO_HOSPITALIZACION") {
      const previo = delEpisodio[0];
      if (previo?.estado === "FIRMADO") {
        omitidos.push({ tipo, motivo: "Consentimiento de ingreso ya firmado" });
        continue;
      }
      if (previo && !previo.textoFirmado) {
        // El que abrió P1 al crear el episodio: se le pone el texto legal y el hash.
        const contenido = (previo.contenido as Record<string, unknown> | null) ?? contenidoDefaultConsentimientoIngreso({ establecimiento: config?.nombreHospital ?? "el establecimiento", procedimiento: episodio.procedimiento, diagnostico: episodio.diagnostico });
        const { ctx } = await contextoPlantilla(db, { companyId: episodio.companyId, pacienteId: episodio.pacienteId, episodioId: episodio.id, contenido, ahora });
        const render = renderizarPlantilla(tipo, ctx, plantillas)!;
        await db.hospDocumento.update({
          where: { id: previo.id },
          data: {
            contenido: contenido as Prisma.InputJsonValue,
            plantillaVersion: render.version,
            textoFirmado: render.texto,
            hashContenido: hashContenidoDocumento(render.texto, contenido),
            firmasRequeridas: firmasRequeridasPara(tipo),
          },
        });
        completados.push(previo.id);
        advertencias.push(...render.advertencias.map((m) => `${tipo}: ${m}`));
        continue;
      }
      if (previo) {
        omitidos.push({ tipo, motivo: "Consentimiento de ingreso ya registrado, pendiente de firma" });
        continue;
      }
    } else if (delEpisodio.length) {
      omitidos.push({ tipo, motivo: `${PLANTILLAS_DOCUMENTO[tipo].titulo} ya registrado` });
      continue;
    }

    const { documento, advertencias: adv } = await crearDocumentoConPlantilla(db, {
      companyId: episodio.companyId,
      pacienteId: episodio.pacienteId,
      episodioId: episodio.id,
      tipo,
      user: a.user,
      ahora,
    });
    creados.push(documento.id);
    advertencias.push(...adv.map((m) => `${tipo}: ${m}`));
  }

  const documentos = await listarDocumentosPaciente(db, { pacienteId: episodio.pacienteId, episodioId: episodio.id });
  return {
    episodio: { id: episodio.id, folio: episodio.folio, tipo: episodio.tipo },
    requeridos,
    creados,
    completados,
    omitidos,
    advertencias,
    documentos,
    pendientes: documentos.filter((d) => d.estado !== "FIRMADO" && (TIPOS_ADMISION as readonly string[]).includes(d.tipo)).map((d) => ({ id: d.id, tipo: d.tipo, nombre: d.nombre, estado: d.estado, firmasFaltantes: d.firmasFaltantes })),
  };
}

/** Documentos del paciente (episodioId null) y, si se pide, los del episodio. Sin bytes ni imágenes de firma. */
export async function listarDocumentosPaciente(db: Db, a: { pacienteId: string; episodioId?: string | null }): Promise<DocumentoSerializado[]> {
  const docs = await db.hospDocumento.findMany({
    where: { pacienteId: a.pacienteId, ...(a.episodioId ? { OR: [{ episodioId: null }, { episodioId: a.episodioId }] } : {}) },
    orderBy: [{ createdAt: "asc" }],
    omit: { archivo: true },
    include: { firmas: { orderBy: { at: "asc" } } },
  });
  return docs.map((d) => documentoConFirmas(d, { conTexto: false }));
}
