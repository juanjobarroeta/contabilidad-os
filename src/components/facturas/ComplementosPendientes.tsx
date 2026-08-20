"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Centro de complementos de pago (REP) por emitir — idioma del deck.
//
// Cola de facturas PPD timbradas con cobros a los que les falta REP. Cada fila
// es compacta (~38px): checkbox para el lote, cliente + folio, parcialidad que
// tocaría, chip de plazo (día 5 del mes siguiente al cobro, RMF 2.7.1.32) y el
// monto sin REP alineado a la derecha. El botón «Emitir N REP en lote» timbra
// los seleccionados (máx. 20) de forma SECUENCIAL vía /complemento-pagos/lote;
// un fallo no tira el resto y los fallidos quedan seleccionados para
// reintentar.
//
// Se conservan los flujos previos: expandir una fila muestra cada cobro con su
// «Previsualizar y emitir» individual (preview del motor con prepararRep, sin
// timbrar), y la sección de PPD sin cobro detectado permite registrar el cobro
// a mano con monto/fecha.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Loader2, X } from "lucide-react";
import { Card, Money } from "@/components/ui";
import { cn } from "@/lib/utils";
import { etiquetaPlazoRep, fechaLimiteRep, repVencido } from "@/lib/facturas/rep-plazo";

interface Pago {
  /** Id del movimiento bancario que detectó el cobro; null si se registró a mano. */
  id: string | null;
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
interface ResultadoLote {
  invoiceId: string;
  ok: boolean;
  uuid?: string;
  monto?: number;
  numParcialidad?: number;
  error?: string;
}

/** Tope del endpoint de lote: cada emisión timbra un CFDI real. */
const MAX_LOTE = 20;

const fmtMoney = (n: number) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(n);
const fmtFecha = (iso: string) => {
  const MES = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
  const d = new Date(iso);
  return `${String(d.getUTCDate()).padStart(2, "0")} ${MES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};
const folioDe = (inv: Pendiente["invoice"]) =>
  inv.serie || inv.folio ? [inv.serie, inv.folio].filter(Boolean).join("-") : `…${(inv.uuid ?? "").slice(-8)}`;

/** Chip de plazo: días contra el día 5 del mes siguiente al cobro. */
function chipPlazo(fechaPago: Date, hoy: Date): { texto: string; cls: string } {
  const limite = fechaLimiteRep(fechaPago);
  const dia5 = Date.UTC(limite.getUTCFullYear(), limite.getUTCMonth(), limite.getUTCDate());
  const hoy0 = Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), hoy.getUTCDate());
  const dias = Math.round((dia5 - hoy0) / 86_400_000);
  if (dias < 0) return { texto: `atrasado ${-dias} d`, cls: "bg-cos-red-tint text-cos-red-ink" };
  if (dias === 0) return { texto: "vence hoy", cls: "bg-cos-red-tint text-cos-red-ink" };
  const texto = `en ${dias} día${dias === 1 ? "" : "s"}`;
  if (dias <= 3) return { texto, cls: "bg-cos-amber-tint text-cos-amber-ink" };
  return { texto, cls: "bg-cos-jade-tint text-cos-jade-ink" };
}

/** El cobro más reciente de la fila (rige el plazo del chip). */
function ultimoPago(p: Pendiente): Pago | null {
  return p.payments.reduce<Pago | null>(
    (max, pg) => (!max || new Date(pg.fecha) > new Date(max.fecha) ? pg : max),
    null,
  );
}

/**
 * El siguiente cobro por complementar: asumiendo REPs en orden cronológico,
 * el primero cuyo acumulado rebasa lo ya complementado.
 */
function mejorPago(p: Pendiente): Pago | null {
  const orden = [...p.payments].sort(
    (a, b) => new Date(a.fecha).getTime() - new Date(b.fecha).getTime(),
  );
  let acum = 0;
  for (const pg of orden) {
    acum += pg.monto;
    if (acum > p.totalReped + 0.01) return pg;
  }
  return orden[orden.length - 1] ?? null;
}

/** «única» si un solo pago cubre el total; si no, la parcialidad que tocaría. */
function parcialidadDe(p: Pendiente): string {
  if (p.existingReps.length === 0 && p.totalPaid >= p.invoice.total - 0.01) return "única";
  return `${p.existingReps.length + 1}ª parcialidad`;
}

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

  // ── Lote ──
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [loteFase, setLoteFase] = useState<null | "confirmar" | "timbrando" | "resultados">(null);
  const [loteErr, setLoteErr] = useState("");
  const [loteRes, setLoteRes] = useState<ResultadoLote[]>([]);
  // Nombre/folio/monto capturados ANTES de timbrar: tras el refresh, las filas
  // emitidas ya no están en `pendientes` y los resultados aún deben nombrarlas.
  const [loteItems, setLoteItems] = useState<{ invoiceId: string; nombre: string; folio: string; monto: number }[]>([]);

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

  /** Cuerpo del POST según el modo: cobro conciliado, cobro a mano previamente
   *  registrado (sin movimiento) o captura manual en el modal. */
  function bodyCobro(m: { inv: Pendiente["invoice"]; pago?: Pago }) {
    if (m.pago) {
      return m.pago.id
        ? { companyId, invoiceId: m.inv.id, bankTransactionId: m.pago.id }
        : { companyId, invoiceId: m.inv.id, monto: m.pago.monto, fechaPago: String(m.pago.fecha).slice(0, 10) };
    }
    return {
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

  // ── Selección para el lote ──

  function toggleSel(id: string) {
    const s = new Set(sel);
    if (s.has(id)) s.delete(id);
    else {
      if (s.size >= MAX_LOTE) {
        onToast(`Máximo ${MAX_LOTE} REP por lote — emite estos y sigue con el resto.`);
        return;
      }
      s.add(id);
    }
    setSel(s);
  }

  /** Item del POST /lote: espeja lo que manda la emisión individual. */
  function itemLote(p: Pendiente) {
    const pago = mejorPago(p);
    if (pago?.id) return { invoiceId: p.invoice.id, bankTransactionId: pago.id };
    // Cobro sin movimiento bancario: monto y fecha explícitos, del dato presente.
    return {
      invoiceId: p.invoice.id,
      monto: p.pendingAmount,
      ...(pago ? { fechaPago: String(pago.fecha).slice(0, 10) } : {}),
    };
  }

  function abrirLote() {
    const seleccion = pendientes.filter((p) => sel.has(p.invoice.id));
    if (seleccion.length === 0) return;
    setLoteItems(
      seleccion.map((p) => ({
        invoiceId: p.invoice.id,
        nombre: p.invoice.customer?.razonSocial ?? "—",
        folio: folioDe(p.invoice),
        monto: p.pendingAmount,
      })),
    );
    setLoteErr("");
    setLoteRes([]);
    setLoteFase("confirmar");
  }

  async function emitirLote() {
    const seleccion = pendientes.filter((p) => sel.has(p.invoice.id));
    if (seleccion.length === 0) return;
    setLoteErr("");
    setLoteFase("timbrando");
    try {
      const res = await fetch("/api/facturas/complemento-pagos/lote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId, items: seleccion.map(itemLote) }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "Error al emitir el lote");
      const resultados: ResultadoLote[] = Array.isArray(data?.resultados) ? data.resultados : [];
      setLoteRes(resultados);
      setLoteFase("resultados");
      // Los fallidos quedan seleccionados para reintentar; los emitidos salen.
      setSel(new Set(resultados.filter((r) => !r.ok).map((r) => r.invoiceId)));
      if (data.fallidos === 0) {
        onToast(`✓ ${data.emitidos} complemento${data.emitidos === 1 ? "" : "s"} de pago timbrado${data.emitidos === 1 ? "" : "s"} en lote`);
      } else {
        onToast(`${data.emitidos} de ${data.total} timbrados — ${data.fallidos} con error, siguen seleccionados`);
      }
      await load();
      if (data.emitidos > 0) onEmitted();
    } catch (e) {
      setLoteErr(e instanceof Error ? e.message : "Error al emitir el lote");
      setLoteFase("confirmar");
    }
  }

  if (pendientes.length === 0 && sinCobro.length === 0) return null;

  const hoy = new Date();
  const vencidos = pendientes.reduce(
    (s, p) => s + p.payments.filter((pg) => repVencido(new Date(pg.fecha), hoy)).length,
    0,
  );

  const seleccionados = pendientes.filter((p) => sel.has(p.invoice.id));
  const nSel = seleccionados.length;
  const sumSel = seleccionados.reduce((s, p) => s + p.pendingAmount, 0);
  const idsVisibles = pendientes.map((p) => p.invoice.id);
  const todosSel = nSel > 0 && idsVisibles.slice(0, MAX_LOTE).every((id) => sel.has(id));

  function toggleTodos() {
    if (todosSel) {
      setSel(new Set());
      return;
    }
    setSel(new Set(idsVisibles.slice(0, MAX_LOTE)));
    if (idsVisibles.length > MAX_LOTE) {
      onToast(`Se seleccionaron los primeros ${MAX_LOTE} — es el máximo por lote.`);
    }
  }

  // Procedencia: cobros detectados por la conciliación (con movimiento
  // bancario) vs. registrados a mano. La nota sólo aparece si conviven ambos.
  const deBanco = pendientes.filter((p) => p.payments.some((pg) => !!pg.id)).length;
  const aMano = pendientes.length - deBanco;

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
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="hidden text-[12px] text-cos-ink-faint lg:inline">
              El plazo es el día 5 del mes siguiente al cobro.
            </span>
            <button
              onClick={abrirLote}
              disabled={nSel === 0}
              className="inline-flex items-center gap-1.5 rounded-control bg-cos-brand px-3 py-1.5 text-[12.5px] font-semibold text-white hover:bg-cos-brand-deep disabled:cursor-default disabled:opacity-40"
            >
              Emitir {nSel} REP en lote
              {nSel > 0 && <Money value={sumSel} className="text-[12px] text-white" weight={600} />}
            </button>
          </div>
        </div>

        {pendientes.length > 0 && (
          <div className="flex items-center gap-2.5 border-b border-cos-line-soft bg-cos-paper px-[18px] py-1.5">
            <input
              type="checkbox"
              checked={todosSel}
              onChange={toggleTodos}
              className="flex-none accent-[--brand]"
              aria-label="Seleccionar todos"
            />
            <span className="font-mono text-[10.5px] font-medium uppercase tracking-[0.14em] text-cos-ink-faint">
              {nSel > 0 ? `${nSel} seleccionado${nSel === 1 ? "" : "s"}` : "Selecciona cobros para emitir en lote"}
            </span>
            <span className="ml-auto hidden font-mono text-[10.5px] font-medium uppercase tracking-[0.14em] text-cos-ink-faint sm:inline">
              parcialidad · plazo · sin REP
            </span>
          </div>
        )}

        {pendientes.map((p) => {
          const marcado = sel.has(p.invoice.id);
          const ultimo = ultimoPago(p);
          const chip = ultimo ? chipPlazo(new Date(ultimo.fecha), hoy) : null;
          return (
            <div key={p.invoice.id} className="border-b border-cos-line last:border-0">
              <div
                className={cn(
                  "flex min-h-[38px] items-center gap-2.5 px-[18px] py-1.5",
                  marcado ? "bg-cos-brand-tint" : "hover:bg-cos-paper",
                )}
              >
                <input
                  type="checkbox"
                  checked={marcado}
                  onChange={() => toggleSel(p.invoice.id)}
                  className="flex-none accent-[--brand]"
                  aria-label={`Seleccionar ${p.invoice.customer?.razonSocial ?? folioDe(p.invoice)}`}
                />
                <button
                  onClick={() => setAbierta(abierta === p.invoice.id ? null : p.invoice.id)}
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                >
                  {abierta === p.invoice.id
                    ? <ChevronDown className="h-4 w-4 flex-none text-cos-ink-faint" />
                    : <ChevronRight className="h-4 w-4 flex-none text-cos-ink-faint" />}
                  <span className="truncate text-[13px] font-medium text-cos-ink">
                    {p.invoice.customer?.razonSocial ?? "—"}
                  </span>
                  <span className="hidden flex-none font-mono text-[11px] text-cos-ink-faint md:inline">
                    {folioDe(p.invoice)} · {p.invoice.customer?.rfc ?? "—"}
                  </span>
                </button>
                <span className="hidden flex-none font-mono text-[11.5px] text-cos-ink-soft sm:inline">
                  {parcialidadDe(p)}
                </span>
                {chip && (
                  <span className={cn("flex-none whitespace-nowrap rounded-full px-2 py-0.5 font-mono text-[11px] font-medium", chip.cls)}>
                    {chip.texto}
                  </span>
                )}
                <Money value={p.pendingAmount} className="inline-block min-w-[92px] flex-none text-right text-[13px]" />
              </div>

              {abierta === p.invoice.id && (
                <div className="bg-cos-paper px-[18px] py-1.5">
                  <p className="py-1 font-mono text-[11px] text-cos-ink-faint">
                    factura {fmtFecha(p.invoice.fecha)} · total {fmtMoney(p.invoice.total)} · cobrado {fmtMoney(p.totalPaid)}
                    {p.totalReped > 0 ? ` · con REP ${fmtMoney(p.totalReped)}` : ""} · sin REP {fmtMoney(p.pendingAmount)}
                  </p>
                  {p.payments.map((pg: Pago) => {
                    const vencido = repVencido(new Date(pg.fecha), hoy);
                    return (
                      <div key={pg.id ?? `${pg.fecha}-${pg.monto}`} className="flex flex-wrap items-center justify-between gap-2 border-t border-cos-line-soft py-2">
                        <div className="min-w-0">
                          <p className="text-[13px] text-cos-ink">
                            {fmtFecha(pg.fecha)} · <span className="font-mono font-medium">{fmtMoney(pg.monto)}</span>
                          </p>
                          <p className="truncate text-[11.5px] text-cos-ink-faint">
                            {pg.descripcion ?? pg.referencia ?? (pg.id ? "Cobro conciliado" : "Cobro registrado a mano")}
                          </p>
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
          );
        })}

        {/* Procedencia de los pendientes: sólo cuando conviven ambas fuentes. */}
        {deBanco > 0 && aMano > 0 && (
          <p className="border-t border-cos-line px-[18px] py-2 text-[11.5px] text-cos-ink-faint">
            {deBanco} de estos {pendientes.length} los detectó la conciliación bancaria; los demás se registraron a mano.
          </p>
        )}

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

      {/* Modal del lote: confirmar → timbrando → resultados. */}
      {loteFase && (
        <div
          className="fixed inset-0 z-[60] grid place-items-center bg-[oklch(0.2_0.02_258_/_0.45)] p-[18px]"
          onClick={() => loteFase !== "timbrando" && setLoteFase(null)}
        >
          <div
            className="w-full max-w-[480px] rounded-[18px] bg-cos-card p-6 shadow-[0_30px_60px_-20px_oklch(0.2_0.05_258_/_0.5)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between">
              <p className="text-[15px] font-semibold text-cos-ink">
                {loteFase === "resultados" ? "Resultado del lote" : "Emitir REP en lote"}
              </p>
              <button
                onClick={() => loteFase !== "timbrando" && setLoteFase(null)}
                disabled={loteFase === "timbrando"}
                className="grid h-9 w-9 place-items-center rounded-control text-cos-ink-soft hover:bg-cos-paper disabled:opacity-40"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {loteFase === "confirmar" && (
              <>
                <p className="text-[12.5px] text-cos-ink-soft">
                  Se timbrarán {loteItems.length} complemento{loteItems.length === 1 ? "" : "s"} de pago ante el SAT,
                  uno por uno, con forma de pago 03 — transferencia. Si algún cobro fue con otra forma,
                  emítelo individual desde su fila.
                </p>
                <div className="mt-3 max-h-[260px] overflow-y-auto border-t border-cos-line-soft">
                  {loteItems.map((it) => (
                    <div key={it.invoiceId} className="flex min-h-[36px] items-center justify-between gap-3 border-b border-cos-line-soft py-1.5">
                      <span className="min-w-0 truncate text-[13px] text-cos-ink">
                        {it.nombre} <span className="font-mono text-[11px] text-cos-ink-faint">{it.folio}</span>
                      </span>
                      <Money value={it.monto} className="flex-none text-[13px]" />
                    </div>
                  ))}
                </div>
                <div className="flex items-center justify-between py-2.5 text-[13px] font-semibold text-cos-ink">
                  <span>Total del lote</span>
                  <Money value={loteItems.reduce((s, it) => s + it.monto, 0)} size={15} />
                </div>

                {loteErr && (
                  <p className="mb-2 flex items-start gap-1.5 rounded-[10px] bg-cos-red-tint px-3 py-2.5 text-[13px] text-cos-red-ink">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {loteErr}
                  </p>
                )}

                <div className="mt-1.5 flex gap-2">
                  <button
                    onClick={emitirLote}
                    className="flex-1 rounded-control bg-cos-brand px-3 py-2 text-[13px] font-semibold text-white hover:bg-cos-brand-deep"
                  >
                    Timbrar {loteItems.length} complemento{loteItems.length === 1 ? "" : "s"}
                  </button>
                  <button
                    onClick={() => setLoteFase(null)}
                    className="rounded-control border border-cos-line px-3 py-2 text-[13px] text-cos-ink-soft hover:bg-cos-paper"
                  >
                    Cancelar
                  </button>
                </div>
              </>
            )}

            {loteFase === "timbrando" && (
              <p className="mt-4 flex items-center gap-2 text-[13px] text-cos-ink-faint">
                <Loader2 className="h-4 w-4 animate-spin" />
                Timbrando {loteItems.length} complemento{loteItems.length === 1 ? "" : "s"}, uno por uno — no cierres esta ventana…
              </p>
            )}

            {loteFase === "resultados" && (
              <>
                <p className="font-mono text-[12px] text-cos-ink-soft">
                  {loteRes.filter((r) => r.ok).length} emitido{loteRes.filter((r) => r.ok).length === 1 ? "" : "s"} ·{" "}
                  {loteRes.filter((r) => !r.ok).length} con error
                </p>
                <div className="mt-3 max-h-[300px] overflow-y-auto border-t border-cos-line-soft">
                  {loteRes.map((r) => {
                    const it = loteItems.find((x) => x.invoiceId === r.invoiceId);
                    return (
                      <div key={r.invoiceId} className="border-b border-cos-line-soft py-2">
                        <div className="flex items-center justify-between gap-3">
                          <span className="min-w-0 truncate text-[13px] text-cos-ink">
                            {it?.nombre ?? "—"} <span className="font-mono text-[11px] text-cos-ink-faint">{it?.folio ?? ""}</span>
                          </span>
                          {r.ok ? (
                            <span className="flex flex-none items-center gap-2">
                              <span className="rounded-full bg-cos-jade-tint px-2 py-0.5 font-mono text-[11px] font-medium text-cos-jade-ink">
                                …{(r.uuid ?? "").slice(-8).toUpperCase()}
                              </span>
                              <Money value={r.monto ?? 0} className="text-[13px]" />
                            </span>
                          ) : (
                            <span className="flex-none rounded-full bg-cos-red-tint px-2 py-0.5 font-mono text-[11px] font-medium text-cos-red-ink">
                              falló
                            </span>
                          )}
                        </div>
                        {r.ok && r.numParcialidad != null && (
                          <p className="font-mono text-[11px] text-cos-ink-faint">parcialidad {r.numParcialidad}</p>
                        )}
                        {!r.ok && <p className="mt-0.5 text-[12px] text-cos-red-ink">{r.error ?? "Error desconocido"}</p>}
                      </div>
                    );
                  })}
                </div>
                {loteRes.some((r) => !r.ok) && (
                  <p className="mt-2 text-[12px] text-cos-ink-faint">
                    Los que fallaron siguen seleccionados en la cola para reintentar.
                  </p>
                )}
                <button
                  onClick={() => setLoteFase(null)}
                  className="mt-3 w-full rounded-control border border-cos-line px-3 py-2 text-[13px] text-cos-ink-soft hover:bg-cos-paper"
                >
                  Cerrar
                </button>
              </>
            )}
          </div>
        </div>
      )}

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
