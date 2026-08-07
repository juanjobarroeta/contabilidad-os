"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Shared working-paper panels (IVA · ISR · Retenciones). Extracted from the
// standalone /impuestos/papeles page so the Declaración Workspace and the legacy
// page render the exact same auditable tables — no duplicated logic. Styled in
// the cos- design system (cards, tokens, <Money>) so they sit natively inside
// the workspace. Each panel fetches its own data for { companyId, year, month }
// and is print/CSV-ready.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { formatCurrency, formatDate } from "@/lib/utils";
import { Money } from "@/components/ui";
import { Download, Loader2, FileText, AlertTriangle, CheckCircle2, Sparkles, Check } from "lucide-react";

const CARD = "rounded-card border border-cos-line bg-cos-card shadow-card print:border-2";
const THEAD = "bg-cos-paper text-[11px] uppercase tracking-[0.02em] text-cos-ink-faint";

// ── IVA PANEL ────────────────────────────────────────────────────────────────
interface IvaRow {
  id: string; fecha: string; uuid: string | null; serie: string | null; folio: string | null;
  contraparte: string; rfc: string; subtotal: number; tasa: number | null; importe: number; metodoPago: string;
  sinPagoConciliado?: boolean;
  pagadaConciliada?: boolean;
  excluidoAcreditamiento?: boolean;
  sinComplementoPago?: boolean;
  pagoParcial?: boolean;
  esComplemento?: boolean;
}
interface IvaData {
  periodo: string;
  company: { rfc: string; razonSocial: string } | null;
  trasladado: IvaRow[];
  acreditable: IvaRow[];
  retenidoPorClientes: IvaRow[];
  retenidoAProveedores: IvaRow[];
  totales: {
    trasladado: number; acreditable: number; retenidoPorClientes: number; retenidoAProveedores: number;
    proporcionAcreditamiento: number; actosGravados: number; actosExentos: number; acreditableProcedente: number;
    ivaCargo: number; saldoFavorAnterior: number; ivaPagar: number; saldoFavorMes: number;
    saldoFavorAnteriorAuto: number;
    saldoFavorAnteriorOverride: number | null;
    saldoFavorAnteriorPeriodo: string | null;
    saldoFavorAnteriorEsManual: boolean;
  };
  reconciliacion?: { activa: boolean; ivaPueSinPago: number; cfdisPueSinPago: number };
  ppdSinComplemento?: { count: number; iva: number };
  ppdIngresoPendiente?: { count: number; iva: number };
  /** Depósitos bancarios del periodo sin CFDI que los respalde (posible IVA omitido). */
  depositosSinFactura?: { count: number; total: number; ivaPotencial: number };
}

export function IvaPanel({ companyId, year, month }: { companyId: string; year: number; month: number }) {
  const [data, setData] = useState<IvaData | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/papeles/iva?companyId=${companyId}&year=${year}&month=${month}`);
      if (res.ok) setData(await res.json());
    } finally {
      setLoading(false);
    }
  }, [companyId, year, month]);

  useEffect(() => { load(); }, [load]);

  const [savingSaldo, setSavingSaldo] = useState(false);
  const [saldoError, setSaldoError] = useState<string | null>(null);

  // Persiste el saldo a favor anterior de IVA como override manual del periodo
  // (mismo campo ivaSaldoFavorAnterior que usa la pantalla de detalle) y recarga
  // el papel para reflejarlo. saldoFavor = null restablece el valor automático.
  const saveSaldoFavor = useCallback(async (saldoFavor: number | null) => {
    setSavingSaldo(true);
    setSaldoError(null);
    try {
      const res = await fetch("/api/impuestos/saldo-favor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId, year, month, saldoFavor }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error ?? "No se pudo guardar el saldo a favor");
      }
      await load();
    } catch (e) {
      setSaldoError(e instanceof Error ? e.message : "Error al guardar");
    } finally {
      setSavingSaldo(false);
    }
  }, [companyId, year, month, load]);

  const [toggling, setToggling] = useState<string | null>(null);
  // field = ivaNoAcreditable (gastos) | ivaNoCausado (ingresos) — IVA is
  // cash-basis on both sides: an unpaid PUE expense isn't acreditable, and an
  // uncollected PUE income isn't causado.
  async function toggleExcluir(id: string, next: boolean, field: "ivaNoAcreditable" | "ivaNoCausado") {
    setToggling(id);
    try {
      const res = await fetch(`/api/facturas/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: next }),
      });
      if (res.ok) await load();
    } finally { setToggling(null); }
  }

  if (loading) return <Loading />;
  if (!data) return <Empty />;

  return (
    <div className="space-y-5">
      <DownloadCsvButton href={`/api/papeles/iva?companyId=${companyId}&year=${year}&month=${month}&format=csv`} />

      <IvaSection
        title="IVA trasladado (cobrado)"
        subtitle="IVA que cobraste a tus clientes en este periodo"
        rows={data.trasladado}
        totalLabel="Total trasladado"
        excluidoLabel="no cobrado"
        onToggleExcluir={(id, next) => toggleExcluir(id, next, "ivaNoCausado")}
        toggling={toggling}
      />
      {data.ppdIngresoPendiente && data.ppdIngresoPendiente.count > 0 && (
        <div className="flex items-start gap-2.5 rounded-card border border-cos-line bg-cos-paper px-4 py-3 text-[13px] text-cos-ink-soft">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-none text-cos-ink-faint" />
          <span>
            <b>{data.ppdIngresoPendiente.count} factura(s) de ingreso PPD</b> ({formatCurrency(data.ppdIngresoPendiente.iva)} de IVA)
            emitida(s) este mes <b>aún sin cobrar</b> — su IVA trasladado se causa en el mes en que las cobres (al recibir su
            complemento de pago / REP), no al emitirlas. Por eso están tenues y fuera del total (igual que el cálculo).
          </span>
        </div>
      )}
      {data.depositosSinFactura && data.depositosSinFactura.count > 0 && (
        <div className="flex items-start gap-2.5 rounded-card border border-cos-amber bg-cos-amber-tint px-4 py-3 text-[13px] text-cos-amber-ink">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" />
          <span>
            <b>{data.depositosSinFactura.count} depósito(s) bancario(s)</b> del periodo por{" "}
            <b>{formatCurrency(data.depositosSinFactura.total)}</b> sin CFDI de ingreso que los respalde. El IVA se causa
            al cobro <i>exista o no la factura</i> (Art. 1-B LIVA): si son ingresos gravados, este cálculo omite hasta{" "}
            <b>{formatCurrency(data.depositosSinFactura.ivaPotencial)}</b> de IVA trasladado. Revísalos en Bancos — emite el
            CFDI si es ingreso, o concílialos/márcalos como no fiscales (préstamo, traspaso) para descartar el aviso.
          </span>
        </div>
      )}
      <IvaSection
        title="IVA acreditable (pagado)"
        subtitle="IVA que pagaste a tus proveedores, acreditable contra el trasladado"
        rows={data.acreditable}
        totalLabel="Total acreditable"
        excluidoLabel="no acreditado"
        onToggleExcluir={(id, next) => toggleExcluir(id, next, "ivaNoAcreditable")}
        toggling={toggling}
      />
      {data.reconciliacion?.activa && data.reconciliacion.cfdisPueSinPago > 0 && (
        <div className="flex items-start gap-2.5 rounded-card border border-cos-amber bg-cos-amber-tint px-4 py-3 text-[13px] text-cos-amber-ink">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" />
          <span>
            <b>{data.reconciliacion.cfdisPueSinPago} CFDI(s) PUE</b> con IVA acreditable de{" "}
            <b>{formatCurrency(data.reconciliacion.ivaPueSinPago)}</b> no aparecen pagados en el banco
            (marcados ↓). El IVA sólo es acreditable si el gasto se pagó (Art. 5-I LIVA) — concilia el pago
            en Bancos o exclúyelos del acreditamiento.
          </span>
        </div>
      )}
      {data.ppdSinComplemento && data.ppdSinComplemento.count > 0 && (
        <div className="flex items-start gap-2.5 rounded-card border border-cos-line bg-cos-paper px-4 py-3 text-[13px] text-cos-ink-soft">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-none text-cos-ink-faint" />
          <span>
            <b>{data.ppdSinComplemento.count} CFDI(s) PPD</b> ({formatCurrency(data.ppdSinComplemento.iva)} de IVA) aún
            sin complemento de pago — <b>no acreditables todavía</b> y excluidos del total; el IVA se acredita en el
            mes en que se reciba su REP (igual que el cálculo).
          </span>
        </div>
      )}
      {data.retenidoPorClientes.length > 0 && (
        <IvaSection
          title="IVA retenido por clientes"
          subtitle="IVA que tus clientes te retuvieron (disminuye el IVA a cargo)"
          rows={data.retenidoPorClientes}
          totalLabel="Total retenido"
        />
      )}
      {data.retenidoAProveedores.length > 0 && (
        <IvaSection
          title="IVA retenido a proveedores"
          subtitle="IVA que tú retuviste (pasivo a pagar al SAT en otra declaración)"
          rows={data.retenidoAProveedores}
          totalLabel="Total retenido"
        />
      )}

      <div className={`${CARD} p-5 text-[14px]`}>
        <h3 className="mb-3 text-[12.5px] font-medium uppercase tracking-[0.02em] text-cos-ink-faint">Determinación del IVA a pagar</h3>
        <dl className="space-y-1.5">
          <Line label="IVA trasladado (+)" value={data.totales.trasladado} />
          <Line label="IVA retenido por clientes (−)" value={-data.totales.retenidoPorClientes} />
          {data.totales.proporcionAcreditamiento < 1 ? (
            <>
              <Line label="IVA acreditable bruto" value={data.totales.acreditable} />
              <Line
                label={`× Proporción de acreditamiento Art. 5-V (gravados ${formatCurrency(data.totales.actosGravados)} / exentos ${formatCurrency(data.totales.actosExentos)})`}
                value={null}
              />
              <Line label={`= IVA acreditable procedente (${(data.totales.proporcionAcreditamiento * 100).toFixed(2)}%) (−)`} value={-data.totales.acreditableProcedente} />
            </>
          ) : (
            <Line label="IVA acreditable (−)" value={-data.totales.acreditable} />
          )}
          <Line label="= IVA a cargo" value={data.totales.ivaCargo} strong />
          <SaldoFavorAnteriorLine
            totales={data.totales}
            saving={savingSaldo}
            error={saldoError}
            onSave={saveSaldoFavor}
          />
          <div className="border-t border-cos-line-soft pt-2">
            {data.totales.ivaPagar > 0 ? (
              <Line label="= IVA A PAGAR" value={data.totales.ivaPagar} strong big colorClass="text-cos-red-ink" />
            ) : (
              <Line label="= Saldo a favor del mes" value={data.totales.saldoFavorMes} strong big colorClass="text-cos-jade-ink" />
            )}
          </div>
        </dl>
      </div>
    </div>
  );
}

