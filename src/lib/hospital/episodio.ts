// ─────────────────────────────────────────────────────────────────────────────
// Crear un episodio (ingreso). Lo comparten POST /episodios y
// POST /cotizaciones/[id]/convertir: una sola forma de abrir un expediente.
//
// En una transacción: folio, validación de que paciente/cama/médico/pagador/
// receptor son de la empresa, cama LIBRE → OCUPADA con su HospTraslado
// INGRESO, la lista de documentos requeridos (los «Pendientes» del
// expediente) y, si nace de una cotización, sus partidas copiadas como cargos
// con origen COTIZACION y la cotización marcada CONVERTIDA.
//
// Una cama asignada a un ingreso PROGRAMADO se reserva desde ya (queda
// OCUPADA): es la forma más simple de que dos programaciones no se pisen.
// ─────────────────────────────────────────────────────────────────────────────

import type { HospDocumentoTipo, HospEpisodioEstado, HospEpisodioTipo, HospRecursoTipo, PrismaClient } from "@prisma/client";
import { HospitalError } from "./errores";
import { conFolioUnico, siguienteFolio } from "./folio";
import { inicioDiaLocal } from "./tz";
import { r2 } from "./util";

export interface CrearEpisodioArgs {
  companyId: string;
  pacienteId: string;
  tipo: HospEpisodioTipo;
  recursoId?: string | null;
  medicoId?: string | null;
  /** undefined = el convenio default del paciente; null = sin convenio. */
  pagadorId?: string | null;
  /** undefined = el receptor fiscal default del paciente; null = ninguno. */
  customerId?: string | null;
  diagnosticoCie10?: string | null;
  diagnostico?: string | null;
  procedimiento?: string | null;
  motivo?: string | null;
  autorizacionPagador?: string | null;
  notasAdmin?: string | null;
  cotizacionId?: string | null;
  fechaIngreso?: Date | null;
  usuario?: { id?: string | null; nombre: string } | null;
  /** Sólo seeds y migraciones: fija el folio en vez de pedir el siguiente. */
  folio?: string;
  hoy?: Date;
}

export const ETIQUETA_RECURSO: Record<HospRecursoTipo, string> = {
  CAMA: "La cama",
  QUIROFANO: "El quirófano",
  CONSULTORIO: "El consultorio",
  SALA: "La sala",
};

const ESTADO_RECURSO_TEXTO = {
  LIBRE: "libre",
  OCUPADA: "ocupada",
  LIMPIEZA: "en limpieza",
  FUERA_DE_SERVICIO: "fuera de servicio",
} as const;

export function describirRecursoNoLibre(recurso: { tipo: HospRecursoTipo; nombre: string; estado: keyof typeof ESTADO_RECURSO_TEXTO; activo: boolean }): string {
  const etiqueta = ETIQUETA_RECURSO[recurso.tipo];
  if (!recurso.activo) return `${etiqueta} ${recurso.nombre} está dada de baja`;
  return `${etiqueta} ${recurso.nombre} está ${ESTADO_RECURSO_TEXTO[recurso.estado]}`;
}

/** Estado con el que nace el episodio según tipo y fecha de ingreso. */
export function estadoInicial(tipo: HospEpisodioTipo, fechaIngreso: Date, hoy: Date): HospEpisodioEstado {
  if (fechaIngreso.getTime() > hoy.getTime()) return "PROGRAMADO";
  if (tipo === "HOSPITALIZACION") return "HOSPITALIZADO";
  return "EN_VALORACION";
}

/**
 * Documentos requeridos por default: identificación siempre; consentimientos
 * cuando hay procedimiento (o cita de quirófano); póliza con aseguradora;
 * nota de egreso en hospitalización.
 */
