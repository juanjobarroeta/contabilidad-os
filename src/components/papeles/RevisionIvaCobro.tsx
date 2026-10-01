"use client";
import { useState } from "react";

export interface CobroReviewRow {
  id: string;
  uuid: string | null;
  fingerprint?: string;
  fechaCfdi?: string;
  fechasCobro?: string[];
  fuenteCobro?: string;
  motivosCobro?: string[];
  evidenciaCobro?: {
    id: string;
    fecha: string;
    monto: number;
    referencia: string;
  }[];
  revisionCobro?: {
    tratamiento: string;
    fechaCobro: string | null;
    evidencia: string | null;
    motivo: string;
    reviewedAt: string;
  } | null;
}
export function RevisionIvaCobro({
  row,
  companyId,
  onSaved,
  onCancel,
}: {
  row: CobroReviewRow;
  companyId: string;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [tratamiento, setTratamiento] = useState(
    row.revisionCobro?.tratamiento ?? "",
  );
  const [manual, setManual] = useState(Boolean(row.revisionCobro?.fechaCobro));
  const [fecha, setFecha] = useState(row.revisionCobro?.fechaCobro ?? "");
  const [evidencia, setEvidencia] = useState(
    row.revisionCobro?.evidencia ?? "",
  );
  const [motivo, setMotivo] = useState(row.revisionCobro?.motivo ?? "");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/facturas/${row.id}/iva-cobro`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId,
          expected: row.fingerprint,
          tratamiento,
          motivo,
          fechaCobro: manual && tratamiento === "FLUJO_GENERAL" ? fecha : null,
          evidencia:
            manual && tratamiento === "FLUJO_GENERAL" ? evidencia : null,
        }),
      });
      const data = await res.json();
      if (!res.ok)
        throw new Error(data.error ?? "No se pudo guardar la revisión.");
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo guardar.");
    } finally {
      setBusy(false);
    }
  }
  const input =
    "w-full rounded-md border border-cos-line bg-cos-card px-3 py-2 text-sm";
  return (
    <form
      onSubmit={save}
      className="space-y-3 rounded-card border border-cos-line bg-cos-card p-4"
      aria-label="Revisar cobro e IVA"
    >
      <h3 className="font-semibold">
        Revisar cobro e IVA · {row.uuid?.slice(0, 8) ?? row.id}
      </h3>
      <p className="text-sm text-cos-ink-soft">
        CFDI: {row.fechaCfdi}. Cobros registrados:{" "}
        {row.fechasCobro?.join(", ") || "sin evidencia"}.
      </p>
      {row.motivosCobro?.map((m) => (
        <p key={m} className="text-sm text-cos-amber-ink">
          {m}
        </p>
      ))}
      <label className="block text-sm">
        Tratamiento revisado
        <select
          required
          value={tratamiento}
          onChange={(e) => setTratamiento(e.target.value)}
          className={input}
        >
          <option value="" disabled>
            Selecciona el tratamiento revisado
          </option>
          <option value="FLUJO_GENERAL">
            IVA por cobro efectivo — regla general
          </option>
          <option value="REVISION_ESPECIAL">
            Requiere tratamiento especial / revisar intereses
          </option>
        </select>
      </label>
      <p className="text-xs text-cos-ink-soft">
        Para intereses, revisa las exenciones del Art. 15-X y el devengo
        especial del Art. 18-A LIVA. Confirma flujo general sólo si corresponde
        y el desglose del CFDI es correcto, incluida su posible exención. Esta
        revisión no cambia la tasa ni sustituye el CFDI.
      </p>
      {tratamiento === "FLUJO_GENERAL" && (
        <>
          <label className="flex gap-2 text-sm">
            <input
              type="checkbox"
              checked={manual}
              onChange={(e) => setManual(e.target.checked)}
            />
            Confirmo un cobro completo con evidencia documental, sin duplicar el
            pago conciliado.
          </label>
          {manual && (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-sm">
                Fecha efectiva del cobro completo
                <input
                  required
                  type="date"
                  value={fecha}
                  onChange={(e) => setFecha(e.target.value)}
                  className={input}
                />
              </label>
              <label className="text-sm">
                Referencia del documento que acredita el cobro
                <input
                  required
                  minLength={10}
                  maxLength={1000}
                  value={evidencia}
                  onChange={(e) => setEvidencia(e.target.value)}
                  placeholder="Recibo, estado de cuenta, contrato o folio"
                  className={input}
                />
              </label>
            </div>
          )}
        </>
      )}
      <label className="block text-sm">
        Motivo y fundamento de la revisión
        <textarea
          required
          minLength={15}
          maxLength={2000}
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
          className={input}
        />
      </label>
      <p className="text-xs text-cos-ink-soft">
        Se registra quién confirmó y cuándo. El cálculo puede cambiar en el mes
        del cobro; las declaraciones presentadas y los asientos guardados
        requieren revisión aparte.
      </p>
      {error && (
        <p role="alert" className="text-sm text-cos-red-ink">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button
          disabled={busy}
          className="rounded-control bg-cos-brand px-3 py-2 text-sm text-white disabled:opacity-50"
        >
          {busy ? "Guardando…" : "Confirmar revisión"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          className="rounded-control border border-cos-line px-3 py-2 text-sm"
        >
          Cancelar
        </button>
      </div>
    </form>
  );
}