// Etiqueta humana de un periodo "YYYY-MM" → "Marzo 2026".
const MESES_LARGOS = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];
function periodoLargo(periodo: string): string {
  const [y, m] = periodo.split("-");
  const mi = parseInt(m) - 1;
  return mi >= 0 && mi < 12 ? `${MESES_LARGOS[mi]} ${y}` : periodo;
}

// Renglón editable del saldo a favor anterior dentro de la determinación del IVA.
// Espeja el patrón de CoeficienteCard/PerdidaCard del panel de ISR: muestra la
// fuente (automático del mes anterior vs. ajuste manual), permite editar el monto
// con Guardar y ofrece restablecer al valor automático. Persiste vía
// /api/impuestos/saldo-favor (mismo campo ivaSaldoFavorAnterior que la pantalla
// de detalle) y, al guardar, recarga el papel para que la determinación se
// actualice en vivo.
function SaldoFavorAnteriorLine({
  totales,
  saving,
  error,
  onSave,
}: {
  totales: IvaData["totales"];
  saving: boolean;
  error: string | null;
  onSave: (saldoFavor: number | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState("");

  const aplicado = totales.saldoFavorAnterior;
  const esManual = totales.saldoFavorAnteriorEsManual;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-3">
        <span className="text-cos-ink-soft">Saldo a favor anterior (−)</span>
        {!editing ? (
          <div className="flex items-center gap-2">
            {esManual ? (
              <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium bg-cos-amber-tint text-cos-amber-ink">
                Ajuste manual
              </span>
            ) : aplicado > 0 ? (
              <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium bg-cos-jade-tint text-cos-jade-ink">
                <Sparkles className="h-3 w-3" />
                {totales.saldoFavorAnteriorPeriodo
                  ? `Automático de ${periodoLargo(totales.saldoFavorAnteriorPeriodo)}`
                  : "Automático"}
              </span>
            ) : null}
            <Money value={-aplicado} size={14} weight={500} />
            <button
              onClick={() => {
                setVal(aplicado > 0 ? aplicado.toFixed(2) : "");
                setEditing(true);
              }}
              className="text-[12px] font-medium text-cos-brand-ink hover:underline"
            >
              Editar
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <div className="inline-flex items-center gap-1">
              <span className="text-cos-ink-soft">$</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={val}
                placeholder="0.00"
                onChange={(e) => setVal(e.target.value)}
                className="w-32 rounded-md border border-cos-line px-2 py-1 text-right text-[13px] focus:outline-none focus:ring-1 focus:ring-cos-brand"
              />
            </div>
            <button
              onClick={() => {
                const monto = parseFloat(val);
                if (!Number.isFinite(monto) || monto < 0) return;
                onSave(+monto.toFixed(2));
                setEditing(false);
              }}
              disabled={saving}
              className="inline-flex items-center gap-1 rounded-md bg-cos-brand px-2.5 py-1 text-[12px] font-semibold text-white hover:opacity-90 disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
              Guardar
            </button>
            {esManual && (
              <button
                onClick={() => {
                  onSave(null);
                  setEditing(false);
                }}
                disabled={saving}
                className="text-[12px] font-medium text-cos-ink-soft hover:text-cos-ink disabled:opacity-50"
                title="Restablecer al saldo a favor automático del mes anterior"
              >
                Restablecer automático
              </button>
            )}
            <button
              onClick={() => setEditing(false)}
              className="text-[12px] font-medium text-cos-ink-soft hover:text-cos-ink"
            >
              Cancelar
            </button>
          </div>
        )}
      </div>
      {error && <p className="text-right text-[12px] text-cos-red-ink">{error}</p>}
    </div>
  );
}

function IvaSection({ title, subtitle, rows, onToggleExcluir, toggling, totalLabel = "Total", excluidoLabel = "excluido" }: {
  title: string; subtitle: string; rows: IvaRow[];
  onToggleExcluir?: (id: string, next: boolean) => void; toggling?: string | null;
  totalLabel?: string; excluidoLabel?: string;
}) {
  if (rows.length === 0) return null;
  // Lo excluido del acreditamiento no suma al total (coincide con el motor).
  const cuenta = (r: IvaRow) => !r.excluidoAcreditamiento && !r.sinComplementoPago;
  const total = rows.filter(cuenta).reduce((s, r) => s + r.importe, 0);
  const excluidos = rows.filter((r) => !cuenta(r)).length;
  const acciones = !!onToggleExcluir;
  return (
    <div className={`${CARD} overflow-hidden`}>
      <div className="border-b border-cos-line px-4 py-3">
        <h3 className="text-[14px] font-semibold text-cos-ink">{title}</h3>
        <p className="mt-0.5 text-[12px] text-cos-ink-soft">{subtitle}</p>
      </div>
      <div className="overflow-x-auto">
      <table className="w-full min-w-[680px] text-[13px]">
        <thead className={THEAD}>
          <tr>
            <th className="px-3 py-2 text-left font-medium">Fecha</th>
            <th className="px-3 py-2 text-left font-medium">Folio</th>
            <th className="px-3 py-2 text-left font-medium">Contraparte</th>
            <th className="px-3 py-2 text-left font-medium">Pago</th>
            <th className="px-3 py-2 text-right font-medium">Subtotal</th>
            <th className="px-3 py-2 text-right font-medium">Tasa</th>
            <th className="px-3 py-2 text-right font-medium">IVA</th>
            {acciones && <th className="px-3 py-2 text-right font-medium"></th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={`border-t border-cos-line-soft ${r.excluidoAcreditamiento || r.sinComplementoPago ? "opacity-55" : ""}`}>
              <td className="px-3 py-1.5 text-[12px] text-cos-ink-faint whitespace-nowrap">{formatDate(r.fecha)}</td>
              <td className="px-3 py-1.5 font-mono text-[12px]">{r.folio ? `${r.serie ?? ""}${r.folio}` : (r.uuid?.slice(0, 8) ?? "—")}</td>
              <td className="px-3 py-1.5 text-[12px]">
                <p className="max-w-[240px] truncate text-cos-ink">{r.contraparte}</p>
                <p className="font-mono text-[10px] text-cos-ink-faint">{r.rfc}</p>
              </td>
              <td className="px-3 py-1.5 text-[12px] text-cos-ink-soft">
                {r.metodoPago}
                {r.esComplemento && (
                  <span className="ml-1.5 inline-flex items-center rounded-full bg-cos-brand-tint px-1.5 py-0.5 text-[10px] font-medium text-cos-brand-ink" title="Ingreso PPD causado al cobrarse — armado desde el complemento de pago (REP) de este periodo">
                    cobrado (REP)
                  </span>
                )}
                {r.excluidoAcreditamiento ? (
                  <span className="ml-1.5 inline-flex items-center rounded-full bg-cos-slate-tint px-1.5 py-0.5 text-[10px] font-medium text-cos-ink-soft">{excluidoLabel}</span>
                ) : r.sinComplementoPago ? (
                  <span className="ml-1.5 inline-flex items-center rounded-full bg-cos-slate-tint px-1.5 py-0.5 text-[10px] font-medium text-cos-ink-soft" title="PPD sin complemento de pago (REP) en el periodo — su IVA se reconoce cuando llegue el pago">
                    sin complemento
                  </span>
                ) : r.pagoParcial ? (
                  <span className="ml-1.5 inline-flex items-center rounded-full bg-cos-brand-tint px-1.5 py-0.5 text-[10px] font-medium text-cos-brand-ink" title="PPD con pago parcial — sólo se acredita el IVA del monto pagado en el periodo (prorrateado)">
                    parcial
                  </span>
                ) : r.sinPagoConciliado ? (
                  <span className="ml-1.5 inline-flex items-center gap-1 rounded-full bg-cos-amber-tint px-1.5 py-0.5 text-[10px] font-medium text-cos-amber-ink" title="PUE sin pago conciliado en banco — el IVA sólo es acreditable si se pagó (Art. 5-I LIVA)">
                    <AlertTriangle className="h-3 w-3" /> sin pago
                  </span>
                ) : r.pagadaConciliada && (
                  <span className="ml-1.5 inline-flex items-center gap-1 rounded-full bg-cos-jade-tint px-1.5 py-0.5 text-[10px] font-medium text-cos-jade-ink" title="PUE con pago conciliado en banco — respaldado por un movimiento bancario">
                    <CheckCircle2 className="h-3 w-3" /> pagada
                  </span>
                )}
              </td>
              <td className="px-3 py-1.5 text-right"><Money value={r.subtotal} size={12} weight={500} /></td>
              <td className="px-3 py-1.5 text-right text-[12px] text-cos-ink-soft">{r.tasa != null ? (r.tasa * 100).toFixed(0) + "%" : "—"}</td>
              <td className={`px-3 py-1.5 text-right ${r.excluidoAcreditamiento || r.sinComplementoPago ? "line-through" : ""}`}><Money value={r.importe} size={12} weight={500} /></td>
              {acciones && (
                <td className="px-3 py-1.5 text-right">
                  {(r.excluidoAcreditamiento || r.metodoPago === "PUE") && (
                    <button
                      onClick={() => onToggleExcluir!(r.id, !r.excluidoAcreditamiento)}
                      disabled={toggling === r.id}
                      className="rounded-control border border-cos-line px-2 py-1 text-[11px] font-medium hover:bg-cos-paper disabled:opacity-50"
                    >
                      {toggling === r.id ? "…" : r.excluidoAcreditamiento ? "Incluir" : "Excluir"}
                    </button>
                  )}
                </td>
              )}
            </tr>
          ))}
          <tr className="border-t-2 border-cos-line bg-cos-paper font-semibold">
            <td colSpan={6} className="px-3 py-2 text-right text-[12px] text-cos-ink-soft">
              {totalLabel}{excluidos > 0 ? ` (${excluidos} excluido${excluidos === 1 ? "" : "s"} del cálculo)` : ""}
            </td>
            <td className="px-3 py-2 text-right" colSpan={acciones ? 2 : 1}><Money value={total} size={12} weight={700} /></td>
          </tr>
        </tbody>
      </table>
      </div>
    </div>
  );
}

