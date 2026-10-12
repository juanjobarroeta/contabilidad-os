import { NextResponse } from "next/server";
import { z } from "zod";
import { requireBancosAccess, requireEscrituraBancos, sesionOBearer } from "@/lib/bancos/statements/access";
import { gateEscritura } from "@/lib/subscription";
import { publicError } from "@/lib/bancos/statements/contract";
import { asignarMes, detalleEstado, resolverFila } from "@/lib/bancos/statements/panel";
import { releerEstado } from "@/lib/bancos/statements/releer";
import { autoVerificarEstado } from "@/lib/bancos/statements/auto-verify";

// ─────────────────────────────────────────────────────────────────────────────
// GET  /api/bancos/estados/[id]?companyId  → controles uno por uno (esperado,
//      encontrado, diferencia), filas por resolver con sus candidatos y
//      movimientos que el estado no cubre.
// POST /api/bancos/estados/[id]  { companyId, accion, … }
//      asignar   { year, month, bankAccountId? }   mes (y cuenta) de un «Sin mes»
//      releer                                      vuelve a leer el original guardado
//      verificar                                   reintenta la verificación automática
//      fila      { rowId, resolucion: LINK|NEW|EXCLUDE, movementId?, motivo, effectExpected? }
// ─────────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const maxDuration = 300;
const noStore = { "Cache-Control": "no-store" };
const fallo = (e: unknown) => NextResponse.json({ error: publicError(e) }, { status: (e as { status?: number }).status ?? 409, headers: noStore });

const accionSchema = z.discriminatedUnion("accion", [
  z.object({ companyId: z.string().min(1), accion: z.literal("asignar"), year: z.number().int().min(2000).max(2100), month: z.number().int().min(1).max(12), bankAccountId: z.string().min(1).nullish() }),
  z.object({ companyId: z.string().min(1), accion: z.literal("releer") }),
  z.object({ companyId: z.string().min(1), accion: z.literal("verificar") }),
  z.object({ companyId: z.string().min(1), accion: z.literal("fila"), rowId: z.string().min(1), resolucion: z.enum(["LINK", "NEW", "EXCLUDE"]),
    movementId: z.string().min(1).nullish(), motivo: z.string().trim().min(8).max(1000), effectExpected: z.string().length(64).nullish() }),
]);

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await sesionOBearer(req); if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const companyId = new URL(req.url).searchParams.get("companyId") ?? "";
  if (!companyId) return NextResponse.json({ error: "Empresa requerida." }, { status: 400 });
  try {
    const access = await requireBancosAccess(session.user.id, companyId);
    return NextResponse.json({ ...(await detalleEstado(companyId, id)), canWrite: access.canWrite }, { headers: noStore });
  } catch (e) { return fallo(e); }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await sesionOBearer(req); if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const parsed = accionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Solicitud inválida." }, { status: 400 });
  const b = parsed.data, userId = session.user.id;
  try {
    await requireEscrituraBancos(userId, b.companyId);
    const gate = await gateEscritura(userId); if (gate) return gate;
    if (b.accion === "asignar") {
      const r = await asignarMes(b.companyId, id, b.year, b.month, userId, b.bankAccountId);
      const verificacion = await autoVerificarEstado(b.companyId, id, userId).catch(() => null);
      return NextResponse.json({ ...r, verificacion }, { headers: noStore });
    }
    if (b.accion === "releer") return NextResponse.json(await releerEstado(b.companyId, id, userId), { headers: noStore });
    if (b.accion === "verificar") return NextResponse.json(await autoVerificarEstado(b.companyId, id, userId), { headers: noStore });
    return NextResponse.json(await resolverFila({ companyId: b.companyId, batchId: id, rowId: b.rowId, resolucion: b.resolucion, movementId: b.movementId,
      motivo: b.motivo, effectExpected: b.effectExpected, userId }), { headers: noStore });
  } catch (e) { return fallo(e); }
}
