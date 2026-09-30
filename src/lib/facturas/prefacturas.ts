import { prisma } from "@/lib/prisma";
import { ensureFacturapiCustomer, getFacturapiClient } from "@/lib/facturapi";
import { registrarBitacora } from "@/lib/audit";
import { createDraftInvoice, discardDraft, stampDraftFromPending, type StampInput } from "@/lib/facturas/stamp";
import { pdfUrlCliente, totalEstimadoPrefactura } from "@/lib/facturas/prefactura";

// ─────────────────────────────────────────────────────────────────────────────
// Prefacturas: la lógica de negocio SIN autorización. La comparten las rutas
// genéricas (/api/facturas/borradores) y las del hospital
// (/api/hospital/facturacion/prefacturas): cada puerta decide QUIÉN puede
// (rol de la empresa; en el hospital además la página y FINANZAS_ESCRIBIR) y
// aquí se decide QUÉ pasa. Dos copias de crear/editar/timbrar serían dos
// lugares donde el total, el enlace del PDF o la bitácora pueden divergir.
//
// Cada función devuelve `{ status, body }` listo para la respuesta: el caller
// sólo lo envuelve en NextResponse.json.
// ─────────────────────────────────────────────────────────────────────────────

export interface Actor {
  id: string;
  email?: string | null;
}

export interface Resultado {
  status: number;
  body: unknown;
}

type Borrador = NonNullable<Awaited<ReturnType<typeof cargarPrefactura>>>;

export function cargarPrefactura(id: string) {
  return prisma.facturaBorrador.findUnique({
    where: { id },
    include: { customer: { select: { email: true, razonSocial: true } } },
  });
}

/**
 * Sync perezoso del receptor con Facturapi, igual que POST /api/facturas.
 * Antes el camino de la prefactura contestaba 422 «créalo en la app primero»
 * para cualquier cliente nuevo — un paciente dado de alta hoy no podía
 * recibir prefactura. Si la empresa no tiene llave o el cliente no es suyo,
 * no hace nada: `createDraftInvoice` contesta esos casos con su mensaje.
 */
async function sincronizarReceptor(companyId: string, customerId: string): Promise<string | null> {
  const [company, customer] = await Promise.all([
    prisma.company.findUnique({ where: { id: companyId }, select: { facturapiApiKey: true } }),
    prisma.customer.findUnique({ where: { id: customerId } }),
  ]);
  if (!company?.facturapiApiKey || !customer || customer.companyId !== companyId) return null;
  const sync = await ensureFacturapiCustomer(company.facturapiApiKey, customer);
  return sync.ok ? null : sync.error;
}

export async function crearPrefactura(input: StampInput, actor: Actor, req: Request): Promise<Resultado> {
  const errorSync = await sincronizarReceptor(input.companyId, input.customerId);
  if (errorSync) return { status: 422, body: { error: errorSync } };

  const draft = await createDraftInvoice(input);
  if (!draft.ok) return { status: draft.status, body: { error: draft.error, needsReconfigure: draft.needsReconfigure } };

  // Total estimado con IVA por partida (el definitivo lo fija el CFDI).
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
    userId: actor.id,
    actorEmail: actor.email,
    accion: "factura.prefactura.crear",
    entidad: "FacturaBorrador",
    entidadId: borrador.id,
    detalle: { draftId: draft.draftId, total },
    req,
  });
  return {
    status: 201,
    body: { ok: true, id: borrador.id, draftId: draft.draftId, total, pdfUrl: pdfUrlCliente(input.companyId, draft.draftId) },
  };
}

export async function listarPrefacturas(companyId: string) {
  const borradores = await prisma.facturaBorrador.findMany({
    where: { companyId, status: "PENDIENTE" },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { customer: { select: { razonSocial: true, rfc: true, email: true } } },
  });
  return borradores.map((b) => ({
    id: b.id,
    draftId: b.draftId,
    cliente: b.customer.razonSocial,
    rfc: b.customer.rfc,
    emailCliente: b.customer.email,
    total: b.total,
    enviadaAt: b.enviadaAt,
    createdAt: b.createdAt,
    pdfUrl: pdfUrlCliente(companyId, b.draftId),
  }));
}

/** El payload completo con el receptor, para precargar el editor. */
export function detallePrefactura(id: string) {
  return prisma.facturaBorrador.findUnique({
    where: { id },
    select: {
      id: true,
      companyId: true,
      customerId: true,
      status: true,
      payload: true,
      total: true,
      draftId: true,
      customer: { select: { id: true, rfc: true, razonSocial: true, regimenFiscal: true, facturapiId: true } },
    },
  });
}

const noPendiente = (b: Borrador): Resultado | null =>
  b.status === "PENDIENTE" ? null : { status: 409, body: { error: `La prefactura ya está ${b.status.toLowerCase()}` } };

/**
 * Editar = volver a crear con otro payload. El draft de Facturapi es
 * INMUTABLE, así que se crea uno nuevo (sin consumir timbre), se descarta el
 * anterior y se actualiza la MISMA fila. El enlace del PDF cambia (va firmado
 * por draftId): uno ya compartido deja de servir, que es lo deseable cuando el
 * contenido cambió. Lo que el cliente ve como BORRADOR es lo que se timbra.
 */
