"use client";

import { useEffect, useState, useCallback } from "react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { Card, Money, Loading } from "@/components/ui";
import {
  ChevronLeft, ChevronRight, Upload, Download, Loader2, RotateCcw,
  CheckCircle2, AlertTriangle, CalendarDays, Sparkles,
} from "lucide-react";

// ── Types (mirror /api/impuestos/cierre and /api/papeles/iva) ──────────────────
type Estado = "FILED" | "PENDING" | "OVERDUE" | "UPCOMING";
interface FederalLinea { tipo: string; descripcion: string; monto: number; tipoMonto: "pagar" | "favor" | "enterar"; }
interface AcuseMensualParsed {
  rfc: string | null; periodoMes: number | null; periodoAnio: number | null;
  ivaAPagar: number | null; ivaAFavor: number | null;
  isrIngresos: number | null; isrPagosAnteriores: number | null; isrAPagar: number | null;
  coeficienteUtilidadAplicado: number | null; lineaCaptura: string | null; fechaPresentacion: string | null;
}
interface CierreData {
  periodo: string; month: number; year: number;
  federal: {
    lineas: FederalLinea[]; totalAPagar: number; saldoFavorIva: number;
    vencimiento: string; estado: Estado;
    lineaCaptura: string | null; acuseUrl: string | null; fechaPresentacion: string | null;
    declaracionId: string | null; acusePdfDisponible: boolean; calculado: boolean;
  };
  diot: { aplica: boolean; proveedores: number; vencimiento: string; estado: Estado } | null;
}
interface PapelRow { id: string; fecha: string; contraparte: string; rfc: string; subtotal: number; tasa: number | null; importe: number; metodoPago: string; }
interface PapelIva {
  trasladado: PapelRow[]; acreditable: PapelRow[];
  totales: {
    trasladado: number; acreditable: number; retenidoPorClientes: number;
    proporcionAcreditamiento: number; actosGravados: number; actosExentos: number; acreditableProcedente: number;
    ivaCargo: number; saldoFavorAnterior: number; ivaPagar: number; saldoFavorMes: number;
  };
}
interface HallazgoDTO {
  id: string; checkClave: string; categoria: string; severidad: string;
  mensaje: string; sugerencia: string;
  fundamento: { ley: string; articulo: string; fraccion: string | null };
  referencias: string[]; estado: string;
}
interface PapelIsr {
  regimen: { kind: string; label: string };
  base: { prevYear: number; prevUtilidad: number; coeficienteCalculado: number | null; coeficiente: number | null; coeficienteFuente: "manual" | "calculado" | "ninguno" };
  calculo: {
    tipo: string; ingresosAcumulados?: number; coeficiente?: number | null; utilidadFiscal?: number | null;
    tasa?: number; isrDelEjercicio?: number | null; isrPagadoAnterior?: number; isrDelMes?: number | null;
  };
}

const MONTHS = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
const MES_ABBR = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];

