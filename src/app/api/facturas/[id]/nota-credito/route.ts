import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { gateEscritura } from "@/lib/subscription";
import { registrarBitacora } from "@/lib/audit";
import { emitirNotaCredito } from "@/lib/facturas/nota-credito";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

// POST /api/facturas/[id]/nota-credito
// Body: { descripcion, montoBase, ivaTasa?, formaPago? }
// Emite un CFDI de egreso (nota de crédito) relacionado a la factura [id].
export async function POST(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const inv = await prisma.invoice.findUnique({ where: { id }, select: { companyId: true } });
  if (!inv) return NextResponse.json({ error: "Factura no encontrada" }, { status: 404 });

  const member = await getEffectiveCompanyMembership(session.user.id, inv.companyId);
  if (!member || member.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }
  const gate = await gateEscritura(session.user.id);
  if (gate) return gate;

  const body = await req.json().catch(() => ({}));
  const result = await emitirNotaCredito({
    companyId: inv.companyId,
    parentInvoiceId: id,
    descripcion: String(body.descripcion ?? "").trim() || "Devolución / descuento",
    montoBase: Number(body.montoBase),
    ivaTasa: body.ivaTasa != null ? Number(body.ivaTasa) : undefined,
    formaPago: body.formaPago ? String(body.formaPago) : undefined,
  });

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  registrarBitacora({
    accion: "factura.nota-credito",
    userId: session.user.id,
    companyId: inv.companyId,
    entidad: "Invoice",
    entidadId: result.invoiceId,
    detalle: { uuid: result.uuid, total: result.total, parentInvoiceId: id },
  });
  return NextResponse.json({ ok: true, uuid: result.uuid, total: result.total, invoiceId: result.invoiceId });
}
