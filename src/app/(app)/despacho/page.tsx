"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Cockpit del despacho — todas las empresas en un panel: estado de la
// declaración del periodo, monto a pagar (de lo ya calculado), nómina sin
// timbrar y empleados, con salto directo a operar cada una. La franja superior
// alerta de datos fiscales desactualizados (cobertura time-aware). Es la capa
// "edge" del despacho multi-RFC: ver todo y entrar a lo que urge sin cambiar de
// contexto a mano.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Building2, Users2, BadgeCheck, Clock4, AlertTriangle, FileWarning,
  ChevronRight as ChevronR, CalendarDays, Database,
} from "lucide-react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { Loading } from "@/components/ui";
import { formatCurrency, formatDate } from "@/lib/utils";

interface Row {
  id: string;
  rfc: string;
  razonSocial: string;
  regimenFiscal: string;
  periodo: string;
  estadoDeclaracion: "presentada" | "calculada" | "pendiente" | "vencida";
  aPagar: number | null;
  nominaSinTimbrar: number;
  empleadosActivos: number;
  obligacionesVencidas: number;
  obligacionesPorVencer: number;
}
interface Data {
  periodo: string;
  vencimiento: string;
  vencido: boolean;
  companies: Row[];
  resumen: { empresas: number; conPendientes: number; totalAPagar: number; empresasConVencidas: number; totalVencidas: number };
  cobertura: { alDia: number; faltantes: number; sinCotejar: number } | null;
}

const ESTADO: Record<Row["estadoDeclaracion"], { label: string; cls: string; icon: typeof BadgeCheck }> = {
  presentada: { label: "Presentada", cls: "bg-cos-jade-tint text-cos-jade-ink", icon: BadgeCheck },
  calculada: { label: "Calculada, sin presentar", cls: "bg-cos-amber-tint text-cos-amber-ink", icon: Clock4 },
  pendiente: { label: "Por calcular", cls: "bg-cos-slate-tint text-cos-ink-soft", icon: Clock4 },
  vencida: { label: "Vencida", cls: "bg-cos-red-tint text-cos-red-ink", icon: AlertTriangle },
};

