import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireContaBotAccess } from "@/lib/contabot/access";
import { ContaBotError } from "@/lib/contabot/config";
import { assertPuedeEscribir } from "@/lib/subscription";
import { documentRefSchema } from "@/lib/ai/documents/contract";
import { readDocument } from "@/lib/ai/documents/read";
import { confirmDocumentStamp, reviewDocument } from "@/lib/ai/documents/stamping";

export const maxDuration = 300;
const bodySchema = z.object({ ref: documentRefSchema, conversationId: z.string().min(1).max(100), action: z.enum(["review", "stamp"]), token: z.string().max(4000).optional() }).strict();
const response = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
function failure(e: unknown) {
  if (e instanceof ContaBotError) return response({ error: e.message }, e.status);
  if (e instanceof z.ZodError) return response({ error: "Datos del documento inválidos." }, 400);
  // Domain messages explain missing data or stale approval; do not leak Prisma
  // query diagnostics or PAC request objects into the conversation.
  const message = e instanceof Error && !/prisma|Invalid.*invocation|SELECT |api.key|sk_live/i.test(e.message) ? e.message : "No se pudo verificar el documento. Intenta consultarlo de nuevo.";
  return response({ error: message }, 409);
}
export async function GET(req: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) return response({ error: "Inicia sesión." }, 401);
    const params = new URL(req.url).searchParams;
    const ref = documentRefSchema.parse({ kind: params.get("kind"), companyId: params.get("companyId"), ...(params.has("id") ? { id: params.get("id") } : {}), ...(params.has("year") ? { year: Number(params.get("year")) } : {}), ...(params.has("month") ? { month: Number(params.get("month")) } : {}) });
    const access = await requireContaBotAccess(session.user.id, ref.companyId, params.get("conversationId") ?? undefined, { requireEnabled: false });
    const document = await readDocument(ref);
    return response({ document: { ...document, stampable: document.stampable && access.canWrite } });
  } catch (e) { return failure(e); }
}
export async function POST(req: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) return response({ error: "Inicia sesión." }, 401);
    // Next may expose its internal bind address in req.url. Compare against
    // the original request host so same-origin browsers work behind Railway.
    const origin = req.headers.get("origin");
    const host = req.headers.get("x-forwarded-host")?.split(",")[0].trim() ?? req.headers.get("host") ?? new URL(req.url).host;
    if (req.headers.get("sec-fetch-site") === "cross-site" || (origin && new URL(origin).host !== host)) return response({ error: "Origen no permitido." }, 403);
    const body = bodySchema.parse(await req.json());
    const access = await requireContaBotAccess(session.user.id, body.ref.companyId, body.conversationId, { requireEnabled: false });
    if (!access.canWrite) return response({ error: "Requiere permiso de escritura." }, 403);
    await assertPuedeEscribir(session.user.id);
    if (body.action === "review") return response(await reviewDocument(body.ref, session.user.id, body.conversationId));
    if (!body.token) return response({ error: "Revisa el documento antes de confirmar su timbrado." }, 400);
    return response(await confirmDocumentStamp(body.ref, body.token, session.user.id, body.conversationId, req));
  } catch (e) { return failure(e); }
}
