"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { Card, Money, Loading } from "@/components/ui";
import {
  ChevronLeft, ChevronRight, Upload, Download, Loader2, RotateCcw,
  CheckCircle2, AlertTriangle, CalendarDays, Sparkles, Printer, SlidersHorizontal, ChevronRight as ChevronR, FileWarning,
} from "lucide-react";
import Link from "next/link";
import { IvaPanel, IsrPanel, RetencionesPanel } from "@/components/papeles/panels";
import { FaltantesUploader } from "@/components/declaraciones/FaltantesUploader";

// ── Types (mirror /api/impuestos/cierre and /api/papeles/iva) ──────────────────
type Estado = "FILED" | "PENDING" | "OVERDUE" | "UPCOMING";
interface FederalLinea { tipo: string; descripcion: string; monto: number; tipoMonto: "pagar" | "favor" | "enterar"; }
interface AcuseMensualParsed {
  rfc: string | null; periodoMes: number | null; periodoAnio: number | null;
  ivaAPagar: number | null; ivaAFavor: number | null;
  isrIngresos: number | null; isrPagosAnteriores: number | null; isrAPagar: number | null;
  coeficienteUtilidadAplicado: number | null; lineaCaptura: string | null; fechaPresentacion: string | null;
}
interface AsimiladosResumen {
  recibos: { id: string; uuid: string | null; fecha: string; emisor: string; rfc: string; regimenLabel: string | null; ingreso: number; isrRetenido: number; esDelMes: boolean }[];
  mes: { ingreso: number; isrRetenido: number };
  anual: { ingreso: number; isrRetenido: number };
}
interface CierreData {
  periodo: string; month: number; year: number;
  asimilados: AsimiladosResumen | null;
  federal: {
    lineas: FederalLinea[]; totalAPagar: number; saldoFavorIva: number;
    vencimiento: string; estado: Estado;
    lineaCaptura: string | null; acuseUrl: string | null; fechaPresentacion: string | null;
    declaracionId: string | null; acusePdfDisponible: boolean; calculado: boolean;
  };
  diot: { aplica: boolean; proveedores: number; vencimiento: string; estado: Estado; acuseUrl: string | null; fechaPresentacion: string | null } | null;
}
interface AcuseFaltante { tipo: "DECLARACION_ANUAL" | "IVA_MENSUAL" | "ISR_PROVISIONAL"; periodo: string; etiqueta: string; motivo: string; critico?: boolean; }
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
  // Roving focus for the tablist (APG keyboard pattern: ←/→/Home/End).
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const [data, setData] = useState<CierreData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Presentar
  const [fecha, setFecha] = useState("");
  const [saving, setSaving] = useState(false);
  const [acuseParsed, setAcuseParsed] = useState<AcuseMensualParsed | null>(null);
  const [acuseUploading, setAcuseUploading] = useState(false);
  const [acuseError, setAcuseError] = useState("");
  const [diotAcuse, setDiotAcuse] = useState("");
  const [savingDiot, setSavingDiot] = useState(false);

  // Auditor findings (company-wide) — drive the Revisión tab + its count badge.
  const [flags, setFlags] = useState<HallazgoDTO[] | null>(null);
  const loadFlags = useCallback(async () => {
    if (!activeCompany) return;
    const res = await fetch(`/api/hallazgos?companyId=${activeCompany.id}&estado=ABIERTO`);
    if (res.ok) { const d = await res.json(); setFlags(d.hallazgos ?? []); }
  }, [activeCompany]);
  useEffect(() => { loadFlags(); }, [loadFlags]);

  // Missing prior acuses for THIS company — gaps in the carry-forward chain
  // (saldo a favor, coeficiente, pagos provisionales) behind the numbers shown.
  const [faltantes, setFaltantes] = useState<AcuseFaltante[]>([]);
  const loadFaltantes = useCallback(async () => {
    if (!activeCompany) return;
    const res = await fetch(`/api/declaraciones/cobertura?companyId=${activeCompany.id}`);
    if (res.ok) { const d = await res.json(); setFaltantes(d?.empresas?.[0]?.faltantes ?? []); }
  }, [activeCompany]);
  useEffect(() => { loadFaltantes(); }, [loadFaltantes]);

  // Honor deep-links from the Control Tower (?month=&year=&tab=). Read the URL
  // directly to avoid forcing a Suspense boundary (useSearchParams).
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const m = parseInt(sp.get("month") ?? ""); if (m >= 1 && m <= 12) setMonth(m);
    const y = parseInt(sp.get("year") ?? ""); if (y >= 2000 && y <= 2100) setYear(y);
    const t = sp.get("tab");
    if (t === "resumen" || t === "papeles" || t === "revision" || t === "presentar") setTab(t);
  }, []);

  const load = useCallback(async () => {
    if (!activeCompany) return;
    setLoading(true); setError("");
    try {
      const res = await fetch(`/api/impuestos/cierre?companyId=${activeCompany.id}&month=${month}&year=${year}`);
      if (!res.ok) throw new Error();
      const d: CierreData = await res.json();
      setData(d);
      setFecha(d.federal.fechaPresentacion ? d.federal.fechaPresentacion.substring(0, 10) : "");
      setDiotAcuse(d.diot?.acuseUrl ?? "");
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

  async function fileDiot(filing: boolean) {
    if (!activeCompany || !data) return;
    setSavingDiot(true);
    try {
      await post({ action: filing ? "file-diot" : "unfile-diot", acuseUrl: diotAcuse || null });
      await load();
    } catch { setError("No se pudo guardar la DIOT"); }
    finally { setSavingDiot(false); }
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
          <button onClick={() => shiftMonth(-1)} aria-label="Mes anterior" className="grid h-8 w-8 place-items-center rounded-control border border-cos-line hover:bg-cos-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cos-brand-tint"><ChevronLeft className="h-4 w-4" /></button>
          <span aria-live="polite" className="min-w-[120px] text-center">{MONTHS[month - 1]} {year}</span>
          <button onClick={() => shiftMonth(1)} aria-label="Mes siguiente" className="grid h-8 w-8 place-items-center rounded-control border border-cos-line hover:bg-cos-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cos-brand-tint"><ChevronRight className="h-4 w-4" /></button>
        </div>
      </div>

      <FaltantesBanner
        faltantes={faltantes}
        empresa={{ companyId: activeCompany.id, rfc: activeCompany.rfc, razonSocial: activeCompany.razonSocial }}
        onUploaded={() => { loadFaltantes(); load(); }}
      />

      {/* Tabs */}
      <div role="tablist" aria-label="Secciones de la declaración" className="mt-5 flex gap-1 border-b border-cos-line">
        {TABS.map((t, i) => (
          <button
            key={t.id}
            role="tab"
            id={`tab-${t.id}`}
            ref={(el) => { tabRefs.current[i] = el; }}
            aria-selected={tab === t.id}
            aria-controls="tabpanel-declaracion"
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => setTab(t.id)}
            onKeyDown={(e) => {
              const last = TABS.length - 1;
              let next: number | null = null;
              if (e.key === "ArrowRight") next = i === last ? 0 : i + 1;
              else if (e.key === "ArrowLeft") next = i === 0 ? last : i - 1;
              else if (e.key === "Home") next = 0;
              else if (e.key === "End") next = last;
              if (next === null) return;
              e.preventDefault();
              setTab(TABS[next].id);
              tabRefs.current[next]?.focus();
            }}
            className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-3.5 py-2 text-[14px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cos-brand-tint ${
              tab === t.id ? "border-cos-brand text-cos-brand-ink" : "border-transparent text-cos-ink-soft hover:text-cos-ink"
            }`}
          >
            {t.label}
            {t.id === "revision" && flags && flags.length > 0 && (
              <span aria-label={`${flags.length} por revisar`} className="grid h-[18px] min-w-[18px] place-items-center rounded-full bg-cos-red-tint px-1 text-[11px] font-semibold text-cos-red-ink">{flags.length}</span>
            )}
          </button>
        ))}
      </div>

      {loading || !data ? (
        <Loading label="Cargando…" className="py-16" />
      ) : (
        <div id="tabpanel-declaracion" role="tabpanel" aria-labelledby={`tab-${tab}`} className="mt-5">
          {tab === "resumen" && <Resumen data={data} companyId={activeCompany.id} month={month} year={year} />}
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
              companyId={activeCompany.id} month={month} year={year}
              diotAcuse={diotAcuse} setDiotAcuse={setDiotAcuse} savingDiot={savingDiot} onFileDiot={fileDiot}
            />
          )}
        </div>
      )}
      {error && <p className="mt-4 flex items-center gap-1.5 text-[13px] text-cos-red-ink"><AlertTriangle className="h-4 w-4" /> {error}</p>}
    </div>
  );
}

function FaltantesBanner({ faltantes, empresa, onUploaded }: {
  faltantes: AcuseFaltante[];
  empresa: { companyId: string; rfc: string; razonSocial: string };
  onUploaded: () => void;
}) {
  const [abierto, setAbierto] = useState(false);
  if (faltantes.length === 0) return null;
  // Sólo los faltantes CRÍTICOS (anual del año previo, IVA dic previo, meses del
  // año en curso) afectan el arrastre de este mes. Las anuales más viejas son
  // históricas: no disparan la alarma de "números incompletos".
  const criticos = faltantes.filter((f) => f.critico);
  const hayCriticos = criticos.length > 0;
  const muestra = (hayCriticos ? criticos : faltantes).slice(0, 4).map((f) => f.etiqueta).join(" · ");
  const toggle = (
    <button onClick={() => setAbierto((v) => !v)}
      className="mt-0.5 inline-flex flex-none items-center gap-1 font-semibold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cos-amber rounded">
      {abierto ? "Ocultar" : "Capturar aquí"} <ChevronR className={`h-3.5 w-3.5 transition-transform ${abierto ? "rotate-90" : ""}`} />
    </button>
  );
  return (
    <div className={`mt-4 rounded-card border ${hayCriticos ? "border-cos-amber bg-cos-amber-tint" : "border-cos-line bg-cos-paper"}`}>
      {hayCriticos ? (
        <div className="flex items-start gap-2.5 px-4 py-3 text-[13px] text-cos-amber-ink">
          <FileWarning className="mt-0.5 h-4 w-4 flex-none" />
          <span className="flex-1">
            Faltan <b>{criticos.length} acuse(s)</b> de esta empresa — sin ellos no podemos arrastrar bien
            el saldo a favor, el coeficiente de utilidad ni los pagos provisionales. Los números de abajo pueden
            estar incompletos. <span className="text-cos-amber-ink/80">{muestra}{criticos.length > 4 ? "…" : ""}</span>
          </span>
          {toggle}
        </div>
      ) : (
        <div className="flex items-start gap-2.5 px-4 py-3 text-[13px] text-cos-ink-soft">
          <FileWarning className="mt-0.5 h-4 w-4 flex-none text-cos-ink-faint" />
          <span className="flex-1">
            Tienes <b>{faltantes.length} declaración(es) histórica(s)</b> sin capturar — <b>no afectan</b> el cálculo de
            este mes; captúralas cuando puedas para el expediente. <span className="text-cos-ink-faint">{muestra}{faltantes.length > 4 ? "…" : ""}</span>
          </span>
          {toggle}
        </div>
      )}
      {abierto && (
        <div className="border-t border-cos-amber/40 p-3">
          <FaltantesUploader
            empresas={[{ companyId: empresa.companyId, rfc: empresa.rfc, razonSocial: empresa.razonSocial, faltantes: faltantes.map((f) => ({ ...f, companyId: empresa.companyId })) }]}
            compact
            onUploaded={onUploaded}
          />
          <Link href="/declaraciones" className="mt-2 inline-block text-[12px] font-medium text-cos-amber-ink hover:underline">Ver todas las empresas →</Link>
        </div>
      )}
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

function Resumen({ data, companyId, month, year }: { data: CierreData; companyId: string; month: number; year: number }) {
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

      {data.asimilados && (
        <Card className="rounded-card border-cos-line p-5 shadow-card">
          <span className="block text-[12.5px] font-medium uppercase tracking-[0.02em] text-cos-ink-faint">Asimilados a salarios</span>
          <table className="mt-3 w-full text-[14px]">
            <tbody>
              <tr className="border-b border-cos-line-soft">
                <td className="py-2 text-cos-ink-soft">Ingresos del mes</td>
                <td className="py-2 text-right"><Money value={data.asimilados.mes.ingreso} size={15} weight={600} /></td>
              </tr>
              <tr className="border-b border-cos-line-soft">
                <td className="py-2 text-cos-ink-soft">ISR que te retuvieron (pago provisional)</td>
                <td className="py-2 text-right"><Money value={data.asimilados.mes.isrRetenido} size={15} weight={600} /></td>
              </tr>
              <tr className="text-cos-jade-ink">
                <td className="py-2 text-[13px]">ISR que te retuvieron en {year} (acreditable en la anual)</td>
                <td className="py-2 text-right"><Money value={data.asimilados.anual.isrRetenido} size={14} weight={600} /></td>
              </tr>
            </tbody>
          </table>
          <p className="mt-2 text-[12.5px] text-cos-ink-faint">
            Art. 94: el pagador retiene y entera el ISR — no entra a tu base de actividad empresarial; se acredita en la declaración anual.
          </p>
        </Card>
      )}

      {/* Expert depth: precierre, saldo a favor, REP y sincronización con el SAT. */}
      <a href={`/impuestos/detalle?month=${month}&year=${year}`}
        className="flex items-center gap-3 rounded-card border border-dashed border-cos-line bg-white px-5 py-4 text-[14px] text-cos-ink-soft hover:border-cos-brand hover:text-cos-brand-ink">
        <SlidersHorizontal className="h-[18px] w-[18px] flex-none" />
        <span className="flex-1">Cálculo a detalle — precierre, saldo a favor, complementos de pago y sincronizar con el SAT</span>
        <ChevronR className="h-4 w-4 flex-none" />
      </a>

      <Simulador companyId={companyId} month={month} year={year} />
    </div>
  );
}

// "What if I bill one more ingreso/gasto?" — debounced against the real fiscal
// engine (/api/impuestos/simular), ported from the old Impuestos page.
function Simulador({ companyId, month, year }: { companyId: string; month: number; year: number }) {
  const [addIng, setAddIng] = useState("");
  const [addGas, setAddGas] = useState("");
  const [sim, setSim] = useState<{ base: { iva: number; isr: number | null; total: number }; sim: { iva: number; isr: number | null; total: number } } | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  useEffect(() => { setAddIng(""); setAddGas(""); setSim(null); }, [companyId, month, year]);

  useEffect(() => {
    const ai = parseFloat(addIng) || 0;
    const ag = parseFloat(addGas) || 0;
    if (ai <= 0 && ag <= 0) { setSim(null); setBusy(false); return; }
    setBusy(true);
    const s = ++seq.current;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/impuestos/simular?companyId=${companyId}&month=${month}&year=${year}&addIngreso=${ai}&addGasto=${ag}`);
        const json = await res.json();
        if (s === seq.current) setSim(json);
      } finally { if (s === seq.current) setBusy(false); }
    }, 350);
    return () => clearTimeout(t);
  }, [addIng, addGas, companyId, month, year]);

  const on = (parseFloat(addIng) || 0) > 0 || (parseFloat(addGas) || 0) > 0;
  return (
    <Card className="rounded-card border-cos-line p-5 shadow-card">
      <div className="mb-4 flex items-start gap-3">
        <span className="grid h-[30px] w-[30px] flex-none place-items-center rounded-[9px] bg-cos-brand text-white"><Sparkles className="h-4 w-4" /></span>
        <div>
          <h3 className="text-[17px] font-semibold text-cos-ink">Simula antes de facturar</h3>
          <p className="mt-1 max-w-[54ch] text-[13.5px] text-cos-ink-soft">¿Qué pasa con tus impuestos si facturas un ingreso o un gasto más? Escribe un monto y míralo al instante — con tu cálculo real.</p>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
        <SimInput label="+ Ingreso (sin IVA)" value={addIng} onChange={setAddIng} />
        <SimInput label="+ Gasto con factura (sin IVA)" value={addGas} onChange={setAddGas} />
      </div>
      {on ? (
        <div className="mt-[18px] grid grid-cols-1 gap-3 border-t border-cos-line pt-[18px] sm:grid-cols-3">
          <SimOut label="Nuevo IVA" value={sim?.sim.iva ?? null} base={sim?.base.iva ?? null} busy={busy} />
          <SimOut label="Nuevo ISR" value={sim?.sim.isr ?? null} base={sim?.base.isr ?? null} busy={busy} />
          <SimOut label="Nuevo total" value={sim?.sim.total ?? null} base={sim?.base.total ?? null} busy={busy} highlight />
        </div>
      ) : (
        <p className="mt-4 text-[13.5px] text-cos-ink-faint">Escribe un monto arriba para ver el impacto.</p>
      )}
    </Card>
  );
}

function SimInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex flex-col gap-2 text-[13px] font-medium text-cos-ink-soft">
      <span>{label}</span>
      <div className="flex items-center gap-1.5 rounded-control border border-cos-line bg-white px-3.5 focus-within:border-cos-brand focus-within:ring-[3px] focus-within:ring-cos-brand-tint">
        <i className="font-mono not-italic text-cos-ink-faint">$</i>
        <input type="number" inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} placeholder="0.00" className="w-full border-0 bg-transparent py-3 font-mono text-[16px] text-cos-ink outline-none" />
      </div>
    </label>
  );
}

function SimOut({ label, value, base, busy, highlight }: { label: string; value: number | null; base: number | null; busy: boolean; highlight?: boolean }) {
  const peso = (n: number) => "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const delta = value != null && base != null ? value - base : null;
  return (
    <div className={`flex flex-col gap-1 rounded-[12px] p-3.5 ${highlight ? "bg-cos-brand-tint" : "bg-cos-paper"}`}>
      <span className="text-[12px] font-medium text-cos-ink-faint">{label}</span>
      {busy && value == null ? (
        <Loader2 className="h-5 w-5 animate-spin text-cos-ink-faint" />
      ) : value == null ? (
        <span className="font-mono text-[20px] font-bold text-cos-ink-faint">—</span>
      ) : (
        <>
          <Money value={value} size={20} weight={700} />
          {delta != null && (Math.abs(delta) < 0.005
            ? <span className="font-mono text-[12px] font-medium text-cos-ink-faint">sin cambio</span>
            : <span className={`font-mono text-[12px] font-medium ${delta > 0 ? "text-cos-red-ink" : "text-cos-jade-ink"}`}>{delta > 0 ? "▲" : "▼"} {peso(delta)}</span>)}
        </>
      )}
    </div>
  );
}