export function documentosRequeridos(args: {
  tipo: HospEpisodioTipo;
  procedimiento?: string | null;
  conCitaQuirofano: boolean;
  pagadorTipo?: string | null;
}): Array<{ tipo: HospDocumentoTipo; nombre: string }> {
  const docs: Array<{ tipo: HospDocumentoTipo; nombre: string }> = [{ tipo: "IDENTIFICACION", nombre: "Identificación oficial" }];
  const quirurgico =
    !!args.procedimiento?.trim() ||
    ((args.tipo === "AMBULATORIO" || args.tipo === "HOSPITALIZACION") && args.conCitaQuirofano);
  if (quirurgico) {
    docs.push({ tipo: "CONSENTIMIENTO_CIRUGIA", nombre: "Consentimiento de cirugía" });
    docs.push({ tipo: "CONSENTIMIENTO_ANESTESIA", nombre: "Consentimiento de anestesia" });
  }
  if (args.pagadorTipo === "ASEGURADORA") docs.push({ tipo: "POLIZA", nombre: "Póliza / carnet de asegurado" });
  if (args.tipo === "HOSPITALIZACION") docs.push({ tipo: "NOTA_EGRESO", nombre: "Nota de egreso" });
  return docs;
}

export async function crearEpisodio(db: PrismaClient, args: CrearEpisodioArgs) {
  const hoy = args.hoy ?? new Date();
  const fechaIngreso = args.fechaIngreso ?? hoy;

  return conFolioUnico(() =>
    db.$transaction(async (tx) => {
      const paciente = await tx.hospPaciente.findUnique({
        where: { id: args.pacienteId },
        select: { id: true, companyId: true, pagadorId: true, customerId: true, activo: true },
      });
      if (!paciente || paciente.companyId !== args.companyId) throw new HospitalError(404, "Paciente no encontrado");

      const pagadorId = args.pagadorId === undefined ? paciente.pagadorId : args.pagadorId;
      const customerId = args.customerId === undefined ? paciente.customerId : args.customerId;

      const recurso = args.recursoId
        ? await tx.hospRecurso.findUnique({
            where: { id: args.recursoId },
            select: { id: true, companyId: true, tipo: true, nombre: true, estado: true, activo: true },
          })
        : null;
      if (args.recursoId && (!recurso || recurso.companyId !== args.companyId)) throw new HospitalError(400, "recursoId inválido");
      if (recurso && (!recurso.activo || recurso.estado !== "LIBRE")) throw new HospitalError(409, describirRecursoNoLibre(recurso));

      if (args.medicoId) {
        const m = await tx.hospMedico.findUnique({ where: { id: args.medicoId }, select: { companyId: true } });
        if (!m || m.companyId !== args.companyId) throw new HospitalError(400, "medicoId inválido");
      }
      const pagador = pagadorId
        ? await tx.hospPagador.findUnique({ where: { id: pagadorId }, select: { companyId: true, tipo: true } })
        : null;
      if (pagadorId && (!pagador || pagador.companyId !== args.companyId)) throw new HospitalError(400, "pagadorId inválido");
      if (customerId) {
        const c = await tx.customer.findUnique({ where: { id: customerId }, select: { companyId: true } });
        if (!c || c.companyId !== args.companyId) throw new HospitalError(400, "customerId inválido");
      }

      const cotizacion = args.cotizacionId
        ? await tx.hospCotizacion.findUnique({
            where: { id: args.cotizacionId },
            include: { partidas: { orderBy: { orden: "asc" } }, episodio: { select: { id: true, folio: true } } },
          })
        : null;
      if (args.cotizacionId && (!cotizacion || cotizacion.companyId !== args.companyId)) {
        throw new HospitalError(404, "Cotización no encontrada");
      }
      if (cotizacion) {
        if (cotizacion.episodio) throw new HospitalError(409, `La cotización ${cotizacion.folio} ya se convirtió en el episodio ${cotizacion.episodio.folio}`);
        if (cotizacion.estado === "CANCELADA" || cotizacion.estado === "VENCIDA") {
          throw new HospitalError(409, `La cotización ${cotizacion.folio} está ${cotizacion.estado.toLowerCase()}`);
        }
        if (cotizacion.pacienteId && cotizacion.pacienteId !== paciente.id) {
          throw new HospitalError(409, `La cotización ${cotizacion.folio} es de otro paciente`);
        }
      }

      const conCitaQuirofano =
        (await tx.hospCita.count({
          where: {
            companyId: args.companyId,
            pacienteId: paciente.id,
            recurso: { tipo: "QUIROFANO" },
            estado: { notIn: ["CANCELADA", "NO_ASISTIO"] },
            inicio: { gte: inicioDiaLocal(fechaIngreso) },
          },
        })) > 0;

      const folio = args.folio ?? (await siguienteFolio(tx, args.companyId, "episodio", fechaIngreso));
      const estado = estadoInicial(args.tipo, fechaIngreso, hoy);

      const episodio = await tx.hospEpisodio.create({
        data: {
          companyId: args.companyId,
          folio,
          pacienteId: paciente.id,
          tipo: args.tipo,
          estado,
          fechaIngreso,
          recursoId: recurso?.id ?? null,
          medicoId: args.medicoId ?? null,
          pagadorId: pagadorId ?? null,
          customerId: customerId ?? null,
          diagnosticoCie10: args.diagnosticoCie10?.trim() || null,
          diagnostico: args.diagnostico?.trim() || null,
          procedimiento: args.procedimiento?.trim() || (cotizacion?.procedimiento ?? null),
          motivo: args.motivo?.trim() || null,
          autorizacionPagador: args.autorizacionPagador?.trim() || null,
          notasAdmin: args.notasAdmin?.trim() || null,
          cotizacionId: cotizacion?.id ?? null,
          creadoPorUserId: args.usuario?.id ?? null,
          documentos: {
            create: documentosRequeridos({
              tipo: args.tipo,
              procedimiento: args.procedimiento ?? cotizacion?.procedimiento,
              conCitaQuirofano,
              pagadorTipo: pagador?.tipo,
            }).map((d) => ({ companyId: args.companyId, tipo: d.tipo, nombre: d.nombre, requerido: true })),
          },
          ...(recurso
            ? {
                traslados: {
                  create: {
                    fecha: fechaIngreso,
                    tipo: "INGRESO",
                    aRecursoId: recurso.id,
                    aRecursoNombre: recurso.nombre,
                    nota: args.motivo?.trim() || null,
                    usuarioId: args.usuario?.id ?? null,
                    usuarioNombre: args.usuario?.nombre ?? null,
                  },
                },
              }
            : {}),
          ...(cotizacion && cotizacion.partidas.length
            ? {
                cargos: {
                  create: cotizacion.partidas.map((p) => ({
                    companyId: args.companyId,
                    fecha: fechaIngreso,
                    categoria: p.categoria,
                    descripcion: p.descripcion,
                    cantidad: p.cantidad,
                    precioUnitario: p.precioUnitario,
                    ivaTasa: p.ivaTasa,
                    importe: r2(Number(p.cantidad) * Number(p.precioUnitario)),
                    origen: "COTIZACION" as const,
                    servicioId: p.servicioId,
                    creadoPorUserId: args.usuario?.id ?? null,
                  })),
                },
              }
            : {}),
        },
        include: {
          paciente: true,
          recurso: true,
          medico: true,
          pagador: true,
          customer: { select: { id: true, razonSocial: true, rfc: true } },
          documentos: true,
          cargos: true,
          traslados: true,
        },
      });

      if (recurso) {
        await tx.hospRecurso.update({ where: { id: recurso.id }, data: { estado: "OCUPADA" } });
      }
      if (cotizacion) {
        await tx.hospCotizacion.update({
          where: { id: cotizacion.id },
          data: { estado: "CONVERTIDA", pacienteId: cotizacion.pacienteId ?? paciente.id },
        });
      }
      return episodio;
    })
  );
}