function fmtFecha(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MES_ABBR[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
function montoLabel(l: FederalLinea) {
  return l.tipoMonto === "favor" ? "a favor" : l.tipoMonto === "enterar" ? "a enterar" : "a pagar";
}

type Tab = "resumen" | "papeles" | "revision" | "presentar";
const TABS: { id: Tab; label: string }[] = [
  { id: "resumen", label: "Resumen" },
  { id: "papeles", label: "Papeles de trabajo" },
  { id: "revision", label: "Revisión" },
  { id: "presentar", label: "Presentar" },
];

export default function DeclaracionWorkspace() {
  const { activeCompany } = useCompany();
  const now = new Date();
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [tab, setTab] = useState<Tab>("resumen");

  const [data, setData] = useState<CierreData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Presentar
  const [fecha, setFecha] = useState("");
  const [saving, setSaving] = useState(false);
  const [acuseParsed, setAcuseParsed] = useState<AcuseMensualParsed | null>(null);
  const [acuseUploading, setAcuseUploading] = useState(false);
  const [acuseError, setAcuseError] = useState("");

  // Auditor findings (company-wide) — drive the Revisión tab + its count badge.
  const [flags, setFlags] = useState<HallazgoDTO[] | null>(null);
  const loadFlags = useCallback(async () => {
    if (!activeCompany) return;
    const res = await fetch(`/api/hallazgos?companyId=${activeCompany.id}&estado=ABIERTO`);
    if (res.ok) { const d = await res.json(); setFlags(d.hallazgos ?? []); }
  }, [activeCompany]);
  useEffect(() => { loadFlags(); }, [loadFlags]);

  const load = useCallback(async () => {
    if (!activeCompany) return;
    setLoading(true); setError("");
    try {
      const res = await fetch(`/api/impuestos/cierre?companyId=${activeCompany.id}&month=${month}&year=${year}`);
      if (!res.ok) throw new Error();
      const d: CierreData = await res.json();
      setData(d);
      setFecha(d.federal.fechaPresentacion ? d.federal.fechaPresentacion.substring(0, 10) : "");
      setAcuseParsed(null); setAcuseError("");
    } catch {
      setError("No se pudo cargar la declaración del mes");
    } finally { setLoading(false); }
  }, [activeCompany, month, year]);

  useEffect(() => { load(); }, [load]);

  function shiftMonth(delta: number) {
    let m = month + delta, y = year;
    if (m < 1) { m = 12; y -= 1; } if (m > 12) { m = 1; y += 1; }
    setMonth(m); setYear(y);
  }

  async function post(bodyExtra: Record<string, unknown>) {
    const res = await fetch("/api/impuestos/cierre", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ companyId: activeCompany!.id, periodo: data!.periodo, ...bodyExtra }),
    });
    if (!res.ok) throw new Error();
  }

  async function fileFederal(filing: boolean) {
    if (!activeCompany || !data) return;
    setSaving(true);
    try {
      await post({
        action: filing ? "file-federal" : "unfile-federal",
        fechaPresentacion: fecha || null,
        ...(filing && acuseParsed ? { acuse: acuseParsed } : {}),
      });
      await load();
    } catch { setError("No se pudo guardar la declaración"); }
    finally { setSaving(false); }
  }

  async function handleAcuseUpload(file: File) {
    setAcuseUploading(true); setAcuseError(""); setAcuseParsed(null);
    try {
      const fd = new FormData(); fd.append("file", file);
      const res = await fetch("/api/onboarding/parse-document", { method: "POST", body: fd });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "No se pudo leer el acuse");
      if (d.type !== "ACUSE_MENSUAL" || !d.extracted?.acuseMensual) {
        throw new Error(`El documento se detectó como "${d.type ?? "desconocido"}". Sube el acuse mensual (PDF).`);
      }
      const m = d.extracted.acuseMensual as AcuseMensualParsed;
      setAcuseParsed(m);
      if (m.fechaPresentacion) setFecha(m.fechaPresentacion.substring(0, 10));
    } catch (e) {
      setAcuseError(e instanceof Error ? e.message : "Error al leer el acuse");
    } finally { setAcuseUploading(false); }
  }

  if (!activeCompany) {
    return <div className="p-8 text-[14px] text-cos-ink-faint">Selecciona una empresa.</div>;
  }

  return (
    <div className="mx-auto max-w-[1000px] px-4 py-6 sm:px-8 sm:py-8">
      {/* Header + period switcher */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[30px] font-semibold leading-[1.05] tracking-[-0.03em] text-cos-ink">Declaración del mes</h1>
          <p className="mt-1.5 text-[15px] text-cos-ink-soft">{activeCompany.razonSocial}</p>
        </div>
        <div className="flex items-center gap-2.5 font-semibold text-cos-ink">
          <button onClick={() => shiftMonth(-1)} aria-label="Mes anterior" className="grid h-8 w-8 place-items-center rounded-control border border-cos-line hover:bg-cos-paper"><ChevronLeft className="h-4 w-4" /></button>
          <span className="min-w-[120px] text-center">{MONTHS[month - 1]} {year}</span>
          <button onClick={() => shiftMonth(1)} aria-label="Mes siguiente" className="grid h-8 w-8 place-items-center rounded-control border border-cos-line hover:bg-cos-paper"><ChevronRight className="h-4 w-4" /></button>
        </div>
      </div>

      {/* Tabs */}
      <div className="mt-5 flex gap-1 border-b border-cos-line">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-3.5 py-2 text-[14px] font-medium transition-colors ${
              tab === t.id ? "border-cos-brand text-cos-brand-ink" : "border-transparent text-cos-ink-soft hover:text-cos-ink"
            }`}
          >
            {t.label}
            {t.id === "revision" && flags && flags.length > 0 && (
              <span className="grid h-[18px] min-w-[18px] place-items-center rounded-full bg-cos-red-tint px-1 text-[11px] font-semibold text-cos-red-ink">{flags.length}</span>
            )}
          </button>
        ))}
      </div>

      {loading || !data ? (
        <Loading label="Cargando…" className="py-16" />
      ) : (
        <div className="mt-5">
          {tab === "resumen" && <Resumen data={data} />}
          {tab === "papeles" && <PapelesTab companyId={activeCompany.id} month={month} year={year} onChanged={load} />}
          {tab === "revision" && (
            <RevisionTab
              companyId={activeCompany.id}
              fechaIso={`${year}-${String(month).padStart(2, "0")}-15`}
              flags={flags}
              onRefresh={loadFlags}
            />
          )}
          {tab === "presentar" && (
            <Presentar
              data={data} fecha={fecha} setFecha={setFecha} saving={saving}
              acuseParsed={acuseParsed} acuseUploading={acuseUploading} acuseError={acuseError}
              onUpload={handleAcuseUpload} onFile={fileFederal}
            />
          )}
        </div>
      )}
      {error && <p className="mt-4 flex items-center gap-1.5 text-[13px] text-cos-red-ink"><AlertTriangle className="h-4 w-4" /> {error}</p>}
    </div>
  );
}

function EstadoBadge({ estado }: { estado: Estado }) {
  const map: Record<Estado, { label: string; cls: string }> = {
    FILED: { label: "Presentada", cls: "bg-cos-jade-tint text-cos-jade-ink" },
    PENDING: { label: "Pendiente", cls: "bg-cos-slate-tint text-cos-ink-soft" },
    OVERDUE: { label: "Vencida", cls: "bg-cos-red-tint text-cos-red-ink" },
    UPCOMING: { label: "Por vencer", cls: "bg-amber-50 text-amber-700" },
  };
  const m = map[estado];
  return <span className={`rounded-full px-2.5 py-1 text-[12px] font-semibold ${m.cls}`}>{m.label}</span>;
}

function Resumen({ data }: { data: CierreData }) {
  const f = data.federal;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-card bg-gradient-to-br from-cos-brand to-cos-brand-deep px-6 py-6 text-white shadow-[0_16px_36px_-20px_var(--brand)]">
        <div>
          <span className="block text-[12.5px] font-medium uppercase tracking-[0.02em] text-white/75">Total a pagar</span>
          <div className="my-1.5"><Money value={f.totalAPagar} size={42} weight={700} className="text-white" /></div>
          <span className="inline-flex items-center gap-1.5 text-[13.5px] text-white/85"><CalendarDays className="h-[15px] w-[15px]" /> Vence el {fmtFecha(f.vencimiento)}</span>
        </div>
        <EstadoBadge estado={f.estado} />
      </div>

      <Card className="rounded-card border-cos-line p-5 shadow-card">
        <span className="block text-[12.5px] font-medium uppercase tracking-[0.02em] text-cos-ink-faint">Declaración federal</span>
        <table className="mt-3 w-full text-[14px]">
          <tbody>
            {f.lineas.map((l) => (
              <tr key={l.tipo} className="border-b border-cos-line-soft last:border-0">
                <td className="py-2 text-cos-ink-soft">{l.descripcion}</td>
                <td className="py-2 text-right">
                  <span className="text-[12px] text-cos-ink-faint mr-2">{montoLabel(l)}</span>
                  <Money value={l.monto} size={15} weight={600} />
                </td>
              </tr>
            ))}
            {f.saldoFavorIva > 0 && (
              <tr className="text-cos-jade-ink"><td className="py-2 text-[13px]">Saldo a favor de IVA (se arrastra)</td><td className="py-2 text-right"><Money value={f.saldoFavorIva} size={14} weight={600} /></td></tr>
            )}
          </tbody>
        </table>
      </Card>

      {data.diot?.aplica && (
        <Card className="rounded-card border-cos-line p-5 shadow-card">
          <div className="flex items-center justify-between">
            <span className="block text-[12.5px] font-medium uppercase tracking-[0.02em] text-cos-ink-faint">DIOT</span>
            <EstadoBadge estado={data.diot.estado} />
          </div>
          <p className="mt-2 text-[14px] text-cos-ink">{data.diot.proveedores} proveedor(es) con IVA · vence {fmtFecha(data.diot.vencimiento)}</p>
        </Card>
      )}
    </div>
  );
}

function PapelesTab({ companyId, month, year, onChanged }: { companyId: string; month: number; year: number; onChanged: () => void }) {
  const [iva, setIva] = useState<PapelIva | null>(null);
  const [isr, setIsr] = useState<PapelIsr | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [a, b] = await Promise.all([
        fetch(`/api/papeles/iva?companyId=${companyId}&month=${month}&year=${year}`).then((r) => (r.ok ? r.json() : null)),
        fetch(`/api/papeles/isr?companyId=${companyId}&month=${month}&year=${year}`).then((r) => (r.ok ? r.json() : null)),
      ]);
      setIva(a); setIsr(b);
    } finally { setLoading(false); }
  }, [companyId, month, year]);

  useEffect(() => { load(); }, [load]);

  // After a persisted edit (coeficiente), refresh both the papel and the parent
  // Resumen/Presentar so the total a pagar reflects the change.
  const afterEdit = useCallback(async () => { await load(); onChanged(); }, [load, onChanged]);

  if (loading) return <Loading label="Cargando papeles…" className="py-12" />;
  if (!iva) return <p className="py-8 text-[14px] text-cos-ink-faint">Sin papel de trabajo para este periodo.</p>;
  const t = iva.totales;

  const rowsCard = (title: string, sub: string, rows: PapelRow[]) => rows.length === 0 ? null : (
    <Card className="rounded-card border-cos-line p-5 shadow-card">
      <span className="block text-[12.5px] font-medium uppercase tracking-[0.02em] text-cos-ink-faint">{title}</span>
      <p className="mt-0.5 text-[12px] text-cos-ink-faint">{sub}</p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead className="text-[11px] uppercase text-cos-ink-faint"><tr><th className="py-1.5 text-left">Fecha</th><th className="text-left">Contraparte</th><th className="text-right">Subtotal</th><th className="text-right">Tasa</th><th className="text-right">IVA</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-cos-line-soft">
                <td className="py-1.5 whitespace-nowrap">{r.fecha}</td>
                <td className="max-w-[240px] truncate" title={`${r.contraparte} · ${r.rfc}`}>{r.contraparte}</td>
                <td className="text-right tabular-nums"><Money value={r.subtotal} size={13} /></td>
                <td className="text-right tabular-nums text-cos-ink-faint">{r.tasa != null ? `${(r.tasa * 100).toFixed(0)}%` : "—"}</td>
                <td className="text-right tabular-nums"><Money value={r.importe} size={13} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );

  return (
    <div className="space-y-4">
      {rowsCard("IVA trasladado (cobrado)", "IVA que cobraste a tus clientes", iva.trasladado)}
      {rowsCard("IVA acreditable (pagado)", "IVA que pagaste a proveedores, acreditable contra el trasladado", iva.acreditable)}

      {/* IVA determination */}
      <Card className="rounded-card border-cos-line p-5 shadow-card text-[14px]">
        <span className="block text-[12.5px] font-medium uppercase tracking-[0.02em] text-cos-ink-faint">Determinación del IVA</span>
        <dl className="mt-3 space-y-1">
          <DetRow label="IVA trasladado (+)" value={t.trasladado} />
          {t.retenidoPorClientes > 0 && <DetRow label="IVA retenido por clientes (−)" value={-t.retenidoPorClientes} />}
          {t.proporcionAcreditamiento < 1 ? (
            <>
              <DetRow label="IVA acreditable bruto" value={t.acreditable} />
              <DetRow label={`= Acreditable procedente (${(t.proporcionAcreditamiento * 100).toFixed(2)}%, Art. 5-V) (−)`} value={-t.acreditableProcedente} />
            </>
          ) : (
            <DetRow label="IVA acreditable (−)" value={-t.acreditable} />
          )}
          <DetRow label="= IVA a cargo" value={t.ivaCargo} strong />
          {t.saldoFavorAnterior > 0 && <DetRow label="Saldo a favor anterior (−)" value={-t.saldoFavorAnterior} />}
          <div className="mt-1 border-t border-cos-line-soft pt-2">
            {t.ivaPagar > 0
              ? <DetRow label="= IVA a pagar" value={t.ivaPagar} strong big />
              : <DetRow label="= Saldo a favor del mes" value={t.saldoFavorMes} strong big jade />}
          </div>
        </dl>
      </Card>

      {/* ISR — coeficiente is the one editable, persisted lever here (Art. 14 / PM). */}
      {isr && isr.calculo.tipo === "art14" && (
        <CoeficienteCard companyId={companyId} year={year} isr={isr} onSaved={afterEdit} />
      )}
    </div>
  );
}

function DetRow({ label, value, strong, big, jade }: { label: string; value: number; strong?: boolean; big?: boolean; jade?: boolean }) {
  return (
    <div className={`flex items-center justify-between ${strong ? "font-semibold" : ""} ${big ? "text-[15px]" : ""}`}>
      <span className={strong ? "text-cos-ink" : "text-cos-ink-soft"}>{label}</span>
      <span className={`tabular-nums ${jade ? "text-cos-jade-ink" : ""}`}><Money value={value} size={big ? 16 : 14} weight={strong ? 700 : 500} /></span>
    </div>
  );
}

function CoeficienteCard({ companyId, year, isr, onSaved }: { companyId: string; year: number; isr: PapelIsr; onSaved: () => void }) {
  const current = isr.base.coeficiente;
  const sugerido = isr.base.coeficienteCalculado;
  const [val, setVal] = useState(current != null ? (current * 100).toFixed(4).replace(/0+$/, "").replace(/\.$/, "") : "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  async function save(coefPct: number) {
    const coeficiente = coefPct / 100;
    if (!Number.isFinite(coeficiente) || coeficiente < 0 || coeficiente > 5) { setErr("Coeficiente fuera de rango"); return; }
    setSaving(true); setErr("");
    try {
      const res = await fetch("/api/impuestos/coeficiente", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId, year, coeficiente }),
      });
      if (!res.ok) throw new Error();
      onSaved();
    } catch { setErr("No se pudo guardar el coeficiente"); }
    finally { setSaving(false); }
  }

  const c = isr.calculo;
  return (
    <Card className="rounded-card border-cos-line p-5 shadow-card">
      <span className="block text-[12.5px] font-medium uppercase tracking-[0.02em] text-cos-ink-faint">ISR provisional — coeficiente de utilidad (Art. 14)</span>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="text-[13px]">
          <span className="mb-1 block text-cos-ink-soft">Coeficiente aplicado{isr.base.coeficienteFuente === "manual" ? " · ajuste del contador" : isr.base.coeficienteFuente === "calculado" ? ` · estimado de ${isr.base.prevYear}` : ""}</span>
          <div className="flex items-center gap-1.5">
            <input
              type="number" step="0.0001" inputMode="decimal" value={val}
              onChange={(e) => setVal(e.target.value)}
              className="w-28 rounded-control border border-cos-line px-2.5 py-2 text-[14px] tabular-nums"
              placeholder="0.0000"
            />
            <span className="text-cos-ink-faint">%</span>
            <button onClick={() => save(parseFloat(val))} disabled={saving || val === ""} className="inline-flex items-center gap-1.5 rounded-control bg-cos-brand px-3 py-2 text-[13px] font-semibold text-white hover:bg-cos-brand-deep disabled:opacity-50">
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />} Guardar
            </button>
          </div>
        </label>
        {sugerido != null && Math.abs((sugerido * 100) - (parseFloat(val) || -1)) > 0.0001 && (
          <button onClick={() => { const p = +(sugerido * 100).toFixed(4); setVal(String(p)); save(p); }} disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-control border border-cos-line px-3 py-2 text-[13px] hover:bg-cos-paper disabled:opacity-50">
            <Sparkles className="h-3.5 w-3.5 text-cos-brand-ink" /> Usar sugerido {(sugerido * 100).toFixed(4)}%
          </button>
        )}
      </div>
      {err && <p className="mt-2 text-[12px] text-cos-red-ink">{err}</p>}

      <dl className="mt-4 space-y-1 text-[14px]">
        <DetRow label="Ingresos acumulados del ejercicio" value={c.ingresosAcumulados ?? 0} />
        <DetRow label={`× Coeficiente (${c.coeficiente != null ? (c.coeficiente * 100).toFixed(4) + "%" : "—"})`} value={c.utilidadFiscal ?? 0} strong />
        <DetRow label={`= ISR del ejercicio (tasa ${c.tasa != null ? (c.tasa * 100).toFixed(0) + "%" : "—"})`} value={c.isrDelEjercicio ?? 0} />
        {(c.isrPagadoAnterior ?? 0) > 0 && <DetRow label="− ISR pagado en meses anteriores" value={-(c.isrPagadoAnterior ?? 0)} />}
        <div className="mt-1 border-t border-cos-line-soft pt-2"><DetRow label="= ISR del mes" value={c.isrDelMes ?? 0} strong big /></div>
      </dl>
    </Card>
  );
}

function RevisionTab({ companyId, fechaIso, flags, onRefresh }: { companyId: string; fechaIso: string; flags: HallazgoDTO[] | null; onRefresh: () => void }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  async function setEstado(id: string, estado: "RESUELTO" | "IGNORADO") {
    setBusyId(id);
    try {
      const res = await fetch(`/api/hallazgos/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ estado }),
      });
      if (res.ok) onRefresh();
    } finally { setBusyId(null); }
  }

  async function rerun() {
    setRunning(true);
    try {
      await fetch("/api/hallazgos/run", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId, fechaIso }),
      });
      onRefresh();
    } finally { setRunning(false); }
  }

  const RerunBtn = (
    <button onClick={rerun} disabled={running} className="inline-flex items-center gap-1.5 rounded-control border border-cos-line px-3 py-1.5 text-[13px] hover:bg-cos-paper disabled:opacity-50">
      {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />} Revisar de nuevo
    </button>
  );

  if (flags === null) return <Loading label="Cargando revisión…" className="py-12" />;

  if (flags.length === 0) {
    return (
      <Card className="rounded-card border-cos-line p-8 text-center shadow-card">
        <CheckCircle2 className="mx-auto mb-3 h-9 w-9 text-cos-jade-ink opacity-80" />
        <p className="text-[15px] font-semibold text-cos-ink">Todo en orden</p>
        <p className="mx-auto mt-1.5 max-w-[52ch] text-[13.5px] text-cos-ink-soft">El auditor no encontró banderas abiertas para esta empresa.</p>
        <div className="mt-4 flex justify-center">{RerunBtn}</div>
      </Card>
    );
  }

  // Most severe first: error → warn → info.
  const order: Record<string, number> = { error: 0, warn: 1, info: 2 };
  const sorted = [...flags].sort((a, b) => (order[a.severidad] ?? 9) - (order[b.severidad] ?? 9));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[13px] text-cos-ink-soft">{flags.length} bandera(s) abierta(s). Revisa, resuelve o ignora — tu decisión sobrevive a las re-corridas del auditor.</p>
        {RerunBtn}
      </div>
      {sorted.map((h) => <FlagCard key={h.id} h={h} busy={busyId === h.id} onResolve={() => setEstado(h.id, "RESUELTO")} onIgnore={() => setEstado(h.id, "IGNORADO")} />)}
    </div>
  );
}

