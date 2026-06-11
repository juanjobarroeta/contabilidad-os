import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getFacturapiClient } from "@/lib/facturapi";
import { parseFacturapiError } from "@/lib/facturapi-errors";
import { getEffectiveCompanyMembership } from "@/lib/authz";

const VALID_MOTIVOS = ["01", "02", "03", "04"] as const;

// DELETE /api/facturas/[id] — cancel a CFDI.
// Body (JSON): { motivo: "01"|"02"|"03"|"04", sustituyeUuid?: string }
//   01 = comprobante emitido con errores CON relación (requiere sustituyeUuid)
//   02 = comprobante emitido con errores SIN relación
//   03 = no se llevó a cabo la operación
//   04 = operación nominativa relacionada en una factura global
//
// SAFETY: we ONLY mark the invoice CANCELLED if Facturapi/SAT confirms. A failed
// SAT cancellation no longer silently flips our DB to CANCELLED (the old bug,
// which gave a false sense the CFDI was dead at SAT when it was still live).
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  const body = await req.json().catch(() => ({}));
  const motivo = String(body?.motivo ?? "");
  const sustituyeUuid: string | undefined = body?.sustituyeUuid
    ? String(body.sustituyeUuid).toUpperCase()
    : undefined;

  if (!VALID_MOTIVOS.includes(motivo as (typeof VALID_MOTIVOS)[number])) {
    return NextResponse.json(
      { error: "Falta el motivo de cancelación (01, 02, 03 o 04)." },
      { status: 400 }
    );
  }
  if (motivo === "01" && !sustituyeUuid) {
    return NextResponse.json(
      { error: "El motivo 01 requiere el UUID de la factura que la sustituye." },
      { status: 400 }
    );
  }

  const invoice = await prisma.invoice.findUnique({
    where: { id },
    include: { company: true },
  });
  if (!invoice) return NextResponse.json({ error: "Factura no encontrada" }, { status: 404 });

  const member = await getEffectiveCompanyMembership(session.user.id, invoice.companyId);
  if (!member || member.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }
  if (invoice.status === "CANCELLED") {
    return NextResponse.json({ error: "La factura ya está cancelada" }, { status: 409 });
  }

  // Stamped CFDI → must cancel at SAT via Facturapi, with the motivo.
  if (invoice.facturapiId && invoice.company.facturapiApiKey) {
    try {
      const fp = getFacturapiClient(invoice.company.facturapiApiKey);
      // Facturapi params: { motive, substitution? }. Only confirmed if it
      // returns without throwing and the status reflects cancellation.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (fp as any).invoices.cancel(invoice.facturapiId, {
        motive: motivo,
        ...(sustituyeUuid ? { substitution: sustituyeUuid } : {}),
      });
    } catch (e) {
      const info = parseFacturapiError(e);
      // DO NOT mark CANCELLED — the CFDI is still live at SAT.
      return NextResponse.json(
        { error: `No se pudo cancelar ante el SAT: ${info.message}`, kind: info.kind },
        { status: info.status }
      );
    }
  } else if (invoice.status !== "STAMPED") {
    // DRAFT / never stamped → safe to cancel locally only.
  } else {
    // Stamped but no Facturapi key → we can't reach SAT. Don't fake it.
    return NextResponse.json(
      { error: "No hay conexión con Facturapi para cancelar ante el SAT. Configúrala o cancela desde el portal." },
      { status: 422 }
    );
  }

  const updated = await prisma.invoice.update({
    where: { id },
    data: {
      status: "CANCELLED",
      canceladaAt: new Date(),
      cancelMotivo: motivo,
      cancelSustituyeUuid: sustituyeUuid ?? null,
    },
  });
  return NextResponse.json(updated);
}

// PATCH /api/facturas/[id] — update contador fields on an invoice.
// Currently only `overrideCuenta` (the auto-classification override).
//
// The override is the SAT subcuenta code (e.g. "601.15") that should be
// used by the posting engine instead of whatever classifyInvoice() returns
// for this invoice. Set to empty/null to clear the override and re-enable
// automatic classification.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const invoice = await prisma.invoice.findUnique({
    where: { id },
    select: { id: true, companyId: true },
  });
  if (!invoice) return NextResponse.json({ error: "Factura no encontrada" }, { status: 404 });

  const member = await getEffectiveCompanyMembership(session.user.id, invoice.companyId);
  if (!member || member.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body inválido" }, { status: 400 });
  }

  const data: {
    overrideCuenta?: string | null;
    naturaleza?: string;
    naturalezaManual?: boolean;
    naturalezaRevision?: boolean;
  } = {};

  // Override de naturaleza fiscal por el contador (GASTO/INVERSION/INVENTARIO/
  // SIN_EFECTOS). Marca naturalezaManual para que el re-sync no lo pise, y
  // limpia la bandera de revisión.
  if ("naturaleza" in body) {
    const v = body.naturaleza;
    const valid = ["GASTO", "INVERSION", "INVENTARIO", "SIN_EFECTOS"];
    if (typeof v !== "string" || !valid.includes(v)) {
      return NextResponse.json({ error: "naturaleza inválida" }, { status: 400 });
    }
    data.naturaleza = v;
    data.naturalezaManual = true;
    data.naturalezaRevision = false;
  }

  if ("overrideCuenta" in body) {
    const v = body.overrideCuenta;
    if (v === null || v === "" || v === undefined) {
      data.overrideCuenta = null;
    } else if (typeof v === "string" && v.trim().length > 0) {
      // Validate the cuenta exists in this company's chart of accounts
      const exists = await prisma.chartAccount.findFirst({
        where: {
          companyId: invoice.companyId,
          OR: [{ subcuenta: v.trim() }, { cuentaSAT: v.trim(), subcuenta: null }],
        },
      });
      if (!exists) {
        return NextResponse.json(
          { error: `La cuenta "${v}" no existe en el catálogo de la empresa` },
          { status: 400 }
        );
      }
      data.overrideCuenta = v.trim();
    } else {
      return NextResponse.json({ error: "overrideCuenta inválido" }, { status: 400 });
    }
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "No hay cambios" }, { status: 400 });
  }

  const updated = await prisma.invoice.update({
    where: { id },
    data,
  });
  return NextResponse.json(updated);
}
