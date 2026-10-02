import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { documentFingerprint } from "@/lib/fiscal/document-fingerprint";
import { draftIdentity } from "@/lib/facturas/draft-identity";
import { cargarPrefactura, timbrarPrefactura } from "@/lib/facturas/prefacturas";
import { previewRecibo } from "@/lib/nomina/preview-recibo";
import { emitNominaCfdi } from "@/lib/nomina/emit-nomina";
import { stampPayrollRun } from "@/lib/nomina/payroll-run";
import { registrarBitacora } from "@/lib/audit";
import { readDocument } from "./read";
import type { DocumentRef, StampReview } from "./contract";
import { signReview, verifyReview } from "./review-token";

const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;

/** Builds the actual fiscal payloads without contacting the PAC. Invoice
 * drafts are immutable provider drafts; payroll uses the SAME payload builder
 * as issuance, including identities recovered from previously stamped XML. */
export async function documentStampState(ref: DocumentRef) {
  if (!ref.id || !["prefactura", "nomina"].includes(ref.kind)) throw new Error("Este documento no requiere timbrado desde esta tarjeta.");
  const view = await readDocument(ref);
  if (!view.stampable) throw new Error("El documento no está disponible para timbrar. Revisa su estado actual.");
  const company = await prisma.company.findUniqueOrThrow({ where: { id: ref.companyId }, select: { id: true, rfc: true, razonSocial: true, regimenFiscal: true, codigoPostal: true } });
  if (ref.kind === "prefactura") {
    const draft = await cargarPrefactura(ref.id);
    if (!draft || draft.companyId !== ref.companyId || draft.status !== "PENDIENTE" || draft.updatedAt.toISOString() !== view.updatedAt) throw new Error("La prefactura cambió. Vuelve a abrirla.");
    const identity = await draftIdentity(ref.companyId, draft.customerId);
    const savedIdentity = (draft.payload as Record<string, unknown>).reviewIdentity;
    if (!savedIdentity || documentFingerprint(savedIdentity) !== documentFingerprint(identity)) throw new Error("La prefactura no tiene una revisión fiscal vigente del emisor y receptor. Ábrela en Facturas, vuelve a guardarla y revisa el PDF actualizado antes de timbrar.");
    const payload = { ...draft.payload as Record<string, unknown> };
    const fingerprint = documentFingerprint({ ref, draftId: draft.draftId, updatedAt: draft.updatedAt, total: draft.total, payload });
    return { view, fingerprint, draft, amountToStamp: Number(draft.total), payloads: [{ id: draft.id, payload }], hashes: {} as Record<string, string> };
  }
  const receipts = view.receipts!.filter((r) => !r.uuid);
  const payloads: StampReview["payloads"] = [];
  const hashes: Record<string, string> = {};
  let amountToStamp = 0;
  // Bound database work; never approve a silently truncated payroll batch.
  if (receipts.length > 100) throw new Error("Este lote supera 100 recibos. Revísalo y tímbrelo desde Nómina.");
  for (const receipt of receipts) {
    const calculated = await previewRecibo(ref.companyId, receipt.id);
    if (!calculated.ok) throw new Error(`${receipt.employee}: ${calculated.error}`);
    const prepared = await emitNominaCfdi(calculated.stampInput, { preview: true });
    if (!prepared.ok || !prepared.preview) throw new Error(`${receipt.employee}: ${prepared.error ?? "No se pudo preparar el recibo."}`);
    if (typeof prepared.netoAPagar !== "number" || !Number.isFinite(prepared.netoAPagar)) throw new Error("No se pudo verificar el importe del recibo.");
    amountToStamp += prepared.netoAPagar;
    hashes[receipt.id] = prepared.preview.hash;
    payloads.push({ id: receipt.id, payload: prepared.preview.payload });
  }
  const current = await readDocument(ref);
  if (current.updatedAt !== view.updatedAt || !current.stampable || documentFingerprint(current.receipts) !== documentFingerprint(view.receipts)) throw new Error("La nómina cambió durante la revisión. Vuelve a abrirla.");
  return { view, fingerprint: documentFingerprint({ ref, company, period: view.period, paymentDate: view.paymentDate, receipts: view.receipts, hashes }), payloads, hashes, draft: null, amountToStamp: Math.round(amountToStamp * 100) / 100 };
}

