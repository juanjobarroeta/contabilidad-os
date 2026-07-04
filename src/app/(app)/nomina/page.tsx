"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Nómina — vista amigable (patrón "dos profundidades": el workspace power-user
// con roster, corridas, incidencias y modales vive en /nomina/detalle).
// Esta vista responde lo que el dueño/contador quiere saber de un vistazo:
// ¿cuánta gente, cuánto cuesta la nómina, ya se corrió/timbró la del periodo,
// y hay algo mal (salarios bajo el mínimo)?
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Users2, Play, ChevronRight as ChevronR, SlidersHorizontal, AlertTriangle,
  CalendarDays, BadgeCheck, Clock4,
} from "lucide-react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { Card, Money, Loading } from "@/components/ui";
import ValidacionCalculo from "./ValidacionCalculo";
import { Building2 } from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/utils";
// Server constant — en cliente aplica el default (el override por env sólo
// vive en el servidor; la validación dura del run se hace server-side).
import { SALARIO_MINIMO_GENERAL } from "@/lib/nomina/constants";

interface Employee {
  id: string;
  nombre: string;
  apellidoPaterno: string;
  rfc: string;
  salarioDiario: number;
  periodicidadPago: string;
  isActive: boolean;
}

interface PayrollRun {
  id: string;
  periodo: string;
  fechaPago: string;
  tipo: string;
  status: string;
  totalPercepciones: number;
  totalDeducciones: number;
  totalNeto: number;
  /** "APP" = creada en la app; "SAT" = importada del histórico timbrado. */
  origen?: string;
  createdAt: string;
  _count?: { items: number };
}

const TIPO_RUN_LABEL: Record<string, string> = {
  ORDINARIA: "Ordinaria",
  EXTRAORDINARIA: "Extraordinaria",
  FINIQUITO: "Finiquito",
  AGUINALDO: "Aguinaldo",
  VACACIONES: "Vacaciones",
  PTU: "PTU",
};

const STATUS_RUN_LABEL: Record<string, string> = {
  DRAFT: "Borrador",
  CALCULATED: "Calculada",
  STAMPED: "Timbrada",
  PAID: "Pagada",
};

const MONTHS = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];

