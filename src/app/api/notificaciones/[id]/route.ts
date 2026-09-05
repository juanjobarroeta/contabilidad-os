import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { marcarAvisoCierreAccionado } from "@/lib/cierre/pase-diario";

type Params = { params: Promise<{ id: string }> };

// PATCH /api/notificaciones/[id]
//
// Cambia el estado de un pendiente del inbox. Acepta:
//   { estado: "VISTO" }                       — al abrir el deep-link
//   { estado: "HECHO" }                       — atendido
//   { estado: "POSPUESTO", posponerHasta }    — snooze hasta una fecha ISO
//   { posponer: "1d" }                        — atajo: posponer N (1 día)
//
// Sólo el recipientUserId del item puede verlo/mutarlo (multi-tenant safe).

const ESTADOS_VALIDOS = ["VISTO", "HECHO", "POSPUESTO"] as const;

function fechaPosponer(token: string, now: Date): Date | null {
  switch (token) {
    case "1d":
      return new Date(now.getTime() + 1 * 86400000);
    case "7d":
      return new Date(now.getTime() + 7 * 86400000);
    default:
      return null;
  }
}

export async function PATCH(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const userId = session.user.id;

  const { id } = await params;

  // El item debe existir y pertenecer al usuario.
  const item = await prisma.notificationItem.findUnique({
    where: { id },
    select: { id: true, recipientUserId: true, dedupeKey: true },
  });
  if (!item || item.recipientUserId !== userId) {
    return NextResponse.json({ error: "No encontrado" }, { status: 404 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    estado?: string;
    posponerHasta?: string;
    posponer?: string;
  };
  const now = new Date();

  const data: Prisma.NotificationItemUpdateInput = {};

  // Atajo "posponer": equivale a estado POSPUESTO con la fecha calculada.
  if (body.posponer) {
    const hasta = fechaPosponer(body.posponer, now);
    if (!hasta) return NextResponse.json({ error: "Token de posponer inválido" }, { status: 400 });
    data.estado = "POSPUESTO";
    data.posponerHasta = hasta;
  } else if (body.estado && (ESTADOS_VALIDOS as readonly string[]).includes(body.estado)) {
    data.estado = body.estado as (typeof ESTADOS_VALIDOS)[number];
    if (body.estado === "VISTO") {
      data.leidoAt = now;
    } else if (body.estado === "HECHO") {
      data.hechoAt = now;
      data.posponerHasta = null;
      // Aviso del cierre guiado marcado como hecho → accionado en su ledger
      // (la dedupeKey «cierre:…» identifica empresa, periodo y paso).
      void marcarAvisoCierreAccionado(item.dedupeKey, now);
    } else if (body.estado === "POSPUESTO") {
      const hasta = body.posponerHasta ? new Date(body.posponerHasta) : null;
      if (!hasta || isNaN(hasta.getTime())) {
        return NextResponse.json({ error: "posponerHasta requerido" }, { status: 400 });
      }
      data.posponerHasta = hasta;
    }
  } else {
    return NextResponse.json({ error: "estado inválido" }, { status: 400 });
  }

  const updated = await prisma.notificationItem.update({
    where: { id },
    data,
    select: { id: true, estado: true, posponerHasta: true, leidoAt: true, hechoAt: true },
  });

  return NextResponse.json({
    id: updated.id,
    estado: updated.estado,
    posponerHasta: updated.posponerHasta?.toISOString() ?? null,
    leidoAt: updated.leidoAt?.toISOString() ?? null,
    hechoAt: updated.hechoAt?.toISOString() ?? null,
  });
}

