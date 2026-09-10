"use client";

// ─────────────────────────────────────────────────────────────────────────────
// AVISO DE REP SUGERIDO — «este cobro necesita complemento de pago».
//
// Al conciliar el cobro de una factura PPD, el PATCH devuelve `repSugerido`:
// el IVA se causa en el MES DEL PAGO y el complemento vence el quinto día
// natural del mes siguiente, así que el momento de emitirlo es justo ése.
//
// Vivía dentro de GestionBancos. La mesa monta el MISMO panel para resolver,
// pero no le pasaba `onRepSugerido`: la sugerencia se caía en silencio y
// conciliar desde la mesa —hoy la pantalla por defecto de /bancos— nunca
// ofrecía el REP. La tarjeta vive aquí para que las dos la muestren.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from "react";
import type { RepSugerido } from "./ResolverMovimiento";

export function AvisoRepSugerido({
  rep,
  companyId,
  onCerrar,
  onToast,
}: {
  rep: RepSugerido;
  companyId: string;
  onCerrar: () => void;
  onToast: (mensaje: string) => void;
}) {
  const [emitiendo, setEmitiendo] = useState(false);

  async function emitir() {
    setEmitiendo(true);
    try {
      const res = await fetch("/api/facturas/complemento-pagos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId,
          invoiceId: rep.invoiceId,
          bankTransactionId: rep.txId, // monto y fecha salen del movimiento
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) { onToast(data?.error ?? "No se pudo timbrar el complemento"); return; }
      onToast(`Complemento de pago timbrado (parcialidad ${data.numParcialidad})`);
      onCerrar();
    } finally {
      setEmitiendo(false);
    }
  }

  return (
    <div className="fixed bottom-6 right-6 z-[89] w-[340px] rounded-card border border-cos-line bg-cos-card p-4 shadow-[0_18px_40px_-16px_oklch(0.2_0.05_258_/_0.5)]">
      <p className="text-[13.5px] font-semibold text-cos-ink">Este cobro necesita complemento de pago</p>
      <p className="mt-1 text-[12.5px] text-cos-ink-soft">
        Conciliaste un cobro de <b>{rep.cliente}</b> por{" "}
        <b>{new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(rep.monto)}</b> contra
        una factura PPD. El IVA se causa en el mes del pago y el REP vence el quinto día natural del mes siguiente.
      </p>
      <div className="mt-3 flex gap-2">
        <button
          onClick={emitir}
          disabled={emitiendo}
          className="flex-1 rounded-control bg-cos-brand px-3 py-2 text-[13px] font-semibold text-white hover:bg-cos-brand-deep disabled:opacity-50"
        >
          {emitiendo ? "Timbrando…" : "Emitir REP ahora"}
        </button>
        <button
          onClick={onCerrar}
          disabled={emitiendo}
          className="rounded-control border border-cos-line px-3 py-2 text-[13px] text-cos-ink-soft hover:bg-cos-paper"
        >
          Después
        </button>
      </div>
    </div>
  );
}
