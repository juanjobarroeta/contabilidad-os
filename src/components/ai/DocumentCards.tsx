"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import * as Dialog from "@radix-ui/react-dialog";
import { FileText, Loader2, X, Download } from "lucide-react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { descargarBlob } from "@/lib/descargar";
import { documentTitles, type DocumentRef, type DocumentView, type StampReview } from "@/lib/ai/documents/contract";

const Balanza = dynamic(() => import("@/components/contabilidad/BalanzaPanel").then((m) => m.BalanzaPanel));
const Polizas = dynamic(() => import("@/components/contabilidad/LibroPanels").then((m) => m.LibroDiarioPanel));
const Catalogo = dynamic(() => import("@/components/contabilidad/CatalogoPanel").then((m) => m.CatalogoPanel));
const Iva = dynamic(() => import("@/components/papeles/panels").then((m) => m.IvaPanel));
const Isr = dynamic(() => import("@/components/papeles/panels").then((m) => m.IsrPanel));
const Retenciones = dynamic(() => import("@/components/papeles/panels").then((m) => m.RetencionesPanel));
const Representacion = dynamic(() => import("@/components/facturas/RepresentacionImpresa").then((m) => m.RepresentacionImpresa));
const money = (n: number, currency = "MXN") => {
  try { return n.toLocaleString("es-MX", { style: "currency", currency }); }
  catch { return `${n.toLocaleString("es-MX")} ${currency}`; }
};
const button = "inline-flex min-h-10 items-center justify-center gap-2 rounded-control border border-cos-line px-3 py-2 text-sm font-medium text-cos-ink hover:bg-cos-paper disabled:opacity-50";

export function DocumentCards({ documents, conversationId }: { documents: DocumentRef[]; conversationId?: string | null }) {
  return <div className="grid min-w-0 gap-2">{documents.map((ref) => <DocumentEntry key={JSON.stringify(ref)} reference={ref} conversationId={conversationId} />)}</div>;
}

