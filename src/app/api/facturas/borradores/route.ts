import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireWriter } from "@/lib/authz";
import { assertPuedeEscribir } from "@/lib/subscription";
import { createDraftInvoice, type StampInput } from "@/lib/facturas/stamp";
import { pdfUrlCliente, prefacturaSchema, totalEstimadoPrefactura } from "@/lib/facturas/prefactura";
import { registrarBitacora } from "@/lib/audit";

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

    const draft = await createDraftInvoice(input);
    if (!draft.ok) {
      return NextResponse.json(
        { error: draft.error, needsReconfigure: draft.needsReconfigure },
        { status: draft.status }
      );
    }

    // Total estimado con IVA por partida (el definitivo lo fija el CFDI).
    // Compartido con el PUT de edición: mismo número por cualquiera de las
    // dos puertas.
    const total = +totalEstimadoPrefactura(input.items);

    const borrador = await prisma.facturaBorrador.create({
      data: {
        companyId: input.companyId,
        customerId: input.customerId,
        draftId: draft.draftId,
        payload: JSON.parse(JSON.stringify(input)),
        total,
      },
    });

    registrarBitacora({
      companyId: input.companyId,
      userId: user.id,
      actorEmail: user.email,
      accion: "factura.prefactura.crear",
      entidad: "FacturaBorrador",
      entidadId: borrador.id,
      detalle: { draftId: draft.draftId, total },
      req,
    });

    return NextResponse.json(
      {
        ok: true,
        id: borrador.id,
        draftId: draft.draftId,
        total,
        pdfUrl: pdfUrlCliente(input.companyId, draft.draftId),
      },
      { status: 201 }
    );
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

    const borradores = await prisma.facturaBorrador.findMany({
      where: { companyId, status: "PENDIENTE" },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { customer: { select: { razonSocial: true, rfc: true, email: true } } },
    });

    return NextResponse.json(
      borradores.map((b) => ({
        id: b.id,
        draftId: b.draftId,
        cliente: b.customer.razonSocial,
        rfc: b.customer.rfc,
        emailCliente: b.customer.email,
        total: b.total,
        enviadaAt: b.enviadaAt,
        createdAt: b.createdAt,
        pdfUrl: pdfUrlCliente(companyId, b.draftId),
      }))
    );
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
