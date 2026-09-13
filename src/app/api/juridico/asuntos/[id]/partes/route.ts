import { NextResponse } from "next/server";
import { AuthzError, puedeUsarJuridico, requireUser } from "@/lib/authz";
import { registrarPartes, type Parte } from "@/lib/juridico/asuntos";

// POST /api/juridico/asuntos/[id]/partes — alta manual (o corrección) de una o varias partes; fuente «manual» = verificada.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let userId: string;
  try {
    const u = await requireUser(req);
    if (!(await puedeUsarJuridico(u.id))) throw new AuthzError(403, "Tu cuenta no tiene acceso al copiloto jurídico");
    userId = u.id;
  } catch (e) {
    return NextResponse.json({ error: e instanceof AuthzError ? e.message : "Unauthorized" }, { status: e instanceof AuthzError ? e.status : 401 });
  }
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { partes?: Partial<Parte>[] } & Partial<Parte>;
  const partes = (Array.isArray(body.partes) ? body.partes : [body]).map((p) => ({ ...p, fuente: "manual" as const }));
  try {
    const r = await registrarPartes(id, userId, partes);
    return NextResponse.json(r.asunto, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Error" }, { status: 400 });
  }
}
