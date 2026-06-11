"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, CalendarDays, Sparkles, ChevronRight as ChevronR, Loader2, SlidersHorizontal } from "lucide-react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { Card, Money, Loading } from "@/components/ui";

interface ImpuestosData {
  iva: {
    trasladado: number; acreditable: number; acreditableBruto: number;
    proporcionAcreditamiento: number; actosGravados: number; actosExentos: number;
    retenidoPorClientes: number; saldoFavorAnterior: number; pagar: number; saldoAFavor: number;
  };
  isr: {
    metodo: "PM_ART14" | "PF_ACT_EMPRESARIAL" | "RESICO_PF";
    ingresosDelMes: number; gastosDelMes: number; ingresosAcumulados: number;
    coeficiente: number | null; coeficienteFuente: "manual" | "declaracion_anual" | "calculado" | "ninguno";
    baseGravable: number | null; isrPagar: number | null;
    retencionesAcreditadas: number; saldoAFavor: number; tarifaVerificada: boolean;
  };
}
interface SimResult {
  base: { iva: number; isr: number | null; total: number };
  sim: { iva: number; isr: number | null; total: number };
}

const MONTHS = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
const MES_ABBR = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
const LBL = "block text-[12.5px] font-medium uppercase tracking-[0.02em] text-cos-ink-faint";
const peso = (n: number) => "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function Delta({ from, to }: { from: number | null; to: number | null }) {
  if (from == null || to == null) return null;
  const d = to - from;
  if (Math.abs(d) < 0.005) return <span className="font-mono text-[12px] font-medium text-cos-ink-faint">sin cambio</span>;
  const up = d > 0;
  return (
    <span className={`font-mono text-[12px] font-medium ${up ? "text-cos-red-ink" : "text-cos-jade-ink"}`}>
      {up ? "▲" : "▼"} {peso(d)}
    </span>
  );
}

