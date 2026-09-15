"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, RotateCcw } from "lucide-react";
import { etiquetaPeriodo } from "@/lib/periodos";
import type { RegimenAllocationReadinessApiResponse } from "@/lib/fiscal/regimen-allocation-readiness";

const DISPLAY_LIMIT = 6;

export function RegimenAllocationReadiness({
  companyId,
  periodo,
  refreshKey,
  onReview,
}: {
  companyId: string;
  periodo: string;
  refreshKey: number;
  onReview: (invoiceId: string) => Promise<void> | void;
}) {
  const [data, setData] = useState<RegimenAllocationReadinessApiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [openingId, setOpeningId] = useState<string | null>(null);
  const monthly = /^\d{4}-(0[1-9]|1[0-2])$/.test(periodo);

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!monthly) {
      setData(null);
      setError("");
      return;
    }
    const [year, month] = periodo.split("-");
    setData(null);
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ companyId, year, month: String(Number(month)) });
      const response = await fetch(`/api/impuestos/asignaciones-regimen?${params}`, { signal });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error ?? "No se pudo revisar la asignación del periodo.");
      if (!signal?.aborted) setData(body as RegimenAllocationReadinessApiResponse);
    } catch (cause) {
      if (!signal?.aborted) {
        setError(cause instanceof Error ? cause.message : "No se pudo revisar la asignación del periodo.");
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [companyId, monthly, periodo, refreshKey]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (!monthly) return null;
  // Keep the ordinary single-regime screen visually unchanged while the cheap
  // regime gate loads. A queue appears only after the server confirms it is
  // relevant (or finds a regime-evidence error).
  if (loading && !data) return null;
  if (error) {
    return (
      <div className="mt-3 rounded-card border border-cos-red-ink/20 bg-cos-red-tint px-4 py-3 text-[12.5px] text-cos-red-ink">
        <p className="flex items-start gap-1.5"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {error}</p>
        <button onClick={() => void load()} className="mt-2 inline-flex items-center gap-1 font-semibold hover:underline">
          <RotateCcw className="h-3.5 w-3.5" /> Reintentar
        </button>
      </div>
    );
  }
  if (!data || data.estado === "NO_REQUIERE_ASIGNACION") return null;

  if (data.estado === "SIN_REGIMEN_CONFIRMADO" || data.estado === "REGIMEN_NO_RECONOCIDO") {
    return (
      <div className="mt-3 rounded-card border border-cos-amber-ink/20 bg-cos-amber-tint px-4 py-3 text-[12.5px] text-cos-amber-ink">
        <p className="flex items-start gap-1.5 font-semibold">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          No se pudieron confirmar los regímenes de {etiquetaPeriodo(periodo)}.
        </p>
        <p className="mt-1">
          {data.estado === "REGIMEN_NO_RECONOCIDO"
            ? `Revisa las claves ${data.regimenesNoReconocidos.join(", ")} antes de asignar CFDI.`
            : "Carga o revisa la Constancia de Situación Fiscal antes de asignar CFDI."}
        </p>
      </div>
    );
  }

  const pending = data.facturasPendientes.slice(0, DISPLAY_LIMIT);
  const tone = data.evidenciaCompleta
    ? "border-cos-jade-ink/20 bg-cos-jade-tint"
    : "border-cos-amber-ink/20 bg-cos-amber-tint";
  const textTone = data.evidenciaCompleta ? "text-cos-jade-ink" : "text-cos-amber-ink";

  return (
    <section className={`mt-3 rounded-card border px-4 py-3 ${tone}`} aria-label="Revisión mensual de asignaciones por régimen">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className={`flex items-center gap-1.5 text-[13px] font-semibold ${textTone}`}>
            {data.evidenciaCompleta
              ? <CheckCircle2 className="h-4 w-4" />
              : <AlertTriangle className="h-4 w-4" />}
            Asignación por régimen · {etiquetaPeriodo(periodo)}
          </p>
          <p className="mt-1 text-[12.5px] text-cos-ink-soft">
            {data.estado === "SIN_FACTURAS"
              ? "No hay CFDI timbrados de ingreso o egreso que asignar en este mes."
              : `${data.resumen.completas} de ${data.resumen.total} CFDI tienen evidencia completa.`}
          </p>
        </div>
        <div className="flex flex-wrap gap-1">
          {data.regimenesDisponibles.map((regimen) => (
            <span key={regimen.code} title={regimen.label ?? undefined} className="rounded-full bg-cos-card/70 px-2 py-0.5 font-mono text-[11.5px] font-semibold text-cos-ink-soft">
              {regimen.code}
            </span>
          ))}
        </div>
      </div>

      {!data.evidenciaCompleta && (
        <p className="mt-2 text-[12.5px] text-cos-ink-soft">
          {data.resumen.sinAsignar > 0 ? `${data.resumen.sinAsignar} sin asignar` : ""}
          {data.resumen.sinAsignar > 0 && data.resumen.requierenRevision > 0 ? " · " : ""}
          {data.resumen.requierenRevision > 0 ? `${data.resumen.requierenRevision} para revisar de nuevo` : ""}
        </p>
      )}

      {pending.length > 0 && (
        <div className="mt-2 space-y-1.5">
          {pending.map((invoice) => (
            <button
              key={invoice.id}
              onClick={async () => {
                setOpeningId(invoice.id);
                try { await onReview(invoice.id); } finally { setOpeningId(null); }
              }}
              disabled={openingId !== null}
              className="flex w-full items-center justify-between gap-3 rounded-[9px] border border-cos-line-soft bg-cos-card/80 px-3 py-2 text-left hover:border-cos-brand disabled:opacity-60"
            >
              <span className="min-w-0">
                <span className="block truncate text-[12.5px] font-medium text-cos-ink">{invoice.contraparte ?? invoice.rfc ?? "CFDI sin contraparte"}</span>
                <span className="block text-[11.5px] text-cos-ink-faint">
                  {invoice.tipo === "INGRESO" ? "Ingreso" : "Egreso"} · {new Intl.DateTimeFormat("es-MX", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(invoice.fecha))}
                  {invoice.folio ? ` · ${[invoice.serie, invoice.folio].filter(Boolean).join("-")}` : ""}
                </span>
              </span>
              <span className="flex-none text-[12px] font-semibold text-cos-brand-ink">
                {openingId === invoice.id ? "Abriendo…" : invoice.estado === "SIN_ASIGNAR" ? "Asignar" : "Revisar"}
              </span>
            </button>
          ))}
          {data.resumen.sinAsignar + data.resumen.requierenRevision > DISPLAY_LIMIT && (
            <p className="px-1 text-[11.5px] text-cos-ink-faint">
              Y {data.resumen.sinAsignar + data.resumen.requierenRevision - DISPLAY_LIMIT} CFDI pendientes más.
            </p>
          )}
        </div>
      )}

      <p className="mt-2 text-[11.5px] text-cos-ink-faint">
        Evidencia por fecha de emisión. Todavía no distribuye pagos PPD, no separa IVA y no cambia cálculos ni cierres.
      </p>
    </section>
  );
}
