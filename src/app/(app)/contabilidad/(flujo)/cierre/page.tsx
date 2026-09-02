"use client";

import { descargarUrl } from "@/lib/descargar";

// ─────────────────────────────────────────────────────────────────────────────
// El Cierre del Mes (brief UX, módulo P0-1): el cierre como checklist vivo.
// Un stepper de 6 pasos sobre el período global; cada paso trae EL NÚMERO que
// importa (nunca sólo un ícono) y liga directa a donde se resuelve.
//
// Datos: periods, ce-readiness, bancos/conciliacion, complemento-pagos (REPs),
// impuestos/diot, ce-serie (¿hay balanza presentada?). Todo APIs existentes.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Check, Lock, AlertCircle, ArrowRight, Loader2, RefreshCw, X,
} from "lucide-react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { usePeriod, MESES } from "@/components/contabilidad/PeriodProvider";
import { FlowPageHeader } from "@/components/contabilidad/FlowPageHeader";
import { EjercicioCard } from "@/components/contabilidad/EjercicioCard";
import { Money } from "@/components/ui/Money";
import { cn } from "@/lib/utils";

// ── Tipos espejo de las APIs ──────────────────────────────────────────────────
type PeriodStatus = "DRAFT" | "POSTED" | "CLOSED";
interface Period {
  id: string;
  year: number;
  month: number;
  status: PeriodStatus;
  postedAt: string | null;
  entriesCount: number;
  totalCargos: number;
  totalAbonos: number;
}
interface ReadinessCheck {
  clave: string;
  estado: "ok" | "warn" | "error";
  titulo: string;
  detalle: string;
  cta?: { label: string; href: string };
}
interface Readiness {
  status: "lista" | "con_huecos" | "incompleta";
  resumen: string;
  checks: ReadinessCheck[];
}
interface Conciliacion {
  movimientosBanco: { monto: number; conciliado: boolean }[];
  conciliado: boolean;
  sinCuentaBancos: boolean;
  resumen: string;
}
interface RepStats {
  stats: { total: number; conPago: number; sinRep: number };
  pendientes: { needsRep: boolean; payments: { fecha: string }[] }[];
}
interface DiotResumen {
  rows: unknown[];
}

// ── Estado visual de un paso ──────────────────────────────────────────────────
type EstadoPaso = "listo" | "pendiente" | "bloquea" | "bloqueado" | "cargando";

const CHIP: Record<Exclude<EstadoPaso, "cargando">, { t: string; cls: string }> = {
  listo: { t: "LISTO", cls: "bg-cos-jade-tint text-cos-jade-ink" },
  pendiente: { t: "PENDIENTE", cls: "bg-cos-amber-tint text-cos-amber-ink" },
  bloquea: { t: "BLOQUEA EL CIERRE", cls: "bg-cos-red-tint text-cos-red-ink" },
  bloqueado: { t: "BLOQUEADO", cls: "bg-cos-slate-tint text-cos-ink-faint" },
};

function CirculoPaso({ num, estado }: { num: number; estado: EstadoPaso }) {
  if (estado === "listo")
    return (
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-cos-jade text-white">
        <Check className="h-4 w-4" />
      </span>
    );
  if (estado === "bloquea")
    return (
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-cos-red-tint text-cos-red-ink">
        <Lock className="h-3.5 w-3.5" />
      </span>
    );
  if (estado === "bloqueado")
    return (
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-cos-slate-tint text-cos-ink-faint">
        <Lock className="h-3.5 w-3.5" />
      </span>
    );
  return (
    <span
      className={cn(
        "grid h-7 w-7 shrink-0 place-items-center rounded-full border-2 font-mono text-[12px] font-semibold",
        estado === "pendiente"
          ? "border-cos-amber text-cos-amber-ink"
          : "border-cos-line text-cos-ink-faint"
      )}
    >
      {num}
    </span>
  );
}

