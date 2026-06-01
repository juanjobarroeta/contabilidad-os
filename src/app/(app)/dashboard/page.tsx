"use client";

import { useEffect, useState, useCallback } from "react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { formatCurrency, formatDate } from "@/lib/utils";
import {
  TrendingUp, TrendingDown, FileText, AlertCircle,
  ArrowUpRight, ArrowDownLeft, CheckCircle2, Clock,
  Landmark, ShieldCheck, Info,
} from "lucide-react";
import Link from "next/link";
import { PageContainer, Alert, Loading } from "@/components/ui";

// ── Types ──────────────────────────────────────────────────────────────────────
interface TrendPoint {
  label: string;
  periodo: string;
  ingresos: number;
  gastos: number;
}
interface UpcomingOb {
  tipo: string;
  descripcion: string;
  periodicidad: string;
  dueDate: string;
  dueDateFmt: string;
  periodo: string;
  daysUntil: number;
  status: "OVERDUE" | "SOON" | "UPCOMING";
  filed: boolean;
}
interface RecentInvoice {
  id: string;
  tipo: string;
  fecha: string;
  contraparte: string;
  rfc: string;
  total: number;
  status: string;
}
interface BankSummaryItem {
  id: string;
  banco: string;
  nombre: string;
  numeroCuenta: string;
  totalTx: number;
  unmatchedCount: number;
  unmatchedTotal: number;
}
interface DashboardData {
  periodo: { year: number; month: number };
  kpis: {
    ingresosDelMes: number;
    gastosDelMes: number;
    utilidadBruta: number;
    ivaEstimado: number;
    ivaTrasladado: number;
    ivaAcreditable: number;
    facturasEmitidas: number;
    facturasRecibidas: number;
  };
  trend: TrendPoint[];
  upcomingObligations: UpcomingOb[];
  recentInvoices: RecentInvoice[];
  bankSummary: BankSummaryItem[];
  totalUnmatched: number;
  complementos: {
    stats: { totalPendientes: number; vencidos: number; porVencer: number; montoPendiente: number };
    pendientes: {
      invoiceId: string;
      cliente: string | null;
      montoPendiente: number;
      fechaLimite: string;
      urgencia: "VENCIDO" | "POR_VENCER" | "EN_TIEMPO";
      diasParaVencer: number;
    }[];
  };
  lastDeclaracion: {
    periodo: string;
    status: string;
    ivaPagar: number | null;
    isrPagar: number | null;
  } | null;
}

const MONTHS = [
  "Enero","Febrero","Marzo","Abril","Mayo","Junio",
  "Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre",
];

// ── KPI Card ──────────────────────────────────────────────────────────────────
function KpiCard({
  title, value, sub, icon, trend, href,
}: {
  title: string; value: string; sub: string;
  icon: React.ReactNode;
  trend?: "up" | "down" | "neutral";
  href?: string;
}) {
  const card = (
    <div className={`bg-white rounded-xl border border-border p-5 flex flex-col gap-3 ${href ? "hover:shadow-md transition-shadow cursor-pointer" : ""}`}>
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground font-medium">{title}</span>
        <div className="h-8 w-8 rounded-lg bg-gray-50 flex items-center justify-center">{icon}</div>
      </div>
      <div>
        <p className={`text-2xl font-bold ${trend === "up" ? "text-green-700" : trend === "down" ? "text-red-600" : ""}`}>
          {value}
        </p>
        <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>
      </div>
    </div>
  );
  return href ? <Link href={href}>{card}</Link> : card;
}

