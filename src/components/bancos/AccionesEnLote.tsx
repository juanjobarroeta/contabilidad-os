"use client";

// ─────────────────────────────────────────────────────────────────────────────
// ACCIONES EN LOTE — la barra que aparece al palomear N movimientos.
//
// Vivía dentro de GestionBancos (tab Movimientos) y era lo ÚNICO que quedaba
// sin equivalente en la mesa: para categorizar veinte comisiones de un golpe
// había que salirse de la conciliación e irse a otra pestaña. Eso es de donde
// salía la doble mesa. Aquí está una sola vez, con sus tres endpoints:
//
//   PATCH /api/bancos/transactions/[id]  action:ignore  → categoría simple
//                                        (etiqueta en `notes`, sin asiento)
//   POST  /api/bancos/sugerencias/lote                  → familia CON asiento
//                                        en el libro (aprobarSugerencia)
//   POST  /api/bancos/batch-match                       → N movimientos ↔ 1 CFDI
//
// GUARDA DE LO YA CONCILIADO. `ignore` limpia el vínculo con la factura (y
// revierte la declaración pagada): categorizar en lote algo ya cruzado LO
// DESCRUZA en silencio. La lista de la mesa mezcla pendientes con «conciliado ·
// por contabilizar», así que aquí se dice y se pide confirmación — el tab
// Movimientos nunca lo advirtió.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import { Loader2, Search, X } from "lucide-react";
import { Card, Money } from "@/components/ui";
import { FAMILIA_LOTE, fmtFechaCorta, type FacturaBuscada } from "./resolver-tipos";

/** Peticiones simultáneas de la categoría simple (un PATCH por movimiento). */
const TANDA = 8;
/** Tope del endpoint batch-match (su zod: `.max(200)`). */
const LOTE_MATCH_MAX = 200;