// ── ISR PANEL ────────────────────────────────────────────────────────────────
interface IsrData {
  periodo: string;
  company: { rfc: string; razonSocial: string; regimenFiscal: string } | null;
  regimen: { kind: "pf_act_empresarial" | "pf_arrendamiento" | "pf_plataformas" | "resico_pf" | "resico_pm" | "general_pm"; label: string };
  base: {
    prevYear: number; prevIngresosTotal: number; prevGastosTotal: number; prevUtilidad: number;
    coeficienteCalculado: number | null; coeficiente: number | null;
    coeficienteFuente: "manual" | "declaracion_anual" | "provisional_previo" | "calculado" | "ninguno";
    coeficienteSugerido: number | null;
    coeficienteSugeridoFuente: "declaracion_anual" | "provisional_previo" | "calculado" | "ninguno";
    perdidaFiscalPendiente?: number | null;
  };
  acumulado: { mes: number; mesLabel: string; ingresos: number; facturas: number }[];
  /** Cobros anticipados (REP con FechaPago anterior a la factura) reubicados a su mes de cobro. */
  anticipos?: { movimientos: number; monto: number };
  calculo:
    | {
        tipo: "art14";
        ingresosAcumulados: number; coeficiente: number | null; utilidadFiscal: number | null;
        baseGravable?: number | null; perdidaFiscalAplicada?: number | null;
        ptuPagadaEjercicio?: number | null; ptuDisminuida?: number | null;
        tasa: number; isrDelEjercicio: number | null; isrPagadoAnterior: number; isrDelMes: number | null;
      }
    | {
        tipo: "resico_pf";
        ingresosDelMes: number;
        rangoLimiteInferior: number; rangoLimiteSuperior: number;
        tasa: number; tasaPct: string;
        isrCausado: number; retencionesAcreditadas: number;
        saldoFavorAnterior: number; saldoAFavor: number;
        isrDelMes: number;
        tarifa: Array<{ limiteInferior: number; limiteSuperior: number; tasa: number; tasaPct: string }>;
      }
    | {
        tipo: "pf_act_empresarial";
        ingresosCobradosAcum: number; baseGravable: number | null; isrCausado: number | null;
        isrPagadoAnterior: number; retencionesAcreditadas: number; isrDelMes: number | null;
        tarifaVerificada: boolean;
      }
    | {
        tipo: "pf_arrendamiento";
        ingresosCobradosMes: number; deduccionCiega: number; baseGravable: number | null;
        /** Predial pagado del mes — deducible ADEMÁS de la ciega (Art. 115). */
        predialPagado?: number;
        isrCausado: number | null; retencionesAcreditadas: number; isrDelMes: number | null;
        tarifaVerificada: boolean;
      }
    | {
        tipo: "pf_plataformas";
        ingresosCobradosMes: number; actividad: string; actividadAsumida: boolean;
        tasa: number | null; isrCausado: number | null; retencionesAcreditadas: number; isrDelMes: number | null;
      };
}