function DocumentEntry({ reference, conversationId }: { reference: DocumentRef; conversationId?: string | null }) {
  const { activeCompany } = useCompany();
  const [ref, setRef] = useState(reference);
  const [view, setView] = useState<DocumentView | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<StampReview | null>(null);
  const [approved, setApproved] = useState(false);
  const [outcome, setOutcome] = useState("");
  const [representation, setRepresentation] = useState<{ invoiceId?: string; previewUrl?: string } | null>(null);
  const sameCompany = activeCompany?.id === reference.companyId;

  const load = useCallback(async (signal?: AbortSignal, target = ref) => {
    const params = new URLSearchParams(Object.entries(target).map(([k, v]) => [k, String(v)]));
    if (conversationId) params.set("conversationId", conversationId);
    const res = await fetch(`/api/ai/documentos?${params}`, { signal, cache: "no-store" });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? "No se pudo recuperar el documento.");
    if (!signal?.aborted) { setView(body.document); setError(""); }
    return body.document as DocumentView;
  }, [ref, conversationId]);

  useEffect(() => {
    if (!sameCompany) { setOpen(false); setReview(null); setRepresentation(null); return; }
    const abort = new AbortController();
    void load(abort.signal).catch((e) => { if (!abort.signal.aborted) setError(e.message); });
    return () => abort.abort();
  }, [sameCompany, load]);

  async function post(action: "review" | "stamp") {
    if (!conversationId || !sameCompany) return;
    setBusy(true); setError("");
    try {
      const res = await fetch("/api/ai/documentos", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ref, conversationId, action, ...(action === "stamp" ? { token: review?.token } : {}) }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "No se pudo verificar el documento.");
      if (action === "review") { setReview(body); setView(body.view); setApproved(false); }
      else {
        setOutcome(body.message); setReview(null); setApproved(false);
        const target = body.documents?.[0] ?? ref;
        setRef(target); await load(undefined, target);
        window.dispatchEvent(new CustomEvent("cos:data-changed", { detail: { companyId: ref.companyId } }));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo completar la operación.");
      if (action === "stamp") { setReview(null); setApproved(false); void load().catch(() => {}); }
    } finally { setBusy(false); }
  }

  async function download(href: string, label: string) {
    setBusy(true); setError("");
    try {
      const res = await fetch(href);
      if (!res.ok) { const body = await res.json().catch(() => ({})); throw new Error(body.error ?? "Archivo no disponible."); }
      const fileName = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? `${view?.title ?? "Documento"}-${label}`;
      await descargarBlob(await res.blob(), fileName);
    } catch (e) { setError(e instanceof Error ? e.message : "No se pudo descargar."); }
    finally { setBusy(false); }
  }

  if (!sameCompany) return <div className="rounded-card border border-cos-line p-3 text-xs text-cos-ink-soft">Documento de otra empresa. Selecciona su empresa para abrirlo.</div>;
  const reportProps = { companyId: ref.companyId, year: ref.year!, month: ref.month! };
  return <div className="rounded-card border border-cos-line bg-cos-card p-3 text-cos-ink" data-testid="document-card">
    <div className="flex items-start gap-2"><FileText className="mt-0.5 h-4 w-4 shrink-0 text-cos-brand" /><div className="min-w-0">
      <p className="text-sm font-semibold">{view?.title ?? documentTitles[ref.kind]}</p>
      {view && <><p className="mt-1 break-words text-xs text-cos-ink-soft">{view.company.razonSocial} · {view.company.rfc}</p><p className="mt-1 text-xs">{view.period ? `${view.period} · ` : ""}{view.status}</p>{view.recipient && <p className="mt-1 break-words text-xs text-cos-ink-soft">{view.recipient}</p>}{view.total != null && <p className="mt-2 font-mono text-base font-semibold">{money(view.total, view.currency)}</p>}</>}
    </div></div>
    {error && !open && <p role="alert" className="mt-2 text-xs text-cos-red-ink">{error}</p>}
    <Dialog.Root open={open} onOpenChange={(v) => { if (!busy) { setOpen(v); setReview(null); setApproved(false); setRepresentation(null); } }}>
      <Dialog.Trigger asChild><button className={`${button} mt-3 w-full`} disabled={!view} onClick={() => { void load().catch((e) => setError(e.message)); }}>Ver documento</button></Dialog.Trigger>
      {!view && <button className={`${button} mt-2 w-full`} onClick={() => void load().catch((e) => setError(e.message))}>Volver a consultar</button>}
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[100] bg-black/50" />
        <Dialog.Content data-mochi-document-dialog className="fixed inset-0 z-[101] flex flex-col bg-cos-card text-cos-ink sm:inset-5 sm:mx-auto sm:max-w-6xl sm:rounded-card" onInteractOutside={(e) => { if (busy) e.preventDefault(); }} onEscapeKeyDown={(e) => { if (busy) e.preventDefault(); }}>
          <div className="flex items-start justify-between gap-4 border-b border-cos-line px-4 py-3 sm:px-6">
            <div><Dialog.Title className="text-lg font-semibold">{view?.title}</Dialog.Title><Dialog.Description className="mt-1 text-xs text-cos-ink-soft">{view?.company.razonSocial} · {view?.company.rfc}{view?.period ? ` · ${view.period}` : ""}</Dialog.Description></div>
            <Dialog.Close asChild><button className={button} disabled={busy} aria-label="Cerrar documento"><X className="h-4 w-4" /></button></Dialog.Close>
          </div>
          {view && <div className="min-h-0 flex-1 overflow-auto p-4 sm:p-6">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 text-sm"><div><p className="font-medium">{view.status}{view.total != null ? ` · ${money(view.total, view.currency)}` : ""}</p><p className="text-xs text-cos-ink-soft">{view.source}</p>{view.paymentDate && <p>Fecha de pago: {view.paymentDate}</p>}{view.recipient && <p>{view.recipient}</p>}{view.uuid && <p className="mt-1 break-all font-mono text-xs">UUID: {view.uuid}</p>}</div>
              <div className="flex flex-wrap gap-2">{view.downloads.map((f) => <button key={f.href} className={button} disabled={busy} onClick={() => void download(f.href, f.label)}><Download className="h-4 w-4" />{f.label}</button>)}</div>
            </div>
            {error && <p role="alert" className="mb-4 rounded-control bg-cos-red-tint p-3 text-sm text-cos-red-ink">{error}</p>}
            {outcome && <p role="status" className="mb-4 rounded-control bg-cos-slate-tint p-3 text-sm">{outcome}</p>}
            {ref.kind === "balanza" && <Balanza {...reportProps} />}
            {ref.kind === "polizas" && <Polizas {...reportProps} />}
            {ref.kind === "catalogo" && <Catalogo companyId={ref.companyId} />}
            {ref.kind === "iva" && <Iva {...reportProps} />}
            {ref.kind === "isr" && <Isr {...reportProps} />}
            {ref.kind === "retenciones" && <Retenciones {...reportProps} />}
            {view.draftPayload && !review && <InvoiceDraftFields payload={view.draftPayload} />}
            {view.invoiceId && <button className={button} onClick={() => setRepresentation({ invoiceId: view.invoiceId })}>Ver representación impresa</button>}
            {view.previewUrl && ref.kind === "recibo_nomina" && <button className={button} onClick={() => setRepresentation({ previewUrl: view.previewUrl })}>Ver recibo borrador</button>}
            {view.receipts && <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b border-cos-line"><th className="p-2">Empleado / RFC</th><th className="p-2">Percepciones</th><th className="p-2">Deducciones</th><th className="p-2">Neto</th><th className="p-2">Recibo</th></tr></thead><tbody>{view.receipts.map((r) => <tr key={r.id} className="border-b border-cos-line-soft"><td className="p-2">{r.employee}<div className="text-xs text-cos-ink-soft">{r.rfc}</div></td><td className="p-2 whitespace-nowrap">{money(r.perceptions)}</td><td className="p-2 whitespace-nowrap">{money(r.deductions)}</td><td className="p-2 whitespace-nowrap">{money(r.net)}</td><td className="p-2"><ReceiptButton reference={{ kind: "recibo_nomina", companyId: ref.companyId, id: r.id }} onOpen={setRepresentation} onError={setError} /></td></tr>)}</tbody></table></div>}
            {review && <section className="mt-6 rounded-card border border-cos-brand/30 p-4"><h3 className="font-semibold">Documentos que se van a timbrar</h3><p className="mt-1 text-sm text-cos-ink-soft">Revisa receptor, conceptos, fechas, importes e impuestos. La confirmación corresponde a esta versión.</p>{review.payloads.map((p, i) => <details key={p.id} open={review.payloads.length === 1} className="mt-3 rounded-control border border-cos-line p-3"><summary className="cursor-pointer font-medium">{review.view.receipts?.find((r) => r.id === p.id)?.employee ?? `Documento ${i + 1}`}</summary>{ref.kind === "prefactura" ? <InvoiceDraftFields payload={p.payload} /> : <FiscalFields value={p.payload} />}</details>)}<p className="mt-4 font-semibold">{ref.kind === "prefactura" ? "Total estimado" : "Neto de los recibos por timbrar"}: {money(review.amountToStamp)}</p><label className="mt-4 flex items-start gap-3 text-sm"><input className="mt-1 h-4 w-4" type="checkbox" checked={approved} onChange={(e) => setApproved(e.target.checked)} disabled={busy} />He revisado estos {review.payloads.length} documento(s) y autorizo su timbrado para {view.company.razonSocial}.</label><div className="mt-4 flex flex-wrap gap-2"><button className={`${button} bg-cos-brand text-white hover:bg-cos-brand/90`} disabled={!approved || busy} onClick={() => void post("stamp")}>{busy && <Loader2 className="h-4 w-4 animate-spin" />}Confirmar y timbrar</button><button className={button} disabled={busy} onClick={() => { setReview(null); setApproved(false); }}>Seguir revisando</button></div></section>}
            {!review && view.stampable && conversationId && <button className={`${button} mt-5`} disabled={busy} onClick={() => void post("review")}>{busy && <Loader2 className="h-4 w-4 animate-spin" />}Revisar para timbrar</button>}
            {representation && <Representacion {...representation} onClose={() => setRepresentation(null)} />}
          </div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </div>;
}

function ReceiptButton({ reference, onOpen, onError }: { reference: DocumentRef; onOpen: (v: { invoiceId?: string; previewUrl?: string }) => void; onError: (v: string) => void }) {
  return <button className={button} onClick={async () => {
    try {
      const params = new URLSearchParams({ kind: reference.kind, companyId: reference.companyId, id: reference.id! });
      const res = await fetch(`/api/ai/documentos?${params}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      const d = body.document as DocumentView;
      if (!d.invoiceId && !d.previewUrl) throw new Error("El recibo está timbrado, pero su archivo todavía no está disponible.");
      onOpen({ invoiceId: d.invoiceId, previewUrl: d.previewUrl });
    } catch (e) { onError(e instanceof Error ? e.message : "No se pudo recuperar el recibo."); }
  }}>Ver recibo</button>;
}

const labels: Record<string, string> = { reviewIdentity: "Datos fiscales del borrador", rfc: "RFC", razonSocial: "Razón social", codigoPostal: "Código postal", regimenFiscal: "Régimen fiscal", global: "Información global", periodicity: "Periodicidad", months: "Meses", year: "Ejercicio", relations: "CFDI relacionados", relationship: "Tipo de relación", documents: "UUID relacionados", emisor: "Emisor", receptor: "Receptor", items: "Conceptos", quantity: "Cantidad", product: "Concepto", price: "Precio unitario", description: "Descripción", product_key: "Clave de producto SAT", unit_key: "Clave de unidad SAT", tax_included: "Precio incluye impuestos", taxes: "Impuestos", rate: "Tasa", withholding: "Retención", type: "Tipo", factor: "Factor", customer: "Receptor", legal_name: "Razón social", tax_id: "RFC", tax_system: "Régimen fiscal", address: "Domicilio fiscal", zip: "Código postal", country: "País", formaPago: "Forma de pago", metodoPago: "Método de pago", usoCfdi: "Uso del CFDI", payment_form: "Forma de pago", payment_method: "Método de pago", use: "Uso del CFDI", notes: "Observaciones", complements: "Complementos", data: "Datos del complemento", id: "Identificador", companyId: "Empresa", customerId: "Cliente" };
/** Complete server-provided fiscal fields: no truncated concepts or LLM totals.
 * SAT attribute names remain recognizable in the expanded payroll breakdown. */
function FiscalFields({ value }: { value: unknown }) {
  if (value == null) return <span>—</span>;
  if (Array.isArray(value)) return <ol className="my-2 grid gap-3">{value.map((v, i) => <li className="rounded-control border border-cos-line-soft p-3" key={i}><FiscalFields value={v} /></li>)}</ol>;
  if (typeof value === "object") return <dl className="mt-2 grid gap-2 text-sm">{Object.entries(value).filter(([key]) => !["companyId", "customerId", "id"].includes(key)).map(([key, v]) => <div key={key} className={v !== null && typeof v === "object" ? "min-w-0 rounded-control border border-cos-line-soft p-3" : "grid min-w-0 grid-cols-2 gap-3 border-b border-cos-line-soft py-1"}><dt className="font-medium text-cos-ink-soft">{labels[key] ?? key.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2")}</dt><dd className="mt-0.5 break-words"><FiscalFields value={key === "rate" && typeof v === "number" ? `${v * 100}%` : v} /></dd></div>)}</dl>;
  return <span>{typeof value === "boolean" ? value ? "Sí" : "No" : String(value)}</span>;
}

function InvoiceDraftFields({ payload }: { payload: Record<string, unknown> }) {
  const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
  const identity = object(payload.reviewIdentity);
  const items = Array.isArray(payload.items) ? payload.items : [];
  return <div className="space-y-4 text-sm">
    <div className="grid gap-3 sm:grid-cols-2">{["emisor", "receptor"].map((key) => {
      const party = object(identity[key]);
      return <section key={key} className="rounded-control bg-cos-paper p-3"><h4 className="mb-1 text-xs font-semibold uppercase text-cos-ink-soft">{labels[key]}</h4><p className="font-semibold">{String(party.razonSocial ?? "—")}</p><p>{String(party.rfc ?? "—")}</p><p className="mt-1 text-xs">Régimen {String(party.regimenFiscal ?? "—")} · CP {String(party.codigoPostal ?? "—")}</p></section>;
    })}</div>
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">{[["Método de pago", payload.metodoPago], ["Forma de pago", payload.formaPago], ["Uso CFDI", payload.usoCfdi], ["Moneda", "MXN"]].map(([key, value]) => <div key={String(key)}><dt className="text-xs text-cos-ink-soft">{String(key)}</dt><dd className="font-medium">{String(value ?? "—")}</dd></div>)}</dl>
    <h4 className="font-semibold">Conceptos</h4>
    {items.map((raw, i) => {
      const item = object(raw), product = object(item.product);
      const taxes = Array.isArray(product.taxes) ? product.taxes : [];
      const locals = Array.isArray(product.local_taxes) ? product.local_taxes : [];
      return <section className="rounded-control border border-cos-line p-3" key={i}><div className="flex flex-wrap justify-between gap-3"><div><p className="font-medium">{String(product.description ?? "—")}</p><p className="mt-1 text-xs text-cos-ink-soft">Clave SAT {String(product.product_key ?? "—")} · Unidad {String(product.unit_key ?? "—")}{product.sku ? ` · Folio ${String(product.sku)}` : ""}</p></div><p className="font-mono">{String(item.quantity)} × {money(Number(product.price))}</p></div>
      <p className="mt-2 text-xs text-cos-ink-soft">{product.tax_included ? "Precio con impuestos incluidos" : "Precio antes de impuestos"}</p>
      {taxes.map((rawTax, j) => { const tax = object(rawTax); return <p key={j} className="mt-1 text-xs">{tax.withholding ? "Retención" : "Traslado"} {String(tax.type)} · {tax.factor === "Exento" ? "Exento" : `${Number(tax.rate) * 100}%`}</p>; })}
      {!taxes.length && <p className="mt-1 text-xs">Sin impuestos desglosados</p>}
      {!!locals.length && <FiscalFields value={{ "Impuestos locales": locals }} />}</section>;
    })}
    {payload.notes != null && <p className="whitespace-pre-wrap">{String(payload.notes)}</p>}
    {payload.global != null && <FiscalFields value={{ global: payload.global }} />}
    {payload.relations != null && <FiscalFields value={{ relations: payload.relations }} />}
  </div>;
}
