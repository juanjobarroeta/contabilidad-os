// Lo cotizado que surte farmacia (medicamento y material). Al registrar el
// ingreso de una cotización esas partidas NO entran a la cuenta
// (episodio.ts, pasaAlIngreso): farmacia las ve aquí —desde que se agenda la
// cita, para prepararlas— y las carga a la cuenta del paciente al surtirlas,
// al precio cotizado. Cada partida guarda el cargo con que pasó (cargoId):
// no se carga dos veces.

import type { Prisma, PrismaClient } from "@prisma/client";
import { HospitalError } from "./errores";
import { CATEGORIAS_FARMACIA } from "./episodio";
import { ivaContextoPorEpisodio } from "./cuenta";
import { r2 } from "./util";

type Db = PrismaClient | Prisma.TransactionClient;

const ESTADOS_CITA_VIVA = ["SOLICITADA", "PROGRAMADA", "CONFIRMADA", "EN_CURSO"] as const;

const partidaPendiente = {
  categoria: { in: [...CATEGORIAS_FARMACIA] },
  sinCotizar: false,
  cargoId: null,
} satisfies Prisma.HospCotizacionPartidaWhereInput;

const selectPartida = { id: true, descripcion: true, categoria: true, cantidad: true, precioUnitario: true, ivaTasa: true, importe: true, servicio: { select: { clave: true } } } as const;

type PartidaFila = { id: string; descripcion: string; categoria: string; cantidad: unknown; precioUnitario: unknown; ivaTasa: unknown; importe: unknown; servicio: { clave: string } | null };
const fila = (p: PartidaFila) => ({
  id: p.id,
  descripcion: p.descripcion,
  categoria: p.categoria,
  clave: p.servicio?.clave ?? null,
  cantidad: Number(p.cantidad),
  precioUnitario: Number(p.precioUnitario),
  ivaTasa: p.ivaTasa == null ? null : Number(p.ivaTasa),
  importe: Number(p.importe),
});
const nombre = (p: { nombre: string; apellidoPaterno: string | null; apellidoMaterno: string | null } | null) =>
  p ? [p.nombre, p.apellidoPaterno, p.apellidoMaterno].filter(Boolean).join(" ") : null;
const selectPaciente = { id: true, nombre: true, apellidoPaterno: true, apellidoMaterno: true } as const;

/**
 * agendadas: citas vivas, sin ingreso todavía, con cotización que trae
 * medicamento/material (para preparar). porCargar: episodios activos con
 * partidas de su cotización que farmacia no ha pasado a la cuenta.
 */
export async function listarPorSurtir(db: Db, companyId: string, ahora = new Date()) {
  const desde = new Date(ahora.getTime() - 24 * 3600e3);
  const [citas, episodios] = await Promise.all([
    db.hospCita.findMany({
      where: {
        companyId,
        estado: { in: [...ESTADOS_CITA_VIVA] },
        episodioId: null,
        inicio: { gte: desde },
        cotizacion: { partidas: { some: partidaPendiente } },
      },
      orderBy: { inicio: "asc" },
      take: 200,
      select: {
        id: true, titulo: true, inicio: true, estado: true, pacienteNombre: true,
        paciente: { select: selectPaciente },
        medico: { select: { nombre: true } },
        recurso: { select: { nombre: true } },
        cotizacion: { select: { id: true, folio: true, pacienteNombre: true, partidas: { where: partidaPendiente, orderBy: { orden: "asc" }, select: selectPartida } } },
      },
    }),
    db.hospEpisodio.findMany({
      where: { companyId, estado: { notIn: ["ALTA", "CANCELADO"] }, cotizacion: { partidas: { some: partidaPendiente } } },
      orderBy: { fechaIngreso: "asc" },
      take: 200,
      select: {
        id: true, folio: true, estado: true, fechaIngreso: true,
        paciente: { select: selectPaciente },
        recurso: { select: { nombre: true } },
        medico: { select: { nombre: true } },
        cotizacion: { select: { id: true, folio: true, partidas: { where: partidaPendiente, orderBy: { orden: "asc" }, select: selectPartida } } },
      },
    }),
  ]);
  return {
    agendadas: citas.map((c) => ({
      citaId: c.id,
      titulo: c.titulo,
      inicio: c.inicio,
      estado: c.estado,
      paciente: nombre(c.paciente) ?? c.pacienteNombre ?? c.cotizacion?.pacienteNombre ?? null,
      medico: c.medico?.nombre ?? null,
      recurso: c.recurso?.nombre ?? null,
      cotizacion: { id: c.cotizacion!.id, folio: c.cotizacion!.folio },
      partidas: c.cotizacion!.partidas.map(fila),
    })),
    porCargar: episodios.map((e) => ({
      episodioId: e.id,
      folio: e.folio,
      estado: e.estado,
      fechaIngreso: e.fechaIngreso,
      paciente: nombre(e.paciente),
      cama: e.recurso?.nombre ?? null,
      medico: e.medico?.nombre ?? null,
      cotizacion: { id: e.cotizacion!.id, folio: e.cotizacion!.folio },
      partidas: e.cotizacion!.partidas.map(fila),
    })),
  };
}

