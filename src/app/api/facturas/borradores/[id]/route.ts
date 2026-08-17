import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireWriter } from "@/lib/authz";
import { assertPuedeEscribir } from "@/lib/subscription";
import {
  discardDraft,
  stampDraftFromPending,
  type StampInput,
} from "@/lib/facturas/stamp";
import { getFacturapiClient } from "@/lib/facturapi";
import { registrarBitacora } from "@/lib/audit";

// ─────────────────────────────────────────────────────────────────────────────
// Acciones sobre UNA prefactura:
//   POST   /api/facturas/borradores/[id]   { accion: "timbrar" }
//                                          { accion: "enviar", email? }
//   DELETE /api/facturas/borradores/[id]   — descartar (borra el draft en
//                                            Facturapi, marca DESCARTADA)
//
// "timbrar" promueve EXACTAMENTE el draft de Facturapi a CFDI (lo que el
// cliente vio como BORRADOR es lo que se timbra) y persiste el Invoice local.
// "enviar" manda el PDF del borrador al correo vía Facturapi (sendByEmail
// funciona sobre el draft) — sin SMTP propio.
// ─────────────────────────────────────────────────────────────────────────────

type Params = { params: Promise<{ id: string }> };

async function cargarBorrador(id: string) {
  return prisma.facturaBorrador.findUnique({
    where: { id },
    include: { customer: { select: { email: true, razonSocial: true } } },
  });
}

export async function POST(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const borrador = await cargarBorrador(id);
    if (!borrador) return NextResponse.json({ error: "Prefactura no encontrada" }, { status: 404 });

    const { user } = await requireWriter(borrador.companyId, req);
    await assertPuedeEscribir(user.id);

    if (borrador.status !== "PENDIENTE") {
      return NextResponse.json(
        { error: `La prefactura ya está ${borrador.status.toLowerCase()}` },
        { status: 409 }
      );
    }

    const body = (await req.json().catch(() => null)) as { accion?: string; email?: string } | null;
    const accion = body?.accion;

    if (accion === "timbrar") {
      const input = borrador.payload as unknown as StampInput;
      const result = await stampDraftFromPending(input, borrador.draftId);
      if (!result.ok) {
        return NextResponse.json(
          { error: result.error, needsReconfigure: result.needsReconfigure },
          { status: result.status }
        );
      }
      await prisma.facturaBorrador.update({
        where: { id },
        data: { status: "TIMBRADA", invoiceId: result.invoiceId },
      });
      registrarBitacora({
        companyId: borrador.companyId,
        userId: user.id,
        actorEmail: user.email,
        accion: "factura.prefactura.timbrar",
        entidad: "FacturaBorrador",
        entidadId: id,
        detalle: { invoiceId: result.invoiceId, uuid: result.uuid, total: result.total },
        req,
      });
      return NextResponse.json({ ok: true, invoiceId: result.invoiceId, uuid: result.uuid, total: result.total });
    }

    if (accion === "enviar") {
      const email = (body?.email ?? "").trim() || borrador.customer.email || "";
      if (!email) {
        return NextResponse.json(
          { error: "El cliente no tiene correo capturado — indícalo en el campo email." },
          { status: 400 }
        );
      }
      const company = await prisma.company.findUnique({
        where: { id: borrador.companyId },
        select: { facturapiApiKey: true },
      });
      if (!company?.facturapiApiKey) {
        return NextResponse.json({ error: "Facturapi no configurado" }, { status: 422 });
      }
      try {
        const fp = getFacturapiClient(company.facturapiApiKey, {
          companyId: borrador.companyId,
          actor: "route:borrador-email",
        });
        await fp.invoices.sendByEmail(borrador.draftId, { email });
      } catch (e) {
        return NextResponse.json(
          { error: `No se pudo enviar por correo: ${e instanceof Error ? e.message : "error de Facturapi"}` },
          { status: 502 }
        );
      }
      await prisma.facturaBorrador.update({ where: { id }, data: { enviadaAt: new Date() } });
      registrarBitacora({
        companyId: borrador.companyId,
        userId: user.id,
        actorEmail: user.email,
        accion: "factura.prefactura.enviar",
        entidad: "FacturaBorrador",
        entidadId: id,
        detalle: { email },
        req,
      });
      return NextResponse.json({ ok: true, email });
    }

    return NextResponse.json({ error: "accion debe ser 'timbrar' o 'enviar'" }, { status: 400 });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

export async function DELETE(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const borrador = await cargarBorrador(id);
    if (!borrador) return NextResponse.json({ error: "Prefactura no encontrada" }, { status: 404 });

    const { user } = await requireWriter(borrador.companyId, req);

    if (borrador.status !== "PENDIENTE") {
      return NextResponse.json(
        { error: `La prefactura ya está ${borrador.status.toLowerCase()}` },
        { status: 409 }
      );
    }

    // Mejor esfuerzo en Facturapi; el estado local siempre queda DESCARTADA.
    await discardDraft(borrador.companyId, borrador.draftId);
    await prisma.facturaBorrador.update({ where: { id }, data: { status: "DESCARTADA" } });

    registrarBitacora({
      companyId: borrador.companyId,
      userId: user.id,
      actorEmail: user.email,
      accion: "factura.prefactura.descartar",
      entidad: "FacturaBorrador",
      entidadId: id,
      detalle: { draftId: borrador.draftId },
      req,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

