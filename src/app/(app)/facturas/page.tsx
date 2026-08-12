"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { Search, Plus, Download, X, Info, Loader2, AlertTriangle, ShieldCheck, FileText, Copy } from "lucide-react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { Card, Money, Button } from "@/components/ui";
import { esAsimilado, etiquetaRegimenNomina } from "@/lib/nomina/regimen";
import { RepresentacionImpresa } from "@/components/facturas/RepresentacionImpresa";
import {
  PERIODO_TODO,
  etiquetaPeriodo,
  rangoPeriodo,
  type ConteoPeriodo,
} from "@/lib/facturas/periodos";
import { SelectorPeriodo } from "@/components/facturas/SelectorPeriodo";
import { ManifiestoBanner } from "@/components/facturas/ManifiestoBanner";
import { ComplementosPendientes } from "@/components/facturas/ComplementosPendientes";

// ── Types (mirrors /api/facturas) ─────────────────────────────────────────────
interface Invoice {
  id: string;
  companyId: string;
  uuid: string | null;
  fecha: string;
  tipo: "INGRESO" | "EGRESO" | "NOMINA" | "PAGO" | "TRASLADO";
  metodoPago?: string; // "PUE" | "PPD"
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
  // Contraparte del propio comprobante — el respaldo cuando no hay Customer
  // (público en general XAXX010101000 y extranjeros XEXX010101000).
  contraparteNombre?: string | null;
  contraparteRfc?: string | null;
  // REP (tipo PAGO): montos reales del complemento (el comprobante trae 0).
  pagoMonto?: number | null;
  pagoIva?: number | null;
  pagoFecha?: string | null;
}

const NATURALEZA_META: Record<string, { label: string; hint: string }> = {
  GASTO:       { label: "Gasto",        hint: "Deducible en el periodo (Art. 25/27)" },
  INVERSION:   { label: "Activo fijo",  hint: "Se deduce vía depreciación (Art. 31/34)" },
  INVENTARIO:  { label: "Inventario",   hint: "Se deduce al venderse — costo de lo vendido (Art. 39)" },
  SIN_EFECTOS: { label: "Sin efectos",  hint: "No deducible" },
};
interface Resumen {
  timbradas: number;
  totalFacturado: number;
  ivaCobrado: number;
  periodos?: ConteoPeriodo[];
  /** Conteos exactos del periodo (servidor), no de las filas cargadas. */
  conteos?: Record<FilterKey, number>;
}

/** Filas por página. La lista se pagina: antes se cargaban 200 y punto, así que
 *  en una empresa con volumen los CFDIs viejos no existían para el usuario. */
