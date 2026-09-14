// Persistencia de los turnos del copiloto jurídico en JuridicoTurno.
// Los eventos se APPENDEAN en la base (jsonb ||) para no reescribir el arreglo
// entero en cada lote; el checkpoint se reemplaza por ronda.
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { AlmacenTurnos, CheckpointTurno, EstadoTurno, EventoTurno, LectorTurnos } from "./turnos";

export interface FilaTurno {
  id: string;
  conversacionId: string;
  userId: string;
  estado: EstadoTurno;
  instancia: string;
  latido: Date;
  eventos: EventoTurno[];
  checkpoint: CheckpointTurno | null;
  mensajeUsuarioId: string | null;
  pregunta: string;
  convCreada: boolean;
  terminadoAt: Date | null;
}

const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;

export const almacenPrisma: AlmacenTurnos & LectorTurnos & {
  ultimoDeConversacion(conversacionId: string): Promise<FilaTurno | null>;
  huerfanos(msSinLatido: number): Promise<FilaTurno[]>;
  reclamar(id: string, instancia: string, latidoVisto: Date): Promise<boolean>;
} = {
  async crear(t) {
    await prisma.juridicoTurno.create({
      data: { id: t.id, conversacionId: t.conversacionId, userId: t.userId, instancia: t.instancia, estado: "en_curso", latido: new Date(), eventos: [], checkpoint: json(t.checkpoint), mensajeUsuarioId: t.mensajeUsuarioId, pregunta: t.pregunta, convCreada: t.convCreada },
    });
  },
  async agregarEventos(id, eventos) {
    if (eventos.length === 0) return;
    await prisma.$executeRaw`UPDATE "JuridicoTurno" SET "eventos" = "eventos" || ${JSON.stringify(eventos)}::jsonb, "latido" = now(), "updatedAt" = now() WHERE "id" = ${id}`;
  },
  async latido(id) {
    await prisma.juridicoTurno.update({ where: { id }, data: { latido: new Date() } });
  },
  async guardarCheckpoint(id, checkpoint) {
    await prisma.juridicoTurno.update({ where: { id }, data: { checkpoint: json(checkpoint), latido: new Date() } });
  },
  async terminar(id, estado, error) {
    await prisma.juridicoTurno.update({ where: { id }, data: { estado, error: error ?? null, terminadoAt: new Date() } });
  },
  async leer(id) {
    const f = await prisma.juridicoTurno.findUnique({ where: { id }, select: { estado: true, eventos: true } });
    return f ? { estado: f.estado as EstadoTurno, eventos: (f.eventos as unknown as EventoTurno[]) ?? [] } : null;
  },
  async ultimoDeConversacion(conversacionId) {
    const f = await prisma.juridicoTurno.findFirst({ where: { conversacionId }, orderBy: { createdAt: "desc" } });
    return f ? aFila(f) : null;
  },
  async huerfanos(msSinLatido) {
    const filas = await prisma.juridicoTurno.findMany({ where: { estado: "en_curso", latido: { lt: new Date(Date.now() - msSinLatido) } }, orderBy: { createdAt: "asc" }, take: 20 });
    return filas.map(aFila);
  },
  async reclamar(id, instancia, latidoVisto) {
    // Sólo gana quien ve el mismo latido: dos contenedores no lo corren a la vez.
    const r = await prisma.juridicoTurno.updateMany({ where: { id, estado: "en_curso", latido: latidoVisto }, data: { instancia, latido: new Date() } });
    return r.count === 1;
  },
};

function aFila(f: { id: string; conversacionId: string; userId: string; estado: string; instancia: string; latido: Date; eventos: Prisma.JsonValue; checkpoint: Prisma.JsonValue | null; mensajeUsuarioId: string | null; pregunta: string; convCreada: boolean; terminadoAt: Date | null }): FilaTurno {
  return {
    id: f.id,
    conversacionId: f.conversacionId,
    userId: f.userId,
    estado: f.estado as EstadoTurno,
    instancia: f.instancia,
    latido: f.latido,
    eventos: (f.eventos as unknown as EventoTurno[]) ?? [],
    checkpoint: (f.checkpoint as unknown as CheckpointTurno | null) ?? null,
    mensajeUsuarioId: f.mensajeUsuarioId,
    pregunta: f.pregunta,
    convCreada: f.convCreada,
    terminadoAt: f.terminadoAt,
  };
}