export default function NominaPage() {
  const { activeCompany, companies } = useCompany();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [runs, setRuns] = useState<PayrollRun[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!activeCompany) return;
    setLoading(true);
    try {
      const [empRes, runRes] = await Promise.all([
        fetch(`/api/empleados?companyId=${activeCompany.id}`),
        fetch(`/api/nomina/run?companyId=${activeCompany.id}`),
      ]);
      if (empRes.ok) {
        const data = await empRes.json();
        setEmployees(Array.isArray(data) ? data : data.employees ?? []);
      }
      if (runRes.ok) {
        const data = await runRes.json();
        setRuns(Array.isArray(data) ? data : data.runs ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, [activeCompany]);

  useEffect(() => { load(); }, [load]);

  if (!activeCompany) return <Loading />;

  const activos = employees.filter((e) => e.isActive);
  const masaDiaria = activos.reduce((s, e) => s + e.salarioDiario, 0);
  // Costo mensual aproximado (sueldos brutos; sin carga patronal): masa diaria × 30.4
  const costoMensualAprox = masaDiaria * 30.4;
  const bajoMinimo = activos.filter((e) => e.salarioDiario < SALARIO_MINIMO_GENERAL);

  const now = new Date();
  const mesActual = `${MONTHS[now.getMonth()]} ${now.getFullYear()}`;
  const lastRun = runs[0] ?? null; // API ordena desc por creación

  // Onboarding: historial reconstruido desde los CFDIs timbrados del SAT. El
  // aviso se muestra mientras la empresa aún no crea corridas propias — al
  // correr su primera nómina en la app, desaparece solo.
  const runsSat = runs.filter((r) => r.origen === "SAT");
  const soloHistorialSat = runsSat.length > 0 && runsSat.length === runs.length;
  const recibosImportados = runsSat.reduce((s, r) => s + (r._count?.items ?? 0), 0);
  const runsDelMes = runs.filter((r) => {
    const f = new Date(r.fechaPago);
    return f.getFullYear() === now.getFullYear() && f.getMonth() === now.getMonth();
  });
  const netoDelMes = runsDelMes.reduce((s, r) => s + (r.totalNeto ?? 0), 0);
  const ordinariaDelMes = runsDelMes.find((r) => r.tipo === "ORDINARIA");

  return (
    <div className="mx-auto max-w-[1000px] px-6 py-7">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[24px] font-bold tracking-[-0.02em] text-cos-ink">Nómina</h1>
          <p className="mt-0.5 text-[14px] text-cos-ink-soft">Tu equipo, lo que cuesta y si ya está pagado y timbrado.</p>
        </div>
        <Link
          href="/nomina/detalle"
          className="inline-flex items-center gap-1.5 rounded-control bg-cos-brand px-4 py-2.5 text-[14px] font-semibold text-white hover:bg-cos-brand-deep"
        >
          <Play className="h-4 w-4" /> Correr nómina
        </Link>
      </div>

      {loading ? (
        <Loading />
      ) : (
        <div className="mt-4 space-y-5">
          {/* banner — nómina del mes */}
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-card bg-gradient-to-br from-cos-brand to-cos-brand-deep px-6 py-6 text-white shadow-[0_16px_36px_-20px_var(--brand)]">
            <div>
              <span className="block text-[12.5px] font-medium uppercase tracking-[0.02em] text-white/75">Nómina pagada en {mesActual}</span>
              <div className="my-1.5"><Money value={netoDelMes} size={42} weight={700} className="text-white" /></div>
              <span className="inline-flex items-center gap-1.5 text-[13.5px] text-white/85">
                <CalendarDays className="h-[15px] w-[15px]" />
                {runsDelMes.length > 0
                  ? `${runsDelMes.length} corrida${runsDelMes.length > 1 ? "s" : ""} este mes`
                  : ordinariaDelMes
                  ? "Ordinaria registrada"
                  : "Aún no corres la nómina de este mes"}
              </span>
            </div>
            <Link href="/nomina/detalle" className="inline-flex items-center gap-1.5 rounded-control bg-cos-card px-4 py-2.5 text-[14px] font-semibold text-cos-brand-ink hover:bg-cos-brand-tint">
              Ver corridas <ChevronR className="h-[15px] w-[15px]" />
            </Link>
          </div>

          {/* onboarding: historial importado del SAT */}
          {soloHistorialSat && (
            <div className="flex items-start gap-3 rounded-card border border-cos-line bg-cos-card px-5 py-4">
              <BadgeCheck className="mt-0.5 h-[18px] w-[18px] flex-none text-cos-jade-ink" />
              <div className="text-[13.5px] leading-relaxed text-cos-ink-soft">
                <b className="text-cos-ink">Encontramos {recibosImportados} recibo{recibosImportados === 1 ? "" : "s"} de nómina timbrado{recibosImportados === 1 ? "" : "s"} en el SAT</b> — tu historial se importó automáticamente
                ({runsSat.length} corrida{runsSat.length === 1 ? "" : "s"}).
                {" "}Para correr tu siguiente nómina, usa <Link href="/nomina/detalle" className="font-semibold text-cos-brand-ink hover:underline">Iniciar desde la quincena anterior</Link> en el workspace.
              </div>
            </div>
          )}

          {/* nómina en paralelo: recalculamos el histórico timbrado con nuestras tablas */}
          {runsSat.length > 0 && <ValidacionCalculo companyId={activeCompany.id} />}

          {/* alerta: salarios bajo el mínimo */}
          {bajoMinimo.length > 0 && (
            <div className="flex items-start gap-3 rounded-card border border-cos-amber bg-cos-amber-tint px-5 py-4">
              <AlertTriangle className="mt-0.5 h-[18px] w-[18px] flex-none text-cos-amber-ink" />
              <div className="text-[13.5px] leading-relaxed text-cos-amber-ink">
                <b>{bajoMinimo.length} empleado{bajoMinimo.length > 1 ? "s" : ""} con salario diario por debajo del mínimo general 2026 (<Money value={SALARIO_MINIMO_GENERAL} />)</b>
                {" — "}
                {bajoMinimo.slice(0, 3).map((e) => `${e.nombre} ${e.apellidoPaterno} (${formatCurrency(e.salarioDiario)})`).join(", ")}
                {bajoMinimo.length > 3 ? ` y ${bajoMinimo.length - 3} más` : ""}.
                {" "}Corrige el salario en el roster antes de correr la nómina.
              </div>
            </div>
          )}

          {/* cards: equipo + última corrida */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card className="rounded-card border-cos-line p-5 shadow-card">
              <div className="mb-2.5 flex items-center justify-between">
                <span className="rounded-full bg-cos-brand-tint px-2.5 py-1 text-[13px] font-semibold text-cos-brand-ink">Equipo</span>
                <span className="inline-flex items-center gap-1.5 font-mono text-[22px] font-bold text-cos-ink">
                  <Users2 className="h-5 w-5 text-cos-ink-faint" /> {activos.length}
                </span>
              </div>
              <p className="mb-3.5 text-[13.5px] leading-relaxed text-cos-ink-soft">
                Empleados activos en {activeCompany.razonSocial}.
              </p>
              <FriendlyRow label="Masa salarial (diaria)" value={masaDiaria} />
              <FriendlyRow label="Costo mensual aprox. (sueldos brutos)" value={costoMensualAprox} />
              <p className="mt-2 text-[12px] text-cos-ink-faint">Sin carga patronal (IMSS patronal, INFONAVIT) — el detalle por corrida está en el workspace.</p>
            </Card>

            <Card className="rounded-card border-cos-line p-5 shadow-card">
              <div className="mb-2.5 flex items-center justify-between">
                <span className="rounded-full bg-cos-brand-tint px-2.5 py-1 text-[13px] font-semibold text-cos-brand-ink">Última corrida</span>
                {lastRun ? (
                  lastRun.status === "STAMPED" || lastRun.status === "PAID" ? (
                    <span className="inline-flex items-center gap-1 text-[13px] font-semibold text-cos-jade-ink"><BadgeCheck className="h-4 w-4" /> {STATUS_RUN_LABEL[lastRun.status]}</span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-[13px] font-semibold text-cos-amber-ink"><Clock4 className="h-4 w-4" /> {STATUS_RUN_LABEL[lastRun.status] ?? lastRun.status}</span>
                  )
                ) : null}
              </div>
              {lastRun ? (
                <>
                  <p className="mb-3.5 text-[13.5px] leading-relaxed text-cos-ink-soft">
                    {TIPO_RUN_LABEL[lastRun.tipo] ?? lastRun.tipo} · periodo {lastRun.periodo} · pago {formatDate(lastRun.fechaPago)}
                    {lastRun._count ? ` · ${lastRun._count.items} recibo${lastRun._count.items === 1 ? "" : "s"}` : ""}
                  </p>
                  <FriendlyRow label="Percepciones" value={lastRun.totalPercepciones} />
                  <FriendlyRow label="Deducciones (ISR, IMSS, INFONAVIT)" value={-lastRun.totalDeducciones} negative />
                  <FriendlyRow label="Neto pagado" value={lastRun.totalNeto} total />
                  {lastRun.status === "CALCULATED" && (
                    <p className="mt-2 text-[12px] text-cos-amber-ink">Calculada pero sin timbrar — timbra los recibos en el workspace.</p>
                  )}
                </>
              ) : (
                <p className="text-[13.5px] leading-relaxed text-cos-ink-soft">
                  Aún no hay corridas. Da de alta a tu equipo y corre la primera nómina desde el workspace.
                </p>
              )}
            </Card>
          </div>

          {/* recordatorio enteramiento */}
          <div className="flex items-start gap-3 rounded-card border border-cos-line bg-cos-card px-5 py-4 text-[13.5px] leading-relaxed text-cos-ink-soft">
            <CalendarDays className="mt-0.5 h-[18px] w-[18px] flex-none text-cos-ink-faint" />
            <span>
              El <b>ISR retenido</b> a los trabajadores se entera al SAT junto con la declaración del mes (vence el día 17).
              El monto y su estado viven en <Link href="/impuestos?tab=del-mes" className="font-semibold text-cos-brand-ink hover:underline">Impuestos</Link>.
            </span>
          </div>

          {/* multi-RFC cockpit (despacho) */}
          {companies.length > 1 && (
            <Link href="/nomina/cockpit" className="flex items-center gap-3 rounded-card border border-cos-line bg-cos-card px-5 py-4 text-[14px] text-cos-ink-soft hover:border-cos-brand hover:text-cos-brand-ink">
              <Building2 className="h-[18px] w-[18px] flex-none" />
              <span className="flex-1">
                <b className="text-cos-ink">Cockpit multi-RFC</b> — la nómina de tus {companies.length} empresas en un solo panel
              </span>
              <ChevronR className="h-4 w-4 flex-none" />
            </Link>
          )}

          {/* expert depth: link to workspace */}
          <Link href="/nomina/detalle" className="flex items-center gap-3 rounded-card border border-dashed border-cos-line bg-cos-card px-5 py-4 text-[14px] text-cos-ink-soft hover:border-cos-brand hover:text-cos-brand-ink">
            <SlidersHorizontal className="h-[18px] w-[18px] flex-none" />
            <span className="flex-1">Workspace de nómina — roster, corridas, incidencias, finiquitos, IMSS/SUA</span>
            <ChevronR className="h-4 w-4 flex-none" />
          </Link>
        </div>
      )}
    </div>
  );
}

function FriendlyRow({ label, value, total, negative }: { label: string; value: number; total?: boolean; negative?: boolean }) {
  return (
    <div className={`flex items-center justify-between py-1 ${total ? "mt-1 border-t border-cos-line pt-2" : ""}`}>
      <span className={`text-[13.5px] ${total ? "font-semibold text-cos-ink" : "text-cos-ink-soft"}`}>{label}</span>
      <span className={`font-mono text-[14px] ${total ? "font-bold text-cos-ink" : negative ? "text-cos-red-ink" : "text-cos-ink"}`}>
        {negative && value !== 0 ? "−" : ""}{formatCurrency(Math.abs(value))}
      </span>
    </div>
  );
}
