import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  requireUser,
  getEffectiveCompanyMembership,
  AuthzError,
} from "@/lib/authz";
import {
  ivaTimingInput,
  pueInvoiceInclude,
  pueInvoiceFingerprint,
  pueReviewToken,
} from "@/lib/fiscal/iva-pue-cobros-db";
import type { PueTimingReview } from "@/lib/fiscal/iva-pue-cobros";
import { assertPaginaHospitalEnApi } from "@/lib/hospital/permisos";

// Explicit accountant review. Never edits the stamped CFDI, saved returns,
// bank movements or ledger. Historical effects are surfaced by the calculator.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let user;
  try {
    user = await requireUser(req);
  } catch (e) {
    if (e instanceof AuthzError)
      return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const parsed = ivaTimingInput.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json(
      { error: "Confirma tratamiento, motivo y evidencia de cobro válidos." },
      { status: 400 },
    );
  const input = parsed.data;
  const member = await getEffectiveCompanyMembership(user.id, input.companyId);
  if (!member || member.role === "VIEWER")
    return NextResponse.json(
      { error: "Sin permisos para confirmar el tratamiento fiscal." },
      { status: 403 },
    );
  try {
    await assertPaginaHospitalEnApi(input.companyId, user.id, req, [
      "impuestos",
    ]);
  } catch (e) {
    if (e instanceof AuthzError)
      return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  if (input.fechaCobro) {
    const date = new Date(input.fechaCobro + "T00:00:00.000Z");
    if (
      !Number.isFinite(date.getTime()) ||
      date.toISOString().slice(0, 10) !== input.fechaCobro ||
      input.fechaCobro > new Date().toISOString().slice(0, 10)
    ) {
      return NextResponse.json(
        { error: "La fecha efectiva de cobro debe ser real y no futura." },
        { status: 400 },
      );
    }
    if (
      input.tratamiento !== "FLUJO_GENERAL" ||
      !input.evidencia ||
      input.evidencia.length < 10
    ) {
      return NextResponse.json(
        {
          error:
            "Para confirmar un cobro completo indica la referencia del comprobante y el tratamiento de flujo general.",
        },
        { status: 400 },
      );
    }
  }
  const { id } = await params;
  const result = await prisma.$transaction(async (db) => {
    await db.$queryRaw`SELECT id FROM "Invoice" WHERE id=${id} AND "companyId"=${input.companyId} FOR UPDATE`;
    const inv = await db.invoice.findFirst({
      where: { id, companyId: input.companyId },
      include: pueInvoiceInclude,
    });
    if (!inv) return { error: "Factura no encontrada.", status: 404 };
    if (
      inv.tipo !== "INGRESO" ||
      inv.metodoPago !== "PUE" ||
      inv.status !== "STAMPED" ||
      inv.tipoSat === "E" ||
      inv.sustituidoPorUuid ||
      inv.moneda !== "MXN"
    ) {
      return {
        error:
          "Esta revisión corresponde a ingresos PUE vigentes en MXN; otros supuestos requieren revisión específica.",
        status: 422,
      };
    }
    if (pueReviewToken(inv) !== input.expected)
      return {
        error:
          "La factura o su revisión cambió. Recarga el papel antes de confirmar.",
        status: 409,
      };
    const review: PueTimingReview = {
      version: 1,
      tratamiento: input.tratamiento,
      fechaCobro: input.fechaCobro,
      evidencia: input.evidencia,
      motivo: input.motivo,
      fingerprint: pueInvoiceFingerprint(inv),
      actorId: user.id,
      reviewedAt: new Date().toISOString(),
    };
    await db.invoice.update({
      where: { id },
      data: { ivaCausacionRevision: { ...review } },
    });
    await db.auditLog.create({
      data: {
        companyId: input.companyId,
        userId: user.id,
        accion: "factura.iva-cobro-revisado",
        entidad: "Invoice",
        entidadId: id,
        detalle: { anterior: inv.ivaCausacionRevision, nueva: { ...review } },
      },
    });
    return { ok: true, status: 200 };
  });
  return NextResponse.json(result, { status: result.status });
}
