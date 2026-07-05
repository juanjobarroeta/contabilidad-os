"use client";

import { useState } from "react";
import { Loader2, CheckCircle2, XCircle } from "lucide-react";

// Botones de confirmación de una acción escenificada (Tier 3). El "toque" de
// "Confirmar y timbrar" es la autorización: la sesión ya está autenticada, así que
// no hace falta un código. El POST re-valida todo en el servidor (membresía,
// suscripción, candado de un solo uso) y ejecuta por la ruta endurecida.
type Resultado =
  | { estado: "idle" }
  | { estado: "enviando" }
  | { estado: "timbrada"; uuid?: string; message?: string }
  | { estado: "cancelada" }
  | { estado: "error"; mensaje: string };

export function AutorizarAcciones({ token }: { token: string }) {
  const [r, setR] = useState<Resultado>({ estado: "idle" });

  async function enviar(action: "confirmar" | "cancelar") {
    setR({ estado: "enviando" });
    try {
      const res = await fetch(`/api/autorizar/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json().catch(() => ({}));
      if (action === "cancelar") {
        setR({ estado: "cancelada" });
        return;
      }
      if (res.ok && data.ok) {
        setR({ estado: "timbrada", uuid: data.uuid, message: data.message });
      } else {
        setR({ estado: "error", mensaje: data.error || "No se pudo completar la acción." });
      }
    } catch {
      setR({ estado: "error", mensaje: "Error de red. Inténtalo de nuevo." });
    }
  }

  if (r.estado === "timbrada") {
    return (
      <div className="flex items-start gap-3 rounded-control bg-cos-jade-tint px-4 py-3.5">
        <CheckCircle2 className="mt-0.5 h-5 w-5 flex-none text-cos-jade" />
        <div className="min-w-0">
          <p className="text-[14px] font-semibold text-cos-jade-ink">Factura timbrada</p>
          {r.uuid && <p className="mt-0.5 break-all text-[12.5px] text-cos-jade-ink opacity-90">Folio fiscal: {r.uuid}</p>}
          <p className="mt-1 text-[12.5px] text-cos-jade-ink opacity-80">Ya puedes cerrar esta ventana.</p>
        </div>
      </div>
    );
  }

  if (r.estado === "cancelada") {
    return (
      <div className="flex items-center gap-2 rounded-control bg-cos-slate-tint px-4 py-3 text-[14px] text-cos-ink-soft">
        <XCircle className="h-5 w-5 flex-none" /> Acción cancelada. No se timbró nada.
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <button
          type="button"
          disabled={r.estado === "enviando"}
          onClick={() => enviar("confirmar")}
          className="inline-flex flex-1 items-center justify-center gap-2 rounded-control bg-cos-jade px-4 py-2.5 text-[14.5px] font-semibold text-white hover:opacity-90 disabled:opacity-60"
        >
          {r.estado === "enviando" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Confirmar y timbrar
        </button>
        <button
          type="button"
          disabled={r.estado === "enviando"}
          onClick={() => enviar("cancelar")}
          className="inline-flex items-center justify-center rounded-control border border-cos-line px-4 py-2.5 text-[14.5px] font-medium text-cos-ink-soft hover:bg-cos-slate-tint disabled:opacity-60"
        >
          Cancelar
        </button>
      </div>
      {r.estado === "error" && (
        <p className="mt-2.5 text-[13px] text-cos-red-ink">{r.mensaje}</p>
      )}
    </div>
  );
}
