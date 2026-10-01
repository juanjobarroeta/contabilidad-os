import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { ContaBotError } from "@/lib/contabot/config";
import { requireContaBotAccess } from "@/lib/contabot/access";
import { assignObjective, changeObjective, configureMandate, listObjectives } from "@/lib/contabot/objectives/service";

export const dynamic = "force-dynamic";
const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("assign"), companyId: z.string().min(1), year: z.number().int(), month: z.number().int(),
    scope: z.string().max(30).optional(), instructions: z.string().max(2000).optional() }).strict(),
  z.object({ action: z.literal("configure"), companyId: z.string().min(1), responsibleUserId: z.string().min(1),
    enabled: z.boolean(), startPeriod: z.string().regex(/^20\d\d-(0[1-9]|1[0-2])$/), maxRunsPerDay: z.number().int().min(1).max(12) }).strict(),
  z.object({ action: z.enum(["pause", "resume"]), companyId: z.string().min(1), id: z.string().min(1), version: z.number().int().min(0) }).strict(),
]);
function errorResponse(error: unknown) {
  if (error instanceof ContaBotError) return NextResponse.json({ error: error.message }, { status: error.status });
  console.error("[contabot] Objective request failed");
  return NextResponse.json({ error: "No se pudo actualizar el objetivo. Inténtalo de nuevo." }, { status: 500 });
}
export async function GET(req: Request) {
  const user = await auth();
  if (!user?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const search = new URL(req.url).searchParams;
  const companyId = search.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  try {
    await requireContaBotAccess(user.user.id, companyId, undefined, { requireEnabled: false });
    return NextResponse.json(await listObjectives(user.user.id, companyId, search.get("period") ?? undefined), {
    headers: { "Cache-Control": "private, no-store" },
  }); } catch (error) { return errorResponse(error); }
}
export async function POST(req: Request) {
  const user = await auth();
  if (!user?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = actionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Solicitud inválida." }, { status: 400 });
  const input = parsed.data;
  try {
    await requireContaBotAccess(user.user.id, input.companyId, undefined, { requireEnabled: false });
    if (input.action === "assign") return NextResponse.json(await assignObjective(user.user.id, input));
    if (input.action === "configure") {
      const { action: _action, ...config } = input;
      return NextResponse.json(await configureMandate(user.user.id, config));
    }
    return NextResponse.json(await changeObjective(user.user.id, input.companyId, input.id, input.action, input.version));
  } catch (error) { return errorResponse(error); }
}