export default function ImpuestosPage() {
  const { activeCompany } = useCompany();
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [data, setData] = useState<ImpuestosData | null>(null);
  const [loading, setLoading] = useState(false);

  const [addIng, setAddIng] = useState("");
  const [addGas, setAddGas] = useState("");
  const [sim, setSim] = useState<SimResult | null>(null);
  const [simBusy, setSimBusy] = useState(false);

  const fetchData = useCallback(async () => {
    if (!activeCompany) return;
    setLoading(true); setSim(null);
    try {
      const res = await fetch(`/api/impuestos?companyId=${activeCompany.id}&month=${month}&year=${year}`);
      setData(await res.json());
    } finally { setLoading(false); }
  }, [activeCompany, month, year]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Debounced simulation against the real fiscal engine.
  const simSeq = useRef(0);
  useEffect(() => {
    const ai = parseFloat(addIng) || 0;
    const ag = parseFloat(addGas) || 0;
    if (!activeCompany || (ai <= 0 && ag <= 0)) { setSim(null); setSimBusy(false); return; }
    setSimBusy(true);
    const seq = ++simSeq.current;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/impuestos/simular?companyId=${activeCompany.id}&month=${month}&year=${year}&addIngreso=${ai}&addGasto=${ag}`);
        const json = await res.json();
        if (seq === simSeq.current) setSim(json);
      } finally {
        if (seq === simSeq.current) setSimBusy(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [addIng, addGas, activeCompany, month, year]);

  function shiftMonth(delta: number) {
    let m = month + delta, y = year;
    if (m < 1) { m = 12; y -= 1; }
    if (m > 12) { m = 1; y += 1; }
    setMonth(m); setYear(y); setAddIng(""); setAddGas("");
  }

  if (!activeCompany) return <div className="p-8 text-sm text-cos-ink-faint">Selecciona una empresa.</div>;

  const totalPagar = data ? data.iva.pagar + (data.isr.isrPagar ?? 0) : 0;
  const due = new Date(year, month, 17);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const dias = Math.round((due.getTime() - today.getTime()) / 86400000);
  const venceFmt = `${due.getDate()} ${MES_ABBR[due.getMonth()]} ${due.getFullYear()}`;
  const venceLine = dias >= 0 ? `Vence el ${venceFmt} · faltan ${dias} días` : `Venció el ${venceFmt} · hace ${Math.abs(dias)} días`;
  const simOn = (parseFloat(addIng) || 0) > 0 || (parseFloat(addGas) || 0) > 0;

  const coefProvenance = (d: ImpuestosData) => {
    if (d.isr.coeficiente == null) return "Falta tu declaración anual — sin coeficiente";
    const pct = `${(d.isr.coeficiente * 100).toFixed(2)}%`;
    if (d.isr.coeficienteFuente === "manual") return `Coeficiente ${pct} · ajuste del contador`;
    if (d.isr.coeficienteFuente === "declaracion_anual") return `Coeficiente ${pct} · de tu declaración anual ${year - 1}`;
    if (d.isr.coeficienteFuente === "calculado") return `Coeficiente ${pct} · estimado de tus CFDIs ${year - 1}`;
    return `Coeficiente ${pct}`;
  };

  return (
    <div className="mx-auto max-w-[1000px] px-4 py-6 sm:px-8 sm:py-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[30px] font-semibold leading-[1.05] tracking-[-0.03em] text-cos-ink">Impuestos</h1>
          <p className="mt-1.5 max-w-[60ch] text-[15px] text-cos-ink-soft">Lo que le toca pagar al SAT este mes, explicado sin tecnicismos.</p>
        </div>
        <div className="flex items-center gap-2.5 font-semibold text-cos-ink">
          <button onClick={() => shiftMonth(-1)} aria-label="Mes anterior" className="grid h-8 w-8 place-items-center rounded-control border border-cos-line hover:bg-cos-paper"><ChevronLeft className="h-4 w-4" /></button>
          <span className="min-w-[120px] text-center">{MONTHS[month - 1]} {year}</span>
          <button onClick={() => shiftMonth(1)} aria-label="Mes siguiente" className="grid h-8 w-8 place-items-center rounded-control border border-cos-line hover:bg-cos-paper"><ChevronRight className="h-4 w-4" /></button>
        </div>
      </div>

      {loading || !data ? (
        <Loading label="Calculando impuestos…" className="py-16" />
      ) : (
        <div className="mt-4 space-y-5">
          {/* banner */}
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-card bg-gradient-to-br from-cos-brand to-cos-brand-deep px-6 py-6 text-white shadow-[0_16px_36px_-20px_var(--brand)]">
            <div>
              <span className="block text-[12.5px] font-medium uppercase tracking-[0.02em] text-white/75">Total a pagar este mes</span>
              <div className="my-1.5"><Money value={totalPagar} size={42} weight={700} className="text-white" /></div>
              <span className="inline-flex items-center gap-1.5 text-[13.5px] text-white/85"><CalendarDays className="h-[15px] w-[15px]" /> {venceLine}</span>
            </div>
            <Link href="/impuestos/cierre" className="inline-flex items-center gap-1.5 rounded-control bg-white px-4 py-2.5 text-[14px] font-semibold text-cos-brand-ink hover:bg-cos-brand-tint">
              ¿Cómo lo pago? <ChevronR className="h-[15px] w-[15px]" />
            </Link>
          </div>

          {/* IVA + ISR */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card className="rounded-card border-cos-line p-5 shadow-card">
              <div className="mb-2.5 flex items-center justify-between">
                <span className="rounded-full bg-cos-brand-tint px-2.5 py-1 text-[13px] font-semibold text-cos-brand-ink">IVA mensual</span>
                <Money value={data.iva.pagar} size={22} weight={700} />
              </div>
              <p className="mb-3.5 text-[13.5px] leading-relaxed text-cos-ink-soft">El IVA que cobras a tus clientes <b>no es tuyo</b> — se lo juntas al SAT. A eso le restas el IVA que tú pagaste en gastos con factura.</p>
              <Row label="IVA que cobraste" value={data.iva.trasladado} />
              <Row
                label={
                  data.iva.proporcionAcreditamiento < 1
                    ? `IVA que pagaste, acreditable al ${(data.iva.proporcionAcreditamiento * 100).toFixed(0)}%`
                    : "IVA que pagaste (gastos)"
                }
                value={-data.iva.acreditable}
                negative
              />
              <Row label="A pagar" value={data.iva.pagar} total />
              {data.iva.proporcionAcreditamiento < 1 && (
                <p className="mt-2 text-[12px] text-cos-ink-faint">
                  Facturaste actos exentos este mes — por ley (Art. 5 LIVA) solo se acredita la
                  proporción gravada de tu IVA pagado.
                </p>
              )}
            </Card>

            <Card className="rounded-card border-cos-line p-5 shadow-card">
              <div className="mb-2.5 flex items-center justify-between">
                <span className="rounded-full bg-cos-brand-tint px-2.5 py-1 text-[13px] font-semibold text-cos-brand-ink">ISR · anticipo</span>
                {data.isr.isrPagar == null ? <span className="font-mono text-[15px] text-cos-ink-faint">No calculado</span> : <Money value={data.isr.isrPagar} size={22} weight={700} />}
              </div>
              <p className="mb-3.5 text-[13.5px] leading-relaxed text-cos-ink-soft">El ISR es el impuesto sobre <b>lo que ganas</b>. Cada mes pagas un anticipo; en la declaración anual se ajusta.</p>
              {data.isr.metodo === "PM_ART14" ? (
                <>
                  <Row label="Ingresos acumulados" value={data.isr.ingresosAcumulados} />
                  <Row label="× Coeficiente" valueText={data.isr.coeficiente != null ? `${(data.isr.coeficiente * 100).toFixed(2)}%` : "—"} />
                  <Row label="Anticipo a pagar" value={data.isr.isrPagar ?? 0} total />
                  <p className="mt-2 text-[12px] text-cos-ink-faint">{coefProvenance(data)}</p>
                </>
              ) : (
                <>
                  <Row label="Ingresos del mes" value={data.isr.ingresosDelMes} />
                  <Row label="Gastos del mes" value={-data.isr.gastosDelMes} negative />
                  <Row label="Anticipo a pagar" value={data.isr.isrPagar ?? 0} total />
                  {data.isr.saldoAFavor > 0 && (
                    <p className="mt-2 text-[12px] text-cos-jade-ink">
                      Te retuvieron más ISR del que causaste: {peso(data.isr.saldoAFavor)} queda a tu favor para el siguiente mes.
                    </p>
                  )}
                </>
              )}
              {!data.isr.tarifaVerificada && <p className="mt-2.5 text-[12px] text-cos-amber-ink">Tarifa ISR sin verificar contra Anexo 8 — cifra provisional.</p>}
            </Card>
          </div>

          {/* expert depth: link to detailed workspace */}
          <Link href="/impuestos/detalle" className="flex items-center gap-3 rounded-card border border-dashed border-cos-line bg-white px-5 py-4 text-[14px] text-cos-ink-soft hover:border-cos-brand hover:text-cos-brand-ink">
            <SlidersHorizontal className="h-[18px] w-[18px] flex-none" />
            <span className="flex-1">Cálculo a detalle — ajustar coeficiente, saldo a favor, precierre y declaración</span>
            <ChevronR className="h-4 w-4 flex-none" />
          </Link>

          {/* simulador (real engine) */}
          <Card className="rounded-card border-cos-line p-5 shadow-card">
            <div className="mb-4 flex items-start gap-3">
              <span className="grid h-[30px] w-[30px] flex-none place-items-center rounded-[9px] bg-cos-brand text-white"><Sparkles className="h-4 w-4" /></span>
              <div>
                <h3 className="text-[17px] font-semibold text-cos-ink">Simula antes de facturar</h3>
                <p className="mt-1 max-w-[54ch] text-[13.5px] text-cos-ink-soft">¿Qué pasa con tus impuestos si facturas un ingreso o un gasto más? Escribe un monto y míralo al instante — con tu cálculo real, no una estimación.</p>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
              <SimInput label="+ Ingreso (sin IVA)" value={addIng} onChange={setAddIng} />
              <SimInput label="+ Gasto con factura (sin IVA)" value={addGas} onChange={setAddGas} />
            </div>
            {simOn ? (
              <div className="mt-[18px] grid grid-cols-1 gap-3 border-t border-cos-line pt-[18px] sm:grid-cols-3">
                <SimOut label="Nuevo IVA" value={sim?.sim.iva ?? null} base={sim?.base.iva ?? null} busy={simBusy} />
                <SimOut label="Nuevo ISR" value={sim?.sim.isr ?? null} base={sim?.base.isr ?? null} busy={simBusy} />
                <SimOut label="Nuevo total" value={sim?.sim.total ?? null} base={sim?.base.total ?? null} busy={simBusy} highlight />
              </div>
            ) : (
              <p className="mt-4 text-[13.5px] text-cos-ink-faint">Escribe un monto arriba para ver el impacto.</p>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}

function Row({ label, value, valueText, negative, total }: { label: string; value?: number; valueText?: string; negative?: boolean; total?: boolean }) {
  return (
    <div className={`flex items-center justify-between gap-3 py-2.5 text-[14px] ${total ? "border-t border-cos-line font-semibold text-cos-ink" : "border-t border-cos-line-soft text-cos-ink-soft first:border-t-0"}`}>
      <span className="whitespace-nowrap">{label}</span>
      {valueText != null ? (
        <span className="font-mono text-[15px]">{valueText}</span>
      ) : negative ? (
        <span className="font-mono text-[15px] tabular-nums text-cos-red-ink">−{peso(value ?? 0)}</span>
      ) : (
        <Money value={value ?? 0} size={total ? 16 : 15} weight={total ? 700 : 500} />
      )}
    </div>
  );
}

function SimInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex flex-col gap-2 text-[13px] font-medium text-cos-ink-soft">
      <span>{label}</span>
      <div className="flex items-center gap-1.5 rounded-control border border-cos-line bg-white px-3.5 focus-within:border-cos-brand focus-within:ring-[3px] focus-within:ring-cos-brand-tint">
        <i className="font-mono not-italic text-cos-ink-faint">$</i>
        <input type="number" inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} placeholder="0.00" className="w-full border-0 bg-transparent py-3 font-mono text-[16px] text-cos-ink outline-none" />
      </div>
    </label>
  );
}

function SimOut({ label, value, base, busy, highlight }: { label: string; value: number | null; base: number | null; busy: boolean; highlight?: boolean }) {
  return (
    <div className={`flex flex-col gap-1 rounded-[12px] p-3.5 ${highlight ? "bg-cos-brand-tint" : "bg-cos-paper"}`}>
      <span className="text-[12px] font-medium text-cos-ink-faint">{label}</span>
      {busy && value == null ? (
        <Loader2 className="h-5 w-5 animate-spin text-cos-ink-faint" />
      ) : value == null ? (
        <span className="font-mono text-[20px] font-bold text-cos-ink-faint">—</span>
      ) : (
        <><Money value={value} size={20} weight={700} /><Delta from={base} to={value} /></>
      )}
    </div>
  );
}
