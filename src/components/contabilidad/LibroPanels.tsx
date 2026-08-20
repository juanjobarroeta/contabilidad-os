"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Libro diario, auxiliar de cuenta y balance general — la capa visible de las
// pólizas. El folio que se muestra es el MISMO NumUnIdenPol del XML del Anexo
// 24 (misma agrupación derivada — ver lib/contabilidad/libro.ts). Drill-down:
// balanza → auxiliar → póliza → CFDI (representación impresa).
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, Scale, ScrollText, CheckCircle2, AlertTriangle, X, Plus, Pencil, Trash2 } from "lucide-react";
import { Money } from "@/components/ui";
import { formatCurrency } from "@/lib/utils";
import { RepresentacionImpresa } from "@/components/facturas/RepresentacionImpresa";
import { BotonExcel } from "@/components/contabilidad/BotonExcel";

const FUENTE_LABEL: Record<string, string> = {
  CFDI: "CFDI", NOMINA: "Nómina", BANCO: "Banco", MANUAL: "Manual",
  APERTURA: "Apertura", CIERRE: "Cierre", CONSTRUCCION: "Construcción",
  FLOTA: "Flota", PADEL: "Padel", PURIFICADORA: "Purificadora",
  RESTAURANTE: "Restaurante", AUTOMOTRIZ: "Automotriz", JCPT: "JCPT",
};

interface PolizaVista {
  folio: string;
  fecha: string;
  concepto: string;
  fuente: string;
  referencia: string | null;
  referenciaTipo: string | null;
  totalCargos: number;
  totalAbonos: number;
  cuadrada: boolean;
  transacciones: Array<{ entryId: string; numCta: string; desCta: string; concepto: string; cargo: number; abono: number }>;
}

function Cargando() {
  return (
    <div className="flex items-center gap-2 text-sm text-cos-ink-soft py-8 justify-center">
      <Loader2 className="h-4 w-4 animate-spin" /> Cargando…
    </div>
  );
}

function Vacio({ texto }: { texto: string }) {
  return (
    <div className="bg-cos-card border border-dashed border-cos-line rounded-xl p-12 text-center">
      <ScrollText className="h-10 w-10 text-cos-ink-soft mx-auto mb-3 opacity-30" />
      <p className="text-sm text-cos-ink-soft">{texto}</p>
    </div>
  );
}

// ── Libro diario ─────────────────────────────────────────────────────────────

