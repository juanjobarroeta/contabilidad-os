"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Pestaña Resumen del hub de Nómina — la vista amigable que antes era /nomina.
// Responde lo que el dueño/contador quiere saber de un vistazo: ¿cuánta gente,
// cuánto cuesta la nómina, ya se corrió/timbró la del periodo, y hay algo mal
// (salarios bajo el mínimo)? Los enlaces profundos ahora cambian de pestaña
// dentro del hub (onTab) en lugar de navegar a /nomina/detalle.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Users2, Play, ChevronRight as ChevronR, AlertTriangle,
  CalendarDays, BadgeCheck, Clock4, Receipt, FileText, Ban, Loader2, X,
} from "lucide-react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { Alert, Card, Money, Loading, RetryButton } from "@/components/ui";
import { RepresentacionImpresa } from "@/components/facturas/RepresentacionImpresa";
import ValidacionCalculo from "./ValidacionCalculo";
import ImssPagosCard from "./ImssPagosCard";
import { formatCurrency, formatDate } from "@/lib/utils";
// Server constant — en cliente aplica el default (el override por env sólo
// vive en el servidor; la validación dura del run se hace server-side).
import { SALARIO_MINIMO_GENERAL } from "@/lib/nomina/constants";
import { TIPO_RUN_LABEL, STATUS_RUN_LABEL } from "./workspace-shared";

interface Employee {
  id: string;
  nombre: string;
  apellidoPaterno: string;
  rfc: string;
  salarioDiario: number;
  periodicidadPago: string;
  isActive: boolean;
  ultimoRecibo?: { fechaPago: string; periodo: string; origen: string } | null;
}

/** GET /api/nomina/hub — recibos recientes + desglose del mes. */
interface HubData {
  recientes: {
    id: string;
    empleado: string;
    rfc: string;
    periodo: string;
    fechaPago: string;
    tipo: string;
    origen: string;
    neto: number;
    cfdiUuid: string | null;
    invoiceId: string | null;
    pdfDisponible: boolean;
    xmlDisponible: boolean;
  }[];
  mes: {
    recibos: number;
    timbrados: number;
    sueldos: number;
    horasExtra: number;
    bonosComisiones: number;
    valesOtras: number;
    especiales: number;
    isr: number;
    imssObrero: number;
    infonavit: number;
    otrasDeducciones: number;
    imssPatronal: number;
    totalPercepciones: number;
    totalDeducciones: number;
    neto: number;
  };
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

const MONTHS = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];

