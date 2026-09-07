import { NextResponse } from "next/server";
import { withAuthz } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { parsePeriodoQuery, requireCierreGuiado } from "@/lib/cierre/gate";
import { conversacionDelPeriodo } from "@/lib/cierre/pase-diario";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/cierre/conversacion?companyId=&year=&month=
//
// EL HILO DEL CIERRE del periodo: el mismo en el que escribe el pase diario.
// Sin esto, /cierre vivía sólo en la memoria del navegador — cambiabas de
// pestaña y había que empezar de cero, y cada visita abría una conversación
// nueva. Es COMPANY: el cierre lo trabaja el equipo, no una sola sesión.
// Plan PRO.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";

/** Últimos mensajes que se pintan y se mandan como contexto (el turno recorta a 40). */
const MAX_MENSAJES = 40;

export const GET = withAuthz(async (req: Request) => {
  const p = parsePeriodoQuery(new URL(req.url).searchParams);
  if (!p) return NextResponse.json({ error: "companyId, year y month son requeridos" }, { status: 400 });
  await requireCierreGuiado(p.companyId, undefined, req);

  const cierre = await prisma.cierrePeriodo.findUnique({
    where: { companyId_year_month: { companyId: p.companyId, year: p.year, month: p.month } },
    select: { responsableUserId: true },
  });
  const conversationId = await conversacionDelPeriodo(p.companyId, p.year, p.month, cierre?.responsableUserId ?? null);
  if (!conversationId) return NextResponse.json({ conversationId: null, messages: [] });

  const filas = await prisma.chatMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    take: MAX_MENSAJES,
    select: { id: true, role: true, content: true, feedback: true },
  });
  return NextResponse.json({ conversationId, messages: filas.reverse() });
});
