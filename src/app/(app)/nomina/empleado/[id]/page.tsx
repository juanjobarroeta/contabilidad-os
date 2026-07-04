"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Expediente del empleado — /nomina/empleado/[id]
//
// Todo lo de una persona en un solo lugar: ficha (RFC, CURP, NSS, puesto,
// salario, SBC, alta/baja), acumulados del ejercicio (base del futuro ajuste
// anual Art. 97 — lib pura src/lib/nomina/acumulados.ts), historial de recibos
// (nativos e importados del SAT) y cambios de salario (movimientos IMSS).
// Sólo lectura; el acceso lo valida el endpoint (membresía, VIEWER incluido).
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ArrowLeft, BadgeCheck, Loader2, Receipt, TrendingUp, UserRound, FileText,
} from "lucide-react";
import { Card, Money, Loading } from "@/components/ui";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { AcumuladosEmpleado } from "@/lib/nomina/acumulados";
import { TIPO_RUN_LABEL, STATUS_RUN_LABEL, PERIODICIDAD_LABEL } from "../../workspace-shared";

interface EmpleadoFicha {
  id: string;
  nombre: string;
  apellidoPaterno: string;
  apellidoMaterno: string | null;
  rfc: string;
  curp: string;
  nss: string;
  numEmpleado: string | null;
  puesto: string | null;
  departamento: string | null;
  salarioDiario: number;
  salarioDiarioIntegrado: number | null;
  periodicidadPago: string;
  fechaIngreso: string;
  fechaBaja: string | null;
  isActive: boolean;
}

interface ReciboExpediente {
  id: string;
  runId: string;
  periodo: string;
  fechaPago: string;
  tipo: string;
  status: string;
  origen: string;
  sueldoBase: number;
  totalPercepciones: number;
  isrRetenido: number;
  imssObrero: number;
  infonavit: number;
  totalDeducciones: number;
  netoAPagar: number;
  cfdiUuid: string | null;
}

interface CambioSalario {
  id: string;
  tipo: string;
  fechaMovimiento: string;
  sbcAnterior: number | null;
  sbcNuevo: number | null;
  motivo: string | null;
}

interface ExpedienteResponse {
  empleado: EmpleadoFicha;
  anios: number[];
  anio: number;
  acumulados: AcumuladosEmpleado;
  recibos: { items: ReciboExpediente[]; total: number; page: number; pageSize: number };
  cambiosSalario: CambioSalario[];
}

const MOV_LABEL: Record<string, string> = {
  ALTA: "Alta IMSS",
  REINGRESO: "Reingreso",
  MODIFICACION_SALARIO: "Modificación de salario",
};

export default function ExpedienteEmpleadoPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<ExpedienteResponse | null>(null);
  const [recibos, setRecibos] = useState<ReciboExpediente[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [anio, setAnio] = useState<number | null>(null);

  const load = useCallback(async (year: number | null, page: number, append: boolean) => {
    if (!id) return;
    if (append) setLoadingMore(true); else setLoading(true);
    setError("");
    try {
      const sp = new URLSearchParams();
      if (year != null) sp.set("year", String(year));
      sp.set("page", String(page));
      const res = await fetch(`/api/nomina/empleado/${id}?${sp.toString()}`);
      const d = await res.json();
      if (!res.ok) { setError(d.error ?? "No se pudo cargar el expediente"); return; }
      setData(d);
      setRecibos((prev) => (append ? [...prev, ...d.recibos.items] : d.recibos.items));
    } catch {
      setError("No se pudo cargar el expediente");
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [id]);

  useEffect(() => { load(anio, 1, false); }, [load, anio]);

  if (loading && !data) return <Loading />;

  if (error && !data) {
    return (
      <div className="mx-auto max-w-[1000px] px-6 py-7">
        <Link href="/nomina?tab=empleados" className="inline-flex items-center gap-1.5 text-[13px] font-medium text-cos-ink-soft hover:text-cos-brand-ink">
          <ArrowLeft className="h-4 w-4" /> Volver a Empleados
        </Link>
        <div className="mt-4 rounded-card border border-cos-red-ink/20 bg-cos-red-tint px-5 py-4 text-[13.5px] text-cos-red-ink">{error}</div>
      </div>
    );
  }
  if (!data) return <Loading />;

  const e = data.empleado;
  const acc = data.acumulados;
  const nombreCompleto = `${e.nombre} ${e.apellidoPaterno} ${e.apellidoMaterno ?? ""}`.trim();
  const hayMas = recibos.length < data.recibos.total;
  const desgloseP: [string, number][] = [
    ["Sueldo", acc.percepciones.sueldo],
    ["Horas extra", acc.percepciones.horasExtra],
    ["Bonos fijos", acc.percepciones.bonosFijos],
    ["Bonos variables", acc.percepciones.bonosVariables],
    ["Vales de despensa", acc.percepciones.vales],
    ["Aguinaldo", acc.percepciones.aguinaldo],
    ["Prima vacacional", acc.percepciones.primaVacacional],
    ["Vacaciones", acc.percepciones.vacaciones],
    ["PTU", acc.percepciones.ptu],
    ["Otras percepciones", acc.percepciones.otras],
  ];
  const desgloseD: [string, number][] = [
    ["ISR retenido", acc.deducciones.isrRetenido],
    ["IMSS obrero", acc.deducciones.imssObrero],
    ["INFONAVIT", acc.deducciones.infonavit],
    ["Otras deducciones", acc.deducciones.otras],
  ];

  return (
    <div className="mx-auto max-w-[1000px] px-4 py-6 sm:px-6 sm:py-7">
      <Link href="/nomina?tab=empleados" className="inline-flex items-center gap-1.5 text-[13px] font-medium text-cos-ink-soft hover:text-cos-brand-ink">
        <ArrowLeft className="h-4 w-4" /> Volver a Empleados
      </Link>

      {/* ── Ficha ── */}
      <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2.5 text-[24px] font-bold tracking-[-0.02em] text-cos-ink">
            <UserRound className="h-6 w-6 text-cos-ink-faint" /> {nombreCompleto}
            {e.isActive ? (
              <span className="rounded-full bg-cos-jade-tint px-2.5 py-1 text-[12px] font-semibold text-cos-jade-ink">Activo</span>
            ) : (
              <span className="rounded-full bg-cos-slate-tint px-2.5 py-1 text-[12px] font-semibold text-cos-ink-soft">Baja</span>
            )}
          </h1>
          <p className="mt-0.5 text-[14px] text-cos-ink-soft">
            {e.puesto ?? "Sin puesto"}{e.departamento ? ` · ${e.departamento}` : ""}
            {e.numEmpleado ? ` · No. ${e.numEmpleado}` : ""}
          </p>
        </div>
      </div>

      <Card className="mt-4 rounded-card border-cos-line p-5 shadow-card">
        <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
          <Dato label="RFC" value={e.rfc} mono />
          <Dato label="CURP" value={e.curp} mono />
          <Dato label="NSS" value={e.nss} mono />
          <Dato label="Periodicidad" value={PERIODICIDAD_LABEL[e.periodicidadPago] ?? e.periodicidadPago} />
          <Dato label="Salario diario" value={formatCurrency(e.salarioDiario)} mono />
          <Dato label="SBC (integrado)" value={e.salarioDiarioIntegrado != null ? formatCurrency(e.salarioDiarioIntegrado) : "—"} mono />
          <Dato label="Fecha de alta" value={formatDate(e.fechaIngreso)} />
          <Dato label={e.isActive ? "Estado" : "Fecha de baja"} value={e.isActive ? "Activo" : e.fechaBaja ? formatDate(e.fechaBaja) : "Baja"} />
        </div>
      </Card>

      {/* ── Acumulados del ejercicio ── */}
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-[17px] font-semibold text-cos-ink">
          <TrendingUp className="h-[18px] w-[18px] text-cos-ink-faint" /> Acumulados del ejercicio
        </h2>
        {data.anios.length > 0 && (
          <select
            value={data.anio}
            onChange={(ev) => setAnio(Number(ev.target.value))}
            className="rounded-md border border-cos-line bg-cos-card px-2 py-1.5 text-sm"
            aria-label="Ejercicio"
          >
            {data.anios.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        )}
      </div>

      {acc.recibos === 0 ? (
        <Card className="mt-3 rounded-card border-dashed border-cos-line p-8 text-center text-[13.5px] text-cos-ink-soft shadow-none">
          Sin recibos en el ejercicio {data.anio}.
        </Card>
      ) : (
        <>
          <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label="Percepciones" value={acc.percepciones.total} />
            <Kpi label="ISR retenido" value={acc.deducciones.isrRetenido} />
            <Kpi label="IMSS obrero" value={acc.deducciones.imssObrero} />
            <Kpi label="Neto pagado" value={acc.netoPagado} destacado />
          </div>

          <Card className="mt-3 rounded-card border-cos-line p-5 shadow-card">
            <div className="grid grid-cols-1 gap-x-10 gap-y-1 sm:grid-cols-2">
              <div>
                <p className="mb-1.5 text-[12px] font-semibold uppercase tracking-wide text-cos-ink-soft">Percepciones</p>
                {desgloseP.filter(([, v]) => v !== 0).map(([label, v]) => (
                  <FilaMonto key={label} label={label} value={v} />
                ))}
                <FilaMonto label="Total percepciones" value={acc.percepciones.total} total />
              </div>
              <div>
                <p className="mb-1.5 text-[12px] font-semibold uppercase tracking-wide text-cos-ink-soft">Deducciones</p>
                {desgloseD.filter(([, v]) => v !== 0).map(([label, v]) => (
                  <FilaMonto key={label} label={label} value={v} />
                ))}
                <FilaMonto label="Total deducciones" value={acc.deducciones.total} total />
                <FilaMonto label="Neto pagado" value={acc.netoPagado} total jade />
              </div>
            </div>
            <p className="mt-3 text-[12px] leading-relaxed text-cos-ink-faint">
              {acc.recibos} recibo{acc.recibos === 1 ? "" : "s"} en {data.anio}
              {acc.porOrigen.sat > 0 ? ` (${acc.porOrigen.sat} importado${acc.porOrigen.sat === 1 ? "" : "s"} del SAT)` : ""}.
              Estos acumulados son la base del ajuste anual de ISR (Art. 97 LISR). El desglose gravado/exento por
              percepción y el subsidio al empleo no se conservan por recibo, por lo que aquí se acumulan importes totales.
            </p>
          </Card>
        </>
      )}

      {/* ── Historial de recibos ── */}
      <h2 className="mt-6 flex items-center gap-2 text-[17px] font-semibold text-cos-ink">
        <Receipt className="h-[18px] w-[18px] text-cos-ink-faint" /> Historial de recibos {data.anios.length > 1 ? `· ${data.anio}` : ""}
      </h2>
      {recibos.length === 0 ? (
        <Card className="mt-3 rounded-card border-dashed border-cos-line p-8 text-center text-[13.5px] text-cos-ink-soft shadow-none">
          Sin recibos en el ejercicio seleccionado.
        </Card>
      ) : (
        <div className="mt-3 overflow-hidden rounded-card border border-cos-line bg-cos-card">
          {recibos.map((r, idx) => (
            <div key={r.id} className={`flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 ${idx > 0 ? "border-t border-cos-line" : ""}`}>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13.5px] font-semibold text-cos-ink">{TIPO_RUN_LABEL[r.tipo] ?? r.tipo}</span>
                  <span className="text-[12px] text-cos-ink-soft">{r.periodo}</span>
                  {r.origen === "SAT" ? (
                    <span className="rounded-full bg-cos-slate-tint px-2 py-0.5 text-[10px] font-medium text-cos-ink-soft"
                      title="Reconstruido desde tu recibo timbrado en el SAT">
                      Importado del SAT
                    </span>
                  ) : (
                    <span className="rounded-full bg-cos-brand-tint px-2 py-0.5 text-[10px] font-medium text-cos-brand-ink">
                      {STATUS_RUN_LABEL[r.status] ?? r.status}
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-[12px] text-cos-ink-faint">
                  Pago {formatDate(r.fechaPago)}
                  {" · "}ISR {r.isrRetenido > 0 ? formatCurrency(r.isrRetenido) : "—"}
                  {" · "}IMSS {r.imssObrero > 0 ? formatCurrency(r.imssObrero) : "—"}
                  {r.infonavit > 0 ? ` · INFONAVIT ${formatCurrency(r.infonavit)}` : ""}
                </p>
              </div>
              <div className="text-right">
                <p className="font-mono text-[14px] font-bold text-cos-jade-ink">{formatCurrency(r.netoAPagar)}</p>
                <p className="font-mono text-[11px] text-cos-ink-faint">de <Money value={r.totalPercepciones} /></p>
              </div>
              <div className="w-full sm:w-auto">
                {r.cfdiUuid ? (
                  <Link
                    href={`/facturas?q=${r.cfdiUuid}`}
                    className="inline-flex items-center gap-1 text-[12px] font-medium text-cos-brand-ink hover:underline"
                    title={r.cfdiUuid}
                  >
                    <FileText className="h-3.5 w-3.5" /> CFDI …{r.cfdiUuid.slice(-8)}
                  </Link>
                ) : (
                  <span className="text-[12px] text-cos-ink-faint">Sin timbrar</span>
                )}
              </div>
            </div>
          ))}
          {hayMas && (
            <div className="border-t border-cos-line p-3 text-center">
              <button
                onClick={() => load(data.anio, data.recibos.page + 1, true)}
                disabled={loadingMore}
                className="inline-flex items-center gap-2 rounded-md border border-cos-line px-4 py-2 text-sm font-medium hover:bg-cos-paper disabled:opacity-50"
              >
                {loadingMore && <Loader2 className="h-4 w-4 animate-spin" />}
                Cargar más ({recibos.length} de {data.recibos.total})
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Cambios de salario (movimientos IMSS) ── */}
      {data.cambiosSalario.length > 0 && (
        <>
          <h2 className="mt-6 flex items-center gap-2 text-[17px] font-semibold text-cos-ink">
            <BadgeCheck className="h-[18px] w-[18px] text-cos-ink-faint" /> Historial salarial
          </h2>
          <div className="mt-3 overflow-hidden rounded-card border border-cos-line bg-cos-card">
            {data.cambiosSalario.map((m, idx) => (
              <div key={m.id} className={`flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 ${idx > 0 ? "border-t border-cos-line" : ""}`}>
                <div className="min-w-0 flex-1">
                  <p className="text-[13.5px] font-medium text-cos-ink">{MOV_LABEL[m.tipo] ?? m.tipo}</p>
                  <p className="text-[12px] text-cos-ink-faint">{formatDate(m.fechaMovimiento)}{m.motivo ? ` · ${m.motivo}` : ""}</p>
                </div>
                <p className="font-mono text-[13px] text-cos-ink">
                  {m.sbcAnterior != null ? <>{formatCurrency(m.sbcAnterior)} → </> : null}
                  {m.sbcNuevo != null ? <b>{formatCurrency(m.sbcNuevo)}</b> : "—"}
                </p>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[12px] text-cos-ink-faint">
            Derivado de los movimientos IMSS registrados (el salario diario no se conserva recibo por recibo).
          </p>
        </>
      )}
    </div>
  );
}

function Dato({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-[11.5px] font-medium uppercase tracking-wide text-cos-ink-faint">{label}</p>
      <p className={`mt-0.5 text-[13.5px] text-cos-ink ${mono ? "font-mono" : ""}`}>{value}</p>
    </div>
  );
}

function Kpi({ label, value, destacado }: { label: string; value: number; destacado?: boolean }) {
  return (
    <Card className={`rounded-card border-cos-line p-4 shadow-card ${destacado ? "bg-cos-jade-tint" : ""}`}>
      <p className="text-[12px] font-medium text-cos-ink-soft">{label}</p>
      <p className={`mt-1 font-mono text-[18px] font-bold ${destacado ? "text-cos-jade-ink" : "text-cos-ink"}`}>
        {formatCurrency(value)}
      </p>
    </Card>
  );
}

function FilaMonto({ label, value, total, jade }: { label: string; value: number; total?: boolean; jade?: boolean }) {
  return (
    <div className={`flex items-center justify-between py-1 ${total ? "mt-1 border-t border-cos-line pt-1.5" : ""}`}>
      <span className={`text-[13px] ${total ? "font-semibold text-cos-ink" : "text-cos-ink-soft"}`}>{label}</span>
      <span className={`font-mono text-[13px] ${jade ? "font-bold text-cos-jade-ink" : total ? "font-semibold text-cos-ink" : "text-cos-ink"}`}>
        {formatCurrency(value)}
      </span>
    </div>
  );
}
