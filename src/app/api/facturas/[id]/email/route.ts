import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireWriter } from "@/lib/authz";
import { getFacturapiClient } from "@/lib/facturapi";
import { registrarBitacora } from "@/lib/audit";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/facturas/[id]/email  { email? }
//
// Envía el CFDI TIMBRADO (PDF + XML) al correo del cliente vía Facturapi
// (sendByEmail) — sin SMTP propio. Sin `email` en el body usa el correo del
// cliente de la factura. Sólo facturas emitidas en la app (facturapiId);
// las importadas del SAT no viven en Facturapi y no se pueden reenviar así.
// ─────────────────────────────────────────────────────────────────────────────

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const invoice = await prisma.invoice.findUnique({
      where: { id },
      select: {
        id: true,
        companyId: true,
        facturapiId: true,
        status: true,
        uuid: true,
        customer: { select: { email: true, razonSocial: true } },
        company: { select: { facturapiApiKey: true } },
      },
    });
    if (!invoice) return NextResponse.json({ error: "Factura no encontrada" }, { status: 404 });

    const { user } = await requireWriter(invoice.companyId, req);

    if (invoice.status !== "STAMPED") {
      return NextResponse.json({ error: "Sólo se pueden enviar facturas timbradas" }, { status: 409 });
    }
    if (!invoice.facturapiId) {
      return NextResponse.json(
        { error: "Esta factura se importó del SAT (no vive en Facturapi) — descarga el XML y envíalo manualmente." },
        { status: 422 }
      );
    }
    if (!invoice.company.facturapiApiKey) {
      return NextResponse.json({ error: "Facturapi no configurado" }, { status: 422 });
    }

    const body = (await req.json().catch(() => null)) as { email?: string } | null;
    const email = (body?.email ?? "").trim() || invoice.customer?.email || "";
    if (!email) {
      return NextResponse.json(
        { error: "El cliente no tiene correo capturado — indícalo en el campo email." },
        { status: 400 }
      );
    }

    try {
      const fp = getFacturapiClient(invoice.company.facturapiApiKey);
      await fp.invoices.sendByEmail(invoice.facturapiId, { email });
    } catch (e) {
      return NextResponse.json(
        { error: `No se pudo enviar por correo: ${e instanceof Error ? e.message : "error de Facturapi"}` },
        { status: 502 }
      );
    }

    registrarBitacora({
      companyId: invoice.companyId,
      userId: user.id,
      actorEmail: user.email,
      accion: "factura.enviar-correo",
      entidad: "Invoice",
      entidadId: invoice.id,
      detalle: { email, uuid: invoice.uuid },
      req,
    });

    return NextResponse.json({ ok: true, email });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
