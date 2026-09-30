import { NextResponse } from "next/server";
import { AuthzError, requireMembership, requireWriter } from "@/lib/authz";
import { assertPuedeEscribir } from "@/lib/subscription";
import type { StampInput } from "@/lib/facturas/stamp";
import { prefacturaSchema } from "@/lib/facturas/prefactura";
import {
  cargarPrefactura,
  descartarPrefactura,
  detallePrefactura,
  editarPrefactura,
  enviarPrefactura,
  timbrarPrefactura,
} from "@/lib/facturas/prefacturas";

// ─────────────────────────────────────────────────────────────────────────────
// Acciones sobre UNA prefactura:
//   GET    /api/facturas/borradores/[id]   — el payload completo, para
//                                            precargar el wizard al editar
//   PUT    /api/facturas/borradores/[id]   — editar: draft NUEVO en Facturapi
//                                            con el payload editado, descartar
//                                            el viejo, actualizar la MISMA fila
//   POST   /api/facturas/borradores/[id]   { accion: "timbrar" }
//                                          { accion: "enviar", email? }
//   DELETE /api/facturas/borradores/[id]   — descartar (borra el draft en
//                                            Facturapi, marca DESCARTADA)
//
// "timbrar" promueve EXACTAMENTE el draft de Facturapi a CFDI (lo que el
// cliente vio como BORRADOR es lo que se timbra) y persiste el Invoice local.
// La lógica vive en lib/facturas/prefacturas.ts (la comparte el hospital).
// ─────────────────────────────────────────────────────────────────────────────

type Params = { params: Promise<{ id: string }> };

const noEncontrada = () => NextResponse.json({ error: "Prefactura no encontrada" }, { status: 404 });

export async function GET(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const borrador = await detallePrefactura(id);
    if (!borrador) return noEncontrada();
    await requireMembership(borrador.companyId, undefined, req);
    return NextResponse.json(borrador);
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

export async function PUT(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const borrador = await cargarPrefactura(id);
    if (!borrador) return noEncontrada();
    const { user } = await requireWriter(borrador.companyId, req);
    await assertPuedeEscribir(user.id);

    const parsed = prefacturaSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Datos inválidos" },
        { status: 400 }
      );
    }
    const r = await editarPrefactura(borrador, parsed.data as StampInput, user, req);
    return NextResponse.json(r.body, { status: r.status });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

export async function POST(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const borrador = await cargarPrefactura(id);
    if (!borrador) return noEncontrada();
    const { user } = await requireWriter(borrador.companyId, req);
    await assertPuedeEscribir(user.id);

    const body = (await req.json().catch(() => null)) as { accion?: string; email?: string } | null;
    const r =
      body?.accion === "timbrar" ? await timbrarPrefactura(borrador, user, req)
      : body?.accion === "enviar" ? await enviarPrefactura(borrador, body.email, user, req)
      : { status: 400, body: { error: "accion debe ser 'timbrar' o 'enviar'" } };
    return NextResponse.json(r.body, { status: r.status });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

export async function DELETE(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const borrador = await cargarPrefactura(id);
    if (!borrador) return noEncontrada();
    const { user } = await requireWriter(borrador.companyId, req);
    const r = await descartarPrefactura(borrador, user, req);
    return NextResponse.json(r.body, { status: r.status });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
