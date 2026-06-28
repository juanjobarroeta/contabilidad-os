"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Cockpit multi-RFC de nómina — el panel del despacho de outsourcing: el estado
// de la nómina de TODAS las empresas a las que tienes acceso, en una tabla, con
// semáforo operativo y salto directo a operar cada una (cambia la empresa
// activa y entra al workspace).
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Building2, Users2, AlertTriangle, BadgeCheck, Clock4, CircleDashed,
  ChevronLeft, ChevronRight as ChevronR, Settings2,
} from "lucide-react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { Loading, Money } from "@/components/ui";
import { formatCurrency, formatDate } from "@/lib/utils";

interface CockpitCompany {
  id: string;
  rfc: string;
  razonSocial: string;
  regimenFiscal: string;
  empleadosActivos: number;
  masaSalarialDiaria: number;
  bajoMinimo: number;
  corridasDelMes: number;
  netoDelMes: number;
  corridasSinTimbrar: number;
  ultimaCorrida: { periodo: string; tipo: string; status: string; fechaPago: string; totalNeto: number } | null;
  setupCompleto: boolean;
}

interface CockpitData {
  salarioMinimoGeneral: number;
  periodo: string;
  companies: CockpitCompany[];
}

const TIPO_RUN_LABEL: Record<string, string> = {
  ORDINARIA: "Ordinaria",
  EXTRAORDINARIA: "Extraordinaria",
  FINIQUITO: "Finiquito",
  AGUINALDO: "Aguinaldo",
  VACACIONES: "Vacaciones",
  PTU: "PTU",
};

// Semáforo operativo del mes, en orden de urgencia.
type Estado = { label: string; cls: string; icon: typeof BadgeCheck };
function estadoDe(c: CockpitCompany): Estado {
  if (c.empleadosActivos === 0)
    return { label: "Sin empleados", cls: "bg-cos-slate-tint text-cos-ink-faint", icon: CircleDashed };
  if (!c.setupCompleto)
    return { label: "Setup incompleto", cls: "bg-cos-amber-tint text-cos-amber-ink", icon: Settings2 };
  if (c.corridasSinTimbrar > 0)
    return { label: `${c.corridasSinTimbrar} sin timbrar`, cls: "bg-cos-amber-tint text-cos-amber-ink", icon: Clock4 };
  if (c.corridasDelMes === 0)
    return { label: "Sin corrida este mes", cls: "bg-cos-red-tint text-cos-red-ink", icon: AlertTriangle };
  return { label: "Al corriente", cls: "bg-cos-jade-tint text-cos-jade-ink", icon: BadgeCheck };
}