/**
 * Pasa a la cuenta del episodio las partidas surtidas, al precio cotizado.
 * 409 si alguna ya se cargó (otra persona se adelantó) o no es de farmacia.
 */
export async function cargarPorSurtir(
  db: PrismaClient,
  args: { companyId: string; episodioId: string; partidaIds: string[]; usuario: { id: string; nombre: string } }
) {
  const ids = [...new Set(args.partidaIds)];
  if (!ids.length) throw new HospitalError(400, "Elige al menos una partida");
  return db.$transaction(async (tx) => {
    const ep = await tx.hospEpisodio.findUnique({
      where: { id: args.episodioId },
      select: { id: true, companyId: true, folio: true, estado: true, tipo: true, cotizacion: { select: { id: true } } },
    });
    if (!ep || ep.companyId !== args.companyId) throw new HospitalError(404, "Episodio no encontrado");
    if (ep.estado === "CANCELADO") throw new HospitalError(409, `El episodio ${ep.folio} está cancelado`);
    if (!ep.cotizacion) throw new HospitalError(409, `El episodio ${ep.folio} no viene de una cotización`);
    const partidas = await tx.hospCotizacionPartida.findMany({ where: { id: { in: ids }, cotizacionId: ep.cotizacion.id } });
    if (partidas.length !== ids.length) throw new HospitalError(400, "Alguna partida no es de la cotización de este episodio");
    const ajena = partidas.find((p) => p.sinCotizar || !(CATEGORIAS_FARMACIA as readonly string[]).includes(p.categoria));
    if (ajena) throw new HospitalError(400, `«${ajena.descripcion}» no la surte farmacia`);
    const ya = partidas.find((p) => p.cargoId);
    if (ya) throw new HospitalError(409, `«${ya.descripcion}» ya se cargó a la cuenta`);

    const ahora = new Date();
    const ivaContexto = ivaContextoPorEpisodio(ep.tipo);
    const cargos = [];
    for (const p of partidas) {
      const cargo = await tx.hospCargo.create({
        data: {
          companyId: args.companyId,
          episodioId: ep.id,
          fecha: ahora,
          categoria: p.categoria,
          descripcion: p.descripcion,
          cantidad: p.cantidad,
          precioUnitario: p.precioUnitario,
          ivaTasa: p.ivaTasa,
          ivaContexto,
          importe: r2(Number(p.cantidad) * Number(p.precioUnitario)),
          origen: "FARMACIA",
          servicioId: p.servicioId,
          creadoPorUserId: args.usuario.id,
        },
      });
      // Candado: si otra persona la cargó entre la lectura y aquí, no cuenta 1 y todo se revierte.
      const marcada = await tx.hospCotizacionPartida.updateMany({
        where: { id: p.id, cargoId: null },
        data: { cargoId: cargo.id, surtidaAt: ahora, surtidaPor: args.usuario.nombre },
      });
      if (marcada.count !== 1) throw new HospitalError(409, `«${p.descripcion}» ya se cargó a la cuenta`);
      cargos.push(cargo);
    }
    return { folio: ep.folio, cargos: cargos.length, importe: r2(cargos.reduce((s, c) => s + Number(c.importe), 0)) };
  });
}
