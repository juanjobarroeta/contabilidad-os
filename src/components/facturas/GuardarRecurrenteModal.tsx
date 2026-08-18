"use client";

import { useState } from "react";
import { Loader2, Repeat, X } from "lucide-react";
import { Button } from "@/components/ui";
import {
  PERIODICIDAD_LABEL,
  siguienteEmision,
  formatoFecha,
  type Periodicidad,
} from "@/lib/facturas/recurrentes";

// ─────────────────────────────────────────────────────────────────────────────
// "Guardar como recurrente" desde el compositor de facturas.
//
// Reusa el MISMO buildPayload() del timbrado y la prefactura: la serie guarda
// ese cuerpo tal cual, así que lo que se generará cada mes es exactamente lo
// que está en pantalla. No hay una segunda forma de armar un CFDI.
//
// Sólo pide lo que el compositor no sabe: cómo se llama la serie, cada cuánto
// repite y desde/hasta cuándo.
// ─────────────────────────────────────────────────────────────────────────────

const PERIODICIDADES: Periodicidad[] = [
  "SEMANAL",
  "MENSUAL",
  "BIMESTRAL",
  "TRIMESTRAL",
  "SEMESTRAL",
  "ANUAL",
];

/** Hoy en `YYYY-MM-DD` UTC — el default de la primera emisión. */
function hoyISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export function GuardarRecurrenteModal({
  companyId,
  clienteNombre,
  /** El mismo cuerpo que se timbraría; la serie lo guarda tal cual. */
  payload,
  inicial,
  onClose,
  onGuardada,
}: {
  companyId: string;
  clienteNombre: string;
  payload: Record<string, unknown>;
  /**
   * Valores de arranque cuando el alta viene de una cadencia DETECTADA: el
   * sistema ya midió el ritmo, así que abrir el diálogo en "cada mes, hoy"
   * obligaría a re-capturar lo que acaba de deducir. Siguen siendo editables.
   */
  inicial?: { nombre?: string; periodicidad?: Periodicidad; inicio?: string };
  onClose: () => void;
  onGuardada: (nombre: string) => void;
}) {
  const [nombre, setNombre] = useState(inicial?.nombre ?? `Recurrente · ${clienteNombre}`);
  const [periodicidad, setPeriodicidad] = useState<Periodicidad>(
    inicial?.periodicidad ?? "MENSUAL"
  );
  const [inicio, setInicio] = useState(inicial?.inicio ?? hoyISO());
  const [fin, setFin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // El ancla sale del día de la primera emisión: quien elige "31 de enero"
  // está diciendo "el último día de cada mes", no "el 31 salvo en febrero".
  const diaMes = Number(inicio.slice(8, 10)) || 1;

  const inicioValido = /^\d{4}-\d{2}-\d{2}$/.test(inicio);
  const proxima = inicioValido
    ? siguienteEmision(new Date(`${inicio}T00:00:00.000Z`), periodicidad, diaMes)
    : null;

  async function guardar() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/facturas/recurrentes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...payload,
          companyId,
          nombre,
          periodicidad,
          diaMes,
          inicio,
          ...(fin ? { fin } : {}),
        }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.error ?? "No se pudo guardar la serie");
      onGuardada(nombre);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error inesperado");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl bg-cos-card shadow-xl">
        <div className="flex items-center justify-between border-b border-cos-line px-6 py-4">
          <h2 className="flex items-center gap-2 text-base font-semibold text-cos-ink">
            <Repeat className="h-4 w-4 text-cos-brand" />
            Guardar como recurrente
          </h2>
          <button
            onClick={onClose}
            aria-label="Cerrar"
            className="rounded-control p-1.5 text-cos-ink-faint hover:bg-cos-paper"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-6 py-5">
          <p className="rounded-lg bg-cos-brand-tint px-3.5 py-2.5 text-[12.5px] leading-snug text-cos-brand-ink">
            En cada fecha se guardará una <strong className="font-semibold">prefactura</strong> con
            estos mismos datos. Nunca se timbra sola: la revisas y la timbras desde la pestaña
            Prefacturas.
          </p>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-cos-ink">Nombre de la serie</label>
            <input
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
              maxLength={120}
              placeholder="Renta oficina"
              className="w-full rounded-control border border-cos-line px-3 py-2 text-sm focus:border-cos-brand focus:outline-none focus:ring-1 focus:ring-cos-brand"
            />
            <p className="mt-1 text-xs text-cos-ink-soft">Sólo para reconocerla en la lista.</p>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-cos-ink">Cada cuánto</label>
            <select
              value={periodicidad}
              onChange={(e) => setPeriodicidad(e.target.value as Periodicidad)}
              className="w-full rounded-control border border-cos-line px-3 py-2 text-sm focus:border-cos-brand focus:outline-none focus:ring-1 focus:ring-cos-brand"
            >
              {PERIODICIDADES.map((p) => (
                <option key={p} value={p}>
                  {PERIODICIDAD_LABEL[p]}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-cos-ink">Primera emisión</label>
              <input
                type="date"
                value={inicio}
                onChange={(e) => setInicio(e.target.value)}
                className="w-full rounded-control border border-cos-line px-3 py-2 text-sm focus:border-cos-brand focus:outline-none focus:ring-1 focus:ring-cos-brand"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-cos-ink">
                Hasta <span className="font-normal text-cos-ink-faint">(opcional)</span>
              </label>
              <input
                type="date"
                value={fin}
                onChange={(e) => setFin(e.target.value)}
                className="w-full rounded-control border border-cos-line px-3 py-2 text-sm focus:border-cos-brand focus:outline-none focus:ring-1 focus:ring-cos-brand"
              />
            </div>
          </div>

          {/* Confirmar la segunda fecha hace visible el anclaje: quien elige el
              31 de enero ve que la siguiente es el 28 de febrero, no el 3 de marzo. */}
          {proxima && periodicidad !== "SEMANAL" && (
            <p className="text-[12.5px] text-cos-ink-soft">
              Después de la primera, la siguiente caería el{" "}
              <strong className="font-semibold text-cos-ink">{formatoFecha(proxima)}</strong>.
            </p>
          )}

          {error && (
            <p className="rounded-lg bg-cos-red-tint px-3.5 py-2.5 text-[12.5px] text-cos-red-ink">
              {error}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-cos-line px-6 py-4">
          <Button variant="soft" size="md" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button
            variant="brand"
            size="md"
            onClick={guardar}
            disabled={busy || !nombre.trim() || !inicioValido}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Repeat className="h-4 w-4" />}
            {busy ? "Guardando…" : "Guardar serie"}
          </Button>
        </div>
      </div>
    </div>
  );
}
