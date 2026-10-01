import { NextResponse } from "next/server";
import { requireWriter, withAuthz } from "@/lib/authz";
import { olvidarNotaDelCopiloto } from "@/lib/expediente/notas";

// DELETE /api/ai/memoria/[id]?companyId= — «Olvidar». Borra la nota sólo si la
// escribió el copiloto desde el chat; la bitácora del motor y de las personas
// no se toca desde aquí.
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export const DELETE = withAuthz(async (req: Request, { params }: Params) => {
  const { id } = await params;
  const companyId = new URL(req.url).searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId es requerido" }, { status: 400 });
  await requireWriter(companyId, req);
  const ok = await olvidarNotaDelCopiloto(companyId, id);
  if (!ok) return NextResponse.json({ error: "No encontrada" }, { status: 404 });
  return NextResponse.json({ ok: true });
});
