"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Centro de complementos de pago (REP) por emitir.
//
// Lista las facturas PPD timbradas con cobros detectados (conciliación
// bancaria) a los que les falta REP, con el plazo legal de cada cobro (día 5
// del mes siguiente, RMF 2.7.1.32). Cada cobro se PREVISUALIZA antes de
// timbrar: parcialidad, saldo anterior/insoluto e IVA del pago — el mismo
// cálculo del motor (prepararRep), sin timbrar ni escribir nada.
//
// Los cobros que la conciliación no conoce todavía se registran desde el
// detalle de la factura ("Emitir complemento de pago"), que permite monto y
// fecha manuales. Este centro es para no dejar pasar los detectados.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Loader2, X } from "lucide-react";
import { Card, Money } from "@/components/ui";
import { etiquetaPlazoRep, repVencido } from "@/lib/facturas/rep-plazo";

interface Pago {
  id: string;
  fecha: string;
  monto: number;
  descripcion: string | null;
  referencia: string | null;
}
interface Pendiente {
  invoice: {
    id: string;
    uuid: string | null;
    serie: string | null;
    folio: string | null;
    fecha: string;
    total: number;
    customer: { razonSocial: string; rfc: string } | null;
  };
  payments: Pago[];
  existingReps: { id: string; uuid: string | null; total: number }[];
  totalPaid: number;
  totalReped: number;
  pendingAmount: number;
  needsRep: boolean;
}
interface SinCobro {
  invoice: Pendiente["invoice"];
  totalReped: number;
  saldoInsoluto: number;
}
interface Preview {
  cliente: string;
  rfc: string;
  monto: number;
  fechaPago: string;
  numParcialidad: number;
  impSaldoAnterior: number;
  impSaldoInsoluto: number;
  ivaTrasladado: number;
}