export async function reviewDocument(ref: DocumentRef, userId: string, conversationId: string): Promise<StampReview> {
  const state = await documentStampState(ref);
  return { view: state.view, payloads: state.payloads, amountToStamp: state.amountToStamp, token: signReview({ ref, userId, conversationId, fingerprint: state.fingerprint }) };
}

type Outcome = { ok: boolean; message: string; documents: DocumentRef[] };

/** Authenticated HUMAN endpoint only. This is deliberately not an agent tool
 * or a reversible PendingAction. One durable receipt per reviewed version. */
export async function confirmDocumentStamp(ref: DocumentRef, token: string, userId: string, conversationId: string, req: Request): Promise<Outcome> {
  const claims = verifyReview(token, ref, userId, conversationId);
  const key = documentFingerprint(["mochi-human-stamp-v1", ref.companyId, ref.kind, ref.id, claims.fingerprint]);
  const prior = await prisma.stagedAction.findUnique({ where: { tokenHash: key } });
  if (prior) {
    if (prior.status === "DONE" || prior.status === "FAILED") return (prior.payload as { outcome: Outcome }).outcome;
    throw new Error("El timbrado ya está en curso o requiere verificar su resultado. Recupera el documento antes de reintentar.");
  }
  const state = await documentStampState(ref);
  if (state.fingerprint !== claims.fingerprint) throw new Error("El documento cambió después de revisarlo. No se timbró. Revisa la versión actual.");
  let action;
  try {
    action = await prisma.stagedAction.create({ data: { tokenHash: key, type: "mochi_human_stamp", companyId: ref.companyId, createdByUserId: userId, confirmedByUserId: userId, confirmedAt: new Date(), summary: state.view.title, payload: { ref, conversationId, fingerprint: state.fingerprint }, status: "EXECUTING", expiresAt: new Date(claims.expiresAt) } });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw new Error("El documento ya tiene un timbrado en curso. No se repitió la emisión.");
    throw e;
  }
  let outcome: Outcome;
  try {
    if (state.draft) {
      const result = await timbrarPrefactura(state.draft, { id: userId }, req);
      const body = result.body as { ok?: boolean; invoiceId?: string; uuid?: string; error?: string };
      outcome = body.ok && body.invoiceId
        ? { ok: true, message: `CFDI timbrado: ${body.uuid ?? body.invoiceId}. Archivos disponibles en esta tarjeta.`, documents: [{ kind: "factura", companyId: ref.companyId, id: body.invoiceId }] }
        : { ok: false, message: body.error ?? "No se pudo verificar el timbrado. Consulta el estado antes de reintentar.", documents: [ref] };
    } else {
      const result = await stampPayrollRun(ref.id!, { reviewedPayloads: state.hashes });
      outcome = { ok: result.ok, message: `${result.stamped} de ${result.total} recibos timbrados.${result.errors.length ? ` ${result.errors.join("; ")}` : " Archivos disponibles en esta tarjeta."}`, documents: [ref] };
    }
  } catch {
    outcome = { ok: false, message: "No se pudo verificar el resultado del timbrado. Revisa los documentos del PAC/SAT antes de solicitar otra emisión.", documents: [ref] };
  }
  // Store the fiscal outcome and its chat handoff atomically. If persistence
  // fails, EXECUTING survives and blocks automatic replay of the provider call.
  await prisma.$transaction(async (tx) => {
    await tx.stagedAction.update({ where: { id: action.id }, data: { status: outcome.ok ? "DONE" : "FAILED", payload: json({ ref, conversationId, fingerprint: state.fingerprint, outcome }), error: outcome.ok ? null : outcome.message } });
    await tx.chatMessage.create({ data: { conversationId, role: "assistant", content: outcome.message, cards: json([{ type: "documentos", documents: outcome.documents }]), meta: { source: "human_document_confirmation", actionId: action.id } } });
  });
  registrarBitacora({ companyId: ref.companyId, userId, accion: "ai.documento.timbrado_confirmado", entidad: ref.kind === "prefactura" ? "FacturaBorrador" : "PayrollRun", entidadId: ref.id, detalle: { actionId: action.id, ok: outcome.ok, conversationId }, req });
  return outcome;
}