function PapelesTab({ companyId, month, year, onChanged }: { companyId: string; month: number; year: number; onChanged: () => void }) {
  const [sub, setSub] = useState<"iva" | "isr" | "retenciones">("iva");
  const [isr, setIsr] = useState<PapelIsr | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // Fetched only to drive the editable coeficiente (current/suggested + régimen).
  // The read-only panels below fetch their own data.
  useEffect(() => {
    fetch(`/api/papeles/isr?companyId=${companyId}&month=${month}&year=${year}`)
      .then((r) => (r.ok ? r.json() : null)).then(setIsr).catch(() => {});
  }, [companyId, month, year, refreshKey]);

  // After saving the coeficiente: remount the ISR panel (so its cálculo updates)
  // and refresh the parent Resumen/Presentar so the total a pagar reflects it.
  const afterEdit = useCallback(() => { setRefreshKey((k) => k + 1); onChanged(); }, [onChanged]);

  const subTabs = [["iva", "IVA"], ["isr", "ISR provisional"], ["retenciones", "Retenciones"]] as const;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-control border border-cos-line p-0.5">
          {subTabs.map(([id, label]) => (
            <button key={id} onClick={() => setSub(id)}
              className={`rounded-[7px] px-3 py-1.5 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cos-brand-tint ${sub === id ? "bg-cos-brand text-white" : "text-cos-ink-soft hover:text-cos-ink"}`}>
              {label}
            </button>
          ))}
        </div>
        <a href={`/impuestos/papeles?tab=${sub}&month=${month}&year=${year}`} target="_blank" rel="noreferrer"
          className="inline-flex items-center gap-1.5 rounded-control border border-cos-line px-3 py-1.5 text-[13px] hover:bg-cos-paper">
          <Printer className="h-3.5 w-3.5" /> Imprimir / versión completa
        </a>
      </div>

      {sub === "iva" && <IvaPanel companyId={companyId} year={year} month={month} />}
      {sub === "isr" && (
        <div className="space-y-4">
          {isr && isr.calculo.tipo === "art14" && (
            <CoeficienteCard companyId={companyId} year={year} isr={isr} onSaved={afterEdit} />
          )}
          <IsrPanel key={`isr-${refreshKey}`} companyId={companyId} year={year} month={month} />
        </div>
      )}
      {sub === "retenciones" && <RetencionesPanel companyId={companyId} year={year} month={month} />}
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

  return (
    <Card className="rounded-card border-cos-line p-5 shadow-card">
      <span className="block text-[12.5px] font-medium uppercase tracking-[0.02em] text-cos-ink-faint">ISR provisional — coeficiente de utilidad (Art. 14)</span>
      <p className="mt-1 text-[12px] text-cos-ink-faint">Ajusta el coeficiente y el cálculo de abajo se recalcula.</p>

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
  companyId, month, year, diotAcuse, setDiotAcuse, savingDiot, onFileDiot,
}: {
  data: CierreData; fecha: string; setFecha: (s: string) => void; saving: boolean;
  acuseParsed: AcuseMensualParsed | null; acuseUploading: boolean; acuseError: string;
  onUpload: (f: File) => void; onFile: (filing: boolean) => void;
  companyId: string; month: number; year: number;
  diotAcuse: string; setDiotAcuse: (s: string) => void; savingDiot: boolean; onFileDiot: (filing: boolean) => void;
}) {
  const f = data.federal;
  return (
    <div className="space-y-4">
      <FederalPresentar
        f={f} fecha={fecha} setFecha={setFecha} saving={saving}
        acuseParsed={acuseParsed} acuseUploading={acuseUploading} acuseError={acuseError}
        onUpload={onUpload} onFile={onFile}
      />
      {data.diot?.aplica && (
        <Card className="rounded-card border-cos-line p-5 shadow-card">
          <div className="flex items-center justify-between">
            <span className="block text-[12.5px] font-medium uppercase tracking-[0.02em] text-cos-ink-faint">DIOT</span>
            <EstadoBadge estado={data.diot.estado} />
          </div>
          <p className="mt-2 text-[14px] text-cos-ink">{data.diot.proveedores} proveedor(es) con IVA · vence {fmtFecha(data.diot.vencimiento)}</p>
          <a href={`/api/impuestos/diot?companyId=${companyId}&month=${month}&year=${year}&format=txt`}
            className="mt-2 inline-flex items-center gap-1.5 rounded-control border border-cos-line px-2.5 py-1.5 text-[12.5px] hover:bg-cos-paper">
            <Download className="h-3.5 w-3.5" /> Descargar archivo DIOT (.txt)
          </a>
          {data.diot.estado === "FILED" ? (
            <div className="mt-3 flex items-center justify-between gap-3 rounded-md bg-cos-jade-tint p-3">
              <p className="flex items-center gap-1.5 text-[13px] font-medium text-cos-jade-ink">
                <CheckCircle2 className="h-4 w-4" /> Presentada {data.diot.fechaPresentacion ? `el ${fmtFecha(data.diot.fechaPresentacion)}` : ""}
              </p>
              <button onClick={() => onFileDiot(false)} disabled={savingDiot} className="inline-flex items-center gap-1 rounded-control border border-cos-line px-2.5 py-1.5 text-[12.5px] hover:bg-white disabled:opacity-50">
                {savingDiot ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />} Revertir
              </button>
            </div>
          ) : (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <input value={diotAcuse} onChange={(e) => setDiotAcuse(e.target.value)} placeholder="URL del acuse (opcional)"
                className="min-w-[200px] flex-1 rounded-control border border-cos-line px-2.5 py-2 text-[13px]" />
              <button onClick={() => onFileDiot(true)} disabled={savingDiot}
                className="inline-flex items-center gap-1.5 rounded-control bg-cos-brand px-3 py-2 text-[13px] font-semibold text-white hover:bg-cos-brand-deep disabled:opacity-50">
                {savingDiot ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Marcar presentada
              </button>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

function FederalPresentar({
  f, fecha, setFecha, saving, acuseParsed, acuseUploading, acuseError, onUpload, onFile,
}: {
  f: CierreData["federal"]; fecha: string; setFecha: (s: string) => void; saving: boolean;
  acuseParsed: AcuseMensualParsed | null; acuseUploading: boolean; acuseError: string;
  onUpload: (f: File) => void; onFile: (filing: boolean) => void;
}) {
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
