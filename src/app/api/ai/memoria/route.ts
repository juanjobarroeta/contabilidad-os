import { NextResponse } from "next/server";
import { requireMembership, withAuthz } from "@/lib/authz";
import { notasDelCopiloto } from "@/lib/expediente/notas";

// GET /api/ai/memoria?companyId= — «Lo que recuerdo»: las notas del expediente
// que el copiloto guardó desde el chat. Es la misma memoria que lee en su
// contexto; aquí sólo se enseña para que el usuario la vea y la pueda olvidar.
export const dynamic = "force-dynamic";

export const GET = withAuthz(async (req: Request) => {
  const companyId = new URL(req.url).searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId es requerido" }, { status: 400 });
  await requireMembership(companyId, undefined, req);
  const notas = await notasDelCopiloto(companyId);
  return NextResponse.json(
    notas.map((n) => ({ id: n.id, texto: n.titulo, detalle: n.cuerpo, tipo: n.tipo, estado: n.estado, createdAt: n.createdAt })),
  );
});
