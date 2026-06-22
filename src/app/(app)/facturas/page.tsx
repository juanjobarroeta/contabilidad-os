"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { Search, Plus, Download, X, Info, Loader2, AlertTriangle, ShieldCheck, FileText } from "lucide-react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { Card, Money, Button } from "@/components/ui";
import { esAsimilado, etiquetaRegimenNomina } from "@/lib/nomina/regimen";
import { RepresentacionImpresa } from "@/components/facturas/RepresentacionImpresa";

// ── Types (mirrors /api/facturas) ─────────────────────────────────────────────
interface Invoice {
  id: string;
  companyId: string;
  uuid: string | null;
  fecha: string;
  tipo: "INGRESO" | "EGRESO" | "NOMINA" | "PAGO" | "TRASLADO";
  status: string; // DRAFT | STAMPED | CANCELLED
  subtotal: number;
  total: number;
  totalImpuestos: number;
  notas: string | null;
  facturapiId: string | null;
  naturaleza: "GASTO" | "INVERSION" | "INVENTARIO" | "SIN_EFECTOS" | null;
  naturalezaRevision: boolean;
  regimenNomina: string | null;
  isrRetenidoNomina: number | null;
  customer: { razonSocial: string; rfc: string } | null;
}

const NATURALEZA_META: Record<string, { label: string; hint: string }> = {
  GASTO:       { label: "Gasto",        hint: "Deducible en el periodo (Art. 25/27)" },
  INVERSION:   { label: "Activo fijo",  hint: "Se deduce vía depreciación (Art. 31/34)" },
  INVENTARIO:  { label: "Inventario",   hint: "Se deduce al venderse — costo de lo vendido (Art. 39)" },
  SIN_EFECTOS: { label: "Sin efectos",  hint: "No deducible" },
};
interface Resumen { timbradas: number; totalFacturado: number; ivaCobrado: number }

type FilterKey = "todas" | "ingreso" | "egreso" | "nomina" | "pago" | "cancelada";

// CFDI tipo → plain-language presentation (Contia palette).
const TIPO_META: Record<string, { label: string; plain: string; badge: string }> = {
  ingreso:   { label: "Ingreso",    plain: "Te pagaron",          badge: "bg-cos-jade-tint text-cos-jade-ink" },
  egreso:    { label: "Gasto",      plain: "Pagaste",             badge: "bg-cos-red-tint text-cos-red-ink" },
  nomina:    { label: "Nómina",     plain: "Sueldo",              badge: "bg-cos-brand-tint text-cos-brand-ink" },
  pago:      { label: "Pago (REP)", plain: "Comprobante de pago", badge: "bg-cos-slate-tint text-cos-ink-soft" },
  traslado:  { label: "Traslado",   plain: "Traslado",            badge: "bg-cos-slate-tint text-cos-ink-soft" },
  cancelada: { label: "Cancelada",  plain: "Cancelada",           badge: "bg-cos-red-tint text-cos-red-ink" },
};

