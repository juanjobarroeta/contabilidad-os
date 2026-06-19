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
import { Download, Loader2, FileText } from "lucide-react";

const CARD = "rounded-card border border-cos-line bg-white shadow-card print:border-2";
const THEAD = "bg-cos-paper text-[11px] uppercase tracking-[0.02em] text-cos-ink-faint";

// ── IVA PANEL ────────────────────────────────────────────────────────────────
interface IvaRow {
  id: string; fecha: string; uuid: string | null; serie: string | null; folio: string | null;
  contraparte: string; rfc: string; subtotal: number; tasa: number | null; importe: number; metodoPago: string;
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
  };
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

  if (loading) return <Loading />;
  if (!data) return <Empty />;

  return (
    <div className="space-y-5">
      <DownloadCsvButton href={`/api/papeles/iva?companyId=${companyId}&year=${year}&month=${month}&format=csv`} />

      <IvaSection
        title="IVA trasladado (cobrado)"
        subtitle="IVA que cobraste a tus clientes en este periodo"
        rows={data.trasladado}
      />
      <IvaSection
        title="IVA acreditable (pagado)"
        subtitle="IVA que pagaste a tus proveedores, acreditable contra el trasladado"
        rows={data.acreditable}
      />
      {data.retenidoPorClientes.length > 0 && (
        <IvaSection
          title="IVA retenido por clientes"
          subtitle="IVA que tus clientes te retuvieron (disminuye el IVA a cargo)"
          rows={data.retenidoPorClientes}
        />
      )}
      {data.retenidoAProveedores.length > 0 && (
        <IvaSection
          title="IVA retenido a proveedores"
          subtitle="IVA que tú retuviste (pasivo a pagar al SAT en otra declaración)"
          rows={data.retenidoAProveedores}
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
          <Line label="Saldo a favor anterior (−)" value={-data.totales.saldoFavorAnterior} />
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

function IvaSection({ title, subtitle, rows }: { title: string; subtitle: string; rows: IvaRow[] }) {
  if (rows.length === 0) return null;
  const total = rows.reduce((s, r) => s + r.importe, 0);
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
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-cos-line-soft">
              <td className="px-3 py-1.5 text-[12px] text-cos-ink-faint whitespace-nowrap">{formatDate(r.fecha)}</td>
              <td className="px-3 py-1.5 font-mono text-[12px]">{r.folio ? `${r.serie ?? ""}${r.folio}` : (r.uuid?.slice(0, 8) ?? "—")}</td>
              <td className="px-3 py-1.5 text-[12px]">
                <p className="max-w-[240px] truncate text-cos-ink">{r.contraparte}</p>
                <p className="font-mono text-[10px] text-cos-ink-faint">{r.rfc}</p>
              </td>
              <td className="px-3 py-1.5 text-[12px] text-cos-ink-soft">{r.metodoPago}</td>
              <td className="px-3 py-1.5 text-right"><Money value={r.subtotal} size={12} weight={500} /></td>
              <td className="px-3 py-1.5 text-right text-[12px] text-cos-ink-soft">{r.tasa != null ? (r.tasa * 100).toFixed(0) + "%" : "—"}</td>
              <td className="px-3 py-1.5 text-right"><Money value={r.importe} size={12} weight={500} /></td>
            </tr>
          ))}
          <tr className="border-t-2 border-cos-line bg-cos-paper font-semibold">
            <td colSpan={6} className="px-3 py-2 text-right text-[12px] text-cos-ink-soft">Total ({rows.length} facturas)</td>
            <td className="px-3 py-2 text-right"><Money value={total} size={12} weight={700} /></td>
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
    coeficienteFuente: "manual" | "calculado" | "ninguno";
  };
  acumulado: { mes: number; mesLabel: string; ingresos: number; facturas: number }[];
  calculo:
    | {
        tipo: "art14";
        ingresosAcumulados: number; coeficiente: number | null; utilidadFiscal: number | null;
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
        isrCausado: number | null; retencionesAcreditadas: number; isrDelMes: number | null;
        tarifaVerificada: boolean;
      }
    | {
        tipo: "pf_plataformas";
        ingresosCobradosMes: number; actividad: string; actividadAsumida: boolean;
        tasa: number | null; isrCausado: number | null; retencionesAcreditadas: number; isrDelMes: number | null;
      };
}

