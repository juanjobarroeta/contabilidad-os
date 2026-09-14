import { NextResponse } from "next/server";
import { requireWriter, withAuthz } from "@/lib/authz";
import { cerrarHecho, verificarHecho } from "@/lib/expediente/hechos";

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/expediente/hechos/[id]  { companyId, accion: "verificar" | "desverificar" | "cerrar" }
//
// Verificar es lo que convierte una inferencia en un dato: a partir de ahí ni el
// motor ni el agente lo cambian. Cerrar es decir «esto dejó de ser cierto» sin
// poner nada en su lugar; el hecho no se borra, se le pone fecha de fin.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export const PATCH = withAuthz(async (req: Request, { params }: Params) => {
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const companyId = typeof body?.companyId === "string" ? body.companyId : null;
  if (!companyId) return NextResponse.json({ error: "companyId es requerido" }, { status: 400 });
  await requireWriter(companyId, req);

  if (body?.accion === "cerrar") {
    const ok = await cerrarHecho(companyId, id);
    if (!ok) return NextResponse.json({ error: "Hecho no encontrado o ya cerrado" }, { status: 404 });
    return NextResponse.json({ ok: true, cerrado: true });
  }

  const verificado = body?.accion !== "desverificar";
  const hecho = await verificarHecho(companyId, id, verificado);
  if (!hecho) return NextResponse.json({ error: "Hecho no encontrado" }, { status: 404 });
  return NextResponse.json({ hecho });
});
