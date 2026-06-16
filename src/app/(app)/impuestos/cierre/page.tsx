"use client";

import { useEffect, useState, useCallback } from "react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { formatCurrency, formatDate } from "@/lib/utils";
import {
  ChevronLeft, ChevronRight, CheckCircle2, AlertCircle, Clock,
  Loader2, Printer, FileText, Lock, RotateCcw, Save, Download, ExternalLink,
  Upload, AlertTriangle, Sparkles,
} from "lucide-react";

const MONTHS = [
  "Enero","Febrero","Marzo","Abril","Mayo","Junio",
  "Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre",
];

type Estado = "FILED" | "PENDING" | "OVERDUE" | "UPCOMING";
const ESTADO_CONFIG: Record<Estado, { label: string; bg: string; text: string; icon: typeof CheckCircle2 }> = {
  FILED:    { label: "Presentada", bg: "bg-green-50", text: "text-green-700", icon: CheckCircle2 },
  PENDING:  { label: "Pendiente",  bg: "bg-gray-50",  text: "text-gray-600",  icon: Clock },
  OVERDUE:  { label: "Vencida",    bg: "bg-red-50",   text: "text-red-700",   icon: AlertCircle },
  UPCOMING: { label: "Por vencer", bg: "bg-amber-50", text: "text-amber-700", icon: Clock },
};

interface FederalLinea { tipo: string; descripcion: string; monto: number; tipoMonto: "pagar" | "favor" | "enterar"; }

// Filed figures parsed from the SAT acuse PDF (shape from /api/onboarding/parse-document).
interface AcuseMensualParsed {
  rfc: string | null; periodoMes: number | null; periodoAnio: number | null;
  tipoImpuesto: string | null; tipoPago: string | null;
  ivaCausado: number | null; ivaAcreditable: number | null;
  ivaAPagar: number | null; ivaAFavor: number | null; ivaSaldoFavorAplicado: number | null;
  isrIngresos: number | null; isrRetenciones: number | null; isrPagosAnteriores: number | null;
  isrAPagar: number | null; coeficienteUtilidadAplicado: number | null;
  lineaCaptura: string | null; fechaPresentacion: string | null;
}
interface AcuseDiff { campo: string; filed: number; computed: number; delta: number; }
interface AcuseData {
  extractedAt: string; tipoImpuesto: string | null; tipoPago: string | null; rfc: string | null;
  diffs: AcuseDiff[];
}

interface CierreData {
  periodo: string; month: number; year: number;
  federal: {
    lineas: FederalLinea[];
    totalAPagar: number; saldoFavorIva: number;
    vencimiento: string; estado: Estado;
    lineaCaptura: string | null; acuseUrl: string | null; fechaPresentacion: string | null;
    acuseData: AcuseData | null;
    declaracionId: string | null; acusePdfDisponible: boolean;
    calculado: boolean;
  };
  diot: {
    aplica: boolean; proveedores: number; vencimiento: string;
    estado: Estado; acuseUrl: string | null; fechaPresentacion: string | null;
  } | null;
  readiness: Record<string, { ok: boolean; aplica: boolean; detail: string }>;
  resumen: { totalAPagar: number; obligacionesPresentadas: number; obligacionesTotal: number; mesCerrado: boolean; };
}

const READINESS_LABELS: Record<string, string> = {
  cfdisSincronizados: "CFDIs sincronizados",
  nominaTimbrada: "Nómina del mes timbrada",
  periodoCerrado: "Periodo concluido",
  complementosPago: "Complementos de pago (REP)",
};

// Each federal sub-obligation has a downloadable working paper backing its figure.
type PapelId = "iva" | "isr" | "retenciones";
const PAPEL_BY_TIPO: Record<string, PapelId | undefined> = {
  IVA_MENSUAL: "iva",
  ISR_PROVISIONAL: "isr",
  RETENCIONES_ISR: "retenciones",
};
const PAPEL_LABEL: Record<PapelId, string> = {
  iva: "IVA — acreditable, trasladado y determinación",
  isr: "ISR provisional — base, coeficiente y cálculo",
  retenciones: "Retenciones — recibidas y efectuadas",
};

