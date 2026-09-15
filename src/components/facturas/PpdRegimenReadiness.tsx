"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { etiquetaPeriodo } from "@/lib/periodos";
import type {
  PpdRegimenReadinessApiResponse,
} from "@/lib/fiscal/regimen-payment-allocation";
import {
  ppdPaymentReference,
  ppdReadinessSummaryParts,
  shouldShowPpdRegimenReadiness,
} from "@/lib/facturas/ppd-regimen-readiness";

const DISPLAY_LIMIT = 6;

export function PpdRegimenReadiness({
  companyId,
  periodo,
  refreshKey,
  onReviewParent,
}: {
  companyId: string;
  periodo: string;
  refreshKey: number;
  onReviewParent: (invoiceId: string) => Promise<void> | void;
}) {
  const [data, setData] = useState<PpdRegimenReadinessApiResponse | null>(null);
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
      const response = await fetch(`/api/impuestos/asignaciones-regimen/ppd?${params}`, { signal });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error ?? "No se pudieron revisar los pagos PPD del periodo.");
      if (!signal?.aborted) setData(body as PpdRegimenReadinessApiResponse);
    } catch (cause) {
      if (!signal?.aborted) {
        setError(cause instanceof Error ? cause.message : "No se pudieron revisar los pagos PPD del periodo.");
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
  if (!shouldShowPpdRegimenReadiness(data)) return null;

  const pending = data.pagosPendientes.slice(0, DISPLAY_LIMIT);
  const summaryParts = ppdReadinessSummaryParts(data.resumen);

  return (
    <section className="mt-3 rounded-card border border-cos-amber-ink/20 bg-cos-amber-tint px-4 py-3" aria-label="Revisión mensual de pagos PPD por régimen">
      <p className="flex items-center gap-1.5 text-[13px] font-semibold text-cos-amber-ink">
        <AlertTriangle className="h-4 w-4" />
        Pagos PPD por régimen · {etiquetaPeriodo(periodo)}
      </p>
      <p className="mt-1 text-[12.5px] text-cos-ink-soft">
        {data.resumen.proyectables} de {data.resumen.totalRelaciones} relaciones de pago conservan evidencia suficiente del CFDI padre.
      </p>
      {summaryParts.length > 0 && (
        <p className="mt-2 text-[12.5px] text-cos-ink-soft">{summaryParts.join(" · ")}</p>
      )}

      {pending.length > 0 && (
        <div className="mt-2 space-y-1.5">
          {pending.map((item) => {
            const parent = item.parent;
            const content = (
              <>
                <span className="min-w-0">
                  <span className="block truncate text-[12.5px] font-medium text-cos-ink">
                    {parent?.contraparte ?? parent?.rfc ?? item.parentUuid}
                  </span>
                  <span className="block text-[11.5px] text-cos-ink-faint">
                    {ppdPaymentReference(item)}
                    {item.fechaPago
                      ? ` · ${new Intl.DateTimeFormat("es-MX", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(item.fechaPago))}`
                      : ""}
                  </span>
                  <span className="mt-0.5 block text-[11.5px] text-cos-amber-ink">{item.error}</span>
                </span>
                {parent && (
                  <span className="flex-none text-[12px] font-semibold text-cos-brand-ink">
                    {openingId === parent.invoiceId
                      ? "Abriendo…"
                      : item.code === "ASSIGNMENT_REQUIRED" ? "Asignar" : "Abrir CFDI"}
                  </span>
                )}
              </>
            );

            return parent ? (
              <button
                key={item.id}
                onClick={async () => {
                  setOpeningId(parent.invoiceId);
                  try { await onReviewParent(parent.invoiceId); } finally { setOpeningId(null); }
                }}
                disabled={openingId !== null}
                className="flex w-full items-center justify-between gap-3 rounded-[9px] border border-cos-line-soft bg-cos-card/80 px-3 py-2 text-left hover:border-cos-brand disabled:opacity-60"
              >
                {content}
              </button>
            ) : (
              <div key={item.id} className="flex w-full items-center justify-between gap-3 rounded-[9px] border border-cos-line-soft bg-cos-card/80 px-3 py-2">
                {content}
              </div>
            );
          })}
          {data.resumen.pendientes > pending.length && (
            <p className="px-1 text-[11.5px] text-cos-ink-faint">
              Y {data.resumen.pendientes - pending.length} pagos pendientes más.
            </p>
          )}
        </div>
      )}

      <p className="mt-2 text-[11.5px] text-cos-ink-faint">
        Esta cola sigue la FechaPago del REP. Es evidencia de preparación: no separa IVA ni cambia cálculos, declaraciones o cierres.
      </p>
    </section>
  );
}