export function LibroDiarioPanel({ companyId, year, month }: { companyId: string; year: number; month: number }) {
  const [polizas, setPolizas] = useState<PolizaVista[]>([]);
  const [invoiceIdPorUuid, setInvoiceIdPorUuid] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [abierta, setAbierta] = useState<string | null>(null);
  const [repInvoiceId, setRepInvoiceId] = useState<string | null>(null);
  // Editor de pólizas manuales: null = cerrado; sin referencia = nueva.
  const [editor, setEditor] = useState<{ poliza: PolizaVista | null } | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const res = await fetch(`/api/contabilidad/libro-diario?companyId=${companyId}&year=${year}&month=${month}`);
      const d = await res.json();
      setPolizas(d.polizas ?? []);
      setInvoiceIdPorUuid(d.invoiceIdPorUuid ?? {});
      setLoading(false);
    })();
  }, [companyId, year, month, reload]);

  async function borrarManual(p: PolizaVista) {
    if (!p.referencia) return;
    if (!confirm(`¿Borrar la póliza manual «${p.concepto}»?`)) return;
    const res = await fetch(
      `/api/contabilidad/polizas-manuales?companyId=${companyId}&referencia=${encodeURIComponent(p.referencia)}`,
      { method: "DELETE" }
    );
    if (res.ok) setReload((n) => n + 1);
    else alert((await res.json().catch(() => null))?.error ?? "No se pudo borrar");
  }

  const botonNueva = (
    <button
      onClick={() => setEditor({ poliza: null })}
      className="inline-flex items-center gap-1.5 rounded-lg bg-cos-brand px-3 py-1.5 text-xs font-semibold text-white hover:bg-cos-brand-deep"
    >
      <Plus className="h-3.5 w-3.5" /> Nueva póliza manual
    </button>
  );

  const editorModal = editor && (
    <PolizaManualModal
      companyId={companyId}
      year={year}
      month={month}
      poliza={editor.poliza}
      onClose={() => setEditor(null)}
      onSaved={() => { setEditor(null); setReload((n) => n + 1); }}
    />
  );

  if (loading) return <Cargando />;
  if (polizas.length === 0) {
    return (
      <div>
        <div className="mb-3 flex justify-end print:hidden">{botonNueva}</div>
        <Vacio texto="Sin pólizas en este periodo. Cierra el mes desde «Cierres mensuales» o captura una póliza manual." />
        {editorModal}
      </div>
    );
  }

  const totalCargos = polizas.reduce((s, p) => s + p.totalCargos, 0);
  const totalAbonos = polizas.reduce((s, p) => s + p.totalAbonos, 0);

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-xs text-cos-ink-soft">
          {polizas.length} póliza{polizas.length === 1 ? "" : "s"} · el folio coincide con el XML de Pólizas del Periodo (Anexo 24)
          · cargos {formatCurrency(totalCargos)} · abonos {formatCurrency(totalAbonos)}
        </p>
        <div className="flex items-center gap-2 print:hidden">
          <BotonExcel
            href={`/api/contabilidad/libro-diario?companyId=${companyId}&year=${year}&month=${month}&format=xlsx`}
            label="Libro diario en Excel"
          />
          {botonNueva}
        </div>
      </div>
      <div className="bg-cos-card border border-cos-line rounded-xl overflow-hidden print:overflow-visible">
        {polizas.map((p) => {
          const abiertaEsta = abierta === p.folio;
          return (
            <div key={p.folio} className="border-b border-cos-line last:border-0">
              <button
                onClick={() => setAbierta(abiertaEsta ? null : p.folio)}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-cos-paper/50"
              >
                {abiertaEsta ? <ChevronDown className="h-4 w-4 text-cos-ink-faint" /> : <ChevronRight className="h-4 w-4 text-cos-ink-faint" />}
                <span className="font-mono text-xs text-cos-ink-soft w-10">#{p.folio}</span>
                <span className="font-mono text-xs text-cos-ink-soft w-20">{p.fecha}</span>
                <span className="flex-1 min-w-0 truncate text-sm text-cos-ink">{p.concepto}</span>
                <span className="rounded-full bg-cos-slate-tint px-2 py-0.5 text-[11px] text-cos-ink-soft">{FUENTE_LABEL[p.fuente] ?? p.fuente}</span>
                <span className="font-mono text-xs w-28 text-right">{formatCurrency(p.totalCargos)}</span>
                {p.cuadrada ? (
                  <CheckCircle2 className="h-4 w-4 text-cos-jade-ink" aria-label="Cuadrada" />
                ) : (
                  <AlertTriangle className="h-4 w-4 text-cos-amber-ink" aria-label="Descuadrada" />
                )}
              </button>
              {abiertaEsta && (
                <div className="px-11 pb-3">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-cos-ink-faint">
                        <th className="text-left py-1 font-medium">Cuenta</th>
                        <th className="text-left py-1 font-medium">Concepto</th>
                        <th className="text-right py-1 font-medium">Cargo</th>
                        <th className="text-right py-1 font-medium">Abono</th>
                      </tr>
                    </thead>
                    <tbody>
                      {p.transacciones.map((t) => (
                        <tr key={t.entryId} className="border-t border-cos-line/60">
                          <td className="py-1 pr-3 font-mono whitespace-nowrap">{t.numCta} <span className="font-sans text-cos-ink-soft">{t.desCta}</span></td>
                          <td className="py-1 pr-3 text-cos-ink-soft">{t.concepto}</td>
                          <td className="py-1 text-right font-mono">{t.cargo > 0 ? formatCurrency(t.cargo) : "—"}</td>
                          <td className="py-1 text-right font-mono">{t.abono > 0 ? formatCurrency(t.abono) : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="mt-2 flex items-center gap-3 print:hidden">
                    {p.referenciaTipo === "CFDI" && p.referencia && invoiceIdPorUuid[p.referencia] && (
                      <button
                        onClick={() => setRepInvoiceId(invoiceIdPorUuid[p.referencia!])}
                        className="text-[11.5px] font-medium text-cos-brand-ink underline hover:opacity-80"
                      >
                        Ver CFDI {p.referencia.slice(0, 8)}…
                      </button>
                    )}
                    {p.fuente === "MANUAL" && p.referenciaTipo === "POLIZA" && p.referencia && (
                      <>
                        <button onClick={() => setEditor({ poliza: p })}
                          className="inline-flex items-center gap-1 text-[11.5px] font-medium text-cos-brand-ink underline hover:opacity-80">
                          <Pencil className="h-3 w-3" /> Editar
                        </button>
                        <button onClick={() => borrarManual(p)}
                          className="inline-flex items-center gap-1 text-[11.5px] font-medium text-cos-red-ink underline hover:opacity-80">
                          <Trash2 className="h-3 w-3" /> Borrar
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {repInvoiceId && <RepresentacionImpresa invoiceId={repInvoiceId} onClose={() => setRepInvoiceId(null)} />}
      {editorModal}
    </div>
  );
}

// ── Editor de pólizas manuales ───────────────────────────────────────────────

interface CuentaOpcion { codigo: string; nombre: string; nivel: number }

interface LineaEdit { cuenta: string; concepto: string; cargo: string; abono: string }

function PolizaManualModal({
  companyId, year, month, poliza, onClose, onSaved,
}: {
  companyId: string; year: number; month: number;
  /** null = nueva; con valor = editar esa póliza MANUAL. */
  poliza: PolizaVista | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [cuentas, setCuentas] = useState<CuentaOpcion[]>([]);
  const [fecha, setFecha] = useState(
    poliza?.fecha ?? `${year}-${String(month).padStart(2, "0")}-01`
  );
  const [concepto, setConcepto] = useState(poliza?.concepto ?? "");
  const [lineas, setLineas] = useState<LineaEdit[]>(
    poliza
      ? poliza.transacciones.map((t) => ({
          cuenta: t.numCta,
          concepto: t.concepto,
          cargo: t.cargo > 0 ? String(t.cargo) : "",
          abono: t.abono > 0 ? String(t.abono) : "",
        }))
      : [
          { cuenta: "", concepto: "", cargo: "", abono: "" },
          { cuenta: "", concepto: "", cargo: "", abono: "" },
        ]
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      const res = await fetch(`/api/contabilidad/apertura?companyId=${companyId}`);
      const d = await res.json().catch(() => null);
      const cs: CuentaOpcion[] = (d?.cuentas ?? [])
        .filter((c: { nivel: number }) => c.nivel >= 3)
        .map((c: { cuentaSAT: string; subcuenta: string | null; nombre: string; nivel: number }) => ({
          codigo: c.subcuenta ?? c.cuentaSAT,
          nombre: c.nombre,
          nivel: c.nivel,
        }));
      setCuentas(cs);
    })();
  }, [companyId]);

  const num = (s: string) => (s.trim() ? Number(s) : 0);
  const totalCargos = lineas.reduce((s, l) => s + num(l.cargo), 0);
  const totalAbonos = lineas.reduce((s, l) => s + num(l.abono), 0);
  const cuadra = Math.abs(totalCargos - totalAbonos) < 0.01 && totalCargos > 0;

  function setLinea(i: number, patch: Partial<LineaEdit>) {
    setLineas((prev) => prev.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  }

  async function guardar() {
    setBusy(true);
    setError("");
    try {
      const payload = {
        companyId,
        fecha,
        concepto,
        ...(poliza?.referencia ? { referencia: poliza.referencia } : {}),
        lineas: lineas
          .filter((l) => l.cuenta && (num(l.cargo) > 0 || num(l.abono) > 0))
          .map((l) => ({ cuenta: l.cuenta, concepto: l.concepto || undefined, cargo: num(l.cargo), abono: num(l.abono) })),
      };
      const res = await fetch("/api/contabilidad/polizas-manuales", {
        method: poliza ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.error ?? "No se pudo guardar la póliza");
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo guardar la póliza");
    } finally {
      setBusy(false);
    }
  }

  const inputCls =
    "w-full rounded-md border border-cos-line bg-cos-canvas px-2 py-1.5 text-xs text-cos-ink focus:border-cos-brand focus:outline-none";

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-10" onClick={() => !busy && onClose()}>
      <div className="w-full max-w-[880px] rounded-xl border border-cos-line bg-cos-card shadow-card" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-cos-line px-5 py-3">
          <p className="text-sm font-semibold text-cos-ink">{poliza ? "Editar póliza manual" : "Nueva póliza manual"}</p>
          <button onClick={() => !busy && onClose()} className="rounded p-1 text-cos-ink-faint hover:bg-cos-paper"><X className="h-4 w-4" /></button>
        </div>
        <div className="p-5">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
            <label className="block">
              <span className="mb-1 block text-[11px] font-medium text-cos-ink-soft">Fecha</span>
              <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} className={inputCls} />
            </label>
            <label className="block sm:col-span-2">
              <span className="mb-1 block text-[11px] font-medium text-cos-ink-soft">Concepto de la póliza</span>
              <input value={concepto} onChange={(e) => setConcepto(e.target.value)} className={inputCls}
                placeholder="Ej. Provisión de renta de julio / reclasificación de gasto" />
            </label>
          </div>

          <table className="w-full text-xs">
            <thead>
              <tr className="text-cos-ink-faint border-b border-cos-line">
                <th className="text-left py-1.5 font-medium w-[38%]">Cuenta</th>
                <th className="text-left py-1.5 font-medium">Concepto (opcional)</th>
                <th className="text-right py-1.5 font-medium w-28">Cargo</th>
                <th className="text-right py-1.5 font-medium w-28">Abono</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody>
              {lineas.map((l, i) => (
                <tr key={i} className="border-b border-cos-line/60">
                  <td className="py-1.5 pr-2">
                    <select value={l.cuenta} onChange={(e) => setLinea(i, { cuenta: e.target.value })} className={inputCls}>
                      <option value="">— cuenta —</option>
                      {cuentas.map((c) => (
                        <option key={c.codigo} value={c.codigo}>{c.codigo} · {c.nombre}</option>
                      ))}
                    </select>
                  </td>
                  <td className="py-1.5 pr-2">
                    <input value={l.concepto} onChange={(e) => setLinea(i, { concepto: e.target.value })} className={inputCls} />
                  </td>
                  <td className="py-1.5 pr-2">
                    <input type="number" min="0" step="0.01" value={l.cargo}
                      onChange={(e) => setLinea(i, { cargo: e.target.value, ...(e.target.value ? { abono: "" } : {}) })}
                      className={`${inputCls} text-right font-mono`} placeholder="0.00" />
                  </td>
                  <td className="py-1.5 pr-2">
                    <input type="number" min="0" step="0.01" value={l.abono}
                      onChange={(e) => setLinea(i, { abono: e.target.value, ...(e.target.value ? { cargo: "" } : {}) })}
                      className={`${inputCls} text-right font-mono`} placeholder="0.00" />
                  </td>
                  <td className="py-1.5 text-right">
                    {lineas.length > 2 && (
                      <button onClick={() => setLineas((prev) => prev.filter((_, j) => j !== i))}
                        className="rounded p-1 text-cos-ink-faint hover:bg-cos-red-tint hover:text-cos-red-ink" title="Quitar línea">
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              <tr className="font-semibold">
                <td className="py-2" colSpan={2}>
                  <button onClick={() => setLineas((prev) => [...prev, { cuenta: "", concepto: "", cargo: "", abono: "" }])}
                    className="inline-flex items-center gap-1 text-[11.5px] font-medium text-cos-brand-ink underline hover:opacity-80">
                    <Plus className="h-3 w-3" /> Agregar línea
                  </button>
                </td>
                <td className="py-2 text-right font-mono">{formatCurrency(totalCargos)}</td>
                <td className="py-2 text-right font-mono">{formatCurrency(totalAbonos)}</td>
                <td />
              </tr>
            </tbody>
          </table>

          <div className={`mt-3 flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${
            cuadra ? "border-cos-jade-ink/25 bg-cos-jade-tint text-cos-jade-ink" : "border-cos-amber-ink/25 bg-cos-amber-tint text-cos-amber-ink"
          }`}>
            {cuadra ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
            {cuadra
              ? "La póliza cuadra (cargos = abonos)."
              : `Diferencia: ${formatCurrency(Math.abs(totalCargos - totalAbonos))} — cargos y abonos deben ser iguales.`}
          </div>

          {error && (
            <p className="mt-2 rounded-lg border border-cos-red-ink/20 bg-cos-red-tint px-3 py-2 text-xs text-cos-red-ink">{error}</p>
          )}

          <div className="mt-4 flex justify-end gap-2">
            <button onClick={onClose} disabled={busy}
              className="rounded-lg border border-cos-line px-4 py-2 text-xs font-medium text-cos-ink hover:bg-cos-paper disabled:opacity-50">
              Cancelar
            </button>
            <button onClick={guardar} disabled={busy || !cuadra || !concepto.trim()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-cos-brand px-4 py-2 text-xs font-semibold text-white hover:bg-cos-brand-deep disabled:opacity-50">
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {busy ? "Guardando…" : poliza ? "Guardar cambios" : "Crear póliza"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Auxiliar de cuenta (modal, drill-down desde la balanza) ──────────────────

interface AuxiliarData {
  cuenta: string;
  nombre: string;
  saldoInicial: number;
  movimientos: Array<{
    entryId: string; fecha: string; folioPoliza: string; concepto: string;
    fuente: string; referencia: string | null; referenciaTipo: string | null;
    cargo: number; abono: number; saldo: number;
  }>;
  totalCargos: number;
  totalAbonos: number;
  saldoFinal: number;
  invoiceIdPorUuid: Record<string, string>;
}

export function AuxiliarCuentaModal({
  companyId, year, month, cuenta, onClose,
}: { companyId: string; year: number; month: number; cuenta: string; onClose: () => void }) {
  const [data, setData] = useState<AuxiliarData | null>(null);
  const [loading, setLoading] = useState(true);
  const [repInvoiceId, setRepInvoiceId] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const res = await fetch(`/api/contabilidad/auxiliar?companyId=${companyId}&year=${year}&month=${month}&cuenta=${encodeURIComponent(cuenta)}`);
      setData(res.ok ? await res.json() : null);
      setLoading(false);
    })();
  }, [companyId, year, month, cuenta]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-10" onClick={onClose}>
      <div className="w-full max-w-[860px] rounded-xl border border-cos-line bg-cos-card shadow-card" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-cos-line px-5 py-3">
          <div>
            <p className="text-sm font-semibold text-cos-ink">
              Auxiliar · <span className="font-mono">{cuenta}</span> {data?.nombre ?? ""}
            </p>
            <p className="text-xs text-cos-ink-soft">{String(month).padStart(2, "0")}/{year}</p>
          </div>
          <button onClick={onClose} className="rounded p-1 text-cos-ink-faint hover:bg-cos-paper"><X className="h-4 w-4" /></button>
        </div>
        <div className="p-5">
          {loading ? (
            <Cargando />
          ) : !data ? (
            <p className="text-sm text-cos-red-ink">No se pudo cargar el auxiliar.</p>
          ) : (
            <>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-cos-ink-faint border-b border-cos-line">
                    <th className="text-left py-1.5 font-medium">Fecha</th>
                    <th className="text-left py-1.5 font-medium">Póliza</th>
                    <th className="text-left py-1.5 font-medium">Concepto</th>
                    <th className="text-right py-1.5 font-medium">Cargo</th>
                    <th className="text-right py-1.5 font-medium">Abono</th>
                    <th className="text-right py-1.5 font-medium">Saldo</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b border-cos-line/60 text-cos-ink-soft">
                    <td className="py-1.5" colSpan={5}>Saldo inicial</td>
                    <td className="py-1.5 text-right font-mono font-semibold"><Money value={data.saldoInicial} /></td>
                  </tr>
                  {data.movimientos.map((m) => (
                    <tr key={m.entryId} className="border-b border-cos-line/60">
                      <td className="py-1.5 font-mono whitespace-nowrap">{m.fecha}</td>
                      <td className="py-1.5 font-mono">#{m.folioPoliza}</td>
                      <td className="py-1.5 pr-2">
                        <span className="text-cos-ink">{m.concepto}</span>{" "}
                        {m.referenciaTipo === "CFDI" && m.referencia && data.invoiceIdPorUuid[m.referencia] && (
                          <button onClick={() => setRepInvoiceId(data.invoiceIdPorUuid[m.referencia!])}
                            className="text-[10.5px] font-medium text-cos-brand-ink underline hover:opacity-80">CFDI</button>
                        )}
                      </td>
                      <td className="py-1.5 text-right font-mono">{m.cargo > 0 ? formatCurrency(m.cargo) : "—"}</td>
                      <td className="py-1.5 text-right font-mono">{m.abono > 0 ? formatCurrency(m.abono) : "—"}</td>
                      <td className="py-1.5 text-right font-mono"><Money value={m.saldo} /></td>
                    </tr>
                  ))}
                  <tr className="font-semibold">
                    <td className="py-1.5" colSpan={3}>Totales del periodo</td>
                    <td className="py-1.5 text-right font-mono">{formatCurrency(data.totalCargos)}</td>
                    <td className="py-1.5 text-right font-mono">{formatCurrency(data.totalAbonos)}</td>
                    <td className="py-1.5 text-right font-mono"><Money value={data.saldoFinal} /></td>
                  </tr>
                </tbody>
              </table>
              {data.movimientos.length === 0 && (
                <p className="mt-3 text-xs text-cos-ink-soft">Sin movimientos en el periodo — el saldo viene de meses anteriores.</p>
              )}
            </>
          )}
        </div>
      </div>
      {repInvoiceId && <RepresentacionImpresa invoiceId={repInvoiceId} onClose={() => setRepInvoiceId(null)} />}
    </div>
  );
}

// ── Balance general ──────────────────────────────────────────────────────────

interface BalanceGeneralData {
  activo: Array<{ cuenta: string; nombre: string; monto: number }>;
  pasivo: Array<{ cuenta: string; nombre: string; monto: number }>;
  capital: Array<{ cuenta: string; nombre: string; monto: number }>;
  totalActivo: number;
  totalPasivo: number;
  totalCapital: number;
  resultadoEnCurso: number;
  descuadre: number;
}

export function BalanceGeneralPanel({ companyId, year, month }: { companyId: string; year: number; month: number }) {
  const [data, setData] = useState<BalanceGeneralData | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const res = await fetch(`/api/contabilidad/balance-general?companyId=${companyId}&year=${year}&month=${month}`);
      setData(res.ok ? await res.json() : null);
      setLoading(false);
    })();
  }, [companyId, year, month]);

  if (loading) return <Cargando />;
  if (!data || (data.activo.length === 0 && data.pasivo.length === 0 && data.capital.length === 0)) {
    return <Vacio texto="Sin saldos acumulados a este periodo. Cierra meses desde «Cierres mensuales»." />;
  }

  const cuadra = Math.abs(data.descuadre) < 0.01;

  return (
    <div>
      <div className="mb-3 flex justify-end print:hidden">
        <BotonExcel
          href={`/api/contabilidad/balance-general?companyId=${companyId}&year=${year}&month=${month}&format=xlsx`}
          label="Balance general en Excel"
        />
      </div>

      <div className={`mb-4 flex items-center gap-2 rounded-lg border px-4 py-2.5 text-sm ${
        cuadra ? "border-cos-jade-ink/25 bg-cos-jade-tint text-cos-jade-ink" : "border-cos-amber-ink/25 bg-cos-amber-tint text-cos-amber-ink"
      }`}>
        {cuadra ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
        {cuadra
          ? "La ecuación contable cuadra: Activo = Pasivo + Capital (incluido el resultado en curso)."
          : `Descuadre de ${formatCurrency(Math.abs(data.descuadre))} — revisa periodos sin cerrar o asientos descuadrados.`}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Seccion titulo="Activo" icon={<Scale className="h-4 w-4" />} filas={data.activo} total={data.totalActivo} />
        <div className="space-y-4">
          <Seccion titulo="Pasivo" filas={data.pasivo} total={data.totalPasivo} />
          <Seccion
            titulo="Capital contable"
            filas={[
              ...data.capital,
              ...(Math.abs(data.resultadoEnCurso) >= 0.01
                ? [{ cuenta: "—", nombre: "Resultado del ejercicio (en curso, sin traspasar)", monto: data.resultadoEnCurso }]
                : []),
            ]}
            total={data.totalCapital + data.resultadoEnCurso}
          />
        </div>
      </div>
    </div>
  );
}

function Seccion({ titulo, filas, total, icon }: {
  titulo: string;
  filas: Array<{ cuenta: string; nombre: string; monto: number }>;
  total: number;
  icon?: React.ReactNode;
}) {
  return (
    <div className="bg-cos-card border border-cos-line rounded-xl overflow-hidden print:overflow-visible">
      <div className="flex items-center gap-2 border-b border-cos-line bg-cos-paper px-4 py-2.5 text-xs font-semibold text-cos-ink">
        {icon} {titulo}
      </div>
      <table className="w-full text-sm">
        <tbody>
          {filas.map((f, i) => (
            <tr key={`${f.cuenta}-${i}`} className="border-b border-cos-line/60 last:border-0">
              <td className="px-4 py-1.5 font-mono text-xs text-cos-ink-soft w-20">{f.cuenta}</td>
              <td className="px-4 py-1.5">{f.nombre}</td>
              <td className="px-4 py-1.5 text-right font-mono text-xs"><Money value={f.monto} /></td>
            </tr>
          ))}
          <tr className="bg-cos-paper font-semibold">
            <td className="px-4 py-2" colSpan={2}>Total {titulo.toLowerCase()}</td>
            <td className="px-4 py-2 text-right font-mono text-xs"><Money value={total} /></td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
