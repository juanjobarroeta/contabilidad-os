"use client";

import { useEffect, useState, useCallback } from "react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { Card, Money, Loading } from "@/components/ui";
import {
  ChevronLeft, ChevronRight, Upload, Download, Loader2, RotateCcw,
  CheckCircle2, AlertTriangle, ScanSearch, CalendarDays,
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
  totales: { trasladado: number; acreditable: number; ivaCargo: number; saldoFavorAnterior: number; ivaPagar: number; saldoFavorMes: number };
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

  // Papeles (lazy)
  const [papel, setPapel] = useState<PapelIva | null>(null);
  const [papelLoading, setPapelLoading] = useState(false);

  const load = useCallback(async () => {
    if (!activeCompany) return;
    setLoading(true); setError("");
    try {
      const res = await fetch(`/api/impuestos/cierre?companyId=${activeCompany.id}&month=${month}&year=${year}`);
      if (!res.ok) throw new Error();
      const d: CierreData = await res.json();
      setData(d);
      setFecha(d.federal.fechaPresentacion ? d.federal.fechaPresentacion.substring(0, 10) : "");
      setAcuseParsed(null); setAcuseError(""); setPapel(null);
    } catch {
      setError("No se pudo cargar la declaración del mes");
    } finally { setLoading(false); }
  }, [activeCompany, month, year]);

  useEffect(() => { load(); }, [load]);

  // Lazy-load the IVA working paper the first time the tab is opened for a period.
  useEffect(() => {
    if (tab !== "papeles" || !activeCompany || papel) return;
    setPapelLoading(true);
    fetch(`/api/papeles/iva?companyId=${activeCompany.id}&month=${month}&year=${year}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) setPapel(d); })
      .finally(() => setPapelLoading(false));
  }, [tab, activeCompany, month, year, papel]);

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
            className={`-mb-px border-b-2 px-3.5 py-2 text-[14px] font-medium transition-colors ${
              tab === t.id ? "border-cos-brand text-cos-brand-ink" : "border-transparent text-cos-ink-soft hover:text-cos-ink"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading || !data ? (
        <Loading label="Cargando…" className="py-16" />
      ) : (
        <div className="mt-5">
          {tab === "resumen" && <Resumen data={data} />}
          {tab === "papeles" && <Papeles papel={papel} loading={papelLoading} />}
          {tab === "revision" && <Revision />}
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

function Papeles({ papel, loading }: { papel: PapelIva | null; loading: boolean }) {
  if (loading) return <Loading label="Cargando papeles…" className="py-12" />;
  if (!papel) return <p className="py-8 text-[14px] text-cos-ink-faint">Sin papel de trabajo para este periodo.</p>;
  const sec = (title: string, rows: PapelRow[]) => (
    <Card className="rounded-card border-cos-line p-5 shadow-card">
      <span className="block text-[12.5px] font-medium uppercase tracking-[0.02em] text-cos-ink-faint">{title}</span>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead className="text-[11px] uppercase text-cos-ink-faint"><tr><th className="py-1.5 text-left">Fecha</th><th className="text-left">Contraparte</th><th className="text-right">Subtotal</th><th className="text-right">IVA</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-cos-line-soft">
                <td className="py-1.5">{r.fecha}</td>
                <td className="max-w-[220px] truncate">{r.contraparte}</td>
                <td className="text-right tabular-nums"><Money value={r.subtotal} size={13} /></td>
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
      <p className="text-[13px] text-cos-ink-soft">Edición en línea llega en la siguiente fase. Por ahora, el respaldo de cada cifra (sólo lectura).</p>
      {sec("IVA trasladado (cobrado)", papel.trasladado)}
      {sec("IVA acreditable (pagado)", papel.acreditable)}
      <Card className="rounded-card border-cos-line p-5 shadow-card text-[14px]">
        <div className="flex justify-between py-1"><span className="text-cos-ink-soft">IVA trasladado</span><Money value={papel.totales.trasladado} size={14} /></div>
        <div className="flex justify-between py-1"><span className="text-cos-ink-soft">IVA acreditable</span><Money value={papel.totales.acreditable} size={14} /></div>
        <div className="flex justify-between py-1"><span className="text-cos-ink-soft">Saldo a favor anterior</span><Money value={papel.totales.saldoFavorAnterior} size={14} /></div>
        <div className="flex justify-between border-t border-cos-line-soft py-1.5 font-semibold"><span>IVA a pagar</span><Money value={papel.totales.ivaPagar} size={15} weight={700} /></div>
      </Card>
    </div>
  );
}

function Revision() {
  return (
    <Card className="rounded-card border-cos-line p-8 text-center shadow-card">
      <ScanSearch className="mx-auto mb-3 h-9 w-9 text-cos-ink-faint opacity-60" />
      <p className="text-[15px] font-semibold text-cos-ink">Revisión — próximamente</p>
      <p className="mx-auto mt-1.5 max-w-[52ch] text-[13.5px] text-cos-ink-soft">
        Aquí el “contador 24/7” marcará lo que falta o se ve mal (declaraciones previas, coeficiente,
        cancelaciones, materialidad) con su acción de un clic. (Fase 3)
      </p>
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
