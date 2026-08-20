import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireWriter } from "@/lib/authz";
import { assertPuedeEscribir } from "@/lib/subscription";
import {
  createDraftInvoice,
  discardDraft,
  stampDraftFromPending,
  type StampInput,
} from "@/lib/facturas/stamp";
import { pdfUrlCliente, prefacturaSchema, totalEstimadoPrefactura } from "@/lib/facturas/prefactura";
import { getFacturapiClient } from "@/lib/facturapi";
import { registrarBitacora } from "@/lib/audit";

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

export async function GET(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const borrador = await prisma.facturaBorrador.findUnique({
      where: { id },
      select: {
        id: true,
        companyId: true,
        customerId: true,
        status: true,
        payload: true,
        total: true,
        // El RECEPTOR completo viaja con el borrador. Antes el wizard lo
        // buscaba en su lista de clientes ya cargada, lo que ataba el
        // precargado a esa lista: si el cliente no estaba (lista filtrada por
        // el buscador) el receptor quedaba vacío, y peor, la lista cambia de
        // identidad en cada tecla y cancelaba el precargado a media carga.
        customer: {
          select: { id: true, rfc: true, razonSocial: true, regimenFiscal: true, facturapiId: true },
        },
      },
    });
    if (!borrador) return NextResponse.json({ error: "Prefactura no encontrada" }, { status: 404 });
    await requireMembership(borrador.companyId, undefined, req);
    return NextResponse.json(borrador);
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

// Editar = volver a crear con otro payload. El draft de Facturapi es
// INMUTABLE una vez creado, así que se crea uno nuevo (sin consumir timbre),
// se descarta el anterior y se actualiza la MISMA fila — el id de la
// prefactura no cambia, pero el enlace del PDF sí (va firmado por draftId):
// un enlace ya compartido deja de servir, que es exactamente lo deseable
// cuando el contenido cambió. El invariante se sostiene: lo que el cliente
// ve como BORRADOR es lo que se timbra.
export async function PUT(req: Request, { params }: Params) {
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

    const parsed = prefacturaSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Datos inválidos" },
        { status: 400 }
      );
    }
    // La empresa no se edita: una prefactura no se "muda" de emisor.
    if (parsed.data.companyId !== borrador.companyId) {
      return NextResponse.json({ error: "La empresa de la prefactura no coincide" }, { status: 422 });
    }
    const input = parsed.data as StampInput;

    // Primero el draft nuevo; sólo si Facturapi lo aceptó se descarta el
    // viejo. Al revés, un fallo a media edición dejaría la prefactura sin
    // ningún draft detrás — ni el contenido viejo ni el nuevo.
    const draft = await createDraftInvoice(input);
    if (!draft.ok) {
      return NextResponse.json(
        { error: draft.error, needsReconfigure: draft.needsReconfigure },
        { status: draft.status }
      );
    }
    await discardDraft(borrador.companyId, borrador.draftId); // best-effort

    const total = +totalEstimadoPrefactura(input.items);
    await prisma.facturaBorrador.update({
      where: { id },
      data: {
        customerId: input.customerId,
        draftId: draft.draftId,
        payload: JSON.parse(JSON.stringify(input)),
        total,
        // El PDF que el cliente pudo haber visto ya no existe: si se había
        // enviado, hay que reenviar el nuevo. Limpiar la marca lo hace visible.
        enviadaAt: null,
      },
    });

    registrarBitacora({
      companyId: borrador.companyId,
      userId: user.id,
      actorEmail: user.email,
      accion: "factura.prefactura.editar",
      entidad: "FacturaBorrador",
      entidadId: id,
      detalle: { draftAnterior: borrador.draftId, draftId: draft.draftId, total },
      req,
    });

    return NextResponse.json({
      ok: true,
      id,
      draftId: draft.draftId,
      total,
      pdfUrl: pdfUrlCliente(borrador.companyId, draft.draftId),
    });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
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
        const fp = getFacturapiClient(company.facturapiApiKey);
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

