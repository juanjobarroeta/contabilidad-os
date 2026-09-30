import { NextResponse } from "next/server";
import { AuthzError, requireMembership, requireWriter } from "@/lib/authz";
import { assertPuedeEscribir } from "@/lib/subscription";
import type { StampInput } from "@/lib/facturas/stamp";
import { prefacturaSchema } from "@/lib/facturas/prefactura";
import { crearPrefactura, listarPrefacturas } from "@/lib/facturas/prefacturas";

// ─────────────────────────────────────────────────────────────────────────────
// Prefacturas (borradores de CFDI).
//
// POST /api/facturas/borradores — crea el draft en Facturapi (su PDF sale con
// marca BORRADOR y NO consume timbre) y lo persiste con el payload completo
// para poder timbrarlo después. Devuelve el enlace firmado del PDF (7 días)
// listo para compartir con el cliente.
//
// GET /api/facturas/borradores?companyId= — lista las PENDIENTES con cliente
// y enlace de PDF vigente.
//
// La lógica vive en lib/facturas/prefacturas.ts (la comparte el hospital).
// ─────────────────────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  try {
    const parsed = prefacturaSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Datos inválidos" },
        { status: 400 }
      );
    }
    const input = parsed.data as StampInput;
    const { user } = await requireWriter(input.companyId, req);
    await assertPuedeEscribir(user.id);
    const r = await crearPrefactura(input, user, req);
    return NextResponse.json(r.body, { status: r.status });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const companyId = url.searchParams.get("companyId");
    if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
    await requireMembership(companyId, undefined, req);
    return NextResponse.json(await listarPrefacturas(companyId));
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
