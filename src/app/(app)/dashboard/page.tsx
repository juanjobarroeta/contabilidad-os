"use client";

import { useCompany } from "@/components/layout/CompanyProvider";
import { formatCurrency } from "@/lib/utils";
import { FileText, TrendingUp, TrendingDown, AlertCircle } from "lucide-react";

export default function DashboardPage() {
  const { activeCompany, loading } = useCompany();

  if (loading) {
    return (
      <div className="p-8 text-muted-foreground text-sm">Cargando...</div>
    );
  }

  if (!activeCompany) {
    return (
      <div className="p-8">
        <div className="max-w-md mx-auto text-center mt-20">
          <h2 className="text-lg font-semibold">No hay empresas registradas</h2>
          <p className="text-muted-foreground text-sm mt-2">
            Agrega tu primera empresa para comenzar.
          </p>
          <a
            href="/empresas/nueva"
            className="mt-4 inline-block bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium"
          >
            Agregar empresa
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">{activeCompany.razonSocial}</h1>
        <p className="text-muted-foreground text-sm">RFC: {activeCompany.rfc}</p>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <KpiCard
          title="Facturas emitidas (mes)"
          value="—"
          icon={<FileText className="h-5 w-5 text-primary" />}
          sub="Sin datos aún"
        />
        <KpiCard
          title="Ingresos (mes)"
          value={formatCurrency(0)}
          icon={<TrendingUp className="h-5 w-5 text-green-600" />}
          sub="IVA incluido"
        />
        <KpiCard
          title="Gastos (mes)"
          value={formatCurrency(0)}
          icon={<TrendingDown className="h-5 w-5 text-red-500" />}
          sub="IVA incluido"
        />
        <KpiCard
          title="IVA a pagar (est.)"
          value={formatCurrency(0)}
          icon={<AlertCircle className="h-5 w-5 text-amber-500" />}
          sub="Estimado"
        />
      </div>

      {/* Placeholder panels */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-xl border border-border p-6">
          <h3 className="font-semibold text-sm mb-4">Facturas recientes</h3>
          <p className="text-sm text-muted-foreground">
            Aquí aparecerán las últimas facturas emitidas.
          </p>
        </div>
        <div className="bg-white rounded-xl border border-border p-6">
          <h3 className="font-semibold text-sm mb-4">Movimientos bancarios sin conciliar</h3>
          <p className="text-sm text-muted-foreground">
            Aquí aparecerán los movimientos pendientes de conciliar.
          </p>
        </div>
      </div>
    </div>
  );
}

function KpiCard({
  title,
  value,
  icon,
  sub,
}: {
  title: string;
  value: string;
  icon: React.ReactNode;
  sub: string;
}) {
  return (
    <div className="bg-white rounded-xl border border-border p-5">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs text-muted-foreground font-medium">{title}</span>
        {icon}
      </div>
      <p className="text-2xl font-bold">{value}</p>
      <p className="text-xs text-muted-foreground mt-1">{sub}</p>
    </div>
  );
}