export default function ResumenTab({ onTab }: { onTab: (t: "corridas" | "empleados" | "cumplimiento") => void }) {
  const { activeCompany } = useCompany();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [runs, setRuns] = useState<PayrollRun[]>([]);
  const [hub, setHub] = useState<HubData | null>(null);
  const [loading, setLoading] = useState(true);
  // Error de carga. Si CUALQUIERA de los tres fetches falla, el resumen entero
  // sería mentira (hero de $0.00, equipo vacío) — mejor error + reintentar.
  const [loadError, setLoadError] = useState(false);

  // Cancelación de un timbre de nómina: modal con motivo SAT. Tras cancelar,
  // el empleado queda listo para retimbrar (la corrida vuelve a CALCULATED).
  const [cancelRecibo, setCancelRecibo] = useState<HubData["recientes"][number] | null>(null);
  const [cancelMotivo, setCancelMotivo] = useState("02");
  const [cancelSustituye, setCancelSustituye] = useState("");
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelErr, setCancelErr] = useState("");
  const [cancelOkMsg, setCancelOkMsg] = useState("");
  // Representación impresa (imprimir / guardar PDF — también recibos importados).
  const [repInvoiceId, setRepInvoiceId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!activeCompany) return;
    setLoading(true);
    setLoadError(false);
    try {
      const [empRes, runRes, hubRes] = await Promise.all([
        fetch(`/api/empleados?companyId=${activeCompany.id}&withUltimoRecibo=1`),
        fetch(`/api/nomina/run?companyId=${activeCompany.id}`),
        fetch(`/api/nomina/hub?companyId=${activeCompany.id}`),
      ]);
      if (!empRes.ok || !runRes.ok || !hubRes.ok) throw new Error("hub fetch failed");
      const empData = await empRes.json();
      setEmployees(Array.isArray(empData) ? empData : empData.employees ?? []);
      const runData = await runRes.json();
      setRuns(Array.isArray(runData) ? runData : runData.runs ?? []);
      setHub(await hubRes.json());
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [activeCompany]);

  useEffect(() => { load(); }, [load]);

  async function doCancelTimbre() {
    if (!activeCompany || !cancelRecibo) return;
    setCancelBusy(true);
    setCancelErr("");
    try {
      const res = await fetch("/api/nomina/recibos/cancelar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: activeCompany.id,
          payrollItemId: cancelRecibo.id,
          motivo: cancelMotivo,
          ...(cancelMotivo === "01" ? { sustituyeUuid: cancelSustituye.trim() } : {}),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "No se pudo cancelar el recibo");
      setCancelOkMsg(
        `Recibo de ${data.empleado} cancelado ante el SAT. El empleado quedó listo para retimbrar: corrige sus datos si hace falta, recalcula la corrida y vuelve a timbrar.`
      );
      setCancelRecibo(null);
      setCancelSustituye("");
      setCancelMotivo("02");
      load();
    } catch (e) {
      setCancelErr(e instanceof Error ? e.message : "No se pudo cancelar el recibo");
    } finally {
      setCancelBusy(false);
    }
  }

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
        <button
          onClick={() => onTab("corridas")}
          className="inline-flex items-center gap-1.5 rounded-control bg-cos-brand px-4 py-2.5 text-[14px] font-semibold text-white hover:bg-cos-brand-deep"
        >
          <Play className="h-4 w-4" /> Correr nómina
        </button>
      </div>

      {loading ? (
        <Loading />
      ) : loadError ? (
        /* Fetch fallido → error con reintento, NUNCA el hero en $0.00. */
        <Alert tone="danger" className="mt-4" action={<RetryButton onClick={load} />}>
          No se pudo cargar el resumen de nómina. Vuelve a intentarlo; si persiste, avísanos.
        </Alert>
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
            <button onClick={() => onTab("corridas")} className="inline-flex items-center gap-1.5 rounded-control bg-cos-card px-4 py-2.5 text-[14px] font-semibold text-cos-brand-ink hover:bg-cos-brand-tint">
              Ver corridas <ChevronR className="h-[15px] w-[15px]" />
            </button>
          </div>

          {/* onboarding: historial importado del SAT */}
          {soloHistorialSat && (
            <div className="flex items-start gap-3 rounded-card border border-cos-line bg-cos-card px-5 py-4">
              <BadgeCheck className="mt-0.5 h-[18px] w-[18px] flex-none text-cos-jade-ink" />
              <div className="text-[13.5px] leading-relaxed text-cos-ink-soft">
                <b className="text-cos-ink">Encontramos {recibosImportados} recibo{recibosImportados === 1 ? "" : "s"} de nómina timbrado{recibosImportados === 1 ? "" : "s"} en el SAT</b> — tu historial se importó automáticamente
                ({runsSat.length} corrida{runsSat.length === 1 ? "" : "s"}).
                {" "}Para correr tu siguiente nómina, usa <button onClick={() => onTab("corridas")} className="font-semibold text-cos-brand-ink hover:underline">Iniciar desde la quincena anterior</button> en la pestaña Corridas.
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
                {" "}Corrige el salario en la pestaña <button onClick={() => onTab("empleados")} className="font-semibold underline">Empleados</button> antes de correr la nómina.
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
              {/* mini-roster: los primeros del equipo con su último recibo */}
              {activos.length > 0 && (
                <div className="mt-3 border-t border-cos-line pt-2">
                  {activos.slice(0, 5).map((e) => (
                    <div key={e.id} className="flex items-center justify-between gap-2 py-1 text-[12.5px]">
                      <span className="min-w-0 truncate text-cos-ink">{e.nombre} {e.apellidoPaterno}</span>
                      <span className="flex flex-none items-center gap-2.5">
                        <span className="font-mono text-cos-ink-soft">{formatCurrency(e.salarioDiario)}/día</span>
                        <span className="text-[11.5px] text-cos-ink-faint" title={e.ultimoRecibo ? `Último recibo · ${e.ultimoRecibo.periodo}` : "Sin recibos"}>
                          {e.ultimoRecibo ? formatDate(e.ultimoRecibo.fechaPago) : "sin recibos"}
                        </span>
                      </span>
                    </div>
                  ))}
                  {activos.length > 5 && (
                    <button onClick={() => onTab("empleados")} className="mt-1 text-[12px] font-medium text-cos-brand-ink hover:underline">
                      Ver a los {activos.length} en Empleados →
                    </button>
                  )}
                </div>
              )}
              <p className="mt-2 text-[12px] text-cos-ink-faint">
                Sin carga patronal (IMSS patronal, INFONAVIT) — el detalle por corrida está en{" "}
                <button onClick={() => onTab("corridas")} className="font-medium text-cos-brand-ink hover:underline">Corridas</button>; el roster completo, en{" "}
                <button onClick={() => onTab("empleados")} className="font-medium text-cos-brand-ink hover:underline">Empleados</button>.
              </p>
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
                    <p className="mt-2 text-[12px] text-cos-amber-ink">
                      Calculada pero sin timbrar — <button onClick={() => onTab("corridas")} className="font-semibold underline">timbra los recibos en Corridas</button>.
                    </p>
                  )}
                </>
              ) : (
                <p className="text-[13.5px] leading-relaxed text-cos-ink-soft">
                  Aún no hay corridas. Da de alta a tu equipo en la pestaña Empleados y corre la primera nómina desde Corridas.
                </p>
              )}
            </Card>
          </div>

          {/* desglose del mes + últimos recibos timbrados */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card className="rounded-card border-cos-line p-5 shadow-card">
              <div className="mb-2.5 flex items-center justify-between">
                <span className="rounded-full bg-cos-brand-tint px-2.5 py-1 text-[13px] font-semibold text-cos-brand-ink">Desglose de {mesActual}</span>
                {hub && hub.mes.recibos > 0 && (
                  <span className={`inline-flex items-center gap-1 text-[13px] font-semibold ${hub.mes.timbrados === hub.mes.recibos ? "text-cos-jade-ink" : "text-cos-amber-ink"}`}>
                    <Receipt className="h-4 w-4" /> {hub.mes.timbrados}/{hub.mes.recibos} timbrados
                  </span>
                )}
              </div>
              {hub && hub.mes.recibos > 0 ? (
                <>
                  <FriendlyRow label="Sueldos" value={hub.mes.sueldos} />
                  {hub.mes.horasExtra > 0 && <FriendlyRow label="Horas extra" value={hub.mes.horasExtra} />}
                  {hub.mes.bonosComisiones > 0 && <FriendlyRow label="Bonos y comisiones" value={hub.mes.bonosComisiones} />}
                  {hub.mes.valesOtras > 0 && <FriendlyRow label="Vales y otras percepciones" value={hub.mes.valesOtras} />}
                  {hub.mes.especiales > 0 && <FriendlyRow label="Aguinaldo / prima vac. / PTU" value={hub.mes.especiales} />}
                  <FriendlyRow label="ISR retenido" value={-hub.mes.isr} negative />
                  <FriendlyRow label="IMSS obrero" value={-hub.mes.imssObrero} negative />
                  {hub.mes.infonavit > 0 && <FriendlyRow label="INFONAVIT" value={-hub.mes.infonavit} negative />}
                  {hub.mes.otrasDeducciones > 0 && <FriendlyRow label="Otras deducciones (FONACOT, pensión, descuentos)" value={-hub.mes.otrasDeducciones} negative />}
                  <FriendlyRow label="Neto pagado" value={hub.mes.neto} total />
                  <p className="mt-2 text-[12px] text-cos-ink-faint">
                    Carga patronal del mes (IMSS patronal): <b className="font-mono text-cos-ink-soft">{formatCurrency(hub.mes.imssPatronal)}</b>
                  </p>
                </>
              ) : (
                <p className="text-[13.5px] leading-relaxed text-cos-ink-soft">
                  Sin recibos con fecha de pago en {mesActual}. El desglose aparece al calcular la nómina del mes.
                </p>
              )}
            </Card>

            <Card className="rounded-card border-cos-line p-5 shadow-card">
              <div className="mb-2.5 flex items-center justify-between">
                <span className="rounded-full bg-cos-brand-tint px-2.5 py-1 text-[13px] font-semibold text-cos-brand-ink">Últimos recibos timbrados</span>
              </div>
              {hub && hub.recientes.length > 0 ? (
                <div>
                  {hub.recientes.map((r) => (
                    <div key={r.id} className="flex items-center justify-between gap-2 border-b border-cos-line py-1.5 text-[12.5px] last:border-0">
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-cos-ink">{r.empleado}</span>
                        <span className="block text-[11.5px] text-cos-ink-faint">
                          {TIPO_RUN_LABEL[r.tipo] ?? r.tipo} · pago {formatDate(r.fechaPago)}
                        </span>
                      </span>
                      <span className="flex flex-none items-center gap-2.5">
                        <span className="font-mono font-semibold text-cos-jade-ink">{formatCurrency(r.neto)}</span>
                        {r.invoiceId && r.pdfDisponible && (
                          <a href={`/api/facturas/${r.invoiceId}/download?format=pdf`}
                            className="inline-flex items-center gap-0.5 text-[11px] font-medium text-cos-brand-ink underline hover:opacity-80"
                            title="Descargar recibo en PDF">
                            <FileText className="h-3 w-3" /> PDF
                          </a>
                        )}
                        {r.invoiceId && r.xmlDisponible && (
                          <a href={`/api/facturas/${r.invoiceId}/download?format=xml`}
                            className="text-[11px] font-medium text-cos-brand-ink underline hover:opacity-80"
                            title="Descargar XML del CFDI">XML</a>
                        )}
                        {/* Representación impresa — imprime/guarda PDF también para importados */}
                        {r.invoiceId && (
                          <button onClick={() => setRepInvoiceId(r.invoiceId)}
                            className="text-[11px] font-medium text-cos-brand-ink underline hover:opacity-80"
                            title="Ver la representación impresa (imprimir / guardar PDF)">Recibo</button>
                        )}
                        {/* Cancelable sólo si lo emitimos nosotros (pdfDisponible ⇔ facturapiId) */}
                        {r.invoiceId && r.pdfDisponible && (
                          <button onClick={() => { setCancelRecibo(r); setCancelOkMsg(""); setCancelErr(""); }}
                            className="rounded p-0.5 text-cos-red-ink/70 hover:bg-cos-red-tint hover:text-cos-red-ink"
                            title="Cancelar este timbre ante el SAT">
                            <Ban className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </span>
                    </div>
                  ))}
                  <button onClick={() => onTab("corridas")} className="mt-2 text-[12px] font-medium text-cos-brand-ink hover:underline">
                    Ver todas las corridas →
                  </button>
                </div>
              ) : (
                <p className="text-[13.5px] leading-relaxed text-cos-ink-soft">
                  Aún no hay recibos timbrados. Al timbrar una corrida (o importar tu historial del SAT), aquí aparecen los últimos con su PDF y XML.
                </p>
              )}
              {cancelOkMsg && (
                <p className="mt-2 rounded-lg border border-cos-jade-ink/20 bg-cos-jade-tint px-3 py-2 text-[12.5px] text-cos-jade-ink">
                  {cancelOkMsg}
                </p>
              )}
            </Card>
          </div>

          {/* cuotas IMSS (SIPARE): estimado del periodo con vencimiento en curso + registro del pago */}
          <ImssPagosCard companyId={activeCompany.id} />

          {/* recordatorio enteramiento */}
          <div className="flex items-start gap-3 rounded-card border border-cos-line bg-cos-card px-5 py-4 text-[13.5px] leading-relaxed text-cos-ink-soft">
            <CalendarDays className="mt-0.5 h-[18px] w-[18px] flex-none text-cos-ink-faint" />
            <span>
              El <b>ISR retenido</b> a los trabajadores se entera al SAT junto con la declaración del mes (vence el día 17).
              El monto y su estado viven en <Link href="/impuestos?tab=del-mes" className="font-semibold text-cos-brand-ink hover:underline">Impuestos</Link>.
            </span>
          </div>
        </div>
      )}

      {/* representación impresa del recibo (imprimir / guardar PDF) */}
      {repInvoiceId && <RepresentacionImpresa invoiceId={repInvoiceId} onClose={() => setRepInvoiceId(null)} />}

      {/* ── Modal: cancelar timbre de nómina ── */}
      {cancelRecibo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={() => !cancelBusy && setCancelRecibo(null)}>
          <div className="w-full max-w-[440px] rounded-card border border-cos-line bg-cos-card p-5 shadow-card" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-[16px] font-bold text-cos-ink">Cancelar timbre ante el SAT</h3>
                <p className="mt-0.5 text-[13px] text-cos-ink-soft">
                  {cancelRecibo.empleado} · {TIPO_RUN_LABEL[cancelRecibo.tipo] ?? cancelRecibo.tipo} · pago {formatDate(cancelRecibo.fechaPago)} · {formatCurrency(cancelRecibo.neto)}
                </p>
              </div>
              <button onClick={() => !cancelBusy && setCancelRecibo(null)} className="rounded p-1 text-cos-ink-faint hover:bg-cos-canvas">
                <X className="h-4 w-4" />
              </button>
            </div>

            <label className="mb-1 block text-[12.5px] font-semibold text-cos-ink">Motivo de cancelación</label>
            <select value={cancelMotivo} onChange={(e) => setCancelMotivo(e.target.value)}
              className="w-full rounded-lg border border-cos-line bg-cos-canvas px-3 py-2 text-[13.5px] text-cos-ink focus:border-cos-brand focus:outline-none">
              <option value="02">02 — Errores sin relación (cancelar y retimbrar)</option>
              <option value="01">01 — Errores con relación (ya emití el sustituto)</option>
              <option value="03">03 — No se llevó a cabo la operación</option>
              <option value="04">04 — Operación nominativa en factura global</option>
            </select>
            {cancelMotivo === "01" && (
              <input value={cancelSustituye} onChange={(e) => setCancelSustituye(e.target.value)}
                placeholder="UUID del recibo que lo sustituye"
                className="mt-2 w-full rounded-lg border border-cos-line bg-cos-canvas px-3 py-2 font-mono text-[12.5px] text-cos-ink focus:border-cos-brand focus:outline-none" />
            )}

            <p className="mt-3 rounded-lg border border-cos-amber-ink/20 bg-cos-amber-tint px-3 py-2 text-[12.5px] leading-relaxed text-cos-amber-ink">
              El CFDI se cancela ante el SAT (el receptor es el empleado — no requiere su aceptación).
              El empleado queda listo para <b>retimbrar</b>: corrige los datos, recalcula la corrida y vuelve a timbrar.
            </p>

            {cancelErr && (
              <p className="mt-2 rounded-lg border border-cos-red-ink/20 bg-cos-red-tint px-3 py-2 text-[12.5px] text-cos-red-ink">{cancelErr}</p>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setCancelRecibo(null)} disabled={cancelBusy}
                className="rounded-lg border border-cos-line px-4 py-2 text-[13.5px] font-medium text-cos-ink hover:bg-cos-canvas disabled:opacity-50">
                Conservar el timbre
              </button>
              <button onClick={doCancelTimbre} disabled={cancelBusy || (cancelMotivo === "01" && !cancelSustituye.trim())}
                className="inline-flex items-center gap-1.5 rounded-lg bg-cos-red-ink px-4 py-2 text-[13.5px] font-semibold text-white hover:opacity-90 disabled:opacity-50">
                {cancelBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Ban className="h-3.5 w-3.5" />}
                {cancelBusy ? "Cancelando…" : "Cancelar ante el SAT"}
              </button>
            </div>
          </div>
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