export default function NominaCockpitPage() {
  const { companies, setActiveCompany } = useCompany();
  const router = useRouter();
  const [data, setData] = useState<CockpitData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/nomina/cockpit")
      .then((r) => (r.ok ? r.json() : null))
      .then(setData)
      .finally(() => setLoading(false));
  }, []);

  // Cambia la empresa activa del contexto y entra a su workspace de nómina.
  function operar(c: CockpitCompany, destino: "/nomina" | "/nomina/detalle") {
    const found = companies.find((x) => x.id === c.id);
    if (found) setActiveCompany(found);
    router.push(destino);
  }

  if (loading) return <Loading />;
  // Triage: las que necesitan acción primero (sin corrida → sin timbrar/setup →
  // al corriente → sin empleados), para procesar la quincena de arriba a abajo.
  const urgencia = (c: CockpitCompany): number => {
    if (c.empleadosActivos === 0) return 0;
    const label = estadoDe(c).label;
    if (label === "Sin corrida este mes") return 4;
    if (label.includes("sin timbrar") || label === "Setup incompleto") return 3;
    if (label === "Al corriente") return 1;
    return 2;
  };
  const rows = [...(data?.companies ?? [])].sort((a, b) => urgencia(b) - urgencia(a));
  const totEmpleados = rows.reduce((s, c) => s + c.empleadosActivos, 0);
  const totNetoMes = rows.reduce((s, c) => s + c.netoDelMes, 0);
  const conPendientes = rows.filter((c) => estadoDe(c).label !== "Al corriente" && c.empleadosActivos > 0).length;

  return (
    <div className="mx-auto max-w-[1100px] px-6 py-7">
      <Link href="/nomina" className="inline-flex items-center gap-1 text-[13px] text-cos-ink-faint hover:text-cos-brand-ink">
        <ChevronLeft className="h-4 w-4" /> Nómina
      </Link>
      <div className="mt-1 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[24px] font-bold tracking-[-0.02em] text-cos-ink">Cockpit de nómina</h1>
          <p className="mt-0.5 text-[14px] text-cos-ink-soft">
            Todas tus empresas en un panel — corre, timbra y detecta pendientes sin cambiar de contexto.
          </p>
        </div>
        <div className="flex gap-5 text-[13px] text-cos-ink-soft">
          <span className="inline-flex items-center gap-1.5"><Building2 className="h-4 w-4 text-cos-ink-faint" /> <b className="font-mono">{rows.length}</b> empresas</span>
          <span className="inline-flex items-center gap-1.5"><Users2 className="h-4 w-4 text-cos-ink-faint" /> <b className="font-mono">{totEmpleados}</b> empleados</span>
          <span>Neto del mes: <b className="font-mono"><Money value={totNetoMes} /></b></span>
          {conPendientes > 0 && (
            <span className="text-cos-amber-ink"><b className="font-mono">{conPendientes}</b> con pendientes</span>
          )}
        </div>
      </div>

      <div className="mt-5 overflow-hidden rounded-card border border-cos-line bg-cos-card shadow-card">
        <table className="w-full text-sm">
          <thead className="bg-cos-paper text-[12px] uppercase tracking-[0.02em] text-cos-ink-faint">
            <tr>
              <th className="px-4 py-2.5 text-left font-medium">Empresa</th>
              <th className="px-3 py-2.5 text-right font-medium">Empleados</th>
              <th className="px-3 py-2.5 text-right font-medium">Neto del mes</th>
              <th className="px-3 py-2.5 text-left font-medium">Última corrida</th>
              <th className="px-3 py-2.5 text-left font-medium">Estado</th>
              <th className="px-3 py-2.5"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const est = estadoDe(c);
              const Icon = est.icon;
              return (
                <tr key={c.id} className="border-t border-cos-line hover:bg-cos-paper/60">
                  <td className="px-4 py-3">
                    <p className="font-medium text-cos-ink">{c.razonSocial}</p>
                    <p className="font-mono text-[11px] text-cos-ink-faint">{c.rfc}</p>
                  </td>
                  <td className="px-3 py-3 text-right">
                    <span className="font-mono">{c.empleadosActivos}</span>
                    {c.bajoMinimo > 0 && (
                      <p className="text-[11px] text-cos-amber-ink" title={`Salario diario menor a ${formatCurrency(data?.salarioMinimoGeneral ?? 0)}`}>
                        ⚠ {c.bajoMinimo} bajo mínimo
                      </p>
                    )}
                  </td>
                  <td className="px-3 py-3 text-right font-mono">
                    {c.netoDelMes > 0 ? formatCurrency(c.netoDelMes) : <span className="text-cos-ink-faint">—</span>}
                    {c.corridasDelMes > 1 && <p className="text-[11px] text-cos-ink-faint">{c.corridasDelMes} corridas</p>}
                  </td>
                  <td className="px-3 py-3">
                    {c.ultimaCorrida ? (
                      <>
                        <p className="text-[13px] text-cos-ink">
                          {TIPO_RUN_LABEL[c.ultimaCorrida.tipo] ?? c.ultimaCorrida.tipo} · <Money value={c.ultimaCorrida.totalNeto} />
                        </p>
                        <p className="text-[11px] text-cos-ink-faint">pago {formatDate(c.ultimaCorrida.fechaPago)}</p>
                      </>
                    ) : (
                      <span className="text-[13px] text-cos-ink-faint">Sin corridas</span>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-medium ${est.cls}`}>
                      <Icon className="h-3.5 w-3.5" /> {est.label}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-right">
                    <button
                      onClick={() => operar(c, "/nomina/detalle")}
                      className="inline-flex items-center gap-1 rounded-control bg-cos-brand px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-cos-brand-deep"
                    >
                      Operar <ChevronR className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-[13.5px] text-cos-ink-faint">
                  Sin empresas accesibles.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-[12px] text-cos-ink-faint">
        "Al corriente" = corrida del mes registrada y todo timbrado. "Operar" cambia la empresa activa y abre su workspace.
      </p>
    </div>
  );
}