function FlagCard({ h, busy, onResolve, onIgnore }: { h: HallazgoDTO; busy: boolean; onResolve: () => void; onIgnore: () => void }) {
  const sev: Record<string, { dot: string; label: string }> = {
    error: { dot: "bg-cos-red-ink", label: "text-cos-red-ink" },
    warn: { dot: "bg-amber-500", label: "text-amber-700" },
    info: { dot: "bg-cos-slate", label: "text-cos-ink-soft" },
  };
  const s = sev[h.severidad] ?? sev.info;
  const fund = [h.fundamento.ley, h.fundamento.articulo, h.fundamento.fraccion].filter(Boolean).join(" ");
  return (
    <Card className="rounded-card border-cos-line p-4 shadow-card">
      <div className="flex items-start gap-3">
        <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${s.dot}`} />
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-medium text-cos-ink">{h.mensaje}</p>
          {h.sugerencia && <p className="mt-1 text-[13px] text-cos-ink-soft">{h.sugerencia}</p>}
          <p className="mt-1.5 flex flex-wrap items-center gap-2 text-[11.5px] text-cos-ink-faint">
            {fund && <span className="rounded bg-cos-paper px-1.5 py-0.5">{fund}</span>}
            <span className="font-mono">{h.checkClave}</span>
            {h.referencias.length > 0 && <span>· {h.referencias.length} CFDI(s)</span>}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button onClick={onResolve} disabled={busy} className="inline-flex items-center gap-1 rounded-control bg-cos-jade-tint px-2.5 py-1.5 text-[12.5px] font-medium text-cos-jade-ink hover:brightness-95 disabled:opacity-50">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />} Resolver
          </button>
          <button onClick={onIgnore} disabled={busy} className="rounded-control border border-cos-line px-2.5 py-1.5 text-[12.5px] hover:bg-cos-paper disabled:opacity-50">Ignorar</button>
        </div>
      </div>
    </Card>
  );
}

function Presentar({
  data, fecha, setFecha, saving, acuseParsed, acuseUploading, acuseError, onUpload, onFile,
}: {
  data: CierreData; fecha: string; setFecha: (s: string) => void; saving: boolean;
  acuseParsed: AcuseMensualParsed | null; acuseUploading: boolean; acuseError: string;
  onUpload: (f: File) => void; onFile: (filing: boolean) => void;
}) {
  const f = data.federal;
  if (f.estado === "FILED") {
    return (
      <Card className="rounded-card border-cos-line p-5 shadow-card">
        <div className="flex items-center justify-between gap-3 rounded-md bg-cos-jade-tint p-3.5">
          <div>
            <p className="flex items-center gap-1.5 font-medium text-cos-jade-ink"><CheckCircle2 className="h-4 w-4" /> Presentada {f.fechaPresentacion ? `el ${fmtFecha(f.fechaPresentacion)}` : ""}</p>
            <div className="mt-1 flex items-center gap-3">
              {f.acusePdfDisponible && f.declaracionId && (
                <a href={`/api/declaraciones/acuse/${f.declaracionId}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12.5px] text-cos-jade-ink underline"><Download className="h-3.5 w-3.5" /> Descargar acuse</a>
              )}
              {f.acuseUrl && <a href={f.acuseUrl} target="_blank" rel="noreferrer" className="text-[12.5px] text-cos-jade-ink underline">Ver acuse</a>}
            </div>
          </div>
          <button onClick={() => onFile(false)} disabled={saving} className="inline-flex items-center gap-1 rounded-control border border-cos-line px-2.5 py-1.5 text-[12.5px] hover:bg-white">
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />} Revertir
          </button>
        </div>
      </Card>
    );
  }
  return (
    <Card className="rounded-card border-cos-line p-5 shadow-card space-y-3.5">
      <div className="rounded-md border border-dashed border-cos-line p-3.5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[13px] font-medium">¿Ya la presentaste? Sube el acuse (PDF)</p>
          <div className="flex items-center gap-2">
            {f.acusePdfDisponible && f.declaracionId && (
              <a href={`/api/declaraciones/acuse/${f.declaracionId}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-control border border-cos-line px-2.5 py-1.5 text-[12.5px] hover:bg-cos-paper"><Download className="h-3.5 w-3.5" /> Descargar PDF</a>
            )}
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-control border border-cos-line px-2.5 py-1.5 text-[12.5px] hover:bg-cos-paper">
              {acuseUploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
              {acuseUploading ? "Leyendo…" : "Subir acuse"}
              <input type="file" accept="application/pdf,.pdf" className="hidden" disabled={acuseUploading}
                onChange={(e) => { const file = e.target.files?.[0]; if (file) onUpload(file); e.target.value = ""; }} />
            </label>
          </div>
        </div>
        <p className="mt-1 text-[11px] text-cos-ink-faint">Extraemos línea de captura, fecha e importes y los comparamos con lo calculado.</p>
        {acuseError && <p className="mt-2 text-[12px] text-cos-red-ink">{acuseError}</p>}
        {acuseParsed && (
          <p className="mt-2 text-[12px] text-cos-jade-ink">Acuse leído{acuseParsed.isrAPagar != null ? ` · ISR a pagar ${acuseParsed.isrAPagar.toLocaleString("es-MX", { style: "currency", currency: "MXN" })}` : ""}{acuseParsed.ivaAPagar != null ? ` · IVA a pagar ${acuseParsed.ivaAPagar.toLocaleString("es-MX", { style: "currency", currency: "MXN" })}` : ""}.</p>
        )}
      </div>

      <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} className="rounded-control border border-cos-line px-2.5 py-2 text-[14px]" />

      <button onClick={() => onFile(true)} disabled={saving || (!f.calculado && !acuseParsed)}
        className="inline-flex items-center gap-1.5 rounded-control bg-cos-brand px-4 py-2 text-[14px] font-semibold text-white hover:bg-cos-brand-deep disabled:opacity-50">
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
        {acuseParsed ? "Confirmar acuse y marcar presentada" : "Marcar presentada"}
      </button>
      {!f.calculado && !acuseParsed && (
        <p className="text-[12px] text-amber-600">Calcula la declaración (pestaña Resumen) o sube el acuse antes de marcarla presentada.</p>
      )}
    </Card>
  );
}
