"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Cuotas IMSS (SIPARE) — tarjeta compacta de la vista amigable de nómina.
// Muestra el periodo cuyo vencimiento está en curso (el MES ANTERIOR: sus
// cuotas vencen el día 17 de este mes, LSS Art. 39): estimado desde la nómina
// timbrada (obrero/patronal y, en meses de cierre, Infonavit del bimestre),
// fecha límite con días restantes y el registro del pago en línea (monto
// precargado con el estimado y editable, línea de captura SIPARE y fecha).
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import { BadgeCheck, CalendarDays, Loader2, ShieldCheck } from "lucide-react";
import { Card } from "@/components/ui";
import { formatCurrency } from "@/lib/utils";

interface DeclRow {
  id: string;
  status: string;
  monto: number | null;
  lineaCaptura: string | null;
  fechaPresentacion: string | null;
}

interface BloquePago {
  fechaLimite: string;
  diasRestantes: number;
  vencida: boolean;
  declaracion: DeclRow | null;
  pagada: boolean;
}

interface EstadoImss {
  periodo: string;
  year: number;
  month: number;
  nomina: { tieneEmpleados: boolean; corridasDelMes: number; timbradasDelMes: number };
  mensual: BloquePago & { estimado: { imssObrero: number; imssPatronal: number; total: number } };
  bimestral:
    | (BloquePago & { etiqueta: string; estimado: { infonavit: number; total: number } })
    | null;
}

const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

function fmtFecha(iso: string): string {
  const [y, m, d] = iso.split("-").map((n) => parseInt(n));
  return `${d} de ${MESES[m - 1]} de ${y}`;
}

function hoyIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function ImssPagosCard({ companyId }: { companyId: string }) {
  const [estado, setEstado] = useState<EstadoImss | null>(null);
  const [loading, setLoading] = useState(true);

  // Periodo con vencimiento en curso: el mes anterior.
  const now = new Date();
  const year = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  const month = now.getMonth() === 0 ? 12 : now.getMonth();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/impuestos/imss?companyId=${companyId}&year=${year}&month=${month}`);
      if (res.ok) setEstado(await res.json());
    } finally {
      setLoading(false);
    }
  }, [companyId, year, month]);

  useEffect(() => { load(); }, [load]);

  // Sin empleados ni nómina en el mes: no hay cuotas que enterar — la tarjeta
  // no aplica y no ocupa espacio.
  if (loading || !estado) return null;
  if (!estado.nomina.tieneEmpleados && estado.nomina.corridasDelMes === 0) return null;

  const m = estado.mensual;
  const todoPagado = m.pagada && (estado.bimestral == null || estado.bimestral.pagada);
  // Hay corridas del mes pero ninguna timbrada: el estimado sale en $0 porque
  // sólo cuenta la nómina timbrada — mostramos un estado explicativo en vez de
  // renglones en ceros con el botón activo.
  const sinTimbrar = estado.nomina.corridasDelMes > 0 && estado.nomina.timbradasDelMes === 0;
  const mesLabel = `${MESES[estado.month - 1]} de ${estado.year}`;

  return (
    <Card className="rounded-card border-cos-line p-5 shadow-card">
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <span className="rounded-full bg-cos-brand-tint px-2.5 py-1 text-[13px] font-semibold text-cos-brand-ink">
          Cuotas IMSS (SIPARE)
        </span>
        {todoPagado ? (
          <span className="inline-flex items-center gap-1 text-[13px] font-semibold text-cos-jade-ink">
            <BadgeCheck className="h-4 w-4" /> Pagadas
          </span>
        ) : (
          <span className={`inline-flex items-center gap-1 text-[13px] font-semibold ${m.vencida ? "text-cos-red-ink" : "text-cos-amber-ink"}`}>
            <CalendarDays className="h-4 w-4" />
            {m.vencida
              ? `Venció el ${fmtFecha(m.fechaLimite)}`
              : m.diasRestantes === 0
                ? "Vence HOY"
                : `Vence el ${fmtFecha(m.fechaLimite)} (${m.diasRestantes} día${m.diasRestantes === 1 ? "" : "s"})`}
          </span>
        )}
      </div>

      <p className="mb-3.5 text-[13.5px] leading-relaxed text-cos-ink-soft">
        Cuotas obrero-patronales de {MESES[estado.month - 1]} de {estado.year} — se pagan con línea de
        captura SIPARE a más tardar el día 17 del mes siguiente.
      </p>

      <BloqueRegistro
        companyId={companyId}
        year={estado.year}
        month={estado.month}
        ambito="MENSUAL"
        titulo="Pago mensual"
        bloque={m}
        estimadoTotal={m.estimado.total}
        renglones={[
          { label: "IMSS obrero (retenido)", value: m.estimado.imssObrero },
          { label: "IMSS patronal (incluye RCV)", value: m.estimado.imssPatronal },
        ]}
        sinTimbrar={sinTimbrar}
        mesLabel={mesLabel}
        onSaved={load}
      />

      {estado.bimestral && (
        <div className="mt-4 border-t border-cos-line pt-3.5">
          <BloqueRegistro
            companyId={companyId}
            year={estado.year}
            month={estado.month}
            ambito="BIMESTRAL"
            titulo={`Bimestre ${estado.bimestral.etiqueta}: RCV e Infonavit`}
            bloque={estado.bimestral}
            estimadoTotal={estado.bimestral.estimado.total}
            renglones={[
              { label: "Amortizaciones Infonavit retenidas", value: estado.bimestral.estimado.infonavit },
            ]}
            sinTimbrar={sinTimbrar}
            mesLabel={mesLabel}
            onSaved={load}
          />
        </div>
      )}

      <p className="mt-3 flex items-start gap-1.5 text-[12px] leading-relaxed text-cos-ink-faint">
        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 flex-none" />
        <span>
          Estimado desde tu nómina timbrada — el SUA determina la cifra exacta (el estimado mensual
          incluye RCV, que se entera por bimestre, y el bimestral no incluye la aportación patronal de
          vivienda del 5%). Ajusta el monto al registrar el pago.
        </span>
      </p>
    </Card>
  );
}

function BloqueRegistro({
  companyId,
  year,
  month,
  ambito,
  titulo,
  bloque,
  estimadoTotal,
  renglones,
  sinTimbrar,
  mesLabel,
  onSaved,
}: {
  companyId: string;
  year: number;
  month: number;
  ambito: "MENSUAL" | "BIMESTRAL";
  titulo: string;
  bloque: BloquePago;
  estimadoTotal: number;
  renglones: Array<{ label: string; value: number }>;
  sinTimbrar: boolean;
  mesLabel: string;
  onSaved: () => void;
}) {
  const decl = bloque.declaracion;
  // Prellena con el estimado sólo cuando es mayor a cero — un "0" suelto en el
  // spinner confunde más de lo que ayuda.
  const montoInicial = decl?.monto ?? (estimadoTotal > 0 ? estimadoTotal : null);
  const [monto, setMonto] = useState(montoInicial != null ? String(montoInicial) : "");
  const [lineaCaptura, setLineaCaptura] = useState(decl?.lineaCaptura ?? "");
  const [fecha, setFecha] = useState(decl?.fechaPresentacion?.slice(0, 10) ?? hoyIso());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Estado "sin timbrar": el registrar queda colapsado tras un enlace — el
  // usuario aún puede pagar con base en el SUA si así lo decide.
  const estimadoPendiente = sinTimbrar && estimadoTotal === 0 && !bloque.pagada && !decl;
  const [mostrarForm, setMostrarForm] = useState(false);

  async function registrar() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/impuestos/imss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId,
          year,
          month,
          ambito,
          monto: parseFloat(monto) || 0,
          lineaCaptura: lineaCaptura.trim() || null,
          fechaPresentacion: fecha || null,
          status: "PAID",
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.error ?? "No se pudo registrar el pago.");
        return;
      }
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[13px] font-semibold text-cos-ink">{titulo}</span>
        {bloque.pagada && (
          <span className="inline-flex items-center gap-1 text-[12.5px] font-semibold text-cos-jade-ink">
            <BadgeCheck className="h-3.5 w-3.5" /> Pagado
          </span>
        )}
      </div>
      {estimadoPendiente ? (
        <p className="py-0.5 text-[13px] leading-relaxed text-cos-ink-soft">
          La nómina de {mesLabel} está calculada pero sin timbrar — el estimado se calcula al
          timbrar. Timbra en{" "}
          <a href="/nomina?tab=corridas" className="font-medium text-cos-brand-ink underline underline-offset-2">
            Corridas
          </a>.
        </p>
      ) : (
        <>
          {renglones.map((r) => (
            <div key={r.label} className="flex items-center justify-between gap-2 py-0.5">
              <span className="min-w-0 text-[13px] text-cos-ink-soft">{r.label}</span>
              <span className="whitespace-nowrap font-mono text-[13.5px] text-cos-ink">{formatCurrency(r.value)}</span>
            </div>
          ))}
          <div className="flex items-center justify-between gap-2 border-t border-cos-line py-1">
            <span className="text-[13px] font-semibold text-cos-ink">Total estimado</span>
            <span className="whitespace-nowrap font-mono text-[14px] font-bold text-cos-ink">{formatCurrency(estimadoTotal)}</span>
          </div>
        </>
      )}

      {bloque.pagada && decl ? (
        <p className="mt-1.5 text-[12.5px] text-cos-ink-soft">
          Pagado {formatCurrency(decl.monto ?? 0)}
          {decl.fechaPresentacion ? ` el ${fmtFecha(decl.fechaPresentacion.slice(0, 10))}` : ""}
          {decl.lineaCaptura ? ` · línea de captura ${decl.lineaCaptura}` : ""}.
        </p>
      ) : estimadoPendiente && !mostrarForm ? (
        <button
          onClick={() => setMostrarForm(true)}
          className="mt-1.5 text-[12.5px] font-medium text-cos-brand-ink underline underline-offset-2 hover:opacity-80"
        >
          Registrar pago de todos modos
        </button>
      ) : (
        <div className="mt-2.5">
          {/* En móvil los campos se apilan a lo ancho; en sm+ vuelven a una fila. */}
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end">
            <label className="flex flex-col gap-1 text-[12px] font-medium text-cos-ink-soft sm:w-[130px]">
              Monto pagado
              <input
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                value={monto}
                onChange={(e) => setMonto(e.target.value)}
                placeholder="0.00"
                className="w-full rounded-control border border-cos-line bg-cos-card px-2.5 py-2 font-mono text-[13px] text-cos-ink"
              />
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-[12px] font-medium text-cos-ink-soft sm:min-w-[180px] sm:flex-1">
              Línea de captura (opcional)
              <input
                value={lineaCaptura}
                onChange={(e) => setLineaCaptura(e.target.value)}
                placeholder="Línea de captura SIPARE"
                className="w-full rounded-control border border-cos-line bg-cos-card px-2.5 py-2 text-[13px] text-cos-ink"
              />
            </label>
            <label className="flex flex-col gap-1 text-[12px] font-medium text-cos-ink-soft">
              Fecha de pago
              <input
                type="date"
                value={fecha}
                onChange={(e) => setFecha(e.target.value)}
                className="w-full rounded-control border border-cos-line bg-cos-card px-2.5 py-2 text-[13px] text-cos-ink"
              />
            </label>
            <button
              onClick={registrar}
              disabled={saving}
              className="inline-flex items-center justify-center gap-1.5 rounded-control bg-cos-brand px-3 py-2 text-[13px] font-semibold text-white hover:bg-cos-brand-deep disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <BadgeCheck className="h-4 w-4" />}
              Registrar pago
            </button>
          </div>
          {error && <p className="mt-1.5 text-[12.5px] text-cos-red-ink">{error}</p>}
        </div>
      )}
    </div>
  );
}
