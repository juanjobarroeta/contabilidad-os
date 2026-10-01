import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { AuthzError, requireMembership, requireModule } from "@/lib/authz";
import { parseReviewScope, reviewWriteSchema } from "@/lib/fiscal/deduction-review-contract";
import { DeductionReviewError, readDeductionReviewHistory, readDeductionReviewWorkspace, saveDeductionReview } from "@/lib/fiscal/deduction-review";

const headers = { "Cache-Control": "no-store" };
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers });
const writable = (role: string) => ["OWNER", "ADMIN", "ACCOUNTANT"].includes(role);
async function authorized(req: Request, write = false) {
  const session = await auth();
  if (!session?.user?.id) return { response: json({ error: "Unauthorized" }, 401) };
  const scope = parseReviewScope(new URL(req.url).searchParams);
  if (!scope) return { response: json({ error: "Empresa, periodo o página inválidos." }, 400) };
  // Session-only, matching the accounting hub. A supplied bearer must not
  // substitute another identity for the module check or saved reviewer.
  const { membership: member } = await requireMembership(scope.companyId, write ? ["OWNER", "ADMIN", "ACCOUNTANT"] : undefined);
  await requireModule(scope.companyId, "CONTABILIDAD");
  const allowedModules = "allowedModules" in member && Array.isArray(member.allowedModules) ? member.allowedModules : [];
  if (!member.accessViaDespacho && allowedModules.length > 0
    && !allowedModules.includes("CONTABILIDAD")) return { response: json({ error: "Sin acceso al módulo contable." }, 403) };
  return { scope, member, actor: { id: session.user.id, email: session.user.email ?? null } };
}
function errorResponse(error: unknown) {
  if (error instanceof AuthzError) return json({ error: error.message }, error.status);
  if (error instanceof DeductionReviewError) return json({ code: error.code, error: error.message }, error.status);
  console.error("[deduction-review] operation failed", error instanceof Error ? error.name : "UnknownError");
  return json({ error: "No se pudo completar la revisión. Conserva tu borrador y reintenta." }, 500);
}

export async function GET(req: Request) {
  try {
    const access = await authorized(req);
    if (access.response) return access.response;
    if (new URL(req.url).searchParams.get("history") === "1") return json(await readDeductionReviewHistory(access.scope!));
    return json({ ...await readDeductionReviewWorkspace(access.scope!), puedeEditar: writable(access.member!.role) });
  } catch (error) { return errorResponse(error); }
}

export async function POST(req: Request) {
  try {
    const access = await authorized(req, true);
    if (access.response) return access.response;
    // Cookie-authenticated browser mutations accept only this site's origin.
    // Non-browser clients may omit Origin; hostile browser requests may not.
    const origin = req.headers.get("origin");
    // Next normalizes loopback names in req.url; Host retains the browser's
    // actual authority. Railway supplies the original transport protocol.
    const requestUrl = new URL(req.url);
    const scheme = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ?? requestUrl.protocol.slice(0, -1);
    const expectedOrigin = `${scheme}://${req.headers.get("host") ?? requestUrl.host}`;
    if ((origin && origin !== expectedOrigin) || req.headers.get("sec-fetch-site") === "cross-site") {
      return json({ error: "Origen no permitido." }, 403);
    }
    if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return json({ error: "Se requiere JSON." }, 415);
    const raw = await req.text();
    if (raw.length > 16_384) return json({ error: "La revisión excede el tamaño permitido." }, 413);
    let value: unknown;
    try { value = JSON.parse(raw); } catch { return json({ error: "JSON inválido." }, 400); }
    const parsed = reviewWriteSchema.safeParse(value);
    if (!parsed.success) return json({ error: parsed.error.issues[0]?.message ?? "Revisión inválida." }, 400);
    return json(await saveDeductionReview(access.scope!, parsed.data, access.actor!));
  } catch (error) { return errorResponse(error); }
}