export default function DespachoCockpitPage() {
  const { companies, setActiveCompany } = useCompany();
  const router = useRouter();
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [declFaltan, setDeclFaltan] = useState<{ total: number; empresas: number } | null>(null);

  useEffect(() => {
    fetch("/api/despacho/cockpit").then((r) => (r.ok ? r.json() : null)).then(setData).finally(() => setLoading(false));
    fetch("/api/declaraciones/cobertura")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setDeclFaltan({ total: d.total, empresas: d.empresasConFaltantes }))
      .catch(() => {});
  }, []);

  function operar(id: string, destino: string) {
    const found = companies.find((c) => c.id === id);
    if (found) setActiveCompany(found);
    router.push(destino);
  }

  if (loading) return <Loading />;
  const rows = data?.companies ?? [];

  return (
    <div className="mx-auto max-w-[1140px] px-6 py-7">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-[24px] font-bold tracking-[-0.02em] text-cos-ink">
            <Building2 className="h-6 w-6 text-cos-ink-faint" /> Despacho
          </h1>
          <p className="mt-0.5 text-[14px] text-cos-ink-soft">
            Todas tus empresas en un panel — qué urge declarar, cuánto se paga y qué falta timbrar.
          </p>
        </div>
        {data && (
          <div className="flex gap-5 text-[13px] text-cos-ink-soft">
            <span className="inline-flex items-center gap-1.5"><Building2 className="h-4 w-4 text-cos-ink-faint" /> <b className="font-mono">{data.resumen.empresas}</b> empresas</span>
            <span>Periodo <b>{data.periodo}</b> · vence {formatDate(data.vencimiento)}</span>
            <span>A pagar: <b className="font-mono">{formatCurrency(data.resumen.totalAPagar)}</b></span>
            {data.resumen.conPendientes > 0 && <span className="text-cos-amber-ink"><b className="font-mono">{data.resumen.conPendientes}</b> con pendientes</span>}
            {data.resumen.empresasConVencidas > 0 && <span className="text-cos-red-ink"><b className="font-mono">{data.resumen.empresasConVencidas}</b> con obligaciones vencidas</span>}
          </div>
        )}
      </div>

      {/* franja de cobertura de datos fiscales */}
      {data?.cobertura && (data.cobertura.faltantes > 0 || data.cobertura.sinCotejar > 0) && (
        <Link href="/cumplimiento" className="mt-4 flex items-center gap-2.5 rounded-card border border-cos-amber bg-cos-amber-tint px-4 py-3 text-[13px] text-cos-amber-ink hover:opacity-90">
          <Database className="h-4 w-4 flex-none" />
          <span className="flex-1">
            Datos fiscales: {data.cobertura.faltantes > 0 && <b>{data.cobertura.faltantes} faltante(s)</b>}
            {data.cobertura.faltantes > 0 && data.cobertura.sinCotejar > 0 && " · "}
            {data.cobertura.sinCotejar > 0 && <b>{data.cobertura.sinCotejar} sin cotejar</b>} — afecta todos los RFC.
          </span>
          <ChevronR className="h-4 w-4 flex-none" />
        </Link>
      )}

      {/* franja de declaraciones (acuses) por capturar */}
      {declFaltan && declFaltan.total > 0 && (
        <Link href="/declaraciones" className="mt-3 flex items-center gap-2.5 rounded-card border border-cos-amber bg-cos-amber-tint px-4 py-3 text-[13px] text-cos-amber-ink hover:opacity-90">
          <FileWarning className="h-4 w-4 flex-none" />
          <span className="flex-1">
            Faltan <b>{declFaltan.total} acuse(s)</b> en <b>{declFaltan.empresas} empresa(s)</b> — súbelos para calcular saldos a favor, coeficiente y pagos provisionales.
          </span>
          <ChevronR className="h-4 w-4 flex-none" />
        </Link>
      )}

      <div className="mt-5 overflow-hidden rounded-card border border-cos-line bg-white shadow-card">
        {/* Scroll horizontal en móvil: 5 columnas no caben en ~360px y el
            overflow-hidden del contenedor recortaba la columna Nómina. */}
        <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-cos-paper text-[12px] uppercase tracking-[0.02em] text-cos-ink-faint">
            <tr>
              <th className="px-4 py-2.5 text-left font-medium">Empresa</th>
              <th className="px-3 py-2.5 text-left font-medium">Declaración {data?.periodo}</th>
              <th className="px-3 py-2.5 text-right font-medium">A pagar</th>
              <th className="px-3 py-2.5 text-right font-medium">Nómina</th>
              <th className="px-3 py-2.5"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const est = ESTADO[r.estadoDeclaracion];
              const Icon = est.icon;
              return (
                <tr key={r.id} className="border-t border-cos-line hover:bg-cos-paper/60">
                  <td className="px-4 py-3">
                    <p className="font-medium text-cos-ink">{r.razonSocial}</p>
                    <p className="font-mono text-[11px] text-cos-ink-faint">{r.rfc} · {r.regimenFiscal}</p>
                    {r.obligacionesVencidas > 0 && (
                      <button
                        onClick={() => operar(r.id, "/cumplimiento")}
                        className="mt-1 inline-flex items-center gap-1 rounded-full bg-cos-red-tint px-2 py-0.5 text-[11px] font-medium text-cos-red-ink hover:opacity-90"
                      >
                        <AlertTriangle className="h-3 w-3" /> {r.obligacionesVencidas} vencida{r.obligacionesVencidas === 1 ? "" : "s"}
                      </button>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <button
                      onClick={() => operar(r.id, "/impuestos/cierre")}
                      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-medium ${est.cls}`}
                    >
                      <Icon className="h-3.5 w-3.5" /> {est.label}
                    </button>
                  </td>
                  <td className="px-3 py-3 text-right font-mono">
                    {r.aPagar != null ? formatCurrency(r.aPagar) : <span className="text-cos-ink-faint">—</span>}
                  </td>
                  <td className="px-3 py-3 text-right">
                    {r.nominaSinTimbrar > 0 ? (
                      <button onClick={() => operar(r.id, "/nomina/detalle")} className="inline-flex items-center gap-1 text-[12px] font-medium text-cos-amber-ink">
                        <FileWarning className="h-3.5 w-3.5" /> {r.nominaSinTimbrar} sin timbrar
                      </button>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[12px] text-cos-ink-faint">
                        <Users2 className="h-3.5 w-3.5" /> {r.empleadosActivos}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-3 text-right">
                    <button
                      onClick={() => operar(r.id, "/impuestos/cierre")}
                      className="inline-flex items-center gap-1 rounded-control bg-cos-brand px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-cos-brand-deep"
                    >
                      Operar <ChevronR className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-10 text-center text-[13.5px] text-cos-ink-faint">Sin empresas accesibles.</td></tr>
            )}
          </tbody>
        </table>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-4 text-[12.5px] text-cos-ink-faint">
        <span className="inline-flex items-center gap-1.5"><CalendarDays className="h-3.5 w-3.5" /> Periodo a declarar = mes anterior (vence el 17).</span>
        <Link href="/nomina/cockpit" className="inline-flex items-center gap-1 text-cos-brand-ink hover:underline">
          Cockpit de nómina <ChevronR className="h-3.5 w-3.5" />
        </Link>
      </div>
    </div>
  );
}