export function IsrPanel({ companyId, year, month }: { companyId: string; year: number; month: number }) {
  const [data, setData] = useState<IsrData | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/papeles/isr?companyId=${companyId}&year=${year}&month=${month}`)
      .then((r) => r.json())
      .then(setData)
      .finally(() => setLoading(false));
  }, [companyId, year, month]);

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
            <KV label="= Base gravable">{data.calculo.baseGravable != null ? <Money value={data.calculo.baseGravable} size={13} weight={500} /> : <Dash />}</KV>
            <KV label="ISR causado (tarifa mensual Art. 96)">{data.calculo.isrCausado != null ? <Money value={data.calculo.isrCausado} size={13} weight={500} /> : <Dash />}</KV>
            <KV label="− Retenciones 10% PM (Art. 116)"><Money value={data.calculo.retencionesAcreditadas} size={13} weight={500} /></KV>
            <KV label="= ISR del mes" strong>{data.calculo.isrDelMes != null ? <Money value={data.calculo.isrDelMes} size={15} weight={700} /> : <Dash />}</KV>
            {!data.calculo.tarifaVerificada && <p className="pt-1 text-[12px] text-cos-amber-ink">Tarifa ISR sin verificar contra Anexo 8 — cifra provisional.</p>}
            <p className="pt-1 text-[12px] text-cos-ink-soft">Deducción opcional ciega (sin predial). Si convienen las deducciones comprobadas, ajústalo manualmente — el comparativo automático está pendiente.</p>
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
          <div className={`${CARD} p-5`}>
            <h3 className="mb-3 text-[12.5px] font-medium uppercase tracking-[0.02em] text-cos-ink-faint">Coeficiente de utilidad</h3>
            <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-[14px]">
              <div>
                <dt className="text-[12px] text-cos-ink-faint">Ingresos {data.base.prevYear}</dt>
                <dd><Money value={data.base.prevIngresosTotal} size={14} /></dd>
              </div>
              <div>
                <dt className="text-[12px] text-cos-ink-faint">Gastos {data.base.prevYear}</dt>
                <dd><Money value={data.base.prevGastosTotal} size={14} /></dd>
              </div>
              <div>
                <dt className="text-[12px] text-cos-ink-faint">Utilidad {data.base.prevYear}</dt>
                <dd><Money value={data.base.prevUtilidad} size={14} /></dd>
              </div>
              <div>
                <dt className="text-[12px] text-cos-ink-faint">Coeficiente aplicado ({data.base.coeficienteFuente})</dt>
                <dd className="font-mono text-[14px] font-medium text-cos-ink">
                  {data.base.coeficiente != null ? (data.base.coeficiente * 100).toFixed(4) + "%" : "—"}
                </dd>
              </div>
            </dl>
          </div>

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
          </div>

          <div className={`${CARD} p-5 text-[14px]`}>
            <h3 className="mb-3 text-[12.5px] font-medium uppercase tracking-[0.02em] text-cos-ink-faint">Cálculo ISR provisional (Art. 14 LISR)</h3>
            <dl className="space-y-1.5">
              <Line label="Ingresos acumulados del ejercicio" value={data.calculo.ingresosAcumulados} />
              <Line label={`× Coeficiente de utilidad (${data.calculo.coeficiente != null ? (data.calculo.coeficiente * 100).toFixed(4) + "%" : "—"})`} value={null} />
              <Line label="= Utilidad fiscal estimada" value={data.calculo.utilidadFiscal} strong />
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
        <div className="rounded-card border border-dashed border-cos-line bg-white p-12 text-center text-[14px] text-cos-ink-faint">
          Sin retenciones en este periodo.
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
    <div className="rounded-card border border-dashed border-cos-line bg-white p-12 text-center text-[14px] text-cos-ink-faint">
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