function Paso({
  num, titulo, estado, children, ultimo,
}: {
  num: number;
  titulo: string;
  estado: EstadoPaso;
  children: React.ReactNode;
  ultimo?: boolean;
}) {
  return (
    <li className="relative flex gap-4">
      {!ultimo && (
        <span className="absolute left-[13px] top-8 bottom-[-8px] w-px bg-cos-line" aria-hidden />
      )}
      <CirculoPaso num={num} estado={estado} />
      <div className="mb-3 min-w-0 flex-1 rounded-card border border-cos-line bg-cos-card px-5 py-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-cos-ink">
            {num}. {titulo}
          </h2>
          {estado === "cargando" ? (
            <Loader2 className="h-4 w-4 animate-spin text-cos-ink-faint" />
          ) : (
            <span className={cn("rounded-full px-2.5 py-1 text-[11px] font-semibold tracking-wide", CHIP[estado].cls)}>
              {CHIP[estado].t}
            </span>
          )}
        </div>
        <div className="mt-2 text-sm text-cos-ink-soft">{children}</div>
      </div>
    </li>
  );
}

// ── Página ────────────────────────────────────────────────────────────────────
export default function CierrePage() {
  const { activeCompany } = useCompany();
  const { year, month, setPeriod, label } = usePeriod();

  const [periods, setPeriods] = useState<Period[] | null>(null);
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [concil, setConcil] = useState<Conciliacion | null>(null);
  const [rep, setRep] = useState<RepStats | null>(null);
  const [diot, setDiot] = useState<DiotResumen | null>(null);
  const [presentada, setPresentada] = useState<boolean | null>(null);
  const [posting, setPosting] = useState(false);
  const [pendientesLoading, setPendientesLoading] = useState(false);
  const [cierreLoading, setCierreLoading] = useState(false);
  const [aviso, setAviso] = useState("");
  const [error, setError] = useState("");

  const cargar = useCallback(async () => {
    if (!activeCompany) return;
    const id = activeCompany.id;
    const q = `companyId=${id}&year=${year}&month=${month}`;
    const [rPeriods, rReady, rConcil, rRep, rDiot, rCe] = await Promise.allSettled([
      fetch(`/api/contabilidad/periods?companyId=${id}`).then((r) => r.json()),
      fetch(`/api/contabilidad/ce-readiness?${q}`).then((r) => r.json()),
      fetch(`/api/bancos/conciliacion?${q}`).then((r) => r.json()),
      fetch(`/api/facturas/complemento-pagos?companyId=${id}`).then((r) => r.json()),
      fetch(`/api/impuestos/diot?companyId=${id}&year=${year}&month=${month}`).then((r) => r.json()),
      fetch(`/api/contabilidad/ce-serie?companyId=${id}&anio=${year}&mes=${month}`),
    ]);
    if (rPeriods.status === "fulfilled" && Array.isArray(rPeriods.value)) setPeriods(rPeriods.value);
    if (rReady.status === "fulfilled" && rReady.value?.checks) setReadiness(rReady.value);
    if (rConcil.status === "fulfilled" && rConcil.value?.movimientosNoRegistrados) setConcil(rConcil.value);
    if (rRep.status === "fulfilled" && rRep.value?.stats) setRep(rRep.value);
    if (rDiot.status === "fulfilled" && Array.isArray(rDiot.value?.rows)) setDiot(rDiot.value);
    if (rCe.status === "fulfilled") setPresentada(rCe.value.ok);
  }, [activeCompany, year, month]);

  useEffect(() => {
    setPeriods(null); setReadiness(null); setConcil(null); setPresentada(null);
    cargar();
  }, [cargar]);

  if (!activeCompany) return null;

  const periodo = periods?.find((p) => p.year === year && p.month === month) ?? null;
  const posteado = periodo?.status === "POSTED" || periodo?.status === "CLOSED";

  async function postear() {
    if (!activeCompany) return;
    setPosting(true); setError(""); setAviso("");
    try {
      const res = await fetch("/api/contabilidad/post", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: activeCompany.id, year, month }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Error al contabilizar el mes");
      const warn = data.warnings?.length ?? 0;
      setAviso(
        `${data.entriesCreated} ${data.entriesCreated === 1 ? "asiento creado" : "asientos creados"}${warn > 0 ? ` · ${warn} ${warn === 1 ? "advertencia" : "advertencias"}` : ""}.`
      );
      await cargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al contabilizar el mes");
    } finally {
      setPosting(false);
    }
  }

  /** Asiento de cierre del ejercicio (mes 13). */
  async function generarCierreAnual() {
    if (!activeCompany) return;
    setCierreLoading(true); setError(""); setAviso("");
    try {
      const res = await fetch("/api/contabilidad/cierre", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: activeCompany.id, year }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Error al generar el cierre");
      const r = data.resultado as number;
      setAviso(
        `Cierre ${year} generado (mes 13): ${r >= 0 ? "utilidad" : "pérdida"} de $${Math.abs(r).toLocaleString("es-MX", { minimumFractionDigits: 2 })}.`
      );
      await cargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al generar el cierre");
    } finally {
      setCierreLoading(false);
    }
  }

  /** Postear de una vez todos los meses pendientes del año (post-pending). */
  async function postearPendientes() {
    if (!activeCompany) return;
    setPendientesLoading(true); setError(""); setAviso("");
    try {
      const res = await fetch("/api/contabilidad/post-pending", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: activeCompany.id, year }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Error al actualizar los meses pendientes");
      const partes: string[] = [
        `${data.posted} ${data.posted === 1 ? "mes cerrado" : "meses cerrados"}`,
      ];
      if (data.errors?.length > 0) partes.push(`${data.errors.length} con error`);
      setAviso(`Meses pendientes ${year}: ${partes.join(" · ")}.`);
      await cargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al actualizar los meses pendientes");
    } finally {
      setPendientesLoading(false);
    }
  }

  async function reabrir() {
    if (!activeCompany) return;
    if (!confirm(`¿Reabrir ${label}? Se eliminarán todos los asientos del periodo.`)) return;
    setPosting(true); setError(""); setAviso("");
    try {
      await fetch(
        `/api/contabilidad/post?companyId=${activeCompany.id}&year=${year}&month=${month}`,
        { method: "DELETE" }
      );
      await cargar();
    } finally {
      setPosting(false);
    }
  }

  // ── Estados por paso ────────────────────────────────────────────────────────
  const e1: EstadoPaso = !readiness
    ? "cargando"
    : readiness.status === "lista" ? "listo"
    : readiness.status === "con_huecos" ? "pendiente" : "bloquea";

  // SIN CONCILIAR = status UNMATCHED, no «sin asiento»: un mes en borrador no
  // tiene asientos aunque todo esté conciliado, y contarlo así gritaba «27 sin
  // conciliar» con 16 reales (misma confusión que la mesa, revisión pág. 9).
  const movsSinConciliar = concil?.movimientosBanco.filter((m) => !m.conciliado) ?? [];
  const sinConciliar = movsSinConciliar.length;
  const totalSinConciliar = movsSinConciliar.reduce((s, m) => s + Math.abs(m.monto), 0);
  // En un mes ya posteado los sin conciliar no «bloquean» nada que ya pasó:
  // quedaron fuera del posteo y piden conciliar + re-postear.
  const e2: EstadoPaso = !concil
    ? "cargando"
    : concil.sinCuentaBancos || sinConciliar === 0 ? "listo"
    : posteado ? "pendiente" : "bloquea";

  const e3: EstadoPaso = !periods ? "cargando" : posteado ? "listo" : "pendiente";
  const e4: EstadoPaso =
    presentada === null ? "cargando" : presentada ? "pendiente" : "bloqueado";
  const e5: EstadoPaso = "pendiente";
  const e6: EstadoPaso = posteado ? "listo" : "bloqueado";

  // REPs del PERIODO en pantalla: el endpoint devuelve el pendiente global,
  // pero la tarjeta se llama «obligaciones del período» — aquí cuentan las PPD
  // con cobros de ESTE mes; el resto se anota aparte para que el total ate con
  // la pestaña de facturas.
  const enPeriodo = (iso: string) => {
    const d = new Date(iso);
    return d.getUTCFullYear() === year && d.getUTCMonth() + 1 === month;
  };
  const repsDelPeriodo = rep
    ? rep.pendientes.filter((p) => p.needsRep && p.payments.some((pg) => enPeriodo(pg.fecha))).length
    : null;
  const repsOtrosMeses =
    rep && repsDelPeriodo !== null ? rep.stats.sinRep - repsDelPeriodo : 0;
  const chipPeriodo = !periodo
    ? { t: "SIN INICIAR", cls: "bg-cos-slate-tint text-cos-ink-faint" }
    : periodo.status === "DRAFT"
      ? { t: "BORRADOR", cls: "bg-cos-amber-tint text-cos-amber-ink" }
      : periodo.status === "POSTED"
        ? { t: "POSTEADO", cls: "bg-cos-brand-tint text-cos-brand-ink" }
        : { t: "CERRADO", cls: "bg-cos-jade-tint text-cos-jade-ink" };

  const liga = "inline-flex items-center gap-1 text-[13px] font-medium text-cos-brand-ink hover:underline";

  return (
    <div>
      <FlowPageHeader
        title="Cierre del mes"
        context={
          periods
            ? periodo
              ? `${periodo.entriesCount.toLocaleString("es-MX")} asientos · ${
                  posteado && periodo.postedAt
                    ? `última contabilización ${new Date(periodo.postedAt).toLocaleString("es-MX", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`
                    : "en borrador"
                }`
              : "sin contabilizar · el motor deriva las pólizas de tus CFDIs al contabilizar"
            : undefined
        }
        actions={
          <>
            <span className={cn("rounded-full px-2.5 py-1 text-[11px] font-semibold tracking-wide", chipPeriodo.cls)}>
              {chipPeriodo.t}
            </span>
            <Link
              href="/contabilidad/balanza"
              className="inline-flex items-center rounded-control border border-cos-line bg-cos-card px-3 py-2 text-sm font-medium text-cos-ink hover:bg-cos-paper"
            >
              Ver balanza
            </Link>
            <button
              onClick={postear}
              disabled={posting}
              className="inline-flex items-center gap-1.5 rounded-control bg-cos-brand px-3 py-2 text-sm font-medium text-white hover:bg-cos-brand-deep disabled:opacity-50"
            >
              {posting ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {posteado ? "Volver a contabilizar el mes" : "Contabilizar el mes"}
            </button>
          </>
        }
      />

      {aviso && (
        <div className="mb-4 flex items-center gap-2 rounded-card bg-cos-jade-tint px-4 py-3 text-sm text-cos-jade-ink">
          <Check className="h-4 w-4 shrink-0" /> <span className="flex-1">{aviso}</span>
          <button onClick={() => setAviso("")} aria-label="Cerrar aviso"><X className="h-3.5 w-3.5" /></button>
        </div>
      )}
      {error && (
        <div className="mb-4 flex items-center gap-2 rounded-card bg-cos-red-tint px-4 py-3 text-sm text-cos-red-ink">
          <AlertCircle className="h-4 w-4 shrink-0" /> <span className="flex-1">{error}</span>
          <button onClick={() => setError("")} aria-label="Cerrar error"><X className="h-3.5 w-3.5" /></button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* ── Stepper ── */}
        <ol className="list-none">
          {/* 1 · Documentos */}
          <Paso num={1} titulo="Documentos" estado={e1}>
            {readiness ? (
              <>
                <p>{readiness.resumen}</p>
                <ul className="mt-2 space-y-1">
                  {readiness.checks.map((c) => (
                    <li key={c.clave} className="flex items-start gap-2 text-[13px]">
                      <span
                        className={cn(
                          "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full",
                          c.estado === "ok" ? "bg-cos-jade" : c.estado === "warn" ? "bg-cos-amber" : "bg-cos-red"
                        )}
                      />
                      <span className="min-w-0">
                        <span className="font-medium text-cos-ink">{c.titulo}</span>{" "}
                        <span className="text-cos-ink-soft">{c.detalle}</span>
                        {c.cta && (
                          <>
                            {" "}
                            <Link href={c.cta.href} className={liga}>{c.cta.label}</Link>
                          </>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p>Revisando CFDIs, cobertura y bancos…</p>
            )}
          </Paso>

          {/* 2 · Conciliación */}
          <Paso num={2} titulo="Conciliación" estado={e2}>
            {concil ? (
              concil.sinCuentaBancos ? (
                <p>No hay cuenta contable de Bancos en el catálogo: nada que conciliar este mes.</p>
              ) : sinConciliar > 0 ? (
                <>
                  <p className="flex items-baseline gap-2">
                    <span className="font-mono text-[26px] font-semibold leading-none text-cos-red-ink tabular-nums">
                      {sinConciliar}
                    </span>
                    <span>
                      {sinConciliar === 1 ? "movimiento sin conciliar por" : "movimientos sin conciliar por"}{" "}
                      <Money value={totalSinConciliar} className="mx-1" />
                    </span>
                  </p>
                  <p className="mt-1 text-[13px]">
                    {posteado
                      ? "Quedaron fuera de la última contabilización: concílialos y vuelve a contabilizar el mes."
                      : "El motor no contabiliza movimientos bancarios sin conciliar."}
                  </p>
                  <Link href="/contabilidad/conciliacion" className={cn(liga, "mt-2")}>
                    Ir a conciliación <ArrowRight className="h-3.5 w-3.5" />
                  </Link>
                </>
              ) : (
                <p>{concil.resumen || "Todos los movimientos del mes están conciliados."}</p>
              )
            ) : (
              <p>Cotejando banco contra libro…</p>
            )}

            {/* 2b · Obligaciones del período */}
            <div className="mt-3 rounded-card border border-cos-line-soft bg-cos-paper px-4 py-3">
              <p className="text-[12px] font-semibold uppercase tracking-wide text-cos-ink-faint">
                2b · Obligaciones del período
              </p>
              <ul className="mt-2 space-y-1.5 text-[13px]">
                <li className="flex items-center justify-between gap-2">
                  <span>
                    REPs pendientes:{" "}
                    <span className="font-mono font-semibold tabular-nums">
                      {repsDelPeriodo ?? "…"}
                    </span>{" "}
                    {repsDelPeriodo != null && repsDelPeriodo > 0 &&
                      (repsDelPeriodo === 1 ? "PPD cobrada este mes sin complemento" : "PPD cobradas este mes sin complemento")}
                    {repsOtrosMeses > 0 && (
                      <span className="text-cos-ink-faint">
                        {" "}· {repsOtrosMeses} más de otros meses
                      </span>
                    )}
                  </span>
                  <Link href="/facturas" className={liga}>Emitir</Link>
                </li>
                <li className="flex items-center justify-between gap-2">
                  <span>
                    DIOT:{" "}
                    <span className="font-mono font-semibold tabular-nums">{diot ? diot.rows.length : "…"}</span>{" "}
                    {diot && diot.rows.length === 1 ? "proveedor" : "proveedores"} del período
                  </span>
                  <button
                    type="button"
                    onClick={() => void descargarUrl(`/api/impuestos/diot?companyId=${activeCompany.id}&year=${year}&month=${month}&format=txt`, `diot-${year}-${month}.txt`)}
                    className={liga}
                  >
                    Generar .txt
                  </button>
                </li>
                <li className="flex items-center justify-between gap-2">
                  <span>Depreciación del período</span>
                  <Link href="/contabilidad/activo-fijo" className={liga}>Revisar</Link>
                </li>
              </ul>
            </div>
          </Paso>

          {/* 3 · Posteo */}
          <Paso num={3} titulo="Posteo" estado={e3}>
            {periodo ? (
              <p>
                <span className="font-mono font-semibold tabular-nums">{periodo.entriesCount.toLocaleString("es-MX")}</span>{" "}
                asientos {posteado ? "contabilizados" : "en borrador"}
                {periodo.postedAt &&
                  ` · última contabilización ${new Date(periodo.postedAt).toLocaleString("es-MX", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}`}
                .
              </p>
            ) : (
              <p>El período aún no se ha contabilizado.</p>
            )}
            <div className="mt-2 flex items-start gap-2 rounded-md bg-cos-slate-tint px-3 py-2 text-[13px]">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-cos-ink-soft" />
              <span>
                Se regeneran las pólizas de origen CFDI, NÓMINA y BANCO.{" "}
                <span className="font-semibold text-cos-ink">
                  Tus pólizas manuales y la apertura no se tocan.
                </span>
              </span>
            </div>
            {posteado && (
              <button onClick={reabrir} disabled={posting} className={cn(liga, "mt-2 text-cos-red-ink")}>
                Reabrir el período
              </button>
            )}
          </Paso>

          {/* 4 · Divergencia */}
          <Paso num={4} titulo="Divergencia" estado={e4}>
            {presentada === null ? (
              <p>Buscando la balanza presentada del período…</p>
            ) : presentada ? (
              <>
                <p>Balanza CE presentada: compara lo derivado contra lo declarado, cuenta por cuenta.</p>
                <Link href="/contabilidad/divergencia" className={cn(liga, "mt-1")}>
                  Revisar divergencia <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </>
            ) : (
              <p>
                Sin balanza presentada para {label}. Importa la balanza CE del período para medir la
                divergencia.{" "}
                <Link href="/contabilidad/presentado" className={liga}>Ver presentadas</Link>
              </p>
            )}
          </Paso>

          {/* 5 · Ajustes */}
          <Paso num={5} titulo="Ajustes" estado={e5}>
            <p>Pólizas manuales para el residuo — fuente MANUAL, volver a contabilizar nunca las pisa.</p>
            <Link href="/contabilidad/ajustes" className={cn(liga, "mt-1")}>
              Capturar póliza <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </Paso>

          {/* 6 · Entregables */}
          <Paso num={6} titulo="Entregables" estado={e6} ultimo>
            <p>
              {posteado
                ? "Los 5 XML del Anexo 24 del período están listos para descargar."
                : "Los 5 XML del Anexo 24 se habilitan al contabilizar el mes."}
            </p>
            <p className="mt-1.5 flex flex-wrap gap-1.5">
              {["catálogo", "balanza", "pólizas", "aux. cuentas", "aux. folios"].map((x) => (
                <span
                  key={x}
                  className="rounded border border-cos-line bg-cos-paper px-1.5 py-0.5 font-mono text-[11px] text-cos-ink-faint"
                >
                  {x}
                </span>
              ))}
            </p>
            {posteado && (
              <Link href="/contabilidad/entregables" className={cn(liga, "mt-1.5")}>
                Ir a entregables <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            )}
          </Paso>
        </ol>

        {/* ── Columna derecha ── */}
        <div className="space-y-4">
          <section className="rounded-card border border-cos-line bg-cos-card">
            <h2 className="border-b border-cos-line px-5 py-3.5 text-sm font-semibold text-cos-ink">
              Resumen del período
            </h2>
            <dl className="px-5 py-4 text-sm">
              <div className="flex items-center justify-between py-1">
                <dt className="text-cos-ink-soft">Cargos</dt>
                <dd><Money value={periodo?.totalCargos ?? 0} /></dd>
              </div>
              <div className="flex items-center justify-between py-1">
                <dt className="text-cos-ink-soft">Abonos</dt>
                <dd><Money value={periodo?.totalAbonos ?? 0} /></dd>
              </div>
              {periodo && Math.abs(periodo.totalCargos - periodo.totalAbonos) < 0.01 && periodo.entriesCount > 0 && (
                <div className="py-1.5">
                  <span className="inline-flex items-center gap-1 rounded-full bg-cos-jade-tint px-2.5 py-1 text-[12px] font-semibold text-cos-jade-ink">
                    <Check className="h-3.5 w-3.5" /> Balanza cuadrada
                  </span>
                </div>
              )}
              <div className="mt-1 flex items-center justify-between border-t border-cos-line-soft py-1.5">
                <dt className="text-cos-ink-soft">Asientos</dt>
                <dd className="font-mono tabular-nums">{(periodo?.entriesCount ?? 0).toLocaleString("es-MX")}</dd>
              </div>
            </dl>
          </section>

          <section className="rounded-card border border-cos-line bg-cos-card">
            <h2 className="border-b border-cos-line px-5 py-3.5 text-sm font-semibold text-cos-ink">
              Serie de períodos {year}
            </h2>
            <div className="px-5 py-4">
              <div className="flex items-end gap-1.5" role="list">
                {Array.from({ length: 12 }, (_, i) => {
                  const p = periods?.find((x) => x.year === year && x.month === i + 1);
                  const activo = i + 1 === month;
                  const color = !p
                    ? "bg-cos-slate-tint"
                    : p.status === "CLOSED" ? "bg-cos-jade"
                    : p.status === "POSTED" ? "bg-cos-jade opacity-70"
                    : "bg-cos-amber";
                  return (
                    <button
                      key={i}
                      role="listitem"
                      title={`${MESES[i]} ${year}${p ? ` · ${p.status}` : " · sin iniciar"}`}
                      onClick={() => setPeriod(year, i + 1)}
                      className={cn(
                        "h-9 flex-1 rounded-sm transition-transform hover:scale-y-110",
                        color,
                        activo && "ring-2 ring-cos-brand ring-offset-1"
                      )}
                    />
                  );
                })}
              </div>
              <div className="mt-2 flex justify-between font-mono text-[11px] text-cos-ink-faint">
                <span>ene</span>
                <span>dic</span>
              </div>
              <button
                onClick={postearPendientes}
                disabled={pendientesLoading}
                className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-control border border-cos-line bg-cos-card px-3 py-2 text-[13px] font-medium text-cos-ink hover:bg-cos-paper disabled:opacity-50"
              >
                {pendientesLoading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Postear meses pendientes de {year}
              </button>
            </div>
          </section>

          {/* Cierre anual: asiento de mes 13, traspaso y candado del ejercicio.
              Todo DENTRO de una tarjeta: el enlace y el botón sueltos «flotaban»
              sin contexto, y el enlace a la balanza 13 se servía aunque el mes
              13 no existiera — el navegador enseñaba el JSON de error crudo. */}
          <section className="rounded-card border border-cos-line bg-cos-card">
            <div className="flex items-center justify-between gap-2 border-b border-cos-line px-4 py-3">
              <div>
                <p className="text-sm font-semibold text-cos-ink">Cierre del ejercicio {year}</p>
                <p className="text-[12px] text-cos-ink-soft">
                  El «mes 13» del SAT: el asiento que cierra resultados del año.
                </p>
              </div>
              <button
                onClick={generarCierreAnual}
                disabled={cierreLoading}
                title={`Generar el asiento de cierre del ejercicio ${year} (mes 13)`}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-control border border-cos-line bg-cos-card px-3 py-1.5 text-[13px] font-medium text-cos-ink hover:bg-cos-paper disabled:opacity-50"
              >
                {cierreLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                Cierre {year}
              </button>
            </div>
            <div className="px-4 py-3">
              {periods?.some((p) => p.year === year && p.month === 13) ? (
                <button
                  type="button"
                  onClick={() => void descargarUrl(`/api/contabilidad/coe/balanza?companyId=${activeCompany.id}&year=${year}&month=13`, `balanza-${year}-13.xml`)}
                  title="Descargar la balanza XML del mes 13 (Anexo 24)"
                  className={liga}
                >
                  Descargar balanza de cierre (mes 13)
                </button>
              ) : (
                <p className="text-[12.5px] text-cos-ink-faint">
                  La balanza del mes 13 se podrá descargar cuando generes el asiento de cierre.
                </p>
              )}
            </div>
          </section>

          {/* Estado del ejercicio (traspaso de resultado y candado) — trae su
              propia tarjeta, va como hermana para no anidar bordes. */}
          <EjercicioCard
            companyId={activeCompany.id}
            year={year}
            periods={periods ?? []}
            onReload={cargar}
          />
        </div>
      </div>
    </div>
  );
}