const fmtMoney = (n: number) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(n);
const fmtFecha = (iso: string) => {
  const MES = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
  const d = new Date(iso);
  return `${String(d.getUTCDate()).padStart(2, "0")} ${MES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};
const folioDe = (inv: Pendiente["invoice"]) =>
  inv.serie || inv.folio ? [inv.serie, inv.folio].filter(Boolean).join("-") : `…${(inv.uuid ?? "").slice(-8)}`;

export function ComplementosPendientes({
  companyId,
  onToast,
  onEmitted,
}: {
  companyId: string;
  onToast: (m: string) => void;
  /** Se emitió un REP: el padre refresca su lista (aparece el CFDI tipo PAGO). */
  onEmitted: () => void;
}) {
  const [pendientes, setPendientes] = useState<Pendiente[]>([]);
  const [sinCobro, setSinCobro] = useState<SinCobro[]>([]);
  const [sinCobroAbierto, setSinCobroAbierto] = useState(false);
  const [abierta, setAbierta] = useState<string | null>(null);
  // Modal de previsualización. Con `pago` (cobro conciliado) el motor toma
  // monto/fecha del movimiento; sin él (despacho que no concilia banco) el
  // cobro se captura a mano y se previsualiza con esos datos.
  const [modal, setModal] = useState<{ inv: Pendiente["invoice"]; pago?: Pago } | null>(null);
  const [manualFecha, setManualFecha] = useState("");
  const [manualMonto, setManualMonto] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewErr, setPreviewErr] = useState("");
  const [previewBusy, setPreviewBusy] = useState(false);
  const [formaPago, setFormaPago] = useState("03");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/facturas/complemento-pagos?companyId=${companyId}`);
      const data = await res.json();
      const rows: Pendiente[] = Array.isArray(data?.pendientes) ? data.pendientes : [];
      setPendientes(rows.filter((p) => p.needsRep));
      setSinCobro(Array.isArray(data?.sinCobroDetectado) ? data.sinCobroDetectado : []);
    } catch {
      setPendientes([]);
      setSinCobro([]);
    }
  }, [companyId]);

  useEffect(() => { load(); }, [load]);

  /** Cuerpo del POST según el modo: cobro conciliado o captura manual. */
  function bodyCobro(m: { inv: Pendiente["invoice"]; pago?: Pago }) {
    return m.pago
      ? { companyId, invoiceId: m.inv.id, bankTransactionId: m.pago.id }
      : {
          companyId,
          invoiceId: m.inv.id,
          ...(manualMonto.trim() ? { monto: Number(manualMonto) } : {}),
          ...(manualFecha ? { fechaPago: manualFecha } : {}),
        };
  }

  async function calcularPreview(m: { inv: Pendiente["invoice"]; pago?: Pago }) {
    setPreview(null);
    setPreviewErr("");
    setPreviewBusy(true);
    try {
      const res = await fetch("/api/facturas/complemento-pagos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preview: true, ...bodyCobro(m) }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "No se pudo calcular el complemento");
      setPreview(data.preview);
    } catch (e) {
      setPreviewErr(e instanceof Error ? e.message : "No se pudo calcular el complemento");
    } finally {
      setPreviewBusy(false);
    }
  }

  function abrirConciliado(inv: Pendiente["invoice"], pago: Pago) {
    setModal({ inv, pago });
    calcularPreview({ inv, pago });
  }

  function abrirManual(x: SinCobro) {
    setModal({ inv: x.invoice });
    setPreview(null);
    setPreviewErr("");
    setManualFecha(new Date().toISOString().slice(0, 10));
    setManualMonto(String(x.saldoInsoluto));
  }

  async function emitir() {
    if (!modal) return;
    setBusy(true);
    try {
      const res = await fetch("/api/facturas/complemento-pagos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...bodyCobro(modal), formaPago }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "Error al emitir el complemento");
      onToast(`✓ Complemento emitido (parcialidad ${data.numParcialidad}, ${fmtMoney(data.monto)})`);
      setModal(null);
      await load();
      onEmitted();
    } catch (e) {
      setPreviewErr(e instanceof Error ? e.message : "Error al emitir el complemento");
    } finally {
      setBusy(false);
    }
  }

  if (pendientes.length === 0 && sinCobro.length === 0) return null;

  const hoy = new Date();
  const vencidos = pendientes.reduce(
    (s, p) => s + p.payments.filter((pg) => repVencido(new Date(pg.fecha), hoy)).length,
    0,
  );

  return (
    <>
      <Card className="mt-4 overflow-hidden rounded-card border-cos-line shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-cos-line px-[18px] py-3">
          <span className="text-[13px] font-semibold text-cos-ink">
            Complementos de pago por emitir{" "}
            <span className="ml-1 rounded-full bg-cos-amber-tint px-2 py-0.5 font-mono text-[11.5px] text-cos-amber-ink">
              {pendientes.length}
            </span>
            {vencidos > 0 && (
              <span className="ml-1.5 rounded-full bg-cos-red-tint px-2 py-0.5 text-[11.5px] font-medium text-cos-red-ink">
                {vencidos} fuera de plazo
              </span>
            )}
          </span>
          <span className="text-[12px] text-cos-ink-faint">
            Cobros de facturas PPD sin REP — el plazo es el día 5 del mes siguiente al cobro.
          </span>
        </div>

        {pendientes.map((p) => (
          <div key={p.invoice.id} className="border-b border-cos-line last:border-0">
            <button
              onClick={() => setAbierta(abierta === p.invoice.id ? null : p.invoice.id)}
              className="flex w-full flex-wrap items-center justify-between gap-2 px-[18px] py-2.5 text-left hover:bg-cos-paper"
            >
              <div className="flex min-w-0 items-center gap-2">
                {abierta === p.invoice.id
                  ? <ChevronDown className="h-4 w-4 flex-none text-cos-ink-faint" />
                  : <ChevronRight className="h-4 w-4 flex-none text-cos-ink-faint" />}
                <div className="min-w-0">
                  <p className="truncate text-[13.5px] font-medium text-cos-ink">
                    {p.invoice.customer?.razonSocial ?? "—"}{" "}
                    <span className="font-mono text-[11.5px] text-cos-ink-faint">{folioDe(p.invoice)}</span>
                  </p>
                  <p className="font-mono text-[11.5px] text-cos-ink-faint">
                    {p.invoice.customer?.rfc ?? "—"} · factura {fmtFecha(p.invoice.fecha)} · {fmtMoney(p.invoice.total)}
                  </p>
                </div>
              </div>
              <div className="flex flex-none items-center gap-3 text-[12.5px]">
                <span className="text-cos-ink-soft">cobrado {fmtMoney(p.totalPaid)}</span>
                {p.totalReped > 0 && <span className="text-cos-ink-faint">con REP {fmtMoney(p.totalReped)}</span>}
                <span className="font-semibold text-cos-amber-ink">sin REP {fmtMoney(p.pendingAmount)}</span>
              </div>
            </button>

            {abierta === p.invoice.id && (
              <div className="bg-cos-paper px-[18px] py-1.5">
                {p.payments.map((pg: Pago) => {
                  const vencido = repVencido(new Date(pg.fecha), hoy);
                  return (
                    <div key={pg.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-cos-line-soft py-2 first:border-0">
                      <div className="min-w-0">
                        <p className="text-[13px] text-cos-ink">
                          {fmtFecha(pg.fecha)} · <span className="font-mono font-medium">{fmtMoney(pg.monto)}</span>
                        </p>
                        <p className="truncate text-[11.5px] text-cos-ink-faint">{pg.descripcion ?? pg.referencia ?? "Cobro conciliado"}</p>
                      </div>
                      <div className="flex flex-none items-center gap-2.5">
                        <span className={`text-[12px] ${vencido ? "font-medium text-cos-red-ink" : "text-cos-ink-faint"}`}>
                          {vencido && <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />}
                          {etiquetaPlazoRep(new Date(pg.fecha), hoy)}
                        </span>
                        <button
                          onClick={() => abrirConciliado(p.invoice, pg)}
                          className="rounded-control border border-cos-line bg-cos-card px-2.5 py-1.5 text-[12px] font-medium text-cos-brand-ink hover:bg-cos-brand-tint"
                        >
                          Previsualizar y emitir
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}

        {/* PPD con saldo insoluto y sin cobro detectado: para despachos que no
            concilian banco — el cobro se captura a mano y el motor calcula la
            parcialidad igual. Colapsado por default: puede ser cartera larga. */}
        {sinCobro.length > 0 && (
          <div className="border-t border-cos-line">
            <button
              onClick={() => setSinCobroAbierto(!sinCobroAbierto)}
              className="flex w-full items-center gap-2 px-[18px] py-2.5 text-left hover:bg-cos-paper"
            >
              {sinCobroAbierto
                ? <ChevronDown className="h-4 w-4 flex-none text-cos-ink-faint" />
                : <ChevronRight className="h-4 w-4 flex-none text-cos-ink-faint" />}
              <span className="text-[13px] font-medium text-cos-ink">
                Facturas PPD con saldo insoluto sin cobro registrado{" "}
                <span className="ml-1 rounded-full bg-cos-slate-tint px-2 py-0.5 font-mono text-[11.5px] text-cos-ink-soft">{sinCobro.length}</span>
              </span>
              <span className="ml-auto text-[12px] text-cos-ink-faint">
                ¿Ya te pagaron alguna? Registra el cobro y emite su REP aquí.
              </span>
            </button>
            {sinCobroAbierto && sinCobro.map((x) => (
              <div key={x.invoice.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-cos-line-soft bg-cos-paper px-[18px] py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-[13.5px] font-medium text-cos-ink">
                    {x.invoice.customer?.razonSocial ?? "—"}{" "}
                    <span className="font-mono text-[11.5px] text-cos-ink-faint">{folioDe(x.invoice)}</span>
                  </p>
                  <p className="font-mono text-[11.5px] text-cos-ink-faint">
                    {x.invoice.customer?.rfc ?? "—"} · factura {fmtFecha(x.invoice.fecha)} · {fmtMoney(x.invoice.total)}
                    {x.totalReped > 0 ? ` · con REP ${fmtMoney(x.totalReped)}` : ""}
                  </p>
                </div>
                <div className="flex flex-none items-center gap-2.5">
                  <span className="text-[12.5px] font-semibold text-cos-ink">saldo {fmtMoney(x.saldoInsoluto)}</span>
                  <button
                    onClick={() => abrirManual(x)}
                    className="rounded-control border border-cos-line bg-cos-card px-2.5 py-1.5 text-[12px] font-medium text-cos-brand-ink hover:bg-cos-brand-tint"
                  >
                    Registrar cobro
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Modal: la previsualización del motor antes de timbrar. */}
      {modal && (
        <div className="fixed inset-0 z-[60] grid place-items-center bg-[oklch(0.2_0.02_258_/_0.45)] p-[18px]" onClick={() => !busy && setModal(null)}>
          <div className="w-full max-w-[440px] rounded-[18px] bg-cos-card p-6 shadow-[0_30px_60px_-20px_oklch(0.2_0.05_258_/_0.5)]" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between">
              <p className="text-[15px] font-semibold text-cos-ink">Complemento de pago</p>
              <button onClick={() => !busy && setModal(null)} className="grid h-9 w-9 place-items-center rounded-control text-cos-ink-soft hover:bg-cos-paper">
                <X className="h-5 w-5" />
              </button>
            </div>
            <p className="font-mono text-[12.5px] text-cos-ink-faint">
              {modal.inv.customer?.razonSocial ?? "—"} · {folioDe(modal.inv)}
            </p>

            {/* Cobro manual (sin conciliación): fecha y monto se capturan aquí
                y el motor calcula la parcialidad con esos datos. */}
            {!modal.pago && (
              <>
                <div className="mt-3 grid grid-cols-2 gap-2.5">
                  <label className="block text-[12.5px] text-cos-ink-soft">
                    Fecha del cobro
                    <input
                      type="date"
                      value={manualFecha}
                      onChange={(e) => { setManualFecha(e.target.value); setPreview(null); }}
                      className="mt-1 w-full rounded-control border border-cos-line bg-cos-card px-2.5 py-2 text-[13.5px] text-cos-ink outline-none"
                    />
                  </label>
                  <label className="block text-[12.5px] text-cos-ink-soft">
                    Monto cobrado
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={manualMonto}
                      onChange={(e) => { setManualMonto(e.target.value); setPreview(null); }}
                      className="mt-1 w-full rounded-control border border-cos-line bg-cos-card px-2.5 py-2 text-[13.5px] text-cos-ink outline-none"
                    />
                  </label>
                </div>
                {/* Dedazo típico dd/mm: cobro fechado antes de la factura casi
                    siempre es el mes equivocado. Aviso, no bloqueo. */}
                {manualFecha && new Date(manualFecha + "T12:00:00Z") < new Date(modal.inv.fecha) && (
                  <p className="mt-2 flex items-start gap-1.5 text-[12.5px] text-cos-amber-ink">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    La fecha del cobro es anterior a la emisión de la factura ({fmtFecha(modal.inv.fecha)}).
                    Revisa que no sea el mes equivocado — el IVA se causa en el mes del cobro.
                  </p>
                )}
                {!preview && (
                  <button
                    onClick={() => calcularPreview(modal)}
                    disabled={previewBusy || !manualFecha || !manualMonto.trim()}
                    className="mt-3 w-full rounded-control border border-cos-line py-2 text-[13px] font-medium text-cos-brand-ink hover:bg-cos-brand-tint disabled:opacity-50"
                  >
                    {previewBusy ? "Calculando…" : "Previsualizar complemento"}
                  </button>
                )}
              </>
            )}

            {previewErr && (
              <p className="mt-3 flex items-start gap-1.5 rounded-[10px] bg-cos-red-tint px-3 py-2.5 text-[13px] text-cos-red-ink">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {previewErr}
              </p>
            )}

            {modal.pago && !preview && !previewErr && (
              <p className="mt-4 flex items-center gap-2 text-[13px] text-cos-ink-faint">
                <Loader2 className="h-4 w-4 animate-spin" /> Calculando parcialidad y saldos…
              </p>
            )}

            {preview && (
              <>
                <div className="mt-[18px] border-t border-cos-line-soft">
                  <div className="flex justify-between border-b border-cos-line-soft py-2.5 text-[14px] text-cos-ink-soft">
                    <span>Fecha del cobro</span><span className="font-medium text-cos-ink">{fmtFecha(preview.fechaPago + "T12:00:00Z")}</span>
                  </div>
                  <div className="flex justify-between border-b border-cos-line-soft py-2.5 text-[14px] text-cos-ink-soft">
                    <span>Parcialidad</span><span className="font-medium text-cos-ink">#{preview.numParcialidad}</span>
                  </div>
                  <div className="flex justify-between border-b border-cos-line-soft py-2.5 text-[14px] text-cos-ink-soft">
                    <span>Saldo anterior</span><Money value={preview.impSaldoAnterior} size={15} weight={500} />
                  </div>
                  <div className="flex justify-between border-b border-cos-line-soft py-2.5 text-[14px] text-cos-ink-soft">
                    <span>Monto del pago</span><Money value={preview.monto} size={15} weight={500} />
                  </div>
                  <div className="flex justify-between border-b border-cos-line-soft py-2.5 text-[14px] text-cos-ink-soft">
                    <span>IVA trasladado del pago</span><Money value={preview.ivaTrasladado} size={15} weight={500} />
                  </div>
                  <div className="flex justify-between py-2.5 text-[14px] font-semibold text-cos-ink">
                    <span>Saldo insoluto</span><Money value={preview.impSaldoInsoluto} size={15} weight={600} />
                  </div>
                </div>

                <label className="mt-1 block text-[12.5px] text-cos-ink-soft">
                  Forma de pago
                  <select
                    value={formaPago}
                    onChange={(e) => setFormaPago(e.target.value)}
                    className="mt-1 w-full rounded-control border border-cos-line bg-cos-card px-2.5 py-2 text-[13.5px] text-cos-ink outline-none"
                  >
                    <option value="03">03 — Transferencia electrónica</option>
                    <option value="01">01 — Efectivo</option>
                    <option value="02">02 — Cheque nominativo</option>
                    <option value="04">04 — Tarjeta de crédito</option>
                    <option value="28">28 — Tarjeta de débito</option>
                  </select>
                </label>

                <div className="mt-4 flex gap-2">
                  <button
                    onClick={emitir}
                    disabled={busy}
                    className="flex-1 rounded-control bg-cos-brand px-3 py-2 text-[13px] font-semibold text-white hover:bg-cos-brand-deep disabled:opacity-50"
                  >
                    {busy ? "Timbrando…" : "Timbrar complemento"}
                  </button>
                  <button
                    onClick={() => setModal(null)}
                    disabled={busy}
                    className="rounded-control border border-cos-line px-3 py-2 text-[13px] text-cos-ink-soft hover:bg-cos-paper"
                  >
                    Cancelar
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