export function IsrPanel({ companyId, year, month, onCoefSaved }: { companyId: string; year: number; month: number; onCoefSaved?: () => void }) {
  const [data, setData] = useState<IsrData | null>(null);
  const [loading, setLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [savingCoef, setSavingCoef] = useState(false);
  const [coefError, setCoefError] = useState<string | null>(null);
  const [savingPerdida, setSavingPerdida] = useState(false);
  const [perdidaError, setPerdidaError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/papeles/isr?companyId=${companyId}&year=${year}&month=${month}`)
      .then((r) => r.json())
      .then(setData)
      .finally(() => setLoading(false));
  }, [companyId, year, month, reloadKey]);

  // Persiste el coeficiente como ajuste manual de la empresa (mismo endpoint que
  // usa la pantalla de Impuestos) y recarga el papel para reflejarlo.
  const saveCoeficiente = useCallback(async (coeficiente: number) => {
    setSavingCoef(true);
    setCoefError(null);
    try {
      const res = await fetch("/api/impuestos/coeficiente", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId, year, coeficiente }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error ?? "No se pudo guardar el coeficiente");
      }
      setReloadKey((k) => k + 1);
      onCoefSaved?.(); // refresca totales del padre (Resumen/Presentar)
    } catch (e) {
      setCoefError(e instanceof Error ? e.message : "Error al guardar");
    } finally {
      setSavingCoef(false);
    }
  }, [companyId, year, onCoefSaved]);

  // Persiste el remanente de pérdidas fiscales pendiente de aplicar (mismo
  // endpoint que la pantalla de Impuestos) y recarga el papel para reflejarlo.
  const savePerdida = useCallback(async (perdida: number) => {
    setSavingPerdida(true);
    setPerdidaError(null);
    try {
      const res = await fetch("/api/impuestos/perdida", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId, year, perdida }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error ?? "No se pudo guardar la pérdida");
      }
      setReloadKey((k) => k + 1);
    } catch (e) {
      setPerdidaError(e instanceof Error ? e.message : "Error al guardar");
    } finally {
      setSavingPerdida(false);
    }
  }, [companyId, year]);

  if (loading) return <Loading />;
  if (!data) return <Empty />;

  return (
    <div className="space-y-5">
      <DownloadCsvButton href={`/api/papeles/isr?companyId=${companyId}&year=${year}&month=${month}&format=csv`} />

      <div className="flex items-center gap-2 rounded-card border border-cos-brand bg-cos-brand-tint px-4 py-3 text-[14px] text-cos-brand-ink">
        <FileText className="h-4 w-4 shrink-0" />
        <span><strong>{data.regimen.label}</strong></span>
      </div>

      {data.calculo.tipo === "pf_plataformas" ? (
        <div className={`${CARD} overflow-hidden`}>
          <div className="border-b border-cos-line px-4 py-3">
            <h3 className="text-[14px] font-semibold text-cos-ink">ISR plataformas tecnológicas (Art. 113-A LISR)</h3>
            <p className="mt-0.5 text-[12px] text-cos-ink-soft">Pago definitivo — tasa fija sobre ingresos cobrados, menos lo retenido por las plataformas.</p>
          </div>
          <div className="space-y-2 p-4 text-[14px]">
            <KV label="Actividad"><span>{data.calculo.actividad}</span></KV>
            <KV label="Ingresos cobrados del mes"><Money value={data.calculo.ingresosCobradosMes} size={13} weight={500} /></KV>
            <KV label="× Tasa"><span className="font-mono text-cos-ink">{data.calculo.tasa != null ? (data.calculo.tasa * 100).toFixed(2) + "%" : "—"}</span></KV>
            <KV label="= ISR causado">{data.calculo.isrCausado != null ? <Money value={data.calculo.isrCausado} size={13} weight={500} /> : <Dash />}</KV>
            <KV label="− Retenciones de plataformas"><Money value={data.calculo.retencionesAcreditadas} size={13} weight={500} /></KV>
            <KV label="= ISR del mes" strong>{data.calculo.isrDelMes != null ? <Money value={data.calculo.isrDelMes} size={15} weight={700} /> : <Dash />}</KV>
            {data.calculo.actividadAsumida && <p className="pt-1 text-[12px] text-cos-amber-ink">Tasa asumida (enajenación/servicios, 1%). Configura el tipo de actividad de plataforma de la empresa si es transporte (2.1%) u hospedaje (4%).</p>}
          </div>
        </div>
      ) : data.calculo.tipo === "pf_arrendamiento" ? (
        <div className={`${CARD} overflow-hidden`}>
          <div className="border-b border-cos-line px-4 py-3">
            <h3 className="text-[14px] font-semibold text-cos-ink">ISR pago provisional — PF Arrendamiento (Arts. 114-116 LISR)</h3>
          </div>
          <div className="space-y-2 p-4 text-[14px]">
            <KV label="Ingresos cobrados del mes"><Money value={data.calculo.ingresosCobradosMes} size={13} weight={500} /></KV>
            <KV label="− Deducción ciega 35% (Art. 115)"><Money value={data.calculo.deduccionCiega} size={13} weight={500} /></KV>
            <KV label="− Impuesto predial pagado (Art. 115)"><Money value={data.calculo.predialPagado ?? 0} size={13} weight={500} /></KV>
            <KV label="= Base gravable">{data.calculo.baseGravable != null ? <Money value={data.calculo.baseGravable} size={13} weight={500} /> : <Dash />}</KV>
            <KV label="ISR causado (tarifa mensual Art. 96)">{data.calculo.isrCausado != null ? <Money value={data.calculo.isrCausado} size={13} weight={500} /> : <Dash />}</KV>
            <KV label="− Retenciones 10% PM (Art. 116)"><Money value={data.calculo.retencionesAcreditadas} size={13} weight={500} /></KV>
            <KV label="= ISR del mes" strong>{data.calculo.isrDelMes != null ? <Money value={data.calculo.isrDelMes} size={15} weight={700} /> : <Dash />}</KV>
            {!data.calculo.tarifaVerificada && <p className="pt-1 text-[12px] text-cos-amber-ink">Tarifa ISR sin verificar contra Anexo 8 — cifra provisional.</p>}
            <p className="pt-1 text-[12px] text-cos-ink-soft">
              Deducción opcional ciega más el predial pagado del mes, detectado en los cargos del
              banco (concepto &ldquo;predial&rdquo;). Si convienen las deducciones comprobadas,
              ajústalo manualmente — el comparativo automático está pendiente.
            </p>
          </div>
        </div>
      ) : data.calculo.tipo === "pf_act_empresarial" ? (
        <div className={`${CARD} overflow-hidden`}>
          <div className="border-b border-cos-line px-4 py-3">
            <h3 className="text-[14px] font-semibold text-cos-ink">ISR provisional — PF Actividad Empresarial y Profesional (Art. 106 LISR)</h3>
          </div>
          <div className="space-y-2 p-4 text-[14px]">
            <KV label="Ingresos cobrados (acumulado)"><Money value={data.calculo.ingresosCobradosAcum} size={13} weight={500} /></KV>
            <KV label="= Base gravable">{data.calculo.baseGravable != null ? <Money value={data.calculo.baseGravable} size={13} weight={500} /> : <Dash />}</KV>
            <KV label="ISR causado (tarifa Art. 96 elevada al periodo)">{data.calculo.isrCausado != null ? <Money value={data.calculo.isrCausado} size={13} weight={500} /> : <Dash />}</KV>
            <KV label="− Pagos provisionales anteriores"><Money value={data.calculo.isrPagadoAnterior} size={13} weight={500} /></KV>
            <KV label="− Retenciones 10% PM (Art. 106)"><Money value={data.calculo.retencionesAcreditadas} size={13} weight={500} /></KV>
            <KV label="= ISR del mes" strong>{data.calculo.isrDelMes != null ? <Money value={data.calculo.isrDelMes} size={15} weight={700} /> : <Dash />}</KV>
            {!data.calculo.tarifaVerificada && <p className="pt-1 text-[12px] text-cos-amber-ink">Tarifa ISR sin verificar contra Anexo 8 — cifra provisional.</p>}
          </div>
        </div>
      ) : data.calculo.tipo === "resico_pf" ? (
        <>
          {/* Tarifa table */}
          <div className={`${CARD} overflow-hidden`}>
            <div className="border-b border-cos-line px-4 py-3">
              <h3 className="text-[14px] font-semibold text-cos-ink">Tarifa RESICO PF mensual (Art. 113-E LISR)</h3>
            </div>
            <table className="w-full text-[13px]">
              <thead className={THEAD}>
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Rango de ingresos (mensual)</th>
                  <th className="px-3 py-2 text-right font-medium">Tasa</th>
                </tr>
              </thead>
              <tbody>
                {data.calculo.tarifa.map((t, i) => {
                  const active =
                    data.calculo.tipo === "resico_pf" &&
                    t.limiteInferior === data.calculo.rangoLimiteInferior;
                  return (
                    <tr key={i} className={`border-t border-cos-line-soft ${active ? "bg-cos-brand-tint font-semibold" : ""}`}>
                      <td className="px-3 py-1.5 font-mono text-[12px] text-cos-ink">
                        {formatCurrency(t.limiteInferior)} — {t.limiteSuperior === Infinity || t.limiteSuperior > 1e10 ? "en adelante" : formatCurrency(t.limiteSuperior)}
                      </td>
                      <td className="px-3 py-1.5 text-right text-[12px] text-cos-ink">{t.tasaPct}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Monthly ingresos detail */}
          <div className={`${CARD} overflow-hidden`}>
            <div className="border-b border-cos-line px-4 py-3">
              <h3 className="text-[14px] font-semibold text-cos-ink">Ingresos cobrados del mes</h3>
              <p className="mt-0.5 text-[12px] text-cos-ink-soft">
                RESICO PF usa ingresos efectivamente cobrados (flow-through). El cálculo es sobre este monto, no sobre acumulado.
              </p>
            </div>
            <table className="w-full text-[13px]">
              <thead className={THEAD}>
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Mes</th>
                  <th className="px-3 py-2 text-right font-medium"># Facturas</th>
                  <th className="px-3 py-2 text-right font-medium">Ingresos</th>
                </tr>
              </thead>
              <tbody>
                {data.acumulado.map((m) => (
                  <tr key={m.mes} className="border-t border-cos-line-soft">
                    <td className="px-3 py-1.5 text-[12px] text-cos-ink">{m.mesLabel}</td>
                    <td className="px-3 py-1.5 text-right text-[12px] text-cos-ink-soft">{m.facturas}</td>
                    <td className="px-3 py-1.5 text-right"><Money value={m.ingresos} size={12} weight={500} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Calculation */}
          <div className={`${CARD} p-5 text-[14px]`}>
            <h3 className="mb-3 text-[12.5px] font-medium uppercase tracking-[0.02em] text-cos-ink-faint">Cálculo ISR RESICO PF</h3>
            <dl className="space-y-1.5">
              <Line label="Ingresos cobrados del mes" value={data.calculo.ingresosDelMes} />
              <Line
                label={`Rango aplicable: ${formatCurrency(data.calculo.rangoLimiteInferior)} — ${data.calculo.rangoLimiteSuperior === Infinity || data.calculo.rangoLimiteSuperior > 1e10 ? "∞" : formatCurrency(data.calculo.rangoLimiteSuperior)}`}
                value={null}
              />
              <Line label={`× Tasa (${data.calculo.tasaPct})`} value={null} />
              <Line label="= ISR causado" value={data.calculo.isrCausado} strong />
              {data.calculo.retencionesAcreditadas > 0 && (
                <Line label="− Retenciones 1.25% PM (Art. 113-J)" value={-data.calculo.retencionesAcreditadas} />
              )}
              {data.calculo.saldoFavorAnterior > 0 && (
                <Line label="− Saldo a favor del periodo anterior" value={-data.calculo.saldoFavorAnterior} />
              )}
              <div className="border-t border-cos-line-soft pt-2">
                <Line label="= ISR DEL MES" value={data.calculo.isrDelMes} strong big colorClass="text-cos-red-ink" />
              </div>
              {data.calculo.saldoAFavor > 0 && (
                <p className="pt-2 text-[12px] text-cos-jade-ink">
                  La retención acreditable excede el ISR del mes: {formatCurrency(data.calculo.saldoAFavor)} se
                  arrastra como saldo a favor al siguiente periodo (al guardar la declaración).
                </p>
              )}
            </dl>
          </div>
        </>
      ) : (
        <>
          <CoeficienteCard
            base={data.base}
            saving={savingCoef}
            error={coefError}
            onSave={saveCoeficiente}
          />

          <PerdidaCard
            base={data.base}
            saving={savingPerdida}
            error={perdidaError}
            onSave={savePerdida}
          />

          <div className={`${CARD} overflow-hidden`}>
            <div className="border-b border-cos-line px-4 py-3">
              <h3 className="text-[14px] font-semibold text-cos-ink">Ingresos acumulados del ejercicio</h3>
            </div>
            <table className="w-full text-[13px]">
              <thead className={THEAD}>
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Mes</th>
                  <th className="px-3 py-2 text-right font-medium"># Facturas</th>
                  <th className="px-3 py-2 text-right font-medium">Ingresos</th>
                  <th className="px-3 py-2 text-right font-medium">Acumulado</th>
                </tr>
              </thead>
              <tbody>
                {data.acumulado.map((m, i) => {
                  const acumulado = data.acumulado.slice(0, i + 1).reduce((s, x) => s + x.ingresos, 0);
                  return (
                    <tr key={m.mes} className="border-t border-cos-line-soft">
                      <td className="px-3 py-1.5 text-[12px] text-cos-ink">{m.mesLabel}</td>
                      <td className="px-3 py-1.5 text-right text-[12px] text-cos-ink-soft">{m.facturas}</td>
                      <td className="px-3 py-1.5 text-right"><Money value={m.ingresos} size={12} weight={500} /></td>
                      <td className="px-3 py-1.5 text-right"><Money value={acumulado} size={12} weight={600} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {data.anticipos && data.anticipos.movimientos > 0 && (
              <p className="border-t border-cos-line-soft px-4 py-2.5 text-[12px] text-cos-ink-faint">
                Incluye {formatCurrency(data.anticipos.monto)} de cobros anticipados reubicados a su mes de cobro
                (pagos con REP anteriores a la emisión de su factura — Art. 17-I LISR: el ingreso se acumula en lo
                que ocurra primero, cobro o expedición).
              </p>
            )}
          </div>

          <div className={`${CARD} p-5 text-[14px]`}>
            <h3 className="mb-3 text-[12.5px] font-medium uppercase tracking-[0.02em] text-cos-ink-faint">Cálculo ISR provisional (Art. 14 LISR)</h3>
            <dl className="space-y-1.5">
              <Line label="Ingresos acumulados del ejercicio" value={data.calculo.ingresosAcumulados} />
              <Line label={`× Coeficiente de utilidad (${data.calculo.coeficiente != null ? (data.calculo.coeficiente * 100).toFixed(4) + "%" : "—"})`} value={null} />
              <Line label="= Utilidad fiscal estimada" value={data.calculo.utilidadFiscal} strong />
              {/* PTU pagada en el ejercicio: octavos acumulados mayo–diciembre,
                  ANTES de pérdidas (Art. 14, fracc. II, segundo párrafo LISR). */}
              {data.calculo.ptuDisminuida != null && data.calculo.ptuDisminuida > 0 && (
                <Line label="− PTU pagada en el ejercicio (octavos mayo–diciembre)" value={-data.calculo.ptuDisminuida} />
              )}
              {data.calculo.perdidaFiscalAplicada != null && data.calculo.perdidaFiscalAplicada > 0 && (
                <Line label="− Pérdidas fiscales de ejercicios anteriores aplicadas" value={-data.calculo.perdidaFiscalAplicada} />
              )}
              {((data.calculo.ptuDisminuida ?? 0) > 0 || (data.calculo.perdidaFiscalAplicada ?? 0) > 0) && (
                <Line label="= Base gravable" value={data.calculo.baseGravable ?? null} strong />
              )}
              <Line label={`× Tasa ISR (${(data.calculo.tasa * 100).toFixed(0)}%)`} value={null} />
              <Line label="= ISR del ejercicio acumulado" value={data.calculo.isrDelEjercicio} strong />
              <Line label="− ISR pagado en meses anteriores" value={data.calculo.isrPagadoAnterior > 0 ? -data.calculo.isrPagadoAnterior : 0} />
              <div className="border-t border-cos-line-soft pt-2">
                <Line label="= ISR DEL MES" value={data.calculo.isrDelMes} strong big colorClass="text-cos-red-ink" />
              </div>
            </dl>
          </div>
        </>
      )}
    </div>
  );
}

// Etiqueta humana de la fuente del coeficiente (aplicado o sugerido). Deja claro
// cuándo el valor es la cifra autoritativa de la declaración anual y cuándo sólo
// es un estimado crudo de CFDIs.
type CoefFuente = "manual" | "declaracion_anual" | "provisional_previo" | "calculado" | "ninguno";

function fuenteCoeficienteLabel(fuente: CoefFuente, prevYear: number): string {
  switch (fuente) {
    case "manual":
      return "ajuste manual";
    case "declaracion_anual":
      return `de declaración anual ${prevYear}`;
    case "provisional_previo":
      return "de provisional capturado";
    case "calculado":
      return `calculado de CFDIs ${prevYear} (estimado)`;
    default:
      return "sin determinar";
  }
}

// Solo el cálculo crudo de CFDIs es un estimado no autoritativo; el resto prov
// de fuentes oficiales (anual, provisional capturado) o de un ajuste manual.
function esFuenteEstimada(fuente: CoefFuente): boolean {
  return fuente === "calculado";
}

function CoeficienteCard({
  base,
  saving,
  error,
  onSave,
}: {
  base: IsrData["base"];
  saving: boolean;
  error: string | null;
  onSave: (coeficiente: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState("");

  const aplicado = base.coeficiente;
  const aplicadoFuente = base.coeficienteFuente;
  const sugerido = base.coeficienteSugerido;
  const sugeridoFuente = base.coeficienteSugeridoFuente;

  // Sugerir adoptar el coeficiente detectado por el sistema sólo cuando difiere
  // del aplicado (evita ofrecer un cambio que no mueve nada).
  const ofrecerSugerido =
    sugerido != null &&
    (aplicado == null || Math.abs(sugerido - aplicado) > 0.0005);

  const aplicadoEstimado = esFuenteEstimada(aplicadoFuente);

  return (
    <div className={`${CARD} p-5`}>
      <h3 className="mb-3 text-[12.5px] font-medium uppercase tracking-[0.02em] text-cos-ink-faint">Coeficiente de utilidad</h3>
      <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-[14px]">
        <div>
          <dt className="text-[12px] text-cos-ink-faint">Ingresos {base.prevYear}</dt>
          <dd><Money value={base.prevIngresosTotal} size={14} /></dd>
        </div>
        <div>
          <dt className="text-[12px] text-cos-ink-faint">Gastos {base.prevYear}</dt>
          <dd><Money value={base.prevGastosTotal} size={14} /></dd>
        </div>
        <div>
          <dt className="text-[12px] text-cos-ink-faint">Utilidad {base.prevYear}</dt>
          <dd><Money value={base.prevUtilidad} size={14} /></dd>
        </div>
        <div>
          <dt className="text-[12px] text-cos-ink-faint">Coeficiente aplicado</dt>
          <dd className="flex items-center gap-2">
            <span className="font-mono text-[14px] font-medium text-cos-ink">
              {aplicado != null ? (aplicado * 100).toFixed(4) + "%" : "—"}
            </span>
            <span
              className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium ${
                aplicadoEstimado ? "bg-cos-amber-tint text-cos-amber-ink" : "bg-cos-brand-tint text-cos-brand-ink"
              }`}
            >
              {fuenteCoeficienteLabel(aplicadoFuente, base.prevYear)}
            </span>
          </dd>
        </div>
      </dl>

      {aplicadoEstimado && (
        <p className="mt-3 flex items-start gap-1.5 text-[12px] text-cos-amber-ink">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            El coeficiente aplicado es un estimado crudo de los CFDIs del ejercicio anterior
            (ingresos − egresos). Verifica contra la utilidad fiscal de tu declaración anual
            antes de enterar el pago provisional.
          </span>
        </p>
      )}

      {ofrecerSugerido && sugerido != null && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-card border border-cos-line-soft bg-cos-paper px-3 py-2 text-[13px]">
          <Sparkles className="h-3.5 w-3.5 shrink-0 text-cos-brand-ink" />
          <span className="text-cos-ink-soft">
            Coeficiente sugerido{" "}
            <strong className="font-mono text-cos-ink">{(sugerido * 100).toFixed(4)}%</strong>{" "}
            <span className="text-cos-ink-faint">({fuenteCoeficienteLabel(sugeridoFuente, base.prevYear)})</span>
          </span>
          <button
            onClick={() => onSave(+sugerido.toFixed(4))}
            disabled={saving}
            className="ml-auto inline-flex items-center gap-1 rounded-md border border-cos-brand/40 px-2 py-0.5 text-[12px] font-semibold text-cos-brand-ink hover:bg-cos-brand-tint disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
            Usar sugerido {(sugerido * 100).toFixed(2)}%
          </button>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2 text-[13px]">
        {!editing ? (
          <button
            onClick={() => {
              setVal(aplicado != null ? (aplicado * 100).toFixed(4) : "");
              setEditing(true);
            }}
            className="text-[12px] font-medium text-cos-brand-ink hover:underline"
          >
            Editar manualmente
          </button>
        ) : (
          <>
            <div className="inline-flex items-center gap-1">
              <input
                type="number"
                min="0"
                max="100"
                step="0.0001"
                value={val}
                placeholder="0.0000"
                onChange={(e) => setVal(e.target.value)}
                className="w-28 rounded-md border border-cos-line px-2 py-1 text-right text-[13px] focus:outline-none focus:ring-1 focus:ring-cos-brand"
              />
              <span className="text-cos-ink-soft">%</span>
            </div>
            <button
              onClick={() => {
                const pct = parseFloat(val);
                if (!Number.isFinite(pct) || pct < 0 || pct > 100) return;
                onSave(+(pct / 100).toFixed(6));
                setEditing(false);
              }}
              disabled={saving}
              className="inline-flex items-center gap-1 rounded-md bg-cos-brand px-2.5 py-1 text-[12px] font-semibold text-white hover:opacity-90 disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
              Guardar
            </button>
            <button
              onClick={() => setEditing(false)}
              className="text-[12px] font-medium text-cos-ink-soft hover:text-cos-ink"
            >
              Cancelar
            </button>
          </>
        )}
        {error && <span className="text-[12px] text-cos-red-ink">{error}</span>}
      </div>
    </div>
  );
}

// Remanente de pérdidas fiscales de ejercicios anteriores pendiente de aplicar.
// Editable inline; persiste vía el mismo endpoint que la pantalla de Impuestos y
// se amortiza contra la utilidad fiscal estimada antes de aplicar el 30%.
function PerdidaCard({
  base,
  saving,
  error,
  onSave,
}: {
  base: IsrData["base"];
  saving: boolean;
  error: string | null;
  onSave: (perdida: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState("");

  const pendiente = base.perdidaFiscalPendiente ?? null;

  return (
    <div className={`${CARD} p-5`}>
      <h3 className="mb-3 text-[12.5px] font-medium uppercase tracking-[0.02em] text-cos-ink-faint">Pérdidas fiscales pendientes</h3>
      <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-[14px]">
        <div>
          <dt className="text-[12px] text-cos-ink-faint">Pérdida pendiente de aplicar</dt>
          <dd>{pendiente != null ? <Money value={pendiente} size={14} /> : <Dash />}</dd>
        </div>
      </dl>

      <p className="mt-3 text-[12px] text-cos-ink-soft">
        Remanente de pérdidas fiscales de ejercicios anteriores pendiente de aplicar (actualizado).
        Se amortiza contra la utilidad fiscal estimada antes del 30%.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-[13px]">
        {!editing ? (
          <button
            onClick={() => {
              setVal(pendiente != null ? String(pendiente) : "");
              setEditing(true);
            }}
            className="text-[12px] font-medium text-cos-brand-ink hover:underline"
          >
            Editar manualmente
          </button>
        ) : (
          <>
            <div className="inline-flex items-center gap-1">
              <span className="text-cos-ink-soft">$</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={val}
                placeholder="0.00"
                onChange={(e) => setVal(e.target.value)}
                className="w-36 rounded-md border border-cos-line px-2 py-1 text-right text-[13px] focus:outline-none focus:ring-1 focus:ring-cos-brand"
              />
            </div>
            <button
              onClick={() => {
                const monto = parseFloat(val === "" ? "0" : val);
                if (!Number.isFinite(monto) || monto < 0) return;
                onSave(+monto.toFixed(2));
                setEditing(false);
              }}
              disabled={saving}
              className="inline-flex items-center gap-1 rounded-md bg-cos-brand px-2.5 py-1 text-[12px] font-semibold text-white hover:opacity-90 disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
              Guardar
            </button>
            <button
              onClick={() => setEditing(false)}
              className="text-[12px] font-medium text-cos-ink-soft hover:text-cos-ink"
            >
              Cancelar
            </button>
          </>
        )}
        {error && <span className="text-[12px] text-cos-red-ink">{error}</span>}
      </div>
    </div>
  );
}

// ── RETENCIONES PANEL ────────────────────────────────────────────────────────
interface RetRow {
  id: string; fecha: string; uuid: string | null; serie: string | null; folio: string | null;
  contraparte: string; rfc: string; subtotal: number;
  tipoRetencion: "IVA" | "ISR" | "IEPS"; tasa: number | null; importe: number;
}
interface RetData {
  periodo: string;
  company: { rfc: string; razonSocial: string } | null;
  retencionesRecibidas: RetRow[];
  retencionesEfectuadas: RetRow[];
  totales: {
    recibidas: { isr: number; iva: number; ieps: number; total: number };
    efectuadas: { isr: number; iva: number; ieps: number; total: number };
  };
}

export function RetencionesPanel({ companyId, year, month }: { companyId: string; year: number; month: number }) {
  const [data, setData] = useState<RetData | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/papeles/retenciones?companyId=${companyId}&year=${year}&month=${month}`)
      .then((r) => r.json())
      .then(setData)
      .finally(() => setLoading(false));
  }, [companyId, year, month]);

  if (loading) return <Loading />;
  if (!data) return <Empty />;

  return (
    <div className="space-y-5">
      <DownloadCsvButton href={`/api/papeles/retenciones?companyId=${companyId}&year=${year}&month=${month}&format=csv`} />

      {data.retencionesRecibidas.length > 0 && (
        <RetSection
          title="Retenciones que nos hicieron"
          subtitle="Tus clientes te retuvieron ISR o IVA en estos CFDIs. Son saldos a favor tuyos ante el SAT."
          rows={data.retencionesRecibidas}
          totales={data.totales.recibidas}
        />
      )}
      {data.retencionesEfectuadas.length > 0 && (
        <RetSection
          title="Retenciones que efectuaste"
          subtitle="Le retuviste ISR o IVA a tus proveedores. Son un pasivo que debes enterar al SAT."
          rows={data.retencionesEfectuadas}
          totales={data.totales.efectuadas}
        />
      )}
      {data.retencionesRecibidas.length === 0 && data.retencionesEfectuadas.length === 0 && (
        <div className="rounded-card border border-dashed border-cos-line bg-cos-card p-12 text-center">
          <p className="text-[14px] text-cos-ink-faint">Sin retenciones en este periodo.</p>
          <p className="mx-auto mt-2 max-w-[52ch] text-[12.5px] text-cos-ink-faint">
            Aquí solo van las retenciones de ISR/IVA en CFDIs: las que te hacen tus clientes o las que tú
            efectúas a proveedores. El ISR que te retienen por <strong>asimilados a salarios</strong> se
            muestra aparte, en el Resumen — es tu pago provisional acreditable en la declaración anual.
          </p>
        </div>
      )}
    </div>
  );
}

function RetSection({
  title, subtitle, rows, totales,
}: {
  title: string; subtitle: string; rows: RetRow[]; totales: { isr: number; iva: number; ieps: number; total: number };
}) {
  return (
    <div className={`${CARD} overflow-hidden`}>
      <div className="border-b border-cos-line px-4 py-3">
        <h3 className="text-[14px] font-semibold text-cos-ink">{title}</h3>
        <p className="mt-0.5 text-[12px] text-cos-ink-soft">{subtitle}</p>
      </div>
      <div className="overflow-x-auto">
      <table className="w-full min-w-[680px] text-[13px]">
        <thead className={THEAD}>
          <tr>
            <th className="px-3 py-2 text-left font-medium">Fecha</th>
            <th className="px-3 py-2 text-left font-medium">Tipo</th>
            <th className="px-3 py-2 text-left font-medium">Contraparte</th>
            <th className="px-3 py-2 text-right font-medium">Subtotal</th>
            <th className="px-3 py-2 text-right font-medium">Tasa</th>
            <th className="px-3 py-2 text-right font-medium">Retención</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id + r.tipoRetencion} className="border-t border-cos-line-soft">
              <td className="px-3 py-1.5 text-[12px] text-cos-ink-faint whitespace-nowrap">{formatDate(r.fecha)}</td>
              <td className="px-3 py-1.5 text-[12px] font-medium text-cos-ink">{r.tipoRetencion}</td>
              <td className="px-3 py-1.5 text-[12px]">
                <p className="max-w-[300px] truncate text-cos-ink">{r.contraparte}</p>
                <p className="font-mono text-[10px] text-cos-ink-faint">{r.rfc}</p>
              </td>
              <td className="px-3 py-1.5 text-right"><Money value={r.subtotal} size={12} weight={500} /></td>
              <td className="px-3 py-1.5 text-right text-[12px] text-cos-ink-soft">{r.tasa != null ? (r.tasa * 100).toFixed(2) + "%" : "—"}</td>
              <td className="px-3 py-1.5 text-right"><Money value={r.importe} size={12} weight={500} /></td>
            </tr>
          ))}
          <tr className="border-t-2 border-cos-line bg-cos-paper font-semibold">
            <td colSpan={5} className="px-3 py-2 text-right text-[12px] text-cos-ink-soft">
              Totales — ISR: <span className="font-mono text-cos-ink">{formatCurrency(totales.isr)}</span>
              {totales.iva > 0 && <>  ·  IVA: <span className="font-mono text-cos-ink">{formatCurrency(totales.iva)}</span></>}
              {totales.ieps > 0 && <>  ·  IEPS: <span className="font-mono text-cos-ink">{formatCurrency(totales.ieps)}</span></>}
            </td>
            <td className="px-3 py-2 text-right"><Money value={totales.total} size={12} weight={700} /></td>
          </tr>
        </tbody>
      </table>
      </div>
    </div>
  );
}

// ── Shared bits ──────────────────────────────────────────────────────────────
function Loading() {
  return (
    <div className="flex items-center justify-center gap-2 py-12 text-[14px] text-cos-ink-soft">
      <Loader2 className="h-5 w-5 animate-spin" /> Cargando papel de trabajo…
    </div>
  );
}
function Empty() {
  return (
    <div className="rounded-card border border-dashed border-cos-line bg-cos-card p-12 text-center text-[14px] text-cos-ink-faint">
      Sin datos para este periodo.
    </div>
  );
}
function Dash() {
  return <span className="font-mono text-cos-ink-faint">—</span>;
}

function DownloadCsvButton({ href }: { href: string }) {
  return (
    <div className="flex justify-end print:hidden">
      <a
        href={href}
        className="inline-flex items-center gap-2 rounded-control border border-cos-line px-3 py-1.5 text-[12.5px] font-medium hover:bg-cos-paper"
      >
        <Download className="h-3.5 w-3.5" /> Descargar Excel
      </a>
    </div>
  );
}

// A label/value row for the determination + cálculo dls.
function KV({ label, children, strong }: { label: string; children: ReactNode; strong?: boolean }) {
  return (
    <div className={`flex items-center justify-between ${strong ? "border-t border-cos-line-soft pt-2 font-semibold text-cos-ink" : ""}`}>
      <span className={strong ? "" : "text-cos-ink-soft"}>{label}</span>
      <span>{children}</span>
    </div>
  );
}

function Line({
  label, value, strong, big, colorClass,
}: {
  label: string; value: number | null; strong?: boolean; big?: boolean; colorClass?: string;
}) {
  return (
    <div className={`flex items-center justify-between ${strong ? "font-semibold text-cos-ink" : ""} ${big ? "pt-1" : ""}`}>
      <span className={strong ? "" : "text-cos-ink-soft"}>{label}</span>
      {value != null && <Money value={value} size={big ? 16 : 14} weight={strong ? 700 : 500} className={colorClass} />}
    </div>
  );
}
