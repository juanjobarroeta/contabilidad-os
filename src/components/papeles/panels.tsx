"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Shared working-paper panels (IVA · ISR · Retenciones). Extracted from the
// standalone /impuestos/papeles page so the Declaración Workspace and the legacy
// page render the exact same auditable tables — no duplicated logic. Each panel
// fetches its own data for { companyId, year, month } and is print/CSV-ready.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import { formatCurrency, formatDate } from "@/lib/utils";
import { Download, Loader2, FileText } from "lucide-react";

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
    <div className="space-y-6">
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

      <div className="bg-white border border-border rounded-xl p-5 text-sm print:border-2">
        <h3 className="font-semibold mb-3">Determinación del IVA a pagar</h3>
        <dl className="space-y-1.5 font-mono">
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
          <div className="border-t border-border pt-2">
            {data.totales.ivaPagar > 0 ? (
              <Line label="= IVA A PAGAR" value={data.totales.ivaPagar} strong big colorClass="text-red-700" />
            ) : (
              <Line label="= Saldo a favor del mes" value={data.totales.saldoFavorMes} strong big colorClass="text-green-700" />
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
    <div className="bg-white border border-border rounded-xl overflow-hidden print:border-2">
      <div className="px-4 py-3 border-b border-border">
        <h3 className="font-semibold text-sm">{title}</h3>
        <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
      </div>
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-xs">
          <tr>
            <th className="text-left px-3 py-2 font-medium text-muted-foreground">Fecha</th>
            <th className="text-left px-3 py-2 font-medium text-muted-foreground">Folio</th>
            <th className="text-left px-3 py-2 font-medium text-muted-foreground">Contraparte</th>
            <th className="text-left px-3 py-2 font-medium text-muted-foreground">Pago</th>
            <th className="text-right px-3 py-2 font-medium text-muted-foreground">Subtotal</th>
            <th className="text-right px-3 py-2 font-medium text-muted-foreground">Tasa</th>
            <th className="text-right px-3 py-2 font-medium text-muted-foreground">IVA</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-border">
              <td className="px-3 py-1.5 text-xs text-muted-foreground">{formatDate(r.fecha)}</td>
              <td className="px-3 py-1.5 text-xs font-mono">{r.folio ? `${r.serie ?? ""}${r.folio}` : (r.uuid?.slice(0, 8) ?? "—")}</td>
              <td className="px-3 py-1.5 text-xs">
                <p className="truncate max-w-[240px]">{r.contraparte}</p>
                <p className="text-[10px] text-muted-foreground font-mono">{r.rfc}</p>
              </td>
              <td className="px-3 py-1.5 text-xs">{r.metodoPago}</td>
              <td className="px-3 py-1.5 text-xs text-right font-mono">{formatCurrency(r.subtotal)}</td>
              <td className="px-3 py-1.5 text-xs text-right">{r.tasa != null ? (r.tasa * 100).toFixed(0) + "%" : "—"}</td>
              <td className="px-3 py-1.5 text-xs text-right font-mono">{formatCurrency(r.importe)}</td>
            </tr>
          ))}
          <tr className="border-t-2 border-border bg-gray-50 font-semibold">
            <td colSpan={6} className="px-3 py-2 text-xs text-right">Total ({rows.length} facturas)</td>
            <td className="px-3 py-2 text-right text-xs font-mono">{formatCurrency(total)}</td>
          </tr>
        </tbody>
      </table>
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
    <div className="space-y-6">
      <DownloadCsvButton href={`/api/papeles/isr?companyId=${companyId}&year=${year}&month=${month}&format=csv`} />

      <div className="flex items-center gap-2 bg-indigo-50 border border-indigo-200 rounded-lg px-4 py-3 text-sm text-indigo-900">
        <FileText className="h-4 w-4 shrink-0" />
        <span><strong>{data.regimen.label}</strong></span>
      </div>

      {data.calculo.tipo === "pf_plataformas" ? (
        <div className="bg-white border border-border rounded-xl overflow-hidden print:border-2">
          <div className="px-4 py-3 border-b border-border">
            <h3 className="font-semibold text-sm">ISR plataformas tecnológicas (Art. 113-A LISR)</h3>
            <p className="text-xs text-muted-foreground mt-0.5">Pago definitivo — tasa fija sobre ingresos cobrados, menos lo retenido por las plataformas.</p>
          </div>
          <div className="p-4 space-y-2 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">Actividad</span><span>{data.calculo.actividad}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Ingresos cobrados del mes</span><span className="font-mono">{formatCurrency(data.calculo.ingresosCobradosMes)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">× Tasa</span><span className="font-mono">{data.calculo.tasa != null ? (data.calculo.tasa * 100).toFixed(2) + "%" : "—"}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">= ISR causado</span><span className="font-mono">{data.calculo.isrCausado != null ? formatCurrency(data.calculo.isrCausado) : "—"}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">− Retenciones de plataformas</span><span className="font-mono">{formatCurrency(data.calculo.retencionesAcreditadas)}</span></div>
            <div className="flex justify-between border-t border-border pt-2 font-semibold"><span>= ISR del mes</span><span className="font-mono">{data.calculo.isrDelMes != null ? formatCurrency(data.calculo.isrDelMes) : "—"}</span></div>
            {data.calculo.actividadAsumida && <p className="pt-1 text-xs text-amber-700">Tasa asumida (enajenación/servicios, 1%). Configura el tipo de actividad de plataforma de la empresa si es transporte (2.1%) u hospedaje (4%).</p>}
          </div>
        </div>
      ) : data.calculo.tipo === "pf_arrendamiento" ? (
        <div className="bg-white border border-border rounded-xl overflow-hidden print:border-2">
          <div className="px-4 py-3 border-b border-border">
            <h3 className="font-semibold text-sm">ISR pago provisional — PF Arrendamiento (Arts. 114-116 LISR)</h3>
          </div>
          <div className="p-4 space-y-2 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">Ingresos cobrados del mes</span><span className="font-mono">{formatCurrency(data.calculo.ingresosCobradosMes)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">− Deducción ciega 35% (Art. 115)</span><span className="font-mono">{formatCurrency(data.calculo.deduccionCiega)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">= Base gravable</span><span className="font-mono">{data.calculo.baseGravable != null ? formatCurrency(data.calculo.baseGravable) : "—"}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">ISR causado (tarifa mensual Art. 96)</span><span className="font-mono">{data.calculo.isrCausado != null ? formatCurrency(data.calculo.isrCausado) : "—"}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">− Retenciones 10% PM (Art. 116)</span><span className="font-mono">{formatCurrency(data.calculo.retencionesAcreditadas)}</span></div>
            <div className="flex justify-between border-t border-border pt-2 font-semibold"><span>= ISR del mes</span><span className="font-mono">{data.calculo.isrDelMes != null ? formatCurrency(data.calculo.isrDelMes) : "—"}</span></div>
            {!data.calculo.tarifaVerificada && <p className="pt-1 text-xs text-amber-700">Tarifa ISR sin verificar contra Anexo 8 — cifra provisional.</p>}
            <p className="pt-1 text-xs text-muted-foreground">Deducción opcional ciega (sin predial). Si convienen las deducciones comprobadas, ajústalo manualmente — el comparativo automático está pendiente.</p>
          </div>
        </div>
      ) : data.calculo.tipo === "pf_act_empresarial" ? (
        <div className="bg-white border border-border rounded-xl overflow-hidden print:border-2">
          <div className="px-4 py-3 border-b border-border">
            <h3 className="font-semibold text-sm">ISR provisional — PF Actividad Empresarial y Profesional (Art. 106 LISR)</h3>
          </div>
          <div className="p-4 space-y-2 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">Ingresos cobrados (acumulado)</span><span className="font-mono">{formatCurrency(data.calculo.ingresosCobradosAcum)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">= Base gravable</span><span className="font-mono">{data.calculo.baseGravable != null ? formatCurrency(data.calculo.baseGravable) : "—"}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">ISR causado (tarifa Art. 96 elevada al periodo)</span><span className="font-mono">{data.calculo.isrCausado != null ? formatCurrency(data.calculo.isrCausado) : "—"}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">− Pagos provisionales anteriores</span><span className="font-mono">{formatCurrency(data.calculo.isrPagadoAnterior)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">− Retenciones 10% PM (Art. 106)</span><span className="font-mono">{formatCurrency(data.calculo.retencionesAcreditadas)}</span></div>
            <div className="flex justify-between border-t border-border pt-2 font-semibold"><span>= ISR del mes</span><span className="font-mono">{data.calculo.isrDelMes != null ? formatCurrency(data.calculo.isrDelMes) : "—"}</span></div>
            {!data.calculo.tarifaVerificada && <p className="pt-1 text-xs text-amber-700">Tarifa ISR sin verificar contra Anexo 8 — cifra provisional.</p>}
          </div>
        </div>
      ) : data.calculo.tipo === "resico_pf" ? (
        <>
          {/* Tarifa table */}
          <div className="bg-white border border-border rounded-xl overflow-hidden print:border-2">
            <div className="px-4 py-3 border-b border-border">
              <h3 className="font-semibold text-sm">Tarifa RESICO PF mensual (Art. 113-E LISR)</h3>
            </div>
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs">
                <tr>
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">Rango de ingresos (mensual)</th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">Tasa</th>
                </tr>
              </thead>
              <tbody>
                {data.calculo.tarifa.map((t, i) => {
                  const active =
                    data.calculo.tipo === "resico_pf" &&
                    t.limiteInferior === data.calculo.rangoLimiteInferior;
                  return (
                    <tr key={i} className={`border-t border-border ${active ? "bg-indigo-50 font-semibold" : ""}`}>
                      <td className="px-3 py-1.5 text-xs font-mono">
                        {formatCurrency(t.limiteInferior)} — {t.limiteSuperior === Infinity || t.limiteSuperior > 1e10 ? "en adelante" : formatCurrency(t.limiteSuperior)}
                      </td>
                      <td className="px-3 py-1.5 text-xs text-right">{t.tasaPct}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Monthly ingresos detail */}
          <div className="bg-white border border-border rounded-xl overflow-hidden print:border-2">
            <div className="px-4 py-3 border-b border-border">
              <h3 className="font-semibold text-sm">Ingresos cobrados del mes</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                RESICO PF usa ingresos efectivamente cobrados (flow-through). El cálculo es sobre este monto, no sobre acumulado.
              </p>
            </div>
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs">
                <tr>
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">Mes</th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground"># Facturas</th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">Ingresos</th>
                </tr>
              </thead>
              <tbody>
                {data.acumulado.map((m) => (
                  <tr key={m.mes} className="border-t border-border">
                    <td className="px-3 py-1.5 text-xs">{m.mesLabel}</td>
                    <td className="px-3 py-1.5 text-xs text-right">{m.facturas}</td>
                    <td className="px-3 py-1.5 text-xs text-right font-mono">{formatCurrency(m.ingresos)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Calculation */}
          <div className="bg-white border border-border rounded-xl p-5 text-sm print:border-2">
            <h3 className="font-semibold mb-3">Cálculo ISR RESICO PF</h3>
            <dl className="space-y-1.5 font-mono">
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
              <div className="border-t border-border pt-2">
                <Line label="= ISR DEL MES" value={data.calculo.isrDelMes} strong big colorClass="text-red-700" />
              </div>
              {data.calculo.saldoAFavor > 0 && (
                <p className="pt-2 text-xs text-green-700">
                  La retención acreditable excede el ISR del mes: {formatCurrency(data.calculo.saldoAFavor)} se
                  arrastra como saldo a favor al siguiente periodo (al guardar la declaración).
                </p>
              )}
            </dl>
          </div>
        </>
      ) : (
        <>
          <div className="bg-white border border-border rounded-xl p-5 print:border-2">
            <h3 className="font-semibold text-sm mb-3">Coeficiente de utilidad</h3>
            <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">Ingresos {data.base.prevYear}</dt>
                <dd className="font-mono font-medium">{formatCurrency(data.base.prevIngresosTotal)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Gastos {data.base.prevYear}</dt>
                <dd className="font-mono font-medium">{formatCurrency(data.base.prevGastosTotal)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Utilidad {data.base.prevYear}</dt>
                <dd className="font-mono font-medium">{formatCurrency(data.base.prevUtilidad)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Coeficiente aplicado ({data.base.coeficienteFuente})</dt>
                <dd className="font-mono font-medium">
                  {data.base.coeficiente != null ? (data.base.coeficiente * 100).toFixed(4) + "%" : "—"}
                </dd>
              </div>
            </dl>
          </div>

          <div className="bg-white border border-border rounded-xl overflow-hidden print:border-2">
            <div className="px-4 py-3 border-b border-border">
              <h3 className="font-semibold text-sm">Ingresos acumulados del ejercicio</h3>
            </div>
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs">
                <tr>
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">Mes</th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground"># Facturas</th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">Ingresos</th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">Acumulado</th>
                </tr>
              </thead>
              <tbody>
                {data.acumulado.map((m, i) => {
                  const acumulado = data.acumulado.slice(0, i + 1).reduce((s, x) => s + x.ingresos, 0);
                  return (
                    <tr key={m.mes} className="border-t border-border">
                      <td className="px-3 py-1.5 text-xs">{m.mesLabel}</td>
                      <td className="px-3 py-1.5 text-xs text-right">{m.facturas}</td>
                      <td className="px-3 py-1.5 text-xs text-right font-mono">{formatCurrency(m.ingresos)}</td>
                      <td className="px-3 py-1.5 text-xs text-right font-mono font-semibold">{formatCurrency(acumulado)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="bg-white border border-border rounded-xl p-5 text-sm print:border-2">
            <h3 className="font-semibold mb-3">Cálculo ISR provisional (Art. 14 LISR)</h3>
            <dl className="space-y-1.5 font-mono">
              <Line label="Ingresos acumulados del ejercicio" value={data.calculo.ingresosAcumulados} />
              <Line label={`× Coeficiente de utilidad (${data.calculo.coeficiente != null ? (data.calculo.coeficiente * 100).toFixed(4) + "%" : "—"})`} value={null} />
              <Line label="= Utilidad fiscal estimada" value={data.calculo.utilidadFiscal} strong />
              <Line label={`× Tasa ISR (${(data.calculo.tasa * 100).toFixed(0)}%)`} value={null} />
              <Line label="= ISR del ejercicio acumulado" value={data.calculo.isrDelEjercicio} strong />
              <Line label="− ISR pagado en meses anteriores" value={data.calculo.isrPagadoAnterior > 0 ? -data.calculo.isrPagadoAnterior : 0} />
              <div className="border-t border-border pt-2">
                <Line label="= ISR DEL MES" value={data.calculo.isrDelMes} strong big colorClass="text-red-700" />
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
    <div className="space-y-6">
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
        <div className="bg-white border border-dashed border-border rounded-xl p-12 text-center text-sm text-muted-foreground">
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
    <div className="bg-white border border-border rounded-xl overflow-hidden print:border-2">
      <div className="px-4 py-3 border-b border-border">
        <h3 className="font-semibold text-sm">{title}</h3>
        <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
      </div>
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-xs">
          <tr>
            <th className="text-left px-3 py-2 font-medium text-muted-foreground">Fecha</th>
            <th className="text-left px-3 py-2 font-medium text-muted-foreground">Tipo</th>
            <th className="text-left px-3 py-2 font-medium text-muted-foreground">Contraparte</th>
            <th className="text-right px-3 py-2 font-medium text-muted-foreground">Subtotal</th>
            <th className="text-right px-3 py-2 font-medium text-muted-foreground">Tasa</th>
            <th className="text-right px-3 py-2 font-medium text-muted-foreground">Retención</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id + r.tipoRetencion} className="border-t border-border">
              <td className="px-3 py-1.5 text-xs text-muted-foreground">{formatDate(r.fecha)}</td>
              <td className="px-3 py-1.5 text-xs font-medium">{r.tipoRetencion}</td>
              <td className="px-3 py-1.5 text-xs">
                <p className="truncate max-w-[300px]">{r.contraparte}</p>
                <p className="text-[10px] text-muted-foreground font-mono">{r.rfc}</p>
              </td>
              <td className="px-3 py-1.5 text-xs text-right font-mono">{formatCurrency(r.subtotal)}</td>
              <td className="px-3 py-1.5 text-xs text-right">{r.tasa != null ? (r.tasa * 100).toFixed(2) + "%" : "—"}</td>
              <td className="px-3 py-1.5 text-xs text-right font-mono">{formatCurrency(r.importe)}</td>
            </tr>
          ))}
          <tr className="border-t-2 border-border bg-gray-50 font-semibold">
            <td colSpan={5} className="px-3 py-2 text-right text-xs">
              Totales — ISR: <span className="font-mono">{formatCurrency(totales.isr)}</span>
              {totales.iva > 0 && <>  ·  IVA: <span className="font-mono">{formatCurrency(totales.iva)}</span></>}
              {totales.ieps > 0 && <>  ·  IEPS: <span className="font-mono">{formatCurrency(totales.ieps)}</span></>}
            </td>
            <td className="px-3 py-2 text-right text-xs font-mono">{formatCurrency(totales.total)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ── Shared bits ──────────────────────────────────────────────────────────────
function Loading() {
  return (
    <div className="flex items-center gap-2 text-muted-foreground text-sm py-12 justify-center">
      <Loader2 className="h-5 w-5 animate-spin" /> Cargando papel de trabajo…
    </div>
  );
}
function Empty() {
  return (
    <div className="bg-white border border-dashed border-border rounded-xl p-12 text-center text-sm text-muted-foreground">
      Sin datos para este periodo.
    </div>
  );
}

function DownloadCsvButton({ href }: { href: string }) {
  return (
    <div className="flex justify-end print:hidden">
      <a
        href={href}
        className="flex items-center gap-2 border border-border px-3 py-1.5 rounded-md text-xs font-medium hover:bg-accent"
      >
        <Download className="h-3.5 w-3.5" /> Descargar Excel
      </a>
    </div>
  );
}

function Line({
  label, value, strong, big, colorClass,
}: {
  label: string; value: number | null; strong?: boolean; big?: boolean; colorClass?: string;
}) {
  return (
    <div className={`flex items-center justify-between ${strong ? "font-semibold" : ""} ${big ? "text-base pt-1" : ""}`}>
      <span className={strong ? "" : "text-muted-foreground"}>{label}</span>
      {value != null && <span className={colorClass ?? ""}>{formatCurrency(value)}</span>}
    </div>
  );
}
