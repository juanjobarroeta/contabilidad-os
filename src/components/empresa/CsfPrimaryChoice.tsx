"use client";

import { useId, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import type { CsfRegimenOption } from "@/lib/fiscal/csf-refresh-client";

export function CsfPrimaryChoice({
  regimenes,
  busy,
  onConfirm,
  onCancel,
}: {
  regimenes: ReadonlyArray<CsfRegimenOption>;
  busy: boolean;
  onConfirm: (code: string) => void;
  onCancel: () => void;
}) {
  const selectId = useId();
  const [selectedCode, setSelectedCode] = useState("");

  return (
    <div role="alert" className="mt-4 rounded-control border border-cos-amber bg-cos-amber-tint p-4 text-cos-amber-ink">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">Elige el régimen de referencia</p>
          <p className="mt-1 text-xs leading-relaxed">
            La constancia contiene varios regímenes y no podemos conservar el anterior. Todos los de la lista
            quedarán vigentes; esta elección sólo define cuál usa ContabilidadOS como principal cuando una
            pantalla necesita uno.
          </p>
          <label htmlFor={selectId} className="mt-3 block text-xs font-semibold">
            Régimen principal en ContabilidadOS
          </label>
          <select
            id={selectId}
            value={selectedCode}
            onChange={(event) => setSelectedCode(event.target.value)}
            disabled={busy}
            className="mt-1.5 w-full rounded-control border border-cos-line bg-cos-card px-3 py-2 text-sm text-cos-ink disabled:opacity-60"
          >
            <option value="">Selecciona un régimen</option>
            {regimenes.map((regimen) => (
              <option key={regimen.codigo} value={regimen.codigo}>
                {regimen.codigo} · {regimen.nombre}
              </option>
            ))}
          </select>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => onConfirm(selectedCode)}
              disabled={busy || !selectedCode}
              className="inline-flex items-center gap-2 rounded-control bg-cos-brand px-3 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Confirmar y actualizar
            </button>
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              className="rounded-control border border-cos-line bg-cos-card px-3 py-2 text-xs font-semibold text-cos-ink disabled:opacity-50"
            >
              Cancelar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
