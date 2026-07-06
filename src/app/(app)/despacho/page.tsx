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
  ChevronRight as ChevronR, CalendarDays, Database, ScanSearch, ShieldAlert,
  Check, CircleAlert, Landmark, BookCheck, Sparkles,
} from "lucide-react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { Card, Loading, Money } from "@/components/ui";
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
  flagsAbiertos: number;
  hallazgosAbiertos: number;
  peorSeveridad: "error" | "warn" | "info" | null;
  // Diligencia (mantenimiento del contador AI, sólo lectura)
  cfdisAlDia: boolean;
  bancoSinConciliar: number;
  libroMesPosteado: boolean;
}

// Prioridad de cartera: empresas con hallazgos "error" primero, luego "warn",
// luego por conteo. Empata con 0 para conservar el orden existente (por razón
// social) vía sort estable.
const SEV_RANK: Record<"error" | "warn" | "info", number> = { error: 3, warn: 2, info: 1 };
function severityWeight(r: Row): number {
  return r.hallazgosAbiertos > 0 && r.peorSeveridad ? SEV_RANK[r.peorSeveridad] : 0;
}

// Deep-link al hub de Impuestos (pestaña "Del mes" = workspace de la declaración
// del mes) para un periodo ("YYYY-MM"), opcionalmente abriendo una sub-pestaña
// del workspace (presentar / revision).
function declHref(periodo: string, tab?: "presentar" | "revision"): string {
  const [y, m] = periodo.split("-");
  return `/impuestos?month=${parseInt(m)}&year=${parseInt(y)}${tab ? `&tab=${tab}` : ""}`;
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

// Diligencia: mini-checklist de mantenimiento por empresa (sólo lectura).
// Refleja lo que el contador AI mantiene al día — derivado de estado existente,
// sin acciones destructivas ni recálculos. Verde = en orden, ámbar = por revisar.
function DiligChip({ ok, icon: Icon, label, title }: {
  ok: boolean; icon: typeof Check; label: string; title?: string;
}) {
  return (
    <span
      title={title ?? label}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
        ok ? "bg-cos-jade-tint text-cos-jade-ink" : "bg-cos-amber-tint text-cos-amber-ink"
      }`}
    >
      <Icon className="h-3 w-3" /> {label}
      {ok ? <Check className="h-3 w-3" /> : <CircleAlert className="h-3 w-3" />}
    </span>
  );
}

function DiligenciaChips({ r }: { r: Row }) {
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      <DiligChip
        ok={r.cfdisAlDia}
        icon={Database}
        label={r.cfdisAlDia ? "CFDIs al día" : "CFDIs por sincronizar"}
        title="Frescura de la última sincronización con el SAT"
      />
      <DiligChip
        ok={r.bancoSinConciliar === 0}
        icon={Landmark}
        label={r.bancoSinConciliar === 0 ? "Banco conciliado" : `Banco: ${r.bancoSinConciliar} sin conciliar`}
        title="Movimientos bancarios pendientes de conciliar"
      />
      <DiligChip
        ok={r.libroMesPosteado}
        icon={BookCheck}
        label={r.libroMesPosteado ? "Libro posteado" : "Libro preliminar"}
        title="Estado de la póliza contable del periodo a declarar"
      />
      <DiligChip
        ok={r.hallazgosAbiertos === 0}
        icon={ShieldAlert}
        label={r.hallazgosAbiertos === 0 ? "Sin hallazgos" : `${r.hallazgosAbiertos} hallazgo${r.hallazgosAbiertos === 1 ? "" : "s"}`}
        title="Hallazgos abiertos del auditor"
      />
    </div>
  );
}

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
  // Orden de triage: lo más en riesgo arriba (error → warn → conteo desc),
  // y a igualdad de hallazgos se conserva el orden del servidor (estable).
  const rows = [...(data?.companies ?? [])].sort((a, b) => {
    const wa = severityWeight(a), wb = severityWeight(b);
    if (wa !== wb) return wb - wa;
    return b.hallazgosAbiertos - a.hallazgosAbiertos;
  });

  // "Lo más urgente": la empresa de mayor prioridad con hallazgos abiertos.
  const urgente = rows.find((r) => r.hallazgosAbiertos > 0) ?? null;

  // Briefing "Hoy": resumen del trabajo nocturno del auditor sobre la cartera.
  const total = data?.resumen.empresas ?? 0;
  const necesitaAtencion = (r: Row) =>
    r.hallazgosAbiertos > 0 || r.obligacionesVencidas > 0 || r.estadoDeclaracion === "vencida";
  const atencion = rows.filter(necesitaAtencion).length;
  const alDia = Math.max(0, total - atencion);
  const conErrores = rows.filter((r) => r.peorSeveridad === "error").length;
  const conHallazgos = rows.filter((r) => r.hallazgosAbiertos > 0).length;
  const conVencidas = data?.resumen.empresasConVencidas ?? 0;
  const ahora = new Date();
  const saludo = ahora.getHours() < 12 ? "Buenos días" : ahora.getHours() < 19 ? "Buenas tardes" : "Buenas noches";
  const fechaLarga = ahora.toLocaleDateString("es-MX", { weekday: "long", day: "numeric", month: "long" });

  return (
    <div className="mx-auto max-w-[1140px] px-6 py-7">
      {/* Briefing "Hoy" — el resumen de la revisión nocturna del auditor. */}
      <div className="rounded-card border border-cos-line bg-cos-card p-5 shadow-card">
        <p className="text-[12.5px] font-medium text-cos-ink-faint">
          {saludo} · <span className="capitalize">{fechaLarga}</span>
        </p>
        <h1 className="mt-1 text-[22px] font-semibold leading-tight tracking-[-0.02em] text-cos-ink">
          {!data ? (
            "Despacho"
          ) : atencion > 0 ? (
            <>Revisé tus <span className="font-mono">{total}</span> empresas anoche — <span className="text-cos-amber-ink">{atencion} {atencion === 1 ? "necesita" : "necesitan"} tu atención</span> hoy.</>
          ) : total > 0 ? (
            <>Revisé tus <span className="font-mono">{total}</span> empresas anoche — <span className="text-cos-jade-ink">toda tu cartera al día</span>.</>
          ) : (
            "Despacho"
          )}
        </h1>
        {data && (
          <div className="mt-2.5 flex flex-wrap items-center gap-2 text-[12.5px]">
            {conErrores > 0 && <span className="rounded-full bg-cos-red-tint px-2.5 py-1 font-medium text-cos-red-ink">{conErrores} con algo crítico</span>}
            {conVencidas > 0 && <span className="rounded-full bg-cos-red-tint px-2.5 py-1 font-medium text-cos-red-ink">{conVencidas} con obligaciones vencidas</span>}
            {conHallazgos > 0 && <span className="rounded-full bg-cos-amber-tint px-2.5 py-1 font-medium text-cos-amber-ink">{conHallazgos} con hallazgos por revisar</span>}
            <span className="rounded-full bg-cos-jade-tint px-2.5 py-1 font-medium text-cos-jade-ink">{alDia} al día</span>
            <span className="ml-auto text-cos-ink-soft">
              Periodo <b>{data.periodo}</b> · vence {formatDate(data.vencimiento)} · a pagar{" "}
              <b className="font-mono"><Money value={data.resumen.totalAPagar} /></b>
            </span>
          </div>
        )}
      </div>

      {/* Lo más urgente — la empresa con la peor cartera de hallazgos abiertos */}
      {urgente && (
        <Card className={`mt-4 flex items-center gap-3 px-4 py-3.5 ${
          urgente.peorSeveridad === "error" ? "border-cos-red bg-cos-red-tint"
          : urgente.peorSeveridad === "warn" ? "border-cos-amber bg-cos-amber-tint"
          : "border-cos-jade bg-cos-jade-tint"
        }`}>
          <ShieldAlert className={`h-5 w-5 flex-none ${
            urgente.peorSeveridad === "error" ? "text-cos-red-ink"
            : urgente.peorSeveridad === "warn" ? "text-cos-amber-ink"
            : "text-cos-jade-ink"
          }`} />
          <div className="flex-1 min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.04em] text-cos-ink-faint">Lo más urgente</p>
            <p className="truncate text-[14px] font-medium text-cos-ink">
              <b>{urgente.razonSocial}</b> — {urgente.hallazgosAbiertos} hallazgo{urgente.hallazgosAbiertos === 1 ? "" : "s"} abierto{urgente.hallazgosAbiertos === 1 ? "" : "s"}
              {urgente.peorSeveridad === "error" ? " (errores por resolver)"
                : urgente.peorSeveridad === "warn" ? " (advertencias por revisar)"
                : ""}.
            </p>
          </div>
          <button
            onClick={() => operar(urgente.id, "/hallazgos")}
            className="inline-flex flex-none items-center gap-1 rounded-control bg-cos-brand px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-cos-brand-deep"
          >
            Ver hallazgos <ChevronR className="h-3.5 w-3.5" />
          </button>
        </Card>
      )}

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
        <Link href="/impuestos?tab=historial" className="mt-3 flex items-center gap-2.5 rounded-card border border-cos-amber bg-cos-amber-tint px-4 py-3 text-[13px] text-cos-amber-ink hover:opacity-90">
          <FileWarning className="h-4 w-4 flex-none" />
          <span className="flex-1">
            Faltan <b>{declFaltan.total} acuse(s)</b> en <b>{declFaltan.empresas} empresa(s)</b> — súbelos para calcular saldos a favor, coeficiente y pagos provisionales.
          </span>
          <ChevronR className="h-4 w-4 flex-none" />
        </Link>
      )}

      {/* Diligencia: refuerza que el mantenimiento corre solo, por empresa. */}
      <div className="mt-5 flex items-center gap-2 text-[12.5px] text-cos-ink-soft">
        <Sparkles className="h-3.5 w-3.5 flex-none text-cos-brand-ink" />
        <span>Tu contador AI mantiene esto al día: CFDIs sincronizados, banco conciliado y libros posteados — revisa la diligencia de cada empresa abajo.</span>
      </div>

      <div className="mt-2 overflow-hidden rounded-card border border-cos-line bg-cos-card shadow-card">
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
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      {r.obligacionesVencidas > 0 && (
                        <button
                          onClick={() => operar(r.id, "/cumplimiento")}
                          className="inline-flex items-center gap-1 rounded-full bg-cos-red-tint px-2 py-0.5 text-[11px] font-medium text-cos-red-ink hover:opacity-90"
                        >
                          <AlertTriangle className="h-3 w-3" /> {r.obligacionesVencidas} vencida{r.obligacionesVencidas === 1 ? "" : "s"}
                        </button>
                      )}
                      {r.flagsAbiertos > 0 && (
                        <button
                          onClick={() => operar(r.id, declHref(r.periodo, "revision"))}
                          className="inline-flex items-center gap-1 rounded-full bg-cos-amber-tint px-2 py-0.5 text-[11px] font-medium text-cos-amber-ink hover:opacity-90"
                          title="Banderas del auditor por revisar"
                        >
                          <ScanSearch className="h-3 w-3" /> {r.flagsAbiertos} por revisar
                        </button>
                      )}
                      {r.hallazgosAbiertos > 0 && (
                        <button
                          onClick={() => operar(r.id, "/hallazgos")}
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium hover:opacity-90 ${
                            r.peorSeveridad === "error" ? "bg-cos-red-tint text-cos-red-ink"
                            : r.peorSeveridad === "warn" ? "bg-cos-amber-tint text-cos-amber-ink"
                            : "bg-cos-jade-tint text-cos-jade-ink"
                          }`}
                          title="Hallazgos abiertos del auditor"
                        >
                          <ShieldAlert className="h-3 w-3" /> {r.hallazgosAbiertos} hallazgo{r.hallazgosAbiertos === 1 ? "" : "s"}
                        </button>
                      )}
                    </div>
                    <DiligenciaChips r={r} />
                  </td>
                  <td className="px-3 py-3">
                    <button
                      onClick={() => operar(r.id, declHref(r.periodo, "presentar"))}
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
                      <button onClick={() => operar(r.id, "/nomina?tab=corridas")} className="inline-flex items-center gap-1 text-[12px] font-medium text-cos-amber-ink">
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
                      onClick={() => operar(r.id, declHref(r.periodo))}
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
          Tablero de nómina <ChevronR className="h-3.5 w-3.5" />
        </Link>
      </div>
    </div>
  );
}
