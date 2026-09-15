"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Pencil,
  RotateCcw,
  Trash2,
} from "lucide-react";
import {
  buildRegimenAllocationDraft,
  regimenPercentageDraft,
  type InvoiceRegimenAssignmentApiResponse,
  type RegimenPercentageDraft,
} from "@/lib/fiscal/regimen-allocation-client";

export function RegimenAssignmentPanel({ invoiceId }: { invoiceId: string }) {
  const [data, setData] = useState<InvoiceRegimenAssignmentApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<RegimenPercentageDraft>({});
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState<"save" | "delete" | null>(null);
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setLoadError("");
    try {
      const response = await fetch(`/api/facturas/${invoiceId}/asignacion-regimen`, { signal });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error ?? "No se pudo cargar la asignación.");
      if (!signal?.aborted) setData(body as InvoiceRegimenAssignmentApiResponse);
    } catch (error) {
      if (!signal?.aborted) {
        setLoadError(error instanceof Error ? error.message : "No se pudo cargar la asignación.");
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [invoiceId]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const draftResult = useMemo(
    () => buildRegimenAllocationDraft(data?.regimenesDisponibles ?? [], draft),
    [data?.regimenesDisponibles, draft],
  );

  if (loading) {
    return (
      <div className="mt-3 flex items-center gap-2 rounded-[10px] border border-cos-line-soft px-3 py-3 text-[12.5px] text-cos-ink-faint">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Revisando asignación por régimen…
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="mt-3 rounded-[10px] border border-cos-red-ink/20 bg-cos-red-tint px-3 py-2.5 text-[12.5px] text-cos-red-ink">
        <p className="flex items-start gap-1.5"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {loadError}</p>
        <button onClick={() => void load()} className="mt-2 inline-flex items-center gap-1 font-semibold hover:underline">
          <RotateCcw className="h-3.5 w-3.5" /> Reintentar
        </button>
      </div>
    );
  }

  if (!data || (data.regimenesDisponibles.length <= 1 && !data.asignacion)) return null;

  const regimenLabel = new Map(data.regimenesDisponibles.map((regimen) => [regimen.code, regimen.label]));
  const totalLabel = draftResult.totalBasisPoints === null
    ? "—"
    : `${(draftResult.totalBasisPoints / 100).toFixed(2)}%`;

  function openEditor() {
    if (!data) return;
    setDraft(regimenPercentageDraft(data.regimenesDisponibles, data.asignacion));
    setNote(data.asignacion?.note ?? "");
    setActionError("");
    setNotice("");
    setEditing(true);
  }

  async function save() {
    if (!data || !draftResult.ok) return;
    setSaving("save");
    setActionError("");
    setNotice("");
    try {
      const response = await fetch(`/api/facturas/${invoiceId}/asignacion-regimen`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedRevision: data.asignacion?.revision ?? 0,
          allocations: draftResult.allocations,
          note,
        }),
      });
      const body = await response.json().catch(() => null);
      if (response.status === 409) {
        setEditing(false);
        setNotice("Otra persona actualizó la asignación. Cargamos la versión más reciente; revísala antes de volver a guardar.");
        await load();
        return;
      }
      if (!response.ok) throw new Error(body?.error ?? "No se pudo guardar la asignación.");
      setData(body as InvoiceRegimenAssignmentApiResponse);
      setEditing(false);
      setNotice("Asignación revisada y guardada.");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "No se pudo guardar la asignación.");
    } finally {
      setSaving(null);
    }
  }

  async function remove() {
    if (!data?.asignacion) return;
    if (!window.confirm("¿Quitar esta asignación? La factura volverá a quedar pendiente de revisión.")) return;
    setSaving("delete");
    setActionError("");
    setNotice("");
    try {
      const response = await fetch(`/api/facturas/${invoiceId}/asignacion-regimen`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRevision: data.asignacion.revision }),
      });
      const body = await response.json().catch(() => null);
      if (response.status === 409) {
        setNotice("Otra persona cambió la asignación. Cargamos la versión más reciente.");
        await load();
        return;
      }
      if (!response.ok) throw new Error(body?.error ?? "No se pudo quitar la asignación.");
      setData(body as InvoiceRegimenAssignmentApiResponse);
      setEditing(false);
      setNotice("Asignación eliminada; la factura está pendiente de revisión.");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "No se pudo quitar la asignación.");
    } finally {
      setSaving(null);
    }
  }

  const stateTone = data.estado === "COMPLETA"
    ? "bg-cos-jade-tint text-cos-jade-ink"
    : data.estado === "REQUIERE_REVISION"
      ? "bg-cos-red-tint text-cos-red-ink"
      : "bg-cos-amber-tint text-cos-amber-ink";
  const stateLabel = data.estado === "COMPLETA"
    ? "Revisada"
    : data.estado === "REQUIERE_REVISION"
      ? "Revisar de nuevo"
      : "Sin asignar";

  return (
    <section className="mt-3 rounded-[10px] border border-cos-line-soft px-3 py-3" aria-label="Asignación para ISR por régimen">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[12.5px] font-medium uppercase tracking-[0.02em] text-cos-ink-faint">Asignación para ISR</p>
          <p className="mt-0.5 text-[12px] text-cos-ink-faint">Periodo {data.periodo} · No reparte IVA ni cambia el cálculo todavía.</p>
        </div>
        <span className={`flex-none rounded-full px-2 py-0.5 text-[11.5px] font-semibold ${stateTone}`}>{stateLabel}</span>
      </div>

      {notice && (
        <p className="mt-2 rounded-[8px] bg-cos-brand-tint px-2.5 py-2 text-[12px] text-cos-brand-ink">{notice}</p>
      )}
      {actionError && (
        <p className="mt-2 flex items-start gap-1.5 text-[12px] text-cos-red-ink">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {actionError}
        </p>
      )}

      {!editing && data.asignacion && (
        <div className="mt-2.5 space-y-1.5">
          {data.asignacion.allocations.map((allocation) => {
            const label = regimenLabel.get(allocation.regimenCode);
            return (
              <div key={allocation.regimenCode} className="flex items-baseline justify-between gap-3 text-[13px]">
                <span className="min-w-0 text-cos-ink-soft">
                  <span className="font-mono font-semibold text-cos-ink">{allocation.regimenCode}</span>
                  {label ? ` · ${label}` : " · ya no aparece vigente en este periodo"}
                </span>
                <span className="flex-none font-mono font-semibold text-cos-ink">{allocation.porcentaje.toFixed(2)}%</span>
              </div>
            );
          })}
          <p className="pt-1 text-[11.5px] text-cos-ink-faint">
            Revisó {data.asignacion.reviewedByEmail ?? "usuario del despacho"} · {new Intl.DateTimeFormat("es-MX", {
              dateStyle: "medium",
              timeStyle: "short",
            }).format(new Date(data.asignacion.reviewedAt))}
          </p>
          {data.asignacion.note && <p className="text-[12px] text-cos-ink-soft">Nota: {data.asignacion.note}</p>}
        </div>
      )}

      {!editing && !data.asignacion && (
        <p className="mt-2 text-[12.5px] text-cos-ink-soft">
          Esta empresa tenía varios regímenes en el mes. Indica qué porcentaje del CFDI corresponde a cada uno.
        </p>
      )}

      {!editing && data.observacion && (
        <p className="mt-2 flex items-start gap-1.5 text-[12px] text-cos-red-ink">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {data.observacion.error}
        </p>
      )}

      {!editing && data.regimenesDisponibles.length === 0 && (
        <p className="mt-2 flex items-start gap-1.5 text-[12px] text-cos-red-ink">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> No hay regímenes confirmados para reasignar este CFDI.
        </p>
      )}

      {editing && (
        <div className="mt-3">
          <div className="space-y-2">
            {data.regimenesDisponibles.map((regimen) => (
              <label key={regimen.code} className="grid grid-cols-[minmax(0,1fr)_92px] items-center gap-3 text-[12.5px] text-cos-ink-soft">
                <span className="min-w-0">
                  <span className="font-mono font-semibold text-cos-ink">{regimen.code}</span>
                  <span className="ml-1.5">{regimen.label ?? "Régimen sin etiqueta"}</span>
                </span>
                <span className="relative">
                  <input
                    value={draft[regimen.code] ?? ""}
                    onChange={(event) => setDraft((current) => ({ ...current, [regimen.code]: event.target.value }))}
                    inputMode="decimal"
                    aria-label={`Porcentaje para régimen ${regimen.code}`}
                    className="w-full rounded-control border border-cos-line bg-cos-card py-1.5 pl-2.5 pr-7 text-right font-mono text-[13px] text-cos-ink outline-none focus:border-cos-brand"
                    placeholder="0"
                  />
                  <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[12px] text-cos-ink-faint">%</span>
                </span>
              </label>
            ))}
          </div>

          <div className="mt-2.5 flex items-center justify-between border-t border-cos-line-soft pt-2 text-[12.5px]">
            <span className="text-cos-ink-soft">Total</span>
            <span className={`font-mono font-semibold ${draftResult.ok ? "text-cos-jade-ink" : "text-cos-red-ink"}`}>{totalLabel}</span>
          </div>
          {!draftResult.ok && <p className="mt-1 text-[11.5px] text-cos-red-ink">{draftResult.error}</p>}

          <label className="mt-2.5 block text-[12px] text-cos-ink-soft">
            Nota de revisión <span className="text-cos-ink-faint">(opcional)</span>
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={500}
              rows={2}
              className="mt-1 w-full resize-none rounded-control border border-cos-line bg-cos-card px-2.5 py-2 text-[12.5px] text-cos-ink outline-none focus:border-cos-brand"
              placeholder="Criterio o papel de trabajo consultado"
            />
          </label>

          <div className="mt-2.5 flex gap-2">
            <button
              onClick={() => setEditing(false)}
              disabled={saving !== null}
              className="flex-1 rounded-control border border-cos-line px-3 py-2 text-[12.5px] text-cos-ink-soft hover:bg-cos-paper disabled:opacity-50"
            >
              Cancelar
            </button>
            <button
              onClick={() => void save()}
              disabled={!draftResult.ok || saving !== null}
              className="flex-1 rounded-control bg-cos-brand px-3 py-2 text-[12.5px] font-semibold text-white hover:bg-cos-brand-deep disabled:opacity-50"
            >
              {saving === "save" ? "Guardando…" : "Guardar revisión"}
            </button>
          </div>
        </div>
      )}

      {!editing && data.puedeEditar && data.regimenesDisponibles.length > 0 && (
        <div className="mt-2.5 flex gap-2">
          <button
            onClick={openEditor}
            disabled={saving !== null}
            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-control border border-cos-line px-3 py-1.5 text-[12.5px] font-medium text-cos-brand-ink hover:bg-cos-brand-tint disabled:opacity-50"
          >
            {data.asignacion ? <Pencil className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
            {data.asignacion ? "Editar" : "Asignar"}
          </button>
          {data.asignacion && (
            <button
              onClick={() => void remove()}
              disabled={saving !== null}
              className="inline-flex items-center justify-center gap-1.5 rounded-control border border-cos-red-ink/20 px-3 py-1.5 text-[12.5px] text-cos-red-ink hover:bg-cos-red-tint disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" /> {saving === "delete" ? "Quitando…" : "Quitar"}
            </button>
          )}
        </div>
      )}

      {!editing && !data.puedeEditar && (
        <p className="mt-2 text-[11.5px] text-cos-ink-faint">Sólo lectura. Pide a un contador o administrador que revise la asignación.</p>
      )}
    </section>
  );
}