export default function CierreMensualPage() {
  const { activeCompany } = useCompany();
  const now = new Date();
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [data, setData] = useState<CierreData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Federal acuse capture
  const [federalLinea, setFederalLinea] = useState("");
  const [federalAcuse, setFederalAcuse] = useState("");
  const [federalFecha, setFederalFecha] = useState("");
  const [savingFederal, setSavingFederal] = useState(false);
  // Acuse PDF extraction (federal)
  const [acuseParsed, setAcuseParsed] = useState<AcuseMensualParsed | null>(null);
  const [acuseFileName, setAcuseFileName] = useState("");
  const [acuseUploading, setAcuseUploading] = useState(false);
  const [acuseError, setAcuseError] = useState<string | null>(null);
  // DIOT acuse capture
  const [diotAcuse, setDiotAcuse] = useState("");
  const [savingDiot, setSavingDiot] = useState(false);

  const load = useCallback(async () => {
    if (!activeCompany) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/impuestos/cierre?companyId=${activeCompany.id}&month=${month}&year=${year}`);
      if (!res.ok) throw new Error("Error al cargar el cierre");
      const d: CierreData = await res.json();
      setData(d);
      setFederalLinea(d.federal.lineaCaptura ?? "");
      setFederalAcuse(d.federal.acuseUrl ?? "");
      setFederalFecha(d.federal.fechaPresentacion ? d.federal.fechaPresentacion.substring(0, 10) : "");
      setDiotAcuse(d.diot?.acuseUrl ?? "");
      // Clear any staged-but-unfiled acuse when the period/company changes.
      setAcuseParsed(null);
      setAcuseFileName("");
      setAcuseError(null);
    } catch {
      setError("No se pudo cargar el cierre del mes");
    } finally {
      setLoading(false);
    }
  }, [activeCompany, month, year]);

  useEffect(() => { load(); }, [load]);

  function prevMonth() { if (month === 1) { setMonth(12); setYear(y => y - 1); } else setMonth(m => m - 1); }
  function nextMonth() { if (month === 12) { setMonth(1); setYear(y => y + 1); } else setMonth(m => m + 1); }

  async function post(body: Record<string, unknown>) {
    const res = await fetch("/api/impuestos/cierre", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ companyId: activeCompany!.id, periodo: data!.periodo, ...body }),
    });
    if (!res.ok) throw new Error("Error");
  }

  async function fileFederal(filing: boolean) {
    if (!activeCompany || !data) return;
    setSavingFederal(true);
    try {
      await post({
        action: filing ? "file-federal" : "unfile-federal",
        lineaCaptura: federalLinea || null,
        acuseUrl: federalAcuse || null,
        fechaPresentacion: federalFecha || null,
        // When an acuse was extracted, send its filed figures so they become the
        // authoritative (carry-forward) values and any diff is persisted.
        ...(filing && acuseParsed ? { acuse: acuseParsed } : {}),
      });
      await load();
    } catch { setError("No se pudo guardar la declaración federal"); }
    finally { setSavingFederal(false); }
  }

  // Extract the SAT acuse PDF via the existing document parser, then auto-fill
  // the capture fields. We don't persist anything until the user confirms with
  // "Marcar presentada".
  async function handleAcuseUpload(file: File) {
    setAcuseUploading(true);
    setAcuseError(null);
    setAcuseParsed(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/onboarding/parse-document", { method: "POST", body: fd });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "No se pudo leer el acuse");
      if (d.type !== "ACUSE_MENSUAL" || !d.extracted?.acuseMensual) {
        throw new Error(
          `El documento se detectó como "${d.type ?? "desconocido"}". Sube el acuse de la declaración mensual (PDF).`
        );
      }
      const m = d.extracted.acuseMensual as AcuseMensualParsed;
      setAcuseParsed(m);
      setAcuseFileName(file.name);
      if (m.lineaCaptura) setFederalLinea(m.lineaCaptura);
      if (m.fechaPresentacion) setFederalFecha(m.fechaPresentacion.substring(0, 10));
    } catch (e) {
      setAcuseError(e instanceof Error ? e.message : "Error al leer el acuse");
    } finally {
      setAcuseUploading(false);
    }
  }

  async function fileDiot(filing: boolean) {
    if (!activeCompany || !data) return;
    setSavingDiot(true);
    try {
      await post({ action: filing ? "file-diot" : "unfile-diot", acuseUrl: diotAcuse || null });
      await load();
    } catch { setError("No se pudo guardar la DIOT"); }
    finally { setSavingDiot(false); }
  }

  const EstadoBadge = ({ estado }: { estado: Estado }) => {
    const c = ESTADO_CONFIG[estado];
    const Icon = c.icon;
    return (
      <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium ${c.bg} ${c.text}`}>
        <Icon className="h-3.5 w-3.5" /> {c.label}
      </span>
    );
  };

  const montoLabel = (l: FederalLinea) =>
    l.tipoMonto === "favor" ? "a favor" : l.tipoMonto === "enterar" ? "a enterar" : "a pagar";

  return (
    <div className="max-w-3xl mx-auto px-4 py-6">
      {/* Scoped print styles: only #cierre-packet prints. */}
      <style>{`@media print {
        body * { visibility: hidden !important; }
        #cierre-packet, #cierre-packet * { visibility: visible !important; }
        #cierre-packet { position: absolute; left: 0; top: 0; width: 100%; padding: 24px; }
      }`}</style>

      {/* Header */}
      <div className="flex items-center justify-between mb-4 print:hidden">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2"><Lock className="h-5 w-5" /> Cierre mensual</h1>
          <p className="text-sm text-muted-foreground">Revisa, presenta y cierra todas las obligaciones del mes.</p>
        </div>
        <button
          onClick={() => window.print()}
          disabled={!data}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-border text-sm hover:bg-accent disabled:opacity-50"
        >
          <Printer className="h-4 w-4" /> Imprimir paquete
        </button>
      </div>

      {/* Period selector */}
      <div className="flex items-center gap-3 mb-5 print:hidden">
        <button onClick={prevMonth} className="p-1.5 rounded-md border border-border hover:bg-accent"><ChevronLeft className="h-4 w-4" /></button>
        <span className="text-lg font-semibold min-w-[160px] text-center">{MONTHS[month - 1]} {year}</span>
        <button onClick={nextMonth} className="p-1.5 rounded-md border border-border hover:bg-accent"><ChevronRight className="h-4 w-4" /></button>
        {data?.resumen.mesCerrado && (
          <span className="ml-2 inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-green-50 text-green-700">
            <CheckCircle2 className="h-3.5 w-3.5" /> Mes cerrado
          </span>
        )}
      </div>

      {error && <div className="mb-4 p-3 rounded-md bg-red-50 text-red-700 text-sm print:hidden">{error}</div>}
      {loading && <div className="flex items-center gap-2 text-muted-foreground py-12 justify-center"><Loader2 className="h-5 w-5 animate-spin" /> Cargando…</div>}

      {data && !loading && (
        <div className="space-y-5">
          {/* ── Preparación ── */}
          <section className="rounded-lg border border-border p-4 print:hidden">
            <h2 className="font-semibold text-sm mb-3">Preparación</h2>
            <ul className="space-y-2">
              {Object.entries(data.readiness).filter(([, v]) => v.aplica).map(([key, v]) => (
                <li key={key} className="flex items-center gap-2 text-sm">
                  {v.ok
                    ? <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />
                    : <AlertCircle className="h-4 w-4 text-amber-500 shrink-0" />}
                  <span className="font-medium">{READINESS_LABELS[key] ?? key}</span>
                  <span className="text-muted-foreground">— {v.detail}</span>
                </li>
              ))}
            </ul>
          </section>

          {/* ── Declaración federal ── */}
          <section className="rounded-lg border border-border p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-semibold text-sm">Declaración provisional de impuestos federales</h2>
              <EstadoBadge estado={data.federal.estado} />
            </div>

            <table className="w-full text-sm mb-3">
              <tbody>
                {data.federal.lineas.map((l) => (
                  <tr key={l.tipo} className="border-b border-border/50 last:border-0">
                    <td className="py-1.5">{l.descripcion}</td>
                    <td className={`py-1.5 text-right font-medium tabular-nums ${l.tipoMonto === "favor" ? "text-green-600" : ""}`}>
                      {formatCurrency(l.monto)} <span className="text-xs text-muted-foreground">{montoLabel(l)}</span>
                    </td>
                  </tr>
                ))}
                <tr className="font-semibold">
                  <td className="pt-2">Total a pagar</td>
                  <td className="pt-2 text-right tabular-nums text-red-600">{formatCurrency(data.federal.totalAPagar)}</td>
                </tr>
                {data.federal.saldoFavorIva > 0 && (
                  <tr className="text-green-700 text-xs">
                    <td>Saldo a favor de IVA (se arrastra)</td>
                    <td className="text-right tabular-nums">{formatCurrency(data.federal.saldoFavorIva)}</td>
                  </tr>
                )}
              </tbody>
            </table>

            <p className="text-xs text-muted-foreground mb-3">Vence el {formatDate(data.federal.vencimiento)}</p>

            {data.federal.estado === "FILED" ? (
              <>
                <div className="flex items-center justify-between gap-3 rounded-md bg-green-50 p-3 text-sm">
                  <div>
                    <p className="font-medium text-green-800">Presentada {data.federal.fechaPresentacion ? `el ${formatDate(data.federal.fechaPresentacion)}` : ""}</p>
                    {data.federal.lineaCaptura && <p className="text-green-700 text-xs">Línea de captura: {data.federal.lineaCaptura}</p>}
                    <div className="flex items-center gap-3">
                      {data.federal.acusePdfDisponible && data.federal.declaracionId && (
                        <a href={`/api/declaraciones/acuse/${data.federal.declaracionId}`} target="_blank" rel="noreferrer"
                          className="inline-flex items-center gap-1 text-green-700 text-xs underline">
                          <Download className="h-3 w-3" /> Descargar acuse (PDF)
                        </a>
                      )}
                      {data.federal.acuseUrl && <a href={data.federal.acuseUrl} target="_blank" rel="noreferrer" className="text-green-700 text-xs underline">Ver acuse</a>}
                    </div>
                  </div>
                  <button onClick={() => fileFederal(false)} disabled={savingFederal} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-border text-xs hover:bg-white print:hidden">
                    {savingFederal ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />} Revertir
                  </button>
                </div>
                {data.federal.acuseData && <AcuseDiffFlag acuseData={data.federal.acuseData} />}
              </>
            ) : (
              <div className="space-y-3 print:hidden">
                {/* Acuse PDF capture — extracts the filed figures + auto-fills below. */}
                <div className="rounded-md border border-dashed border-border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-medium flex items-center gap-1.5"><Sparkles className="h-3.5 w-3.5" /> ¿Ya la presentaste? Sube el acuse (PDF)</p>
                    <div className="flex items-center gap-2">
                      {/* Si ya tenemos el acuse (lo trajo el backfill), permite descargarlo. */}
                      {data.federal.acusePdfDisponible && data.federal.declaracionId && (
                        <a href={`/api/declaraciones/acuse/${data.federal.declaracionId}`} target="_blank" rel="noreferrer"
                          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-border text-xs hover:bg-accent">
                          <Download className="h-3.5 w-3.5" /> Descargar PDF
                        </a>
                      )}
                      <label className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-border text-xs cursor-pointer hover:bg-accent">
                        {acuseUploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                        {acuseUploading ? "Leyendo…" : "Subir acuse"}
                        <input type="file" accept="application/pdf,.pdf" className="hidden" disabled={acuseUploading}
                          onChange={e => { const f = e.target.files?.[0]; if (f) handleAcuseUpload(f); e.target.value = ""; }} />
                      </label>
                    </div>
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-1">Extraemos línea de captura, fecha y los importes presentados, y los comparamos con lo calculado.</p>
                  {acuseError && <p className="text-xs text-red-600 mt-2">{acuseError}</p>}
                  {acuseParsed && (
                    <AcuseComparison acuse={acuseParsed} federal={data.federal} month={month} year={year} fileName={acuseFileName} />
                  )}
                </div>

                {/* La línea de captura se extrae del acuse al subirlo (o la trae el
                    backfill) — no se captura a mano. Sólo la fecha y, opcional, una URL. */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <input value={federalAcuse} onChange={e => setFederalAcuse(e.target.value)} placeholder="URL del acuse (opcional)"
                    className="px-2.5 py-1.5 rounded-md border border-border text-sm" />
                  <input type="date" value={federalFecha} onChange={e => setFederalFecha(e.target.value)}
                    className="px-2.5 py-1.5 rounded-md border border-border text-sm" />
                </div>
                <button onClick={() => fileFederal(true)} disabled={savingFederal || (!data.federal.calculado && !acuseParsed)}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md bg-foreground text-background text-sm hover:opacity-90 disabled:opacity-50">
                  {savingFederal ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  {acuseParsed ? "Confirmar acuse y marcar presentada" : "Marcar presentada"}
                </button>
                {!data.federal.calculado && !acuseParsed && (
                  <p className="text-xs text-amber-600">Calcula y guarda la declaración en la página de Impuestos, o sube el acuse, antes de marcarla presentada.</p>
                )}
              </div>
            )}
          </section>

          {/* ── Papeles de trabajo ── */}
          {data.federal.lineas.some((l) => PAPEL_BY_TIPO[l.tipo]) && (
            <section className="rounded-lg border border-border p-4 print:hidden">
              <h2 className="font-semibold text-sm flex items-center gap-1.5"><FileText className="h-4 w-4" /> Papeles de trabajo</h2>
              <p className="text-xs text-muted-foreground mb-3">Respaldo auditable de cada cifra de la declaración. Descárgalos en Excel o revísalos a detalle.</p>
              <ul className="divide-y divide-border/50">
                {data.federal.lineas.map((l) => {
                  const papel = PAPEL_BY_TIPO[l.tipo];
                  if (!papel) return null;
                  const qs = `companyId=${activeCompany?.id}&year=${year}&month=${month}`;
                  return (
                    <li key={l.tipo} className="flex items-center justify-between gap-3 py-2 text-sm">
                      <span className="min-w-0">{PAPEL_LABEL[papel]}</span>
                      <span className="flex items-center gap-3 shrink-0">
                        <a href={`/api/papeles/${papel}?${qs}&format=csv`}
                          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                          <Download className="h-3.5 w-3.5" /> Excel
                        </a>
                        <a href={`/impuestos/papeles?tab=${papel}&month=${month}&year=${year}`}
                          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                          <ExternalLink className="h-3.5 w-3.5" /> Ver
                        </a>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {/* ── DIOT ── */}
          {data.diot && (
            <section className="rounded-lg border border-border p-4">
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-semibold text-sm flex items-center gap-1.5"><FileText className="h-4 w-4" /> DIOT</h2>
                <EstadoBadge estado={data.diot.estado} />
              </div>
              <p className="text-sm mb-1">{data.diot.proveedores} proveedor(es) con IVA en el mes</p>
              <p className="text-xs text-muted-foreground mb-3">Vence el {formatDate(data.diot.vencimiento)}</p>
              <a href={`/api/impuestos/diot?companyId=${activeCompany?.id}&month=${month}&year=${year}&format=txt`}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-border text-xs hover:bg-accent mb-3 print:hidden">
                <FileText className="h-3.5 w-3.5" /> Descargar archivo DIOT (.txt)
              </a>

              {data.diot.estado === "FILED" ? (
                <div className="flex items-center justify-between gap-3 rounded-md bg-green-50 p-3 text-sm">
                  <p className="font-medium text-green-800">Presentada {data.diot.fechaPresentacion ? `el ${formatDate(data.diot.fechaPresentacion)}` : ""}</p>
                  <button onClick={() => fileDiot(false)} disabled={savingDiot} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-border text-xs hover:bg-white print:hidden">
                    {savingDiot ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />} Revertir
                  </button>
                </div>
              ) : (
                <div className="flex gap-2 print:hidden">
                  <input value={diotAcuse} onChange={e => setDiotAcuse(e.target.value)} placeholder="URL del acuse (opcional)"
                    className="flex-1 px-2.5 py-1.5 rounded-md border border-border text-sm" />
                  <button onClick={() => fileDiot(true)} disabled={savingDiot}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md bg-foreground text-background text-sm hover:opacity-90 disabled:opacity-50">
                    {savingDiot ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Marcar presentada
                  </button>
                </div>
              )}
            </section>
          )}

          {/* ── Print packet ── */}
          <div id="cierre-packet" className="hidden print:block text-sm">
            <h1 className="text-lg font-bold mb-1">Paquete de cierre — {MONTHS[month - 1]} {year}</h1>
            <p className="mb-4 text-muted-foreground">{activeCompany?.razonSocial ?? activeCompany?.rfc ?? ""}</p>
            <h2 className="font-semibold mb-1">Declaración provisional de impuestos federales</h2>
            <table className="w-full mb-3">
              <tbody>
                {data.federal.lineas.map((l) => (
                  <tr key={l.tipo}><td>{l.descripcion} ({montoLabel(l)})</td><td className="text-right tabular-nums">{formatCurrency(l.monto)}</td></tr>
                ))}
                <tr className="font-semibold border-t border-border"><td>Total a pagar</td><td className="text-right tabular-nums">{formatCurrency(data.federal.totalAPagar)}</td></tr>
              </tbody>
            </table>
            <p>Estado: {ESTADO_CONFIG[data.federal.estado].label}{data.federal.lineaCaptura ? ` · Línea de captura: ${data.federal.lineaCaptura}` : ""}</p>
            <p className="mb-4">Vence el {formatDate(data.federal.vencimiento)}</p>
            {data.diot && (
              <>
                <h2 className="font-semibold mb-1">DIOT</h2>
                <p>{data.diot.proveedores} proveedor(es) · Estado: {ESTADO_CONFIG[data.diot.estado].label} · Vence el {formatDate(data.diot.vencimiento)}</p>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Format an acuse value: the coeficiente is a 4-decimal ratio, everything else is MXN.
function fmtAcuseValue(campo: string, v: number): string {
  return campo === "Coeficiente de utilidad" ? `${(v * 100).toFixed(4)}%` : formatCurrency(v);
}

// Pre-file: what the app computed vs what the acuse says, mismatches highlighted.
function AcuseComparison({ acuse, federal, month, year, fileName }: {
  acuse: AcuseMensualParsed;
  federal: CierreData["federal"];
  month: number; year: number; fileName: string;
}) {
  const ivaLinea = federal.lineas.find((l) => l.tipo === "IVA_MENSUAL");
  const isrLinea = federal.lineas.find((l) => l.tipo === "ISR_PROVISIONAL");
  const rows: { campo: string; computed: number; filed: number | null }[] = [
    { campo: "IVA a pagar", computed: ivaLinea && ivaLinea.tipoMonto === "pagar" ? ivaLinea.monto : 0, filed: acuse.ivaAPagar },
    { campo: "IVA a favor", computed: federal.saldoFavorIva, filed: acuse.ivaAFavor },
    { campo: "ISR a pagar", computed: isrLinea ? isrLinea.monto : 0, filed: acuse.isrAPagar },
  ].filter((r) => r.filed != null || r.computed > 0);

  const periodMismatch =
    acuse.periodoMes != null && acuse.periodoAnio != null &&
    (acuse.periodoMes !== month || acuse.periodoAnio !== year);

  return (
    <div className="mt-3 rounded-md border border-blue-200 bg-blue-50/60 p-3 text-xs space-y-2">
      <p className="flex items-center gap-1.5 font-medium text-blue-900">
        <CheckCircle2 className="h-3.5 w-3.5" /> Acuse leído{fileName ? ` — ${fileName}` : ""}
      </p>
      {periodMismatch && (
        <p className="flex items-start gap-1.5 text-amber-700">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-px" />
          El acuse es del periodo {String(acuse.periodoMes).padStart(2, "0")}/{acuse.periodoAnio}, no {String(month).padStart(2, "0")}/{year}. Verifica que sea el mes correcto.
        </p>
      )}
      <table className="w-full">
        <thead className="text-blue-700/80">
          <tr>
            <th className="text-left font-normal py-0.5">Concepto</th>
            <th className="text-right font-normal">Calculado</th>
            <th className="text-right font-normal">Acuse</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const mism = r.filed != null && Math.abs(r.filed - r.computed) > 1;
            return (
              <tr key={r.campo} className={mism ? "text-amber-800" : "text-blue-900"}>
                <td className="py-0.5">{r.campo}{mism ? " ⚠️" : ""}</td>
                <td className="text-right tabular-nums">{formatCurrency(r.computed)}</td>
                <td className="text-right tabular-nums font-medium">{r.filed != null ? formatCurrency(r.filed) : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="text-blue-800/90 space-y-0.5 pt-1 border-t border-blue-200">
        {acuse.coeficienteUtilidadAplicado != null && <p>Coeficiente aplicado: <strong>{(acuse.coeficienteUtilidadAplicado * 100).toFixed(4)}%</strong></p>}
        {acuse.lineaCaptura && <p>Línea de captura: <strong>{acuse.lineaCaptura}</strong></p>}
        {acuse.fechaPresentacion && <p>Fecha de presentación: <strong>{acuse.fechaPresentacion.substring(0, 10)}</strong></p>}
      </div>
      <p className="text-[11px] text-blue-700/80">
        Al confirmar se guardan los valores del acuse como definitivos (alimentan el arrastre de saldo a favor y coeficiente). Las diferencias quedan registradas.
      </p>
    </div>
  );
}

// Filed: a persisted flag when the acuse disagreed with the app's computation.
function AcuseDiffFlag({ acuseData }: { acuseData: AcuseData }) {
  if (!acuseData.diffs?.length) return null;
  return (
    <div className="mt-2 rounded-md bg-amber-50 border border-amber-200 p-3 text-xs print:hidden">
      <p className="flex items-center gap-1.5 font-medium text-amber-800 mb-1.5">
        <AlertTriangle className="h-3.5 w-3.5" /> El acuse presentado no coincide con lo calculado
      </p>
      <table className="w-full">
        <thead className="text-amber-700/80">
          <tr>
            <th className="text-left font-normal py-0.5">Concepto</th>
            <th className="text-right font-normal">Calculado</th>
            <th className="text-right font-normal">Acuse</th>
            <th className="text-right font-normal">Diferencia</th>
          </tr>
        </thead>
        <tbody>
          {acuseData.diffs.map((d) => (
            <tr key={d.campo} className="text-amber-900">
              <td className="py-0.5">{d.campo}</td>
              <td className="text-right tabular-nums">{fmtAcuseValue(d.campo, d.computed)}</td>
              <td className="text-right tabular-nums">{fmtAcuseValue(d.campo, d.filed)}</td>
              <td className="text-right tabular-nums font-medium">{fmtAcuseValue(d.campo, d.delta)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-amber-700/80 mt-1.5">
        Se guardaron los valores del acuse (lo presentado ante el SAT). Si la declaración tiene un error, considera una complementaria.
      </p>
    </div>
  );
}
