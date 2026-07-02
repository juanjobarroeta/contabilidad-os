import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { EstadoPendiente, Prisma } from "@prisma/client";

// GET /api/notificaciones[?estado=NUEVO]
//
// Inbox unificado de "Pendientes" del usuario autenticado, cross-empresa. Por
// defecto devuelve lo accionable: NUEVO + VISTO + POSPUESTO cuyo snooze ya venció
// (reaparece). Pasa ?estado=NUEVO|VISTO|HECHO|POSPUESTO para filtrar uno.
//
// Un item sólo es visible para su recipientUserId (multi-tenant safe).

const ESTADOS = ["NUEVO", "VISTO", "HECHO", "POSPUESTO"] as const;

export interface NotificacionDTO {
  id: string;
  companyId: string | null;
  razonSocial: string | null;
  categoria: string;
  severidad: string;
  titulo: string;
  cuerpo: string;
  url: string;
  estado: EstadoPendiente;
  posponerHasta: string | null;
  leidoAt: string | null;
  hechoAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const userId = session.user.id;

  const { searchParams } = new URL(req.url);

  // Lookup puntual por dedupeKey: lo usa el handler global que abre el chat
  // sembrado tras el tap de una notificación. Sólo del usuario en sesión.
  const dedupeKey = searchParams.get("dedupeKey");
  if (dedupeKey) {
    const item = await prisma.notificationItem.findUnique({
      where: { recipientUserId_dedupeKey: { recipientUserId: userId, dedupeKey } },
      select: { id: true, titulo: true, cuerpo: true, url: true, categoria: true },
    });
    if (!item) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(item);
  }

  const estadoParam = searchParams.get("estado");
  const filtro =
    estadoParam && (ESTADOS as readonly string[]).includes(estadoParam)
      ? (estadoParam as EstadoPendiente)
      : undefined;

  const now = new Date();

  // Default (sin filtro): lo accionable — NUEVO, VISTO, y POSPUESTO ya vencido.
  // Un POSPUESTO vigente se oculta hasta que llegue su fecha.
  const where: Prisma.NotificationItemWhereInput = filtro
    ? { recipientUserId: userId, estado: filtro }
    : {
        recipientUserId: userId,
        OR: [
          { estado: "NUEVO" },
          { estado: "VISTO" },
          { estado: "POSPUESTO", posponerHasta: { lte: now } },
          { estado: "POSPUESTO", posponerHasta: null },
        ],
      };

  const rows = await prisma.notificationItem.findMany({
    where,
    // Severidad primero (error < warn < info por orden alfabético inverso no
    // sirve), luego recencia. El orden fino por severidad se resuelve en el
    // cliente con un rank explícito; aquí basta recencia estable.
    orderBy: { createdAt: "desc" },
  });

  // Razón social de las empresas referenciadas (join manual: el modelo es
  // standalone, sin relación). Sólo de las que el usuario ya tiene en su feed.
  const companyIds = [...new Set(rows.map((r) => r.companyId).filter((c): c is string => !!c))];
  const companies = companyIds.length
    ? await prisma.company.findMany({
        where: { id: { in: companyIds } },
        select: { id: true, razonSocial: true },
      })
    : [];
  const razonById = new Map(companies.map((c) => [c.id, c.razonSocial]));

  const items: NotificacionDTO[] = rows.map((r) => ({
    id: r.id,
    companyId: r.companyId,
    razonSocial: r.companyId ? razonById.get(r.companyId) ?? null : null,
    categoria: r.categoria,
    severidad: r.severidad,
    titulo: r.titulo,
    cuerpo: r.cuerpo,
    url: r.url,
    estado: r.estado,
    posponerHasta: r.posponerHasta?.toISOString() ?? null,
    leidoAt: r.leidoAt?.toISOString() ?? null,
    hechoAt: r.hechoAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));

  // Conteo de no leídos (NUEVO) para el badge del menú.
  const noLeidos = await prisma.notificationItem.count({
    where: { recipientUserId: userId, estado: "NUEVO" },
  });

  return NextResponse.json({ items, noLeidos });
}