export function AccionesEnLote({
  companyId,
  txIds,
  suma,
  conciliados,
  onListo,
  onToast,
}: {
  companyId: string;
  /** Los movimientos palomeados. La barra no se pinta si está vacío. */
  txIds: string[];
  /** Neto firmado en valor absoluto: un reembolso resta, igual que el motor. */
  suma: number;
  /** Cuántos de los palomeados YA están conciliados (status ≠ UNMATCHED). */
  conciliados: number;
  /** Tras aplicar: quien la use limpia su selección y recarga. */
  onListo: () => void | Promise<void>;
  onToast: (mensaje: string) => void;
}) {
  const [aplicando, setAplicando] = useState(false);
  const [matchOpen, setMatchOpen] = useState(false);

  if (txIds.length === 0) return null;

  /** true = seguir. Sólo pregunta cuando la acción rompería un cruce vivo. */
  function confirmarDescruce(accion: string): boolean {
    if (conciliados === 0) return true;
    return window.confirm(
      `${conciliados} de los ${txIds.length} movimientos seleccionados ya están conciliados.\n\n` +
        `«${accion}» borra su vínculo con la factura (y revierte el pago de la declaración si lo hubiera).\n\n` +
        `¿Continuar?`,
    );
  }

  /** Categoría simple: etiqueta en `notes`, sin asiento en el libro. */
  async function categorizar(tag: string | null, label: string) {
    if (!confirmarDescruce(label)) return;
    setAplicando(true);
    try {
      // De TANDA en TANDA, y contando: «seleccionar los 300 de la lista» con un
      // PATCH por movimiento abría 300 peticiones simultáneas. Y el resultado
      // se mira — antes se disparaban y se anunciaba el éxito sin leer una sola
      // respuesta, así que un lote fallido se reportaba como aplicado.
      let ok = 0;
      for (let i = 0; i < txIds.length; i += TANDA) {
        const tanda = await Promise.all(
          txIds.slice(i, i + TANDA).map((id) =>
            fetch(`/api/bancos/transactions/${id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "ignore", notes: tag }),
            })
              .then((r) => r.ok)
              .catch(() => false),
          ),
        );
        ok += tanda.filter(Boolean).length;
      }
      onToast(
        ok === txIds.length
          ? `${ok} ${ok === 1 ? "movimiento" : "movimientos"}: ${label}`
          : `${ok} de ${txIds.length}: ${label} — ${txIds.length - ok} no se ${txIds.length - ok === 1 ? "pudo" : "pudieron"} aplicar`,
      );
      await onListo();
    } finally {
      setAplicando(false);
    }
  }

  /** Familia que SÍ asienta en el libro mayor (aprobarSugerencia). */
  async function categorizarConAsiento(familia: string, label: string) {
    if (!confirmarDescruce(label)) return;
    setAplicando(true);
    try {
      const res = await fetch("/api/bancos/sugerencias/lote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ txIds, familia }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const n = data?.lote?.aprobados ?? txIds.length;
        onToast(`${n} ${n === 1 ? "movimiento" : "movimientos"}: ${label}`);
        await onListo();
      } else {
        onToast(data?.error ?? "No se pudo categorizar");
      }
    } finally {
      setAplicando(false);
    }
  }

  const botón =
    "rounded-control bg-white/15 px-3.5 py-2 text-[13.5px] font-semibold hover:bg-white/25 disabled:opacity-50";

  return (
    <>
      <div className="sticky bottom-5 z-[80] mt-5 flex flex-wrap items-center justify-between gap-3 rounded-card bg-cos-ink px-5 py-3.5 text-cos-canvas shadow-[0_18px_40px_-16px_oklch(0.2_0.05_258/0.6)]">
        <span className="text-[14px] font-semibold">
          {txIds.length} {txIds.length === 1 ? "movimiento" : "movimientos"} ·{" "}
          <span className="font-mono">{fmtImporte(suma)}</span>
          {conciliados > 0 && (
            <span className="ml-2 rounded-full bg-white/15 px-2 py-0.5 text-[12px] font-medium">
              {conciliados} ya {conciliados === 1 ? "conciliado" : "conciliados"}
            </span>
          )}
        </span>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => categorizar("TAX_PAYMENT", "Pago de impuestos")} disabled={aplicando} className={botón}>
            Impuestos
          </button>
          <button onClick={() => categorizar("INTERNAL_TRANSFER", "Transferencia")} disabled={aplicando} className={botón}>
            Transferencia
          </button>
          {/* No deducible + selector de familia → registran el asiento (endpoint lote). */}
          <button
            onClick={() => categorizarConAsiento("NON_DEDUCTIBLE", "No deducible")}
            disabled={aplicando}
            className={botón}
          >
            No deducible
          </button>
          <select
            value=""
            disabled={aplicando}
            aria-label="Clasificar en otra familia"
            onChange={(e) => {
              const f = FAMILIA_LOTE.find((x) => x.familia === e.target.value);
              if (f) categorizarConAsiento(f.familia, f.label);
              e.target.value = "";
            }}
            className="rounded-control bg-white/15 px-3 py-2 text-[13.5px] font-semibold text-white hover:bg-white/25 disabled:opacity-50 [&>option]:text-cos-ink"
          >
            <option value="" disabled>
              Otra familia…
            </option>
            {FAMILIA_LOTE.filter((f) => f.familia !== "NON_DEDUCTIBLE").map((f) => (
              <option key={f.familia} value={f.familia}>
                {f.label}
              </option>
            ))}
          </select>
          <button onClick={() => categorizar(null, "Ignorar")} disabled={aplicando} className={botón}>
            Ignorar
          </button>
          <button
            onClick={() => setMatchOpen(true)}
            disabled={aplicando || txIds.length > LOTE_MATCH_MAX}
            title={
              txIds.length > LOTE_MATCH_MAX
                ? `Conciliar contra una factura admite hasta ${LOTE_MATCH_MAX} movimientos a la vez.`
                : undefined
            }
            className="rounded-control bg-cos-brand px-3.5 py-2 text-[13.5px] font-semibold hover:bg-cos-brand-deep disabled:opacity-50"
          >
            {aplicando ? <Loader2 className="h-4 w-4 animate-spin" /> : "Conciliar en lote"}
          </button>
        </div>
      </div>

      {matchOpen && (
        <ModalConciliarEnLote
          companyId={companyId}
          count={txIds.length}
          sum={suma}
          onClose={() => setMatchOpen(false)}
          onConfirm={async (invoiceId) => {
            const res = await fetch("/api/bancos/batch-match", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ txIds, invoiceId }),
            });
            setMatchOpen(false);
            if (res.ok) {
              onToast(`${txIds.length} ${txIds.length === 1 ? "movimiento conciliado" : "movimientos conciliados"}`);
              await onListo();
            } else {
              onToast("No se pudo conciliar en lote");
            }
          }}
        />
      )}
    </>
  );
}

const fmtImporte = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

// ── Modal: conciliar N movimientos con una factura ───────────────────────────
function ModalConciliarEnLote({
  companyId,
  count,
  sum,
  onClose,
  onConfirm,
}: {
  companyId: string;
  count: number;
  sum: number;
  onClose: () => void;
  onConfirm: (invoiceId: string) => Promise<void> | void;
}) {
  const [query, setQuery] = useState("");
  const [tipo, setTipo] = useState<"EGRESO" | "INGRESO" | "NOMINA">("INGRESO");
  const [results, setResults] = useState<FacturaBuscada[]>([]);
  const [loading, setLoading] = useState(false);
  const [picked, setPicked] = useState<FacturaBuscada | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ companyId, tipo, take: "30", unmatchedOnly: "true" });
        if (query.trim()) params.set("q", query.trim());
        const res = await fetch(`/api/facturas?${params}`);
        const data = await res.json();
        if (!cancelled) setResults(Array.isArray(data) ? data : []);
      } catch { if (!cancelled) setResults([]); }
      finally { if (!cancelled) setLoading(false); }
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, tipo, companyId]);

  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <Card className="w-full max-w-[520px] rounded-card border-cos-line p-5 shadow-card" >
        <div onClick={(e) => e.stopPropagation()}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[16px] font-semibold text-cos-ink">Conciliar {count} movimiento(s) con una factura</p>
              <p className="mt-0.5 text-[13px] text-cos-ink-soft">Suma seleccionada: <span className="font-mono font-semibold">{fmtImporte(sum)}</span></p>
            </div>
            <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-control text-cos-ink-soft hover:bg-cos-paper"><X className="h-5 w-5" /></button>
          </div>

          <div className="mt-3 flex gap-1.5">
            {(["INGRESO","EGRESO","NOMINA"] as const).map((t) => (
              <button key={t} onClick={() => setTipo(t)}
                className={"rounded-full px-3 py-1 text-[12.5px] font-medium " + (tipo === t ? "bg-cos-brand text-white" : "bg-cos-paper text-cos-ink-soft hover:bg-cos-line-soft")}>
                {t === "INGRESO" ? "Ingresos" : t === "EGRESO" ? "Gastos (Egreso)" : "Nómina"}
              </button>
            ))}
          </div>

          <div className="mt-3 flex items-center gap-2 rounded-control border border-cos-line px-3 py-2">
            <Search className="h-4 w-4 text-cos-ink-faint" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar por proveedor, RFC, UUID, folio…"
              className="w-full bg-transparent text-[13.5px] outline-none placeholder:text-cos-ink-faint" autoFocus />
          </div>

          <div className="mt-3 max-h-[44vh] overflow-y-auto">
            {loading ? (
              <div className="flex items-center gap-2 py-6 text-[13px] text-cos-ink-faint"><Loader2 className="h-4 w-4 animate-spin" /> Buscando…</div>
            ) : results.length === 0 ? (
              <p className="py-6 text-center text-[13px] text-cos-ink-faint">Sin facturas por conciliar.</p>
            ) : results.map((f) => (
              <button key={f.id} onClick={() => setPicked(f)}
                className={"flex w-full items-center justify-between gap-3 border-b border-cos-line-soft px-1 py-2.5 text-left last:border-0 " + (picked?.id === f.id ? "bg-cos-brand-tint" : "hover:bg-cos-paper")}>
                <div className="min-w-0">
                  <p className="truncate text-[13.5px] font-medium text-cos-ink">{f.customer?.razonSocial ?? "—"}</p>
                  <p className="text-[12px] text-cos-ink-faint"><span className="font-mono">{f.customer?.rfc ?? "—"}</span>{f.folio ? ` · ${f.serie ?? ""}${f.folio}` : ""} · {fmtFechaCorta(f.fecha)}</p>
                </div>
                <Money value={f.total} size={13} weight={600} />
              </button>
            ))}
          </div>

          {picked && (
            <div className="mt-3 rounded-control bg-cos-paper px-3 py-2.5 text-[13px]">
              <div className="flex justify-between"><span className="text-cos-ink-soft">Factura total</span><Money value={picked.total} size={13} weight={600} /></div>
              <div className="flex justify-between"><span className="text-cos-ink-soft">Suma seleccionada</span><span className="font-mono font-semibold">{fmtImporte(sum)}</span></div>
              <div className="flex justify-between">
                <span className="text-cos-ink-soft">Cobertura</span>
                <span className={"font-semibold " + (picked.total > 0 && sum / picked.total > 1.001 ? "text-cos-red-ink" : "text-cos-jade-ink")}>
                  {picked.total > 0 ? Math.round((sum / picked.total) * 100) : 0}%{picked.total > 0 && sum / picked.total > 1.001 ? " (excede)" : ""}
                </span>
              </div>
            </div>
          )}

          <div className="mt-4 flex justify-end gap-2">
            <button onClick={onClose} className="rounded-control border border-cos-line px-4 py-2 text-[13.5px] font-semibold text-cos-ink hover:bg-cos-paper">Cancelar</button>
            <button disabled={!picked || confirming} onClick={async () => { if (!picked) return; setConfirming(true); try { await onConfirm(picked.id); } finally { setConfirming(false); } }}
              className="rounded-control bg-cos-brand px-4 py-2 text-[13.5px] font-semibold text-white hover:bg-cos-brand-deep disabled:opacity-50">
              {confirming ? "Conciliando…" : "Conciliar"}
            </button>
          </div>
        </div>
      </Card>
    </div>
  );
}