// ── Sparkline bar chart (pure CSS) ────────────────────────────────────────────
function TrendChart({ data }: { data: TrendPoint[] }) {
  const maxVal = Math.max(...data.flatMap((d) => [d.ingresos, d.gastos]), 1);
  return (
    <div className="flex items-end gap-2 h-28">
      {data.map((d) => (
        <div key={d.periodo} className="flex-1 flex flex-col items-center gap-1">
          <div className="w-full flex items-end gap-0.5 h-20">
            {/* Ingresos bar */}
            <div className="flex-1 flex flex-col justify-end">
              <div
                className="rounded-t bg-green-400 transition-all duration-500"
                style={{ height: `${Math.round((d.ingresos / maxVal) * 100)}%`, minHeight: d.ingresos > 0 ? "2px" : "0" }}
                title={`Ingresos: ${formatCurrency(d.ingresos)}`}
              />
            </div>
            {/* Gastos bar */}
            <div className="flex-1 flex flex-col justify-end">
              <div
                className="rounded-t bg-red-300 transition-all duration-500"
                style={{ height: `${Math.round((d.gastos / maxVal) * 100)}%`, minHeight: d.gastos > 0 ? "2px" : "0" }}
                title={`Gastos: ${formatCurrency(d.gastos)}`}
              />
            </div>
          </div>
          <span className="text-[10px] text-muted-foreground text-center leading-tight">{d.label}</span>
        </div>
      ))}
    </div>
  );
}

