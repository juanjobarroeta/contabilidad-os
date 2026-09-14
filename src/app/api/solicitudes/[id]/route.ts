import { NextResponse } from "next/server";
import { requireWriter, withAuthz } from "@/lib/authz";
import { cancelarSolicitud, recibirSolicitud } from "@/lib/solicitudes/registro";

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/solicitudes/[id]  { companyId, accion: "recibir" | "cancelar", ref? }
//
// Cerrar una solicitud siempre deja constancia de QUÉ la cerró: un pedido que
// desaparece sin decir qué llegó es indistinguible de uno que alguien silenció,
// y el mes siguiente nadie sabe si el documento existe.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export const PATCH = withAuthz(async (req: Request, { params }: Params) => {
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const companyId = typeof body?.companyId === "string" ? body.companyId : null;
  if (!companyId) return NextResponse.json({ error: "companyId es requerido" }, { status: 400 });
  await requireWriter(companyId, req);

  const ref = typeof body?.ref === "string" && body.ref.trim() ? body.ref.trim() : null;
  const solicitud =
    body?.accion === "cancelar"
      ? await cancelarSolicitud(companyId, id, ref)
      : await recibirSolicitud(companyId, id, ref);

  if (!solicitud) return NextResponse.json({ error: "Solicitud no encontrada o ya cerrada" }, { status: 404 });
  return NextResponse.json({ solicitud });
});
