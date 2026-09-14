import { NextResponse } from "next/server";
import { requireWriter, withAuthz } from "@/lib/authz";
import { anotar, reabrirNota, resolverNota } from "@/lib/expediente/notas";

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/expediente/notas/[id]  { companyId, accion: "resolver" | "reabrir", porque? }
//
// Un pendiente que se cierra sin decir por qué es indistinguible de uno que
// alguien silenció, así que el motivo se escribe como nota y queda enlazado.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export const PATCH = withAuthz(async (req: Request, { params }: Params) => {
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const companyId = typeof body?.companyId === "string" ? body.companyId : null;
  if (!companyId) return NextResponse.json({ error: "companyId es requerido" }, { status: 400 });
  const { user } = await requireWriter(companyId, req);

  if (body?.accion === "reabrir") {
    const nota = await reabrirNota(companyId, id);
    if (!nota) return NextResponse.json({ error: "Pendiente no encontrado" }, { status: 404 });
    return NextResponse.json({ nota });
  }

  const porque = typeof body?.porque === "string" && body.porque.trim() ? body.porque.trim() : null;
  const cierre = porque
    ? await anotar({
        companyId,
        autor: "usuario",
        autorId: user.id,
        tipo: "observacion",
        tema: "general",
        titulo: "Se cerró un pendiente",
        cuerpo: porque,
        refs: [id],
      })
    : null;
  const nota = await resolverNota(companyId, id, { porNotaId: cierre?.id ?? null });
  if (!nota) return NextResponse.json({ error: "Pendiente no encontrado o ya cerrado" }, { status: 404 });
  return NextResponse.json({ nota });
});