/** The filter/badge key for an invoice: cancelled wins, else its tipo. */
function keyOf(inv: Invoice): FilterKey | "traslado" {
  if (inv.status === "CANCELLED") return "cancelada";
  return inv.tipo.toLowerCase() as FilterKey | "traslado";
}
function estadoOf(inv: Invoice): string {
  if (inv.status === "CANCELLED") return "Cancelada";
  if (inv.status === "DRAFT") return "Borrador";
  return inv.tipo === "EGRESO" ? "Recibida" : "Emitida";
}
function fmtFecha(iso: string): string {
  const MES = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, "0")} ${MES[d.getMonth()]} ${d.getFullYear()}`;
}

const LBL = "block text-[12.5px] font-medium uppercase tracking-[0.02em] text-cos-ink-faint";
const FILTERS: { k: FilterKey; t: string }[] = [
  { k: "todas", t: "Todas" },
  { k: "ingreso", t: "Te pagaron" },
  { k: "egreso", t: "Pagaste" },
  { k: "nomina", t: "Nómina" },
  { k: "pago", t: "Pagos" },
  { k: "cancelada", t: "Canceladas" },
];

// ── XML / PDF download (reuses the existing per-invoice endpoint) ─────────────
function DownloadBtn({ id, format }: { id: string; format: "xml" | "pdf" }) {
  const [loading, setLoading] = useState(false);
  async function go() {
    setLoading(true);
    try {
      const res = await fetch(`/api/facturas/${id}/download?format=${format}`);
      if (!res.ok) {
        let msg = "Error al descargar el archivo";
        try { const j = await res.json(); if (j?.error) msg = j.error; } catch { /* keep default */ }
        alert(msg);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `factura.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      alert("Error al descargar el archivo");
    } finally {
      setLoading(false);
    }
  }
  return (
    <Button variant="soft" size="md" onClick={go} disabled={loading} className="flex-1">
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
      {format.toUpperCase()}
    </Button>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function FacturasPage() {
  const { activeCompany } = useCompany();
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [resumen, setResumen] = useState<Resumen | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<FilterKey>("todas");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<Invoice | null>(null);
  const [toast, setToast] = useState("");
  const [checkingCancel, setCheckingCancel] = useState(false);

  const fetchData = useCallback(async () => {
    if (!activeCompany) return;
    setLoading(true);
    try {
      const [list, res] = await Promise.all([
        fetch(`/api/facturas?companyId=${activeCompany.id}&take=200`).then((r) => r.json()),
        fetch(`/api/facturas/resumen?companyId=${activeCompany.id}`).then((r) => r.json()),
      ]);
      setInvoices(Array.isArray(list) ? list : []);
      setResumen(res);
    } finally {
      setLoading(false);
    }
  }, [activeCompany]);

  useEffect(() => { fetchData(); }, [fetchData]);

  function showToast(m: string) {
    setToast(m);
    setTimeout(() => setToast(""), 4500);
  }

  // Pregunta al SAT (metadata) si alguna factura fue cancelada y marca las que sí.
  // Ventana amplia (12 meses) para alcanzar cancelaciones que el cron (3 meses)
  // no revisa. El SAT es asíncrono: puede requerir un segundo intento.
  async function verificarCancelaciones() {
    if (!activeCompany || checkingCancel) return;
    setCheckingCancel(true);
    try {
      const res = await fetch("/api/sat/cancel-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: activeCompany.id }),
      });
      const data = await res.json();
      if (!res.ok) { showToast(data.error ?? "No se pudo verificar cancelaciones"); return; }
      const partes: string[] = [
        data.cancelled > 0 ? `${data.cancelled} cancelada(s) detectada(s)` : "ninguna cancelación nueva",
      ];
      if (data.periodsPending > 0) {
        partes.push(`${data.periodsPending} periodo(s) aún los procesa el SAT — reintenta en unos minutos`);
      }
      showToast(`Revisé ${data.monthsBack} meses: ${partes.join(" · ")}`);
      if (data.cancelled > 0) fetchData();
    } catch {
      showToast("No se pudo verificar cancelaciones");
    } finally {
      setCheckingCancel(false);
    }
  }

  // Counts reflect the loaded set (so chips match the table).
  const counts: Record<FilterKey, number> = {
    todas: invoices.length,
    ingreso: invoices.filter((i) => keyOf(i) === "ingreso").length,
    egreso: invoices.filter((i) => keyOf(i) === "egreso").length,
    nomina: invoices.filter((i) => keyOf(i) === "nomina").length,
    pago: invoices.filter((i) => keyOf(i) === "pago").length,
    cancelada: invoices.filter((i) => keyOf(i) === "cancelada").length,
  };

  let rows = invoices.filter((i) => filter === "todas" || keyOf(i) === filter);
  if (q.trim()) {
    const s = q.toLowerCase();
    rows = rows.filter(
      (i) =>
        (i.customer?.razonSocial ?? "").toLowerCase().includes(s) ||
        (i.customer?.rfc ?? "").toLowerCase().includes(s) ||
        (i.uuid ?? "").toLowerCase().includes(s)
    );
  }

  if (!activeCompany) {
    return <div className="p-8 text-sm text-cos-ink-faint">Selecciona una empresa.</div>;
  }

  return (
    <div className="mx-auto max-w-[1000px] px-4 py-6 sm:px-8 sm:py-8">
      {/* header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[30px] font-semibold leading-[1.05] tracking-[-0.03em] text-cos-ink">Facturas</h1>
          <p className="mt-1.5 max-w-[60ch] text-[15px] text-cos-ink-soft">
            Tus comprobantes fiscales (CFDI) — lo que emites y lo que recibes.
          </p>
        </div>
        <div className="flex gap-2.5">
          <Button variant="soft" size="md" onClick={verificarCancelaciones} disabled={checkingCancel}
            title="Pregunta al SAT si alguna factura fue cancelada (últimos 12 meses)">
            {checkingCancel ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
            {checkingCancel ? "Verificando…" : "Verificar cancelaciones"}
          </Button>
          <a href={`/api/facturas/export?companyId=${activeCompany.id}`}>
            <Button variant="soft" size="md"><Download className="h-4 w-4" /> Excel</Button>
          </a>
          <Link href="/facturas/nueva">
            <Button variant="brand" size="md"><Plus className="h-4 w-4" /> Nueva factura</Button>
          </Link>
        </div>
      </div>

      {/* stat cards */}
      <div className="mt-4 grid grid-cols-1 gap-4 min-[680px]:grid-cols-3">
        <Card className="rounded-card border-cos-line p-5 shadow-card">
          <span className={LBL}>Facturas timbradas</span>
          <div className="my-1 text-[28px] font-semibold tracking-[-0.02em] text-cos-ink">{resumen?.timbradas ?? "—"}</div>
          <span className="text-[12.5px] text-cos-ink-faint">este año</span>
        </Card>
        <Card className="rounded-card border-cos-line p-5 shadow-card">
          <span className={LBL}>Total facturado</span>
          <div className="my-1"><Money value={resumen?.totalFacturado ?? 0} size={24} /></div>
          <span className="text-[12.5px] text-cos-ink-faint">emitido este año</span>
        </Card>
        <Card className="rounded-card border-cos-line p-5 shadow-card">
          <span className={LBL}>IVA cobrado</span>
          <div className="my-1"><Money value={resumen?.ivaCobrado ?? 0} size={24} /></div>
          <span className="text-[12.5px] text-cos-ink-faint">trasladado a clientes</span>
        </Card>
      </div>

      {/* search */}
      <div className="mt-[18px] flex items-center gap-2.5 rounded-control border border-cos-line bg-white px-3.5 text-cos-ink-faint">
        <Search className="h-[18px] w-[18px]" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Buscar por nombre o RFC…"
          className="flex-1 border-0 bg-transparent py-3 text-[14.5px] text-cos-ink outline-none"
        />
      </div>

      {/* filter chips */}
      <div className="mt-3 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.k}
            onClick={() => setFilter(f.k)}
            className={
              "inline-flex items-center gap-1.5 rounded-full border px-3.5 py-2 text-[13.5px] font-medium transition-colors " +
              (filter === f.k
                ? "border-cos-brand bg-cos-brand text-white"
                : "border-cos-line bg-white text-cos-ink-soft hover:border-cos-brand hover:text-cos-brand-ink")
            }
          >
            {f.t} <span className="font-mono text-[12px] opacity-80">{counts[f.k]}</span>
          </button>
        ))}
      </div>

      {/* table */}
      <Card className="mt-3 overflow-hidden rounded-card border-cos-line shadow-card">
        <div className="grid grid-cols-[108px_minmax(0,1fr)_130px] gap-3 border-b border-cos-line px-[18px] py-3.5 text-[12px] font-semibold uppercase tracking-[0.05em] text-cos-ink-faint max-[860px]:grid-cols-[76px_minmax(0,1fr)_auto]">
          <span>Tipo</span>
          <span>Contraparte</span>
          <span className="text-right">Total</span>
        </div>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-cos-ink-faint">
            <Loader2 className="h-4 w-4 animate-spin" /> Cargando…
          </div>
        ) : rows.length === 0 ? (
          <div className="px-10 py-10 text-center text-cos-ink-faint">No hay facturas con ese filtro.</div>
        ) : (
          rows.map((inv) => {
            const k = keyOf(inv);
            const meta = TIPO_META[k];
            const signed = k === "ingreso" || k === "egreso";
            const signVal = k === "egreso" ? -inv.total : inv.total;
            return (
              <button
                key={inv.id}
                onClick={() => setSel(inv)}
                className="grid w-full grid-cols-[108px_minmax(0,1fr)_130px] items-center gap-3 border-t border-cos-line-soft px-[18px] py-3.5 text-left first:border-t-0 hover:bg-cos-paper max-[860px]:grid-cols-[76px_minmax(0,1fr)_auto]"
              >
                <span>
                  <span className={`inline-block rounded-[7px] px-[9px] py-[3px] text-[12px] font-semibold ${meta.badge}`}>
                    {meta.label}
                  </span>
                  {k === "nomina" && esAsimilado(inv.regimenNomina) && (
                    <span className="mt-1 block text-[11px] font-medium text-cos-ink-faint">Asimilados</span>
                  )}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[14.5px] font-medium text-cos-ink">{inv.customer?.razonSocial ?? "—"}</span>
                  <span className="mt-0.5 block truncate font-mono text-[12px] text-cos-ink-faint">{inv.customer?.rfc ?? "—"}</span>
                </span>
                <span className="text-right">
                  {signed ? (
                    <Money value={signVal} sign size={15} />
                  ) : (
                    <Money value={inv.total} size={15} muted />
                  )}
                  <span className="mt-0.5 block text-[12px] text-cos-ink-faint">{fmtFecha(inv.fecha)}</span>
                </span>
              </button>
            );
          })
        )}
      </Card>

      {sel && <FacturaModal inv={sel} onClose={() => setSel(null)} onCancelled={() => { setSel(null); fetchData(); showToast("Factura cancelada"); }} />}

      {toast && (
        <div className="fixed bottom-6 left-1/2 z-[90] -translate-x-1/2 rounded-xl bg-cos-ink px-5 py-3 text-sm font-medium text-white shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}

// ── Naturaleza fiscal (deducibilidad) — badge + override del contador ─────────
function NaturalezaRow({ inv }: { inv: Invoice }) {
  const [valor, setValor] = useState<string>(inv.naturaleza ?? "GASTO");
  const [revision, setRevision] = useState(inv.naturalezaRevision);
  const [saving, setSaving] = useState(false);
  const [activoMsg, setActivoMsg] = useState("");
  const [registrando, setRegistrando] = useState(false);

  async function registrarActivo() {
    setRegistrando(true);
    setActivoMsg("");
    try {
      const res = await fetch("/api/activos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: inv.companyId, invoiceId: inv.id }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      setActivoMsg("✓ Registrado en activo fijo — revisa la tasa y el tope en /activos");
    } catch (e) {
      setActivoMsg(e instanceof Error ? e.message : "Error");
    } finally {
      setRegistrando(false);
    }
  }

  async function save(nuevo: string) {
    const prev = valor;
    setValor(nuevo);
    setSaving(true);
    try {
      const res = await fetch(`/api/facturas/${inv.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ naturaleza: nuevo }),
      });
      if (!res.ok) throw new Error();
      setRevision(false);
    } catch {
      setValor(prev); // revertir si falla
    } finally {
      setSaving(false);
    }
  }

  const meta = NATURALEZA_META[valor];
  return (
    <div className="mt-3 rounded-[10px] border border-cos-line-soft px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12.5px] font-medium uppercase tracking-[0.02em] text-cos-ink-faint">Naturaleza fiscal</span>
        <select
          value={valor}
          disabled={saving}
          onChange={(e) => save(e.target.value)}
          className="rounded-control border border-cos-line bg-white px-2 py-1 text-[13px] focus:outline-none focus:ring-1 focus:ring-cos-brand"
        >
          <option value="GASTO">Gasto</option>
          <option value="INVERSION">Activo fijo</option>
          <option value="INVENTARIO">Inventario</option>
          <option value="SIN_EFECTOS">Sin efectos</option>
        </select>
      </div>
      <p className="mt-1 text-[12px] text-cos-ink-soft">{meta?.hint}</p>
      {revision && (
        <p className="mt-1.5 flex items-start gap-1.5 text-[12px] text-cos-amber-ink">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Clasificación automática por revisar — la clave del producto sugiere que podría ser activo fijo (a depreciar) en vez de gasto inmediato.
        </p>
      )}
      {valor === "INVERSION" && (
        <div className="mt-2">
          <button
            onClick={registrarActivo}
            disabled={registrando}
            className="rounded-control border border-cos-brand px-2.5 py-1 text-[12.5px] font-semibold text-cos-brand-ink hover:bg-cos-brand-tint disabled:opacity-50"
          >
            {registrando ? "Registrando…" : "Registrar como activo fijo"}
          </button>
          {activoMsg && <p className={`mt-1 text-[12px] ${activoMsg.startsWith("✓") ? "text-cos-jade-ink" : "text-cos-red-ink"}`}>{activoMsg}</p>}
        </div>
      )}
    </div>
  );
}

// ── Detail modal (+ Cancelar CFDI, preserved from the old screen) ─────────────
function FacturaModal({ inv, onClose, onCancelled }: { inv: Invoice; onClose: () => void; onCancelled: () => void }) {
  const k = keyOf(inv);
  const meta = TIPO_META[k];
  const [cancelOpen, setCancelOpen] = useState(false);
  const [motivo, setMotivo] = useState("02");
  const [sustituye, setSustituye] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [repOpen, setRepOpen] = useState(false);

  // Only emitted-and-stamped CFDIs we own can be cancelled at the SAT.
  const canCancel = inv.status === "STAMPED" && inv.tipo === "INGRESO" && !!inv.facturapiId;
  const nota = k === "pago" ? "Complemento de pago (REP)" : inv.notas;

  async function doCancel() {
    if (motivo === "01" && !sustituye.trim()) {
      setErr("El motivo 01 requiere el UUID de la factura que sustituye.");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const res = await fetch(`/api/facturas/${inv.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ motivo, ...(motivo === "01" ? { sustituyeUuid: sustituye.trim() } : {}) }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error al cancelar");
      onCancelled();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error al cancelar");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] grid place-items-center bg-[oklch(0.2_0.02_258_/_0.45)] p-[18px]"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[440px] rounded-[18px] bg-white p-6 shadow-[0_30px_60px_-20px_oklch(0.2_0.05_258_/_0.5)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <span className={`inline-block rounded-[7px] px-[9px] py-[3px] text-[12px] font-semibold ${meta.badge}`}>{meta.label}</span>
            <span className="ml-2.5 text-[13px] text-cos-ink-soft">
              {(k === "nomina" && etiquetaRegimenNomina(inv.regimenNomina)) || meta.plain}
            </span>
          </div>
          <button onClick={onClose} className="grid h-9 w-9 place-items-center rounded-control text-cos-ink-soft hover:bg-cos-paper">
            <X className="h-5 w-5" />
          </button>
        </div>

        <h3 className="mt-4 text-[20px] font-semibold leading-tight tracking-[-0.02em] text-cos-ink">
          {inv.customer?.razonSocial ?? "—"}
        </h3>
        <p className="font-mono text-[13px] text-cos-ink-faint">
          {inv.customer?.rfc ?? "—"} · {estadoOf(inv)} · {fmtFecha(inv.fecha)}
        </p>

        {nota && (
          <p className="mt-3 flex items-center gap-1.5 rounded-[10px] bg-cos-amber-tint px-3 py-2.5 text-[13px] text-cos-amber-ink">
            <Info className="h-3.5 w-3.5" /> {nota}
          </p>
        )}

        {inv.tipo === "EGRESO" && <NaturalezaRow inv={inv} />}

        <div className="mt-[18px] border-t border-cos-line-soft">
          <div className="flex justify-between border-b border-cos-line-soft py-2.5 text-[14px] text-cos-ink-soft">
            <span>Subtotal</span><Money value={inv.subtotal} size={15} weight={500} />
          </div>
          <div className="flex justify-between border-b border-cos-line-soft py-2.5 text-[14px] text-cos-ink-soft">
            <span>IVA / impuestos</span><Money value={inv.totalImpuestos} size={15} weight={500} />
          </div>
          <div className="flex justify-between py-2.5 text-[14px] font-semibold text-cos-ink">
            <span>Total</span><Money value={inv.total} size={18} weight={700} />
          </div>
        </div>

        <button
          onClick={() => setRepOpen(true)}
          className="mt-[18px] flex w-full items-center justify-center gap-2 rounded-control bg-cos-brand px-4 py-2.5 text-[13.5px] font-semibold text-white hover:bg-cos-brand-deep"
        >
          <FileText className="h-4 w-4" /> Ver representación impresa
        </button>

        <div className="mt-2.5 flex gap-2.5">
          <DownloadBtn id={inv.id} format="xml" />
          <DownloadBtn id={inv.id} format="pdf" />
        </div>

        {repOpen && <RepresentacionImpresa invoiceId={inv.id} onClose={() => setRepOpen(false)} />}

        {canCancel && !cancelOpen && (
          <button
            onClick={() => setCancelOpen(true)}
            className="mt-3 w-full rounded-control py-2 text-[13px] font-medium text-cos-red-ink hover:bg-cos-red-tint"
          >
            Cancelar factura
          </button>
        )}

        {cancelOpen && (
          <div className="mt-3 rounded-[12px] border border-cos-line bg-cos-paper p-3.5">
            <p className="text-[13px] font-medium text-cos-ink">Cancelar ante el SAT</p>
            {err && (
              <p className="mt-2 flex items-center gap-1.5 text-[12.5px] text-cos-red-ink">
                <AlertTriangle className="h-3.5 w-3.5" /> {err}
              </p>
            )}
            <label className="mt-2.5 block text-[12.5px] text-cos-ink-soft">
              Motivo
              <select
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                className="mt-1 w-full rounded-control border border-cos-line bg-white px-2.5 py-2 text-[13.5px] text-cos-ink outline-none"
              >
                <option value="02">02 — Comprobante con errores sin relación</option>
                <option value="01">01 — Comprobante con errores con relación</option>
                <option value="03">03 — No se llevó a cabo la operación</option>
                <option value="04">04 — Operación nominativa en factura global</option>
              </select>
            </label>
            {motivo === "01" && (
              <input
                value={sustituye}
                onChange={(e) => setSustituye(e.target.value)}
                placeholder="UUID que la sustituye"
                className="mt-2 w-full rounded-control border border-cos-line bg-white px-2.5 py-2 font-mono text-[12.5px] text-cos-ink outline-none"
              />
            )}
            <div className="mt-3 flex gap-2.5">
              <Button variant="soft" size="md" className="flex-1" onClick={() => setCancelOpen(false)} disabled={busy}>
                Volver
              </Button>
              <Button variant="destructive" size="md" className="flex-1" onClick={doCancel} loading={busy}>
                Confirmar cancelación
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