export async function editarPrefactura(borrador: Borrador, input: StampInput, actor: Actor, req: Request): Promise<Resultado> {
  const bloqueo = noPendiente(borrador);
  if (bloqueo) return bloqueo;
  // La empresa no se edita: una prefactura no se «muda» de emisor.
  if (input.companyId !== borrador.companyId) {
    return { status: 422, body: { error: "La empresa de la prefactura no coincide" } };
  }
  const errorSync = await sincronizarReceptor(input.companyId, input.customerId);
  if (errorSync) return { status: 422, body: { error: errorSync } };

  // Primero el draft nuevo; sólo si Facturapi lo aceptó se descarta el viejo.
  // Al revés, un fallo a media edición dejaría la prefactura sin draft detrás.
  const draft = await createDraftInvoice(input);
  if (!draft.ok) return { status: draft.status, body: { error: draft.error, needsReconfigure: draft.needsReconfigure } };
  await discardDraft(borrador.companyId, borrador.draftId); // best-effort

  const total = +totalEstimadoPrefactura(input.items);
  await prisma.facturaBorrador.update({
    where: { id: borrador.id },
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
    userId: actor.id,
    actorEmail: actor.email,
    accion: "factura.prefactura.editar",
    entidad: "FacturaBorrador",
    entidadId: borrador.id,
    detalle: { draftAnterior: borrador.draftId, draftId: draft.draftId, total },
    req,
  });
  return {
    status: 200,
    body: { ok: true, id: borrador.id, draftId: draft.draftId, total, pdfUrl: pdfUrlCliente(borrador.companyId, draft.draftId) },
  };
}

/** Promueve EXACTAMENTE el draft de Facturapi a CFDI y persiste el Invoice local. */
export async function timbrarPrefactura(borrador: Borrador, actor: Actor, req: Request): Promise<Resultado> {
  const bloqueo = noPendiente(borrador);
  if (bloqueo) return bloqueo;
  const input = borrador.payload as unknown as StampInput;
  const result = await stampDraftFromPending(input, borrador.draftId);
  if (!result.ok) return { status: result.status, body: { error: result.error, needsReconfigure: result.needsReconfigure } };
  await prisma.facturaBorrador.update({
    where: { id: borrador.id },
    data: { status: "TIMBRADA", invoiceId: result.invoiceId },
  });
  registrarBitacora({
    companyId: borrador.companyId,
    userId: actor.id,
    actorEmail: actor.email,
    accion: "factura.prefactura.timbrar",
    entidad: "FacturaBorrador",
    entidadId: borrador.id,
    detalle: { invoiceId: result.invoiceId, uuid: result.uuid, total: result.total },
    req,
  });
  return { status: 200, body: { ok: true, invoiceId: result.invoiceId, uuid: result.uuid, total: result.total } };
}

/** Manda el PDF del borrador al correo vía Facturapi (sin SMTP propio). */
export async function enviarPrefactura(borrador: Borrador, emailPedido: string | undefined, actor: Actor, req: Request): Promise<Resultado> {
  const bloqueo = noPendiente(borrador);
  if (bloqueo) return bloqueo;
  const email = (emailPedido ?? "").trim() || borrador.customer.email || "";
  if (!email) {
    return { status: 400, body: { error: "El cliente no tiene correo capturado — indícalo en el campo email." } };
  }
  const company = await prisma.company.findUnique({ where: { id: borrador.companyId }, select: { facturapiApiKey: true } });
  if (!company?.facturapiApiKey) return { status: 422, body: { error: "Facturapi no configurado" } };
  try {
    await getFacturapiClient(company.facturapiApiKey).invoices.sendByEmail(borrador.draftId, { email });
  } catch (e) {
    return { status: 502, body: { error: `No se pudo enviar por correo: ${e instanceof Error ? e.message : "error de Facturapi"}` } };
  }
  await prisma.facturaBorrador.update({ where: { id: borrador.id }, data: { enviadaAt: new Date() } });
  registrarBitacora({
    companyId: borrador.companyId,
    userId: actor.id,
    actorEmail: actor.email,
    accion: "factura.prefactura.enviar",
    entidad: "FacturaBorrador",
    entidadId: borrador.id,
    detalle: { email },
    req,
  });
  return { status: 200, body: { ok: true, email } };
}

/** Descarta: mejor esfuerzo en Facturapi; el estado local siempre queda DESCARTADA. */
export async function descartarPrefactura(borrador: Borrador, actor: Actor, req: Request): Promise<Resultado> {
  const bloqueo = noPendiente(borrador);
  if (bloqueo) return bloqueo;
  await discardDraft(borrador.companyId, borrador.draftId);
  await prisma.facturaBorrador.update({ where: { id: borrador.id }, data: { status: "DESCARTADA" } });
  registrarBitacora({
    companyId: borrador.companyId,
    userId: actor.id,
    actorEmail: actor.email,
    accion: "factura.prefactura.descartar",
    entidad: "FacturaBorrador",
    entidadId: borrador.id,
    detalle: { draftId: borrador.draftId },
    req,
  });
  return { status: 200, body: { ok: true } };
}