// ── Obligation status chip ────────────────────────────────────────────────────
function ObStatus({ ob }: { ob: UpcomingOb }) {
  if (ob.filed) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-50 text-green-700">
        <CheckCircle2 className="h-3 w-3" />Presentada
      </span>
    );
  }
  if (ob.status === "OVERDUE") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-50 text-red-700">
        <AlertCircle className="h-3 w-3" />Vencida
      </span>
    );
  }
  if (ob.status === "SOON") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-700">
        <Clock className="h-3 w-3" />{ob.daysUntil}d
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-600">
      <Clock className="h-3 w-3" />{ob.daysUntil}d
    </span>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function DashboardPage() {
  const { activeCompany, loading: companyLoading } = useCompany();
  const [data, setData]     = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]   = useState("");

  const fetchDashboard = useCallback(async () => {
    if (!activeCompany) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/dashboard?companyId=${activeCompany.id}`);
      if (!res.ok) throw new Error("Error al cargar dashboard");
      setData(await res.json());
    } catch {
      setError("No se pudo cargar el dashboard");
    } finally {
      setLoading(false);
    }
  }, [activeCompany]);

  useEffect(() => { fetchDashboard(); }, [fetchDashboard]);

  if (companyLoading) return <div className="p-8 text-muted-foreground text-sm">Cargando...</div>;

  if (!activeCompany) {
    return (
      <div className="p-8">
        <div className="max-w-md mx-auto text-center mt-20">
          <h2 className="text-lg font-semibold">No hay empresas registradas</h2>
          <p className="text-muted-foreground text-sm mt-2">Agrega tu primera empresa para comenzar.</p>
          <Link href="/empresas/nueva"
            className="mt-4 inline-block bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium">
            Agregar empresa
          </Link>
        </div>
      </div>
    );
  }

  const now   = new Date();
  const month = now.getMonth() + 1;
  const year  = now.getFullYear();
  const mesLabel = `${MONTHS[month - 1]} ${year}`;

  return (
    <PageContainer className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">{activeCompany.razonSocial}</h1>
          <p className="text-muted-foreground text-sm mt-0.5">RFC: {activeCompany.rfc} · {mesLabel}</p>
        </div>
        {data?.lastDeclaracion && (
          <Link href="/impuestos"
            className={`text-xs px-2.5 py-1 rounded-full font-medium ${
              data.lastDeclaracion.status === "PAID"   ? "bg-green-100 text-green-700" :
              data.lastDeclaracion.status === "FILED"  ? "bg-yellow-100 text-yellow-700" :
              data.lastDeclaracion.status === "CALCULATED" ? "bg-blue-100 text-blue-700" :
              "bg-gray-100 text-gray-600"
            }`}>
            Última declaración: {data.lastDeclaracion.periodo} ·{" "}
            {{ DRAFT: "Borrador", CALCULATED: "Calculada", FILED: "Presentada", PAID: "Pagada" }[data.lastDeclaracion.status] ?? data.lastDeclaracion.status}
          </Link>
        )}
      </div>

      {error && (
        <Alert tone="danger" className="flex items-center gap-2">
          <AlertCircle className="h-4 w-4 shrink-0" />{error}
        </Alert>
      )}

      {loading ? (
        <Loading label="Cargando datos…" className="py-16" />
      ) : data ? (
        <>
          {/* ── KPI Row ── */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <KpiCard
              title={`Ingresos · ${mesLabel}`}
              value={formatCurrency(data.kpis.ingresosDelMes)}
              sub={`${data.kpis.facturasEmitidas} factura${data.kpis.facturasEmitidas !== 1 ? "s" : ""} emitida${data.kpis.facturasEmitidas !== 1 ? "s" : ""}`}
              icon={<TrendingUp className="h-4 w-4 text-green-600" />}
              trend="up"
              href="/facturas"
            />
            <KpiCard
              title={`Gastos · ${mesLabel}`}
              value={formatCurrency(data.kpis.gastosDelMes)}
              sub={`${data.kpis.facturasRecibidas} factura${data.kpis.facturasRecibidas !== 1 ? "s" : ""} recibida${data.kpis.facturasRecibidas !== 1 ? "s" : ""}`}
              icon={<TrendingDown className="h-4 w-4 text-red-500" />}
              trend="down"
              href="/facturas"
            />
            <KpiCard
              title="Utilidad bruta"
              value={formatCurrency(data.kpis.utilidadBruta)}
              sub={data.kpis.utilidadBruta >= 0 ? "Positiva este mes" : "Pérdida este mes"}
              icon={<FileText className="h-4 w-4 text-blue-600" />}
              trend={data.kpis.utilidadBruta >= 0 ? "up" : "down"}
            />
            <KpiCard
              title="IVA estimado"
              value={formatCurrency(Math.abs(data.kpis.ivaEstimado))}
              sub={data.kpis.ivaEstimado > 0 ? "Estimado a cargo" : data.kpis.ivaEstimado < 0 ? "Saldo a favor" : "Sin movimiento"}
              icon={<AlertCircle className={`h-4 w-4 ${data.kpis.ivaEstimado > 0 ? "text-amber-500" : "text-green-600"}`} />}
              href="/impuestos"
            />
          </div>

          {/* ── Middle Row: Trend + Obligations ── */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

            {/* Trend chart — takes 2 cols */}
            <div className="lg:col-span-2 bg-white rounded-xl border border-border p-5">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="font-semibold text-sm">Tendencia 6 meses</h3>
                  <p className="text-xs text-muted-foreground">Ingresos vs gastos (sin IVA)</p>
                </div>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-sm bg-green-400" />Ingresos</span>
                  <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-sm bg-red-300" />Gastos</span>
                </div>
              </div>
              {data.trend.every(d => d.ingresos === 0 && d.gastos === 0) ? (
                <div className="h-28 flex items-center justify-center">
                  <div className="text-center">
                    <p className="text-sm text-muted-foreground">Sin facturas en los últimos 6 meses</p>
                    <Link href="/facturas" className="text-xs text-primary hover:underline mt-1 inline-block">
                      Importar CFDIs del SAT →
                    </Link>
                  </div>
                </div>
              ) : (
                <TrendChart data={data.trend} />
              )}
              {/* Summary row */}
              <div className="flex items-center gap-6 mt-4 pt-4 border-t border-border">
                <div>
                  <p className="text-xs text-muted-foreground">Total ingresos 6m</p>
                  <p className="text-sm font-semibold text-green-700">
                    {formatCurrency(data.trend.reduce((s, d) => s + d.ingresos, 0))}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Total gastos 6m</p>
                  <p className="text-sm font-semibold text-red-600">
                    {formatCurrency(data.trend.reduce((s, d) => s + d.gastos, 0))}
                  </p>
                </div>
                <div className="ml-auto">
                  <p className="text-xs text-muted-foreground">Utilidad 6m</p>
                  <p className={`text-sm font-semibold ${
                    data.trend.reduce((s, d) => s + d.ingresos - d.gastos, 0) >= 0
                      ? "text-blue-700" : "text-red-600"
                  }`}>
                    {formatCurrency(data.trend.reduce((s, d) => s + d.ingresos - d.gastos, 0))}
                  </p>
                </div>
              </div>
            </div>

            {/* Upcoming obligations */}
            <div className="bg-white rounded-xl border border-border overflow-hidden">
              <div className="px-5 py-4 border-b border-border flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                  <h3 className="font-semibold text-sm">Próximas obligaciones</h3>
                </div>
                <Link href="/cumplimiento" className="text-xs text-primary hover:underline">Ver todo</Link>
              </div>
              {data.upcomingObligations.length === 0 ? (
                <div className="p-5 text-center">
                  <CheckCircle2 className="h-8 w-8 text-green-500 mx-auto mb-2 opacity-60" />
                  <p className="text-xs text-muted-foreground">Sin obligaciones próximas en 45 días</p>
                </div>
              ) : (
                <ul className="divide-y divide-border">
                  {data.upcomingObligations.map((ob) => (
                    <li key={ob.tipo} className="px-4 py-3 flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-xs font-medium truncate">{ob.descripcion}</p>
                        <p className="text-[11px] text-muted-foreground">{ob.periodo} · vence {ob.dueDateFmt}</p>
                      </div>
                      <ObStatus ob={ob} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* ── Complementos de pago pendientes ── */}
          {data.complementos && data.complementos.stats.totalPendientes > 0 && (
            <div className="bg-white rounded-xl border border-border overflow-hidden">
              <div className="px-5 py-4 border-b border-border flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <AlertCircle className="h-4 w-4 text-amber-500" />
                  <h3 className="font-semibold text-sm">Complementos de pago pendientes</h3>
                </div>
                <span className="text-xs text-muted-foreground">
                  {data.complementos.stats.totalPendientes} pendiente
                  {data.complementos.stats.totalPendientes !== 1 ? "s" : ""}
                  {data.complementos.stats.vencidos > 0 && (
                    <span className="text-red-600 font-medium"> · {data.complementos.stats.vencidos} vencido{data.complementos.stats.vencidos !== 1 ? "s" : ""}</span>
                  )}
                </span>
              </div>
              <ul className="divide-y divide-border">
                {data.complementos.pendientes.map((c) => (
                  <li key={c.invoiceId} className="px-4 py-3 flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs font-medium truncate">{c.cliente ?? "Cliente"}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {formatCurrency(c.montoPendiente)} · límite {formatDate(c.fechaLimite)}
                      </p>
                    </div>
                    <span
                      className={`text-[10px] px-2 py-0.5 rounded-full font-medium shrink-0 ${
                        c.urgencia === "VENCIDO"
                          ? "bg-red-100 text-red-700"
                          : c.urgencia === "POR_VENCER"
                          ? "bg-amber-100 text-amber-700"
                          : "bg-gray-100 text-gray-600"
                      }`}
                    >
                      {c.urgencia === "VENCIDO"
                        ? `Vencido ${Math.abs(c.diasParaVencer)}d`
                        : c.urgencia === "POR_VENCER"
                        ? `${c.diasParaVencer}d`
                        : "En tiempo"}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="px-4 py-2.5 border-t border-border">
                <Link href="/facturas" className="text-xs text-primary hover:underline">
                  Emitir complementos →
                </Link>
              </div>
            </div>
          )}

          {/* ── Bottom Row: Recent Invoices + Bank ── */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

            {/* Recent invoices */}
            <div className="lg:col-span-2 bg-white rounded-xl border border-border overflow-hidden">
              <div className="px-5 py-4 border-b border-border flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <FileText className="h-4 w-4 text-muted-foreground" />
                  <h3 className="font-semibold text-sm">Facturas recientes</h3>
                </div>
                <Link href="/facturas" className="text-xs text-primary hover:underline">Ver todas</Link>
              </div>
              {data.recentInvoices.length === 0 ? (
                <div className="p-10 text-center">
                  <FileText className="h-8 w-8 text-muted-foreground mx-auto mb-2 opacity-30" />
                  <p className="text-sm text-muted-foreground">Sin facturas registradas</p>
                  <Link href="/impuestos" className="text-xs text-primary hover:underline mt-1 inline-block">
                    Sincronizar desde SAT →
                  </Link>
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 border-b border-border">
                      <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground w-20">Tipo</th>
                      <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Fecha</th>
                      <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Contraparte</th>
                      <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recentInvoices.map((inv) => (
                      <tr key={inv.id} className="border-b border-border last:border-0 hover:bg-gray-50/50">
                        <td className="px-4 py-2.5">
                          {inv.tipo === "INGRESO" ? (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium bg-green-50 text-green-700">
                              <ArrowUpRight className="h-3 w-3" />Emitida
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium bg-orange-50 text-orange-700">
                              <ArrowDownLeft className="h-3 w-3" />Recibida
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-xs text-muted-foreground">{formatDate(inv.fecha)}</td>
                        <td className="px-4 py-2.5">
                          <p className="text-xs font-medium truncate max-w-[160px]">{inv.contraparte}</p>
                          <p className="text-[11px] text-muted-foreground">{inv.rfc}</p>
                        </td>
                        <td className={`px-4 py-2.5 text-right text-xs font-semibold ${inv.tipo === "INGRESO" ? "text-green-700" : "text-orange-700"}`}>
                          {inv.tipo === "EGRESO" && "("}
                          {formatCurrency(inv.total)}
                          {inv.tipo === "EGRESO" && ")"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Bank reconciliation summary */}
            <div className="bg-white rounded-xl border border-border overflow-hidden">
              <div className="px-5 py-4 border-b border-border flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Landmark className="h-4 w-4 text-muted-foreground" />
                  <h3 className="font-semibold text-sm">Conciliación bancaria</h3>
                </div>
                <Link href="/bancos" className="text-xs text-primary hover:underline">Gestionar</Link>
              </div>
              {data.bankSummary.length === 0 ? (
                <div className="p-5 text-center">
                  <Landmark className="h-8 w-8 text-muted-foreground mx-auto mb-2 opacity-30" />
                  <p className="text-xs text-muted-foreground mb-2">Sin cuentas bancarias</p>
                  <Link href="/bancos"
                    className="text-xs bg-primary text-primary-foreground px-3 py-1.5 rounded-md font-medium hover:bg-primary/90 inline-block">
                    Agregar cuenta
                  </Link>
                </div>
              ) : (
                <>
                  {data.totalUnmatched > 0 && (
                    <div className="mx-4 mt-3 flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-700">
                      <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                      <span><strong>{data.totalUnmatched}</strong> movimiento{data.totalUnmatched !== 1 ? "s" : ""} sin conciliar</span>
                    </div>
                  )}
                  <ul className="divide-y divide-border mt-2">
                    {data.bankSummary.map((acct) => (
                      <li key={acct.id} className="px-4 py-3">
                        <div className="flex items-center justify-between">
                          <div className="min-w-0">
                            <p className="text-xs font-medium">{acct.banco} · {acct.nombre}</p>
                            <p className="text-[11px] text-muted-foreground">····{acct.numeroCuenta.slice(-4)} · {acct.totalTx} movimientos</p>
                          </div>
                          {acct.unmatchedCount > 0 ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-700 shrink-0">
                              {acct.unmatchedCount} pend.
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-50 text-green-700 shrink-0">
                              <CheckCircle2 className="h-3 w-3" />Al día
                            </span>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </div>
        </>
      ) : null}
    </PageContainer>
  );
}
