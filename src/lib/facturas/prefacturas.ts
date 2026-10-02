import { draftIdentity } from "./draft-identity";
import { prisma } from "@/lib/prisma";
import { ensureFacturapiCustomer, getFacturapiClient } from "@/lib/facturapi";
import { registrarBitacora } from "@/lib/audit";
import { createDraftInvoice, discardDraft, stampDraftFromPending, resolveGlobalInfo, type StampInput } from "@/lib/facturas/stamp";
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

  const reviewIdentity = await draftIdentity(input.companyId, input.customerId);
  input = { ...input, global: resolveGlobalInfo(reviewIdentity.receptor.rfc, input.global) };
  const draft = await createDraftInvoice(input);
  if (!draft.ok) return { status: draft.status, body: { error: draft.error, needsReconfigure: draft.needsReconfigure } };

  // Total estimado con IVA por partida (el definitivo lo fija el CFDI).
  const total = +totalEstimadoPrefactura(input.items);
  const borrador = await prisma.facturaBorrador.create({
    data: {
      companyId: input.companyId,
      customerId: input.customerId,
      draftId: draft.draftId,
      payload: JSON.parse(JSON.stringify({ ...input, reviewIdentity })),
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
    include: { customer: { select: { razonSocial: true, rfc: true, email: true } }, _count: { select: { hospCargos: true } } },
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
    // Armada desde la cuenta de un episodio: no se edita a mano (ver editarPrefactura).
    cargosHospital: b._count.hospCargos,
    // Sustitución (relación 04): el UUID del CFDI que reemplazará.
    sustituyeUuid: (b.payload as { relations?: { relationship?: string; documents?: string[] } } | null)?.relations?.documents?.[0] ?? null,
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

/** Every entry point (chat, billing and hospital) shares this atomic claim. */
async function reclamarPrefactura(b: Borrador, status: string): Promise<boolean> {
  const result = await prisma.facturaBorrador.updateMany({
    where: { id: b.id, companyId: b.companyId, status: "PENDIENTE", draftId: b.draftId, updatedAt: b.updatedAt },
    data: { status },
  });
  return result.count === 1;
}
const prefacturaCambio = (): Resultado => ({ status: 409, body: { error: "La prefactura cambió o hay otra operación en curso. Vuelve a abrirla antes de continuar." } });

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
  // Una prefactura armada desde la cuenta de un episodio no se edita a mano:
  // sus conceptos SON los cargos que tomó, y editarlos desamarraría la cuenta
  // del CFDI. Se descarta (los cargos se liberan) y se vuelve a generar.
  if (await prisma.hospCargo.count({ where: { prefacturaId: borrador.id } })) {
    return { status: 409, body: { error: "Esta prefactura se armó desde la cuenta de un episodio: descártala y vuelve a generarla desde la cuenta." } };
  }
  // La empresa no se edita: una prefactura no se «muda» de emisor.
  if (input.companyId !== borrador.companyId) {
    return { status: 422, body: { error: "La empresa de la prefactura no coincide" } };
  }
  if (!await reclamarPrefactura(borrador, "EDITANDO")) return prefacturaCambio();
  try {
  const errorSync = await sincronizarReceptor(input.companyId, input.customerId);
  if (errorSync) return { status: 422, body: { error: errorSync } };

  // Primero el draft nuevo; sólo si Facturapi lo aceptó se descarta el viejo.
  // Al revés, un fallo a media edición dejaría la prefactura sin draft detrás.
  const reviewIdentity = await draftIdentity(input.companyId, input.customerId);
  input = { ...input, global: resolveGlobalInfo(reviewIdentity.receptor.rfc, input.global) };
  const draft = await createDraftInvoice(input);
  if (!draft.ok) return { status: draft.status, body: { error: draft.error, needsReconfigure: draft.needsReconfigure } };
  await discardDraft(borrador.companyId, borrador.draftId); // best-effort

  const total = +totalEstimadoPrefactura(input.items);
  await prisma.facturaBorrador.update({
    where: { id: borrador.id },
    data: {
      customerId: input.customerId,
      draftId: draft.draftId,
      payload: JSON.parse(JSON.stringify({ ...input, reviewIdentity })),
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
  } finally {
    await prisma.facturaBorrador.updateMany({ where: { id: borrador.id, status: "EDITANDO" }, data: { status: "PENDIENTE" } });
  }
}

/** Promueve EXACTAMENTE el draft de Facturapi a CFDI y persiste el Invoice local. */
export async function timbrarPrefactura(borrador: Borrador, actor: Actor, req: Request): Promise<Resultado> {
  const bloqueo = noPendiente(borrador);
  if (bloqueo) return bloqueo;
  if (!await reclamarPrefactura(borrador, "TIMBRANDO")) return prefacturaCambio();
  const input = borrador.payload as unknown as StampInput;
  let result;
  try {
    result = await stampDraftFromPending(input, borrador.draftId);
  } catch (e) {
    await prisma.facturaBorrador.updateMany({ where: { id: borrador.id, status: "TIMBRANDO" }, data: { status: "REVISAR_TIMBRADO" } });
    throw e;
  }
  if (!result.ok) {
    // Even an HTTP error can follow successful issuance. Preserve the draft
    // reference for recovery; never promote the same uncertain draft again.
    await prisma.facturaBorrador.update({ where: { id: borrador.id }, data: { status: "REVISAR_TIMBRADO" } });
    return { status: result.status, body: { error: `${result.error} Revisa el resultado del PAC antes de reintentar.`, needsReconfigure: result.needsReconfigure } };
  }
  await prisma.facturaBorrador.update({
    where: { id: borrador.id },
    data: { status: "TIMBRADA", invoiceId: result.invoiceId },
  });
  // Los cargos del hospital que tomó esta prefactura quedan amparados por el
  // CFDI (un cargo, un CFDI): la cuenta los ve facturados y la contabilidad
  // los reparte por categoría. Sin cargos ligados, no hace nada.
  // En una sustitución (relación 04) los cargos todavía traen el CFDI viejo:
  // pasan al nuevo aquí, y el viejo se cancela después con motivo 01.
  await prisma.hospCargo.updateMany({
    where: { prefacturaId: borrador.id },
    data: { invoiceId: result.invoiceId },
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
  // Si sustituye a otro CFDI, se devuelve cuál: el siguiente paso es cancelar
  // ése con motivo 01 y el UUID recién timbrado.
  const uuidViejo = input.relations?.relationship === "04" ? input.relations.documents[0]?.toUpperCase() : undefined;
  const vieja = uuidViejo
    ? await prisma.invoice.findFirst({ where: { companyId: borrador.companyId, uuid: uuidViejo }, select: { id: true, uuid: true, status: true } })
    : null;
  return { status: 200, body: { ok: true, invoiceId: result.invoiceId, uuid: result.uuid, total: result.total, sustituye: vieja } };
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
  if (!await reclamarPrefactura(borrador, "DESCARTADA")) return prefacturaCambio();
  await discardDraft(borrador.companyId, borrador.draftId);
  // Los cargos del hospital que tomó quedan como estaban: libres o, si era una
  // sustitución, amparados todavía por el CFDI que iba a reemplazar.
  await prisma.hospCargo.updateMany({ where: { prefacturaId: borrador.id }, data: { prefacturaId: null } });
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
