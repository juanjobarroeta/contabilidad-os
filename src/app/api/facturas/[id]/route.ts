import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { registrarBitacora } from "@/lib/audit";
import { cancelarCfdi } from "@/lib/facturas/cancelar";
import { retirarActivosPorReclasificacion } from "@/lib/fiscal/auto-activo";

// GET /api/facturas/[id] — una factura con sus partidas y su cliente.
// Sirve al atajo «volver a facturar» (/facturas/nueva?desde=<id>), que clona
// una factura concreta sin depender de que aparezca en las sugerencias.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const invoice = await prisma.invoice.findUnique({
    where: { id },
    include: {
      items: true,
      customer: { select: { id: true, rfc: true, razonSocial: true, regimenFiscal: true } },
    },
  });
  if (!invoice) return NextResponse.json({ error: "Factura no encontrada" }, { status: 404 });

  const member = await getEffectiveCompanyMembership(session.user.id, invoice.companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  return NextResponse.json(invoice);
}

// DELETE /api/facturas/[id] — cancel a CFDI.
// Body (JSON): { motivo: "01"|"02"|"03"|"04", sustituyeUuid?: string }
// La regla (motivos, cadena de REPs, cancelación consumada vs. solicitada)
// vive en lib/facturas/cancelar.ts, compartida con la puerta del hospital.
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = await req.json().catch(() => ({}));

  const invoice = await prisma.invoice.findUnique({ where: { id }, select: { companyId: true } });
  if (!invoice) return NextResponse.json({ error: "Factura no encontrada" }, { status: 404 });
  const member = await getEffectiveCompanyMembership(session.user.id, invoice.companyId);
  if (!member || member.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }

  const r = await cancelarCfdi({
    invoiceId: id,
    motivo: String(body?.motivo ?? ""),
    sustituyeUuid: body?.sustituyeUuid ? String(body.sustituyeUuid) : undefined,
    actor: { id: session.user.id, email: session.user.email ?? null },
    req,
  });
  return NextResponse.json(r.body, { status: r.status });
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
    ivaNoAcreditable?: boolean;
    ivaNoCausado?: boolean;
  } = {};

  // El contador excluye/incluye el CFDI del acreditamiento de IVA (p. ej. PUE no
  // pagado: el IVA sólo es acreditable si se pagó, Art. 5-I LIVA).
  if ("ivaNoAcreditable" in body) {
    if (typeof body.ivaNoAcreditable !== "boolean") {
      return NextResponse.json({ error: "ivaNoAcreditable inválido" }, { status: 400 });
    }
    data.ivaNoAcreditable = body.ivaNoAcreditable;
  }

  // El contador excluye/incluye el CFDI del IVA trasladado (p. ej. PUE no cobrado:
  // el IVA se causa cuando se cobra, Art. 1-B/11/17 LIVA).
  if ("ivaNoCausado" in body) {
    if (typeof body.ivaNoCausado !== "boolean") {
      return NextResponse.json({ error: "ivaNoCausado inválido" }, { status: 400 });
    }
    data.ivaNoCausado = body.ivaNoCausado;
  }

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

  // DEJAR DE SER INVERSIÓN TIENE QUE LLEVARSE EL ACTIVO.
  //
  // Un CFDI con usoCfdi I01–I08 crea un ActivoFijo solo (auto-activo.ts). Si el
  // contador lo reclasifica a GASTO, el CFDI pasa a deducirse completo... y el
  // activo huérfano seguía depreciándose mes con mes: LA MISMA COMPRA DEDUCIDA
  // DOS VECES, una en el gasto y otra en la depreciación. Nadie lo veía, porque
  // el activo vive en otra pantalla.
  //
  // Sólo se retira el que creó el sistema (`autoCreado`): uno que el contador
  // capturó o ya revisó es suyo, y borrárselo por editar la factura sería
  // peor que el problema.
  let activosRetirados = 0;
  if (data.naturaleza) {
    activosRetirados = await retirarActivosPorReclasificacion(prisma, {
      companyId: invoice.companyId,
      invoiceId: id,
      naturaleza: data.naturaleza,
    });
    if (activosRetirados > 0) {
      registrarBitacora({
        accion: "activo.retirar-por-reclasificacion",
        userId: session.user.id,
        companyId: invoice.companyId,
        entidad: "ActivoFijo",
        entidadId: id,
        detalle: { invoiceId: id, naturaleza: data.naturaleza, retirados: activosRetirados },
      });
    }
  }

  return NextResponse.json({ ...updated, activosRetirados });
}