const TAKE = 200;

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
function DownloadBtn({ id, format, onUnavailable }: { id: string; format: "xml" | "pdf"; onUnavailable?: () => void }) {
  const [loading, setLoading] = useState(false);
  async function go() {
    setLoading(true);
    try {
      const res = await fetch(`/api/facturas/${id}/download?format=${format}`);
      if (!res.ok) {
        // Los CFDIs importados del SAT no tienen PDF del PAC. En vez de un error,
        // abrimos la representación impresa (que se genera del XML y se imprime).
        if (format === "pdf" && onUnavailable) { onUnavailable(); return; }
        let msg = "Error al descargar el archivo";
        try { const j = await res.json(); if (j?.error) msg = j.error; } catch { /* keep default */ }
        alert(msg);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      // Nombre del servidor (UUID completo, via Content-Disposition) — el
      // hardcode "factura.xml" de antes pisaba el folio fiscal.
      const cd = res.headers.get("content-disposition") ?? "";
      const m = /filename="?([^";]+)"?/i.exec(cd);
      a.download = m?.[1] ?? `factura.${format}`;
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

/** Prefactura pendiente (GET /api/facturas/borradores). */
interface Prefactura {
  id: string;
  cliente: string;
  rfc: string;
  emailCliente: string | null;
  total: number;
  enviadaAt: string | null;
  createdAt: string;
  pdfUrl: string;
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function FacturasPage() {
  const { activeCompany } = useCompany();
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [resumen, setResumen] = useState<Resumen | null>(null);
  const [prefacturas, setPrefacturas] = useState<Prefactura[]>([]);
  const [prefBusy, setPrefBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<FilterKey>("todas");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<Invoice | null>(null);
  const [toast, setToast] = useState("");
  const [checkingCancel, setCheckingCancel] = useState(false);
  // Periodo elegido en el selector ("todo" | "YYYY" | "YYYY-MM") + los meses
  // que tienen comprobantes (los da /api/facturas/resumen).
  const [periodo, setPeriodo] = useState<string>(PERIODO_TODO);
  const [periodos, setPeriodos] = useState<ConteoPeriodo[]>([]);
  const [hayMas, setHayMas] = useState(false);
  const [cargandoMas, setCargandoMas] = useState(false);

  // La búsqueda va al SERVIDOR (antes filtraba sólo sobre lo ya cargado, así que
  // no encontraba nada fuera de las últimas 200 filas). Debounce para no
  // disparar una consulta por tecla.
  const [qBuscado, setQBuscado] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQBuscado(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  // Al cambiar de empresa el periodo elegido ya no aplica.
  useEffect(() => { setPeriodo(PERIODO_TODO); }, [activeCompany?.id]);

  /** Query de la lista para una página, con la ventana del periodo y la búsqueda. */
  const listaUrl = useCallback(
    (skip: number) => {
      const p = new URLSearchParams({ companyId: activeCompany!.id, take: String(TAKE), skip: String(skip) });
      const r = rangoPeriodo(periodo);
      if (r) {
        p.set("from", r.from.toISOString());
        p.set("to", r.to.toISOString());
      }
      if (qBuscado) p.set("q", qBuscado);
      // El filtro va al SERVIDOR: antes se aplicaba sobre las filas ya
      // cargadas, así que "Canceladas" (238 en la empresa) mostraba "no hay
      // facturas" cuando ninguna caía en las primeras páginas.
      if (filter !== "todas") p.set("tipo", filter === "cancelada" ? "CANCELLED" : filter.toUpperCase());
      return `/api/facturas?${p.toString()}`;
    },
    [activeCompany, periodo, qBuscado, filter]
  );

  const fetchData = useCallback(async () => {
    if (!activeCompany) return;
    setLoading(true);
    try {
      const [list, res, prefs] = await Promise.all([
        fetch(listaUrl(0)).then((r) => r.json()),
        fetch(`/api/facturas/resumen?companyId=${activeCompany.id}&periodo=${encodeURIComponent(periodo)}`).then((r) => r.json()),
        fetch(`/api/facturas/borradores?companyId=${activeCompany.id}`).then((r) => r.json()).catch(() => []),
      ]);
      const filas: Invoice[] = Array.isArray(list) ? list : [];
      setInvoices(filas);
      setHayMas(filas.length === TAKE);
      setResumen(res);
      setPeriodos(Array.isArray(res?.periodos) ? res.periodos : []);
      setPrefacturas(Array.isArray(prefs) ? prefs : []);
    } finally {
      setLoading(false);
    }
  }, [activeCompany, listaUrl, periodo]);

  useEffect(() => { fetchData(); }, [fetchData]);

  /** Siguiente página (se agrega al final; el orden del servidor es fecha desc). */
  async function cargarMas() {
    if (!activeCompany || cargandoMas) return;
    setCargandoMas(true);
    try {
      const res = await fetch(listaUrl(invoices.length));
      const filas: Invoice[] = await res.json();
      const nuevas = Array.isArray(filas) ? filas : [];
      setInvoices((prev) => [...prev, ...nuevas]);
      setHayMas(nuevas.length === TAKE);
    } catch {
      showToast("No se pudieron cargar más facturas");
    } finally {
      setCargandoMas(false);
    }
  }

  // Deep-link ?q= — p. ej. el expediente del empleado enlaza el CFDI del
  // recibo por UUID (/facturas?q=<uuid>). Se lee directo de la URL para no
  // forzar un limite de Suspense (useSearchParams).
  useEffect(() => {
    const initial = new URLSearchParams(window.location.search).get("q");
    if (initial) setQ(initial);
  }, []);

  function showToast(m: string) {
    setToast(m);
    setTimeout(() => setToast(""), 4500);
  }

  // ── Acciones sobre prefacturas ──
  async function prefAccion(p: Prefactura, accion: "timbrar" | "enviar" | "descartar") {
    if (accion === "timbrar" && !confirm(`¿Timbrar la prefactura de ${p.cliente} por ${new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(p.total)}? Se emite un CFDI real ante el SAT.`)) return;
    if (accion === "descartar" && !confirm(`¿Descartar la prefactura de ${p.cliente}?`)) return;
    let email: string | undefined;
    if (accion === "enviar") {
      const cap = prompt("Correo del cliente:", p.emailCliente ?? "");
      if (cap === null) return;
      email = cap.trim() || undefined;
    }
    setPrefBusy(p.id);
    try {
      const res = await fetch(`/api/facturas/borradores/${p.id}`, {
        method: accion === "descartar" ? "DELETE" : "POST",
        headers: { "Content-Type": "application/json" },
        ...(accion !== "descartar" ? { body: JSON.stringify({ accion, ...(email ? { email } : {}) }) } : {}),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) { showToast(data?.error ?? "Error"); return; }
      showToast(
        accion === "timbrar" ? `✓ Prefactura timbrada (${data.uuid?.slice(-8) ?? "CFDI emitido"})`
        : accion === "enviar" ? `✓ Prefactura enviada a ${data.email}`
        : "✓ Prefactura descartada"
      );
      fetchData();
    } finally {
      setPrefBusy(null);
    }
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

  // Conteos del PERIODO completo (servidor). Calcularlos sobre las filas
  // cargadas mentía en cuanto había más de una página: con 177k comprobantes y
  // 200 cargados, "Canceladas 0" significaba "ninguna en las primeras 200",
  // no "ninguna en la empresa". Sin resumen (o buscando, donde el servidor ya
  // filtró), se cae al conteo local para que los chips sigan a la tabla.
  const counts: Record<FilterKey, number> =
    resumen?.conteos
      ? resumen.conteos
      : {
          todas: invoices.length,
          ingreso: invoices.filter((i) => keyOf(i) === "ingreso").length,
          egreso: invoices.filter((i) => keyOf(i) === "egreso").length,
          nomina: invoices.filter((i) => keyOf(i) === "nomina").length,
          pago: invoices.filter((i) => keyOf(i) === "pago").length,
          cancelada: invoices.filter((i) => keyOf(i) === "cancelada").length,
        };

  // Búsqueda Y filtro los resuelve el servidor sobre TODO el historial, así que
  // la tabla muestra tal cual lo que llegó (paginado incluido).
  const rows = invoices;

  // Sublabel de las tarjetas: siguen la ventana elegida, no el año fijo.
  const subPeriodo =
    periodo === PERIODO_TODO
      ? "en todo el historial"
      : /^\d{4}$/.test(periodo)
      ? `en ${periodo}`
      : `en ${etiquetaPeriodo(periodo)}`;

  // Excel: se lleva la misma ventana y el mismo tipo que estás viendo.
  const exportUrl = (() => {
    const p = new URLSearchParams({ companyId: activeCompany?.id ?? "" });
    const r = rangoPeriodo(periodo);
    if (r) {
      p.set("from", r.from.toISOString());
      p.set("to", r.to.toISOString());
    }
    if (filter === "cancelada") p.set("tipo", "CANCELLED");
    else if (filter !== "todas") p.set("tipo", filter.toUpperCase());
    return `/api/facturas/export?${p.toString()}`;
  })();

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
          <a href={exportUrl} title="Exporta lo que estás viendo: el periodo y el filtro seleccionados">
            <Button variant="soft" size="md"><Download className="h-4 w-4" /> Excel</Button>
          </a>
          <Link href="/facturas/nueva">
            <Button variant="brand" size="md"><Plus className="h-4 w-4" /> Nueva factura</Button>
          </Link>
        </div>
      </div>

      {/* Carta Manifiesto pendiente: sin ella no se timbra — avisar aquí, no
          hasta que el timbrado falle. */}
      <ManifiestoBanner companyId={activeCompany.id} />

      {/* stat cards */}
      <div className="mt-4 grid grid-cols-1 gap-4 min-[680px]:grid-cols-3">
        <Card className="rounded-card border-cos-line p-5 shadow-card">
          <span className={LBL}>Facturas timbradas</span>
          <div className="my-1 text-[28px] font-semibold tracking-[-0.02em] text-cos-ink">{resumen?.timbradas ?? "—"}</div>
          <span className="text-[12.5px] text-cos-ink-faint">{subPeriodo}</span>
        </Card>
        <Card className="rounded-card border-cos-line p-5 shadow-card">
          <span className={LBL}>Total facturado</span>
          <div className="my-1"><Money value={resumen?.totalFacturado ?? 0} size={24} /></div>
          <span className="text-[12.5px] text-cos-ink-faint">emitido {subPeriodo}</span>
        </Card>
        <Card className="rounded-card border-cos-line p-5 shadow-card">
          <span className={LBL}>IVA cobrado</span>
          <div className="my-1"><Money value={resumen?.ivaCobrado ?? 0} size={24} /></div>
          <span className="text-[12.5px] text-cos-ink-faint">trasladado a clientes</span>
        </Card>
      </div>

      {/* prefacturas pendientes de timbrar */}
      {prefacturas.length > 0 && (
        <Card className="mt-4 overflow-hidden rounded-card border-cos-line shadow-card">
          <div className="flex items-center justify-between border-b border-cos-line px-[18px] py-3">
            <span className="text-[13px] font-semibold text-cos-ink">
              Prefacturas por timbrar <span className="ml-1 rounded-full bg-cos-amber-tint px-2 py-0.5 font-mono text-[11.5px] text-cos-amber-ink">{prefacturas.length}</span>
            </span>
            <span className="text-[12px] text-cos-ink-faint">El PDF sale con marca BORRADOR — no consume timbre hasta que la timbras.</span>
          </div>
          {prefacturas.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-cos-line px-[18px] py-2.5 last:border-0">
              <div className="min-w-0">
                <p className="truncate text-[13.5px] font-medium text-cos-ink">{p.cliente}</p>
                <p className="font-mono text-[11.5px] text-cos-ink-faint">
                  {p.rfc} · {fmtFecha(p.createdAt)}{p.enviadaAt ? ` · enviada ${fmtFecha(p.enviadaAt)}` : ""}
                </p>
              </div>
              <div className="flex flex-none items-center gap-2">
                <span className="mr-1 font-mono text-[13.5px] font-semibold text-cos-ink">
                  {new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(p.total)}
                </span>
                <a href={p.pdfUrl} target="_blank" rel="noopener noreferrer"
                  className="rounded-control border border-cos-line px-2.5 py-1.5 text-[12px] font-medium text-cos-ink-soft hover:bg-cos-paper">PDF</a>
                <button onClick={() => { navigator.clipboard.writeText(p.pdfUrl); showToast("✓ Enlace copiado (vigente 7 días)"); }}
                  className="rounded-control border border-cos-line px-2.5 py-1.5 text-[12px] font-medium text-cos-ink-soft hover:bg-cos-paper">Copiar enlace</button>
                <button onClick={() => prefAccion(p, "enviar")} disabled={prefBusy === p.id}
                  className="rounded-control border border-cos-line px-2.5 py-1.5 text-[12px] font-medium text-cos-brand-ink hover:bg-cos-brand-tint disabled:opacity-50">Enviar</button>
                <button onClick={() => prefAccion(p, "timbrar")} disabled={prefBusy === p.id}
                  className="rounded-control bg-cos-jade-ink px-2.5 py-1.5 text-[12px] font-semibold text-white hover:opacity-90 disabled:opacity-50">
                  {prefBusy === p.id ? "…" : "Timbrar"}
                </button>
                <button onClick={() => prefAccion(p, "descartar")} disabled={prefBusy === p.id}
                  className="rounded-control border border-cos-red-ink/20 px-2.5 py-1.5 text-[12px] font-medium text-cos-red-ink hover:bg-cos-red-tint disabled:opacity-50">✕</button>
              </div>
            </div>
          ))}
        </Card>
      )}

      {/* complementos de pago (REP) por emitir — cobros PPD detectados sin REP */}
      <ComplementosPendientes companyId={activeCompany.id} onToast={showToast} onEmitted={fetchData} />

      {/* búsqueda (servidor, sobre todo el historial) + selector de periodo */}
      <div className="mt-[18px] flex flex-wrap items-stretch gap-2.5">
        <div className="flex min-w-[240px] flex-1 items-center gap-2.5 rounded-control border border-cos-line bg-cos-card px-3.5 text-cos-ink-faint">
          <Search className="h-[18px] w-[18px]" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar por nombre, RFC, folio o UUID…"
            className="flex-1 border-0 bg-transparent py-3 text-[14.5px] text-cos-ink outline-none"
          />
        </div>
        <div className="min-w-[220px]">
          <SelectorPeriodo valor={periodo} conteos={periodos} onChange={setPeriodo} />
        </div>
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
                : "border-cos-line bg-cos-card text-cos-ink-soft hover:border-cos-brand hover:text-cos-brand-ink")
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
          <div className="px-10 py-10 text-center text-cos-ink-faint">
            {qBuscado
              ? `No encontré comprobantes que coincidan con «${qBuscado}»${periodo === PERIODO_TODO ? "" : ` en ${etiquetaPeriodo(periodo)}`}.`
              : periodo === PERIODO_TODO
              ? "No hay facturas con ese filtro."
              : `No hay facturas de ${etiquetaPeriodo(periodo)} con ese filtro.`}
          </div>
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
                {/* La contraparte sale del Customer cuando existe; si no (público
                    en general y extranjeros, que no llevan Customer), del nombre
                    que trae el propio comprobante. */}
                <span className="min-w-0">
                  <span className="block truncate text-[14.5px] font-medium text-cos-ink">
                    {inv.customer?.razonSocial ?? inv.contraparteNombre ?? "—"}
                  </span>
                  <span className="mt-0.5 block truncate font-mono text-[12px] text-cos-ink-faint">
                    {inv.customer?.rfc ?? inv.contraparteRfc ?? "—"}
                    {!inv.customer && inv.contraparteRfc === "XAXX010101000" && (
                      <span className="ml-1.5 font-sans text-cos-ink-faint">· público en general</span>
                    )}
                  </span>
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

        {/* Paginación: la lista trae de 200 en 200. Sin esto, los comprobantes
            más viejos que la primera página eran invisibles. */}
        {!loading && invoices.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-cos-line px-[18px] py-3">
            <span className="text-[12.5px] text-cos-ink-faint">
              {rows.length === invoices.length
                ? `${invoices.length} comprobante${invoices.length === 1 ? "" : "s"}`
                : `${rows.length} de ${invoices.length} cargados`}
              {periodo !== PERIODO_TODO ? ` · ${etiquetaPeriodo(periodo)}` : ""}
              {hayMas ? " · hay más" : ""}
            </span>
            {hayMas && (
              <Button variant="soft" size="md" onClick={cargarMas} loading={cargandoMas}>
                Cargar más
              </Button>
            )}
          </div>
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
      setActivoMsg("✓ Registrado en activo fijo — revisa la tasa y el tope en Contabilidad › Activo fijo");
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
          className="rounded-control border border-cos-line bg-cos-card px-2 py-1 text-[13px] focus:outline-none focus:ring-1 focus:ring-cos-brand"
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

  // Enviar el CFDI timbrado (PDF+XML) al correo del cliente vía Facturapi.
  const canEmail = inv.status === "STAMPED" && !!inv.facturapiId;
  const [mailOpen, setMailOpen] = useState(false);
  const [mailTo, setMailTo] = useState("");
  const [mailBusy, setMailBusy] = useState(false);
  const [mailMsg, setMailMsg] = useState("");
  const [mailErr, setMailErr] = useState("");

  async function doEmail() {
    setMailBusy(true);
    setMailErr("");
    try {
      const res = await fetch(`/api/facturas/${inv.id}/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mailTo.trim() ? { email: mailTo.trim() } : {}),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "No se pudo enviar");
      setMailMsg(`Enviada a ${data.email}`);
      setMailOpen(false);
    } catch (e) {
      setMailErr(e instanceof Error ? e.message : "No se pudo enviar");
    } finally {
      setMailBusy(false);
    }
  }

  // Only emitted-and-stamped CFDIs we own can be cancelled at the SAT.
  const canCancel = inv.status === "STAMPED" && inv.tipo === "INGRESO" && !!inv.facturapiId;
  const nota = k === "pago" ? "Complemento de pago (REP)" : inv.notas;

  // REP desde la factura: una PPD de ingreso vigente puede complementarse aquí
  // SIN esperar la conciliación bancaria (el cobro puede conocerse antes de que
  // llegue el estado de cuenta). El motor calcula parcialidad y saldos; con el
  // monto vacío asume el saldo pendiente completo.
  const canEmitRep = inv.status === "STAMPED" && inv.tipo === "INGRESO" && inv.metodoPago === "PPD" && !!inv.uuid;
  const [repEmitOpen, setRepEmitOpen] = useState(false);
  const [repMonto, setRepMonto] = useState("");
  const [repFecha, setRepFecha] = useState(() => new Date().toISOString().slice(0, 10));
  const [repFormaPago, setRepFormaPago] = useState("03");
  const [repBusy, setRepBusy] = useState(false);
  const [repErr, setRepErr] = useState("");
  const [repOkMsg, setRepOkMsg] = useState("");

  async function doEmitRep() {
    setRepBusy(true);
    setRepErr("");
    try {
      const res = await fetch("/api/facturas/complemento-pagos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: inv.companyId,
          invoiceId: inv.id,
          ...(repMonto.trim() ? { monto: Number(repMonto) } : {}),
          fechaPago: repFecha,
          formaPago: repFormaPago,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "Error al emitir el complemento");
      setRepOkMsg(`Complemento emitido (parcialidad ${data.numParcialidad}, ${new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(data.monto)}).`);
      setRepEmitOpen(false);
      onCancelled(); // refresca la lista — aparece el nuevo CFDI tipo PAGO
    } catch (e) {
      setRepErr(e instanceof Error ? e.message : "Error al emitir el complemento");
    } finally {
      setRepBusy(false);
    }
  }

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
        className="w-full max-w-[440px] rounded-[18px] bg-cos-card p-6 shadow-[0_30px_60px_-20px_oklch(0.2_0.05_258_/_0.5)]"
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

        {k === "pago" ? (
          // REP: el comprobante trae Total/IVA = 0; mostramos los montos reales
          // del complemento (monto pagado + IVA trasladado) y la FECHA DE PAGO,
          // que es la que causa el IVA (no la fecha de emisión del REP).
          <div className="mt-[18px] border-t border-cos-line-soft">
            <div className="flex justify-between border-b border-cos-line-soft py-2.5 text-[14px] text-cos-ink-soft">
              <span>Monto del pago</span><Money value={inv.pagoMonto ?? 0} size={15} weight={500} />
            </div>
            <div className="flex justify-between border-b border-cos-line-soft py-2.5 text-[14px] text-cos-ink-soft">
              <span>IVA trasladado del pago</span><Money value={inv.pagoIva ?? 0} size={15} weight={500} />
            </div>
            <div className="flex justify-between py-2.5 text-[14px] font-semibold text-cos-ink">
              <span>Fecha de pago{inv.pagoFecha ? "" : " (en el complemento)"}</span>
              <span>{inv.pagoFecha ? fmtFecha(inv.pagoFecha) : "—"}</span>
            </div>
            <p className="pb-1 text-[12px] text-cos-ink-faint">
              El IVA de este pago se causa en el mes de la fecha de pago.
            </p>
          </div>
        ) : (
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
        )}

        <button
          onClick={() => setRepOpen(true)}
          className="mt-[18px] flex w-full items-center justify-center gap-2 rounded-control bg-cos-brand px-4 py-2.5 text-[13.5px] font-semibold text-white hover:bg-cos-brand-deep"
        >
          <FileText className="h-4 w-4" /> Ver representación impresa
        </button>

        <div className="mt-2.5 flex gap-2.5">
          <DownloadBtn id={inv.id} format="xml" />
          <DownloadBtn id={inv.id} format="pdf" onUnavailable={() => setRepOpen(true)} />
        </div>

        {/* Volver a facturar: clona esta factura (cliente, conceptos, precios y
            cuenta predial) en el formulario de nueva factura. Sólo tiene sentido
            en las que emites tú. */}
        {inv.tipo === "INGRESO" && inv.customer && (
          <Link href={`/facturas/nueva?desde=${inv.id}`} className="mt-2.5 block">
            <Button variant="soft" size="md" className="w-full">
              <Copy className="h-4 w-4" /> Volver a facturar
            </Button>
          </Link>
        )}

        {/* enviar por correo (PDF + XML, vía Facturapi) */}
        {mailMsg && (
          <p className="mt-2.5 rounded-[10px] bg-cos-jade-tint px-3 py-2.5 text-[13px] text-cos-jade-ink">✓ {mailMsg}</p>
        )}
        {canEmail && !mailOpen && !mailMsg && (
          <button
            onClick={() => setMailOpen(true)}
            className="mt-2.5 w-full rounded-control border border-cos-line py-2 text-[13px] font-medium text-cos-brand-ink hover:bg-cos-brand-tint"
          >
            Enviar por correo al cliente
          </button>
        )}
        {mailOpen && (
          <div className="mt-2.5 rounded-[12px] border border-cos-line bg-cos-paper p-3.5">
            <p className="text-[13px] font-medium text-cos-ink">Enviar factura por correo</p>
            <p className="mt-1 text-[12px] text-cos-ink-faint">
              Facturapi manda el PDF y el XML. Deja el campo vacío para usar el correo del cliente.
            </p>
            {mailErr && <p className="mt-2 text-[12.5px] text-cos-red-ink">{mailErr}</p>}
            <div className="mt-2 flex gap-2">
              <input
                type="email"
                value={mailTo}
                onChange={(e) => setMailTo(e.target.value)}
                placeholder="correo@cliente.com (opcional)"
                className="flex-1 rounded-control border border-cos-line bg-cos-card px-3 py-2 text-[13px] outline-none"
              />
              <button onClick={doEmail} disabled={mailBusy}
                className="rounded-control bg-cos-brand px-3.5 py-2 text-[13px] font-semibold text-white hover:bg-cos-brand-deep disabled:opacity-50">
                {mailBusy ? "Enviando…" : "Enviar"}
              </button>
            </div>
          </div>
        )}

        {repOpen && <RepresentacionImpresa invoiceId={inv.id} onClose={() => setRepOpen(false)} />}

        {repOkMsg && (
          <p className="mt-3 rounded-[10px] bg-cos-jade-tint px-3 py-2.5 text-[13px] text-cos-jade-ink">✓ {repOkMsg}</p>
        )}
        {canEmitRep && !repEmitOpen && !repOkMsg && (
          <button
            onClick={() => setRepEmitOpen(true)}
            className="mt-3 w-full rounded-control border border-cos-line py-2 text-[13px] font-medium text-cos-brand-ink hover:bg-cos-brand-tint"
          >
            Emitir complemento de pago (REP)
          </button>
        )}
        {repEmitOpen && (
          <div className="mt-3 rounded-[12px] border border-cos-line bg-cos-paper p-3.5">
            <p className="text-[13px] font-medium text-cos-ink">Emitir complemento de pago</p>
            <p className="mt-1 text-[12px] text-cos-ink-faint">
              Registra un cobro de esta factura PPD y timbra su REP ante el SAT. No necesitas esperar la
              conciliación bancaria; el sistema calcula la parcialidad y los saldos.
            </p>
            {repErr && (
              <p className="mt-2 flex items-center gap-1.5 text-[12.5px] text-cos-red-ink">
                <AlertTriangle className="h-3.5 w-3.5" /> {repErr}
              </p>
            )}
            <div className="mt-2.5 grid grid-cols-2 gap-2.5">
              <label className="block text-[12.5px] text-cos-ink-soft">
                Fecha del cobro
                <input
                  type="date"
                  value={repFecha}
                  onChange={(e) => setRepFecha(e.target.value)}
                  className="mt-1 w-full rounded-control border border-cos-line bg-cos-card px-2.5 py-2 text-[13.5px] text-cos-ink outline-none"
                />
              </label>
              <label className="block text-[12.5px] text-cos-ink-soft">
                Monto cobrado
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={repMonto}
                  onChange={(e) => setRepMonto(e.target.value)}
                  placeholder="Saldo pendiente completo"
                  className="mt-1 w-full rounded-control border border-cos-line bg-cos-card px-2.5 py-2 text-[13.5px] text-cos-ink outline-none"
                />
              </label>
            </div>
            {/* Dedazo típico dd/mm: un cobro FECHADO ANTES de que existiera la
                factura casi siempre es el mes equivocado. Aviso, no bloqueo —
                un REP de un cobro anterior legítimo es raro pero posible. */}
            {repFecha && new Date(repFecha + "T12:00:00Z") < new Date(inv.fecha) && (
              <p className="mt-2 flex items-start gap-1.5 text-[12.5px] text-cos-amber-ink">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                La fecha del cobro ({fmtFecha(repFecha + "T12:00:00Z")}) es anterior a la emisión de la
                factura ({fmtFecha(inv.fecha)}). Revisa que no sea el mes equivocado — el IVA se causa
                en el mes de esta fecha.
              </p>
            )}
            <label className="mt-2.5 block text-[12.5px] text-cos-ink-soft">
              Forma de pago
              <select
                value={repFormaPago}
                onChange={(e) => setRepFormaPago(e.target.value)}
                className="mt-1 w-full rounded-control border border-cos-line bg-cos-card px-2.5 py-2 text-[13.5px] text-cos-ink outline-none"
              >
                <option value="03">03 — Transferencia electrónica</option>
                <option value="01">01 — Efectivo</option>
                <option value="02">02 — Cheque nominativo</option>
                <option value="04">04 — Tarjeta de crédito</option>
                <option value="28">28 — Tarjeta de débito</option>
              </select>
            </label>
            <div className="mt-3 flex gap-2">
              <button
                onClick={doEmitRep}
                disabled={repBusy}
                className="flex-1 rounded-control bg-cos-brand px-3 py-2 text-[13px] font-semibold text-white hover:bg-cos-brand-deep disabled:opacity-50"
              >
                {repBusy ? "Timbrando…" : "Timbrar complemento"}
              </button>
              <button
                onClick={() => setRepEmitOpen(false)}
                disabled={repBusy}
                className="rounded-control border border-cos-line px-3 py-2 text-[13px] text-cos-ink-soft hover:bg-cos-card"
              >
                Cancelar
              </button>
            </div>
          </div>
        )}

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
                className="mt-1 w-full rounded-control border border-cos-line bg-cos-card px-2.5 py-2 text-[13.5px] text-cos-ink outline-none"
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
                className="mt-2 w-full rounded-control border border-cos-line bg-cos-card px-2.5 py-2 font-mono text-[12.5px] text-cos-ink outline-none"
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
