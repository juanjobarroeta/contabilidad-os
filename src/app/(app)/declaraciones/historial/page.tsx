"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Loader2, FileDown } from "lucide-react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { Card } from "@/components/ui";

interface Decl {
  id: string;
  tipo: string;
  periodo: string;
  status: string;
  isHistorical: boolean;
  isrPagar: number | null;
  isrIngresos: number | null;
  ivaPagar: number | null;
  ivaSaldoFavor: number | null;
  lineaCaptura: string | null;
  fechaPresentacion: string | null;
  tieneAcuse: boolean;
}

const MESES = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
const fmt = (n: number | null) => (n == null ? "—" : n.toLocaleString("es-MX", { style: "currency", currency: "MXN" }));

export default function HistorialDeclaracionesPage() {
  const { activeCompany } = useCompany();
  const [year, setYear] = useState(new Date().getFullYear());
  const [decls, setDecls] = useState<Decl[] | null>(null);

  const load = useCallback(async () => {
    if (!activeCompany) return;
    setDecls(null);
    const res = await fetch(`/api/declaraciones/historial?companyId=${activeCompany.id}&year=${year}`);
    setDecls(res.ok ? (await res.json()).declaraciones : []);
  }, [activeCompany, year]);

  useEffect(() => {
    load();
  }, [load]);

  if (!activeCompany) {
    return <div className="p-8 text-sm text-cos-ink-faint">Selecciona una empresa.</div>;
  }

  // Indexa por mes (1-12) y la anual.
  const byMes = new Map<number, { iva?: Decl; isr?: Decl }>();
  let anual: Decl | undefined;
  for (const d of decls ?? []) {
    if (d.tipo === "DECLARACION_ANUAL") { anual = d; continue; }
    const mes = Number(d.periodo.split("-")[1]);
    if (!mes) continue;
    const cell = byMes.get(mes) ?? {};
    if (d.tipo === "IVA_MENSUAL") cell.iva = d;
    else if (d.tipo === "ISR_PROVISIONAL") cell.isr = d;
    byMes.set(mes, cell);
  }
  const capturadas = (decls ?? []).length;

  const Acuse = ({ d }: { d?: Decl }) =>
    d?.tieneAcuse ? (
      <Link href={`/declaraciones/acuse/${d.id}`} className="text-cos-brand-ink hover:underline" title="Ver acuse PDF">
        <FileDown className="inline h-3.5 w-3.5" />
      </Link>
    ) : null;

  return (
    <div className="mx-auto max-w-[900px] px-4 py-6 sm:px-8 sm:py-8">
      <Link href="/declaraciones" className="inline-flex items-center gap-1 text-[13px] text-cos-ink-soft hover:text-cos-ink">
        <ChevronLeft className="h-4 w-4" /> Declaraciones
      </Link>
      <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[28px] font-semibold tracking-[-0.03em] text-cos-ink">Declaraciones presentadas</h1>
          <p className="mt-1 text-[14px] font-medium text-cos-brand-ink">
            {activeCompany.razonSocial} · <span className="font-mono text-cos-ink-soft">{activeCompany.rfc}</span>
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <button onClick={() => setYear((y) => y - 1)} aria-label="Año anterior" className="grid h-8 w-8 place-items-center rounded-control border border-cos-line hover:bg-cos-paper"><ChevronLeft className="h-4 w-4" /></button>
          <span className="min-w-[60px] text-center text-[17px] font-semibold text-cos-ink">{year}</span>
          <button onClick={() => setYear((y) => y + 1)} aria-label="Año siguiente" className="grid h-8 w-8 place-items-center rounded-control border border-cos-line hover:bg-cos-paper"><ChevronRight className="h-4 w-4" /></button>
        </div>
      </div>

      {decls === null ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-cos-ink-faint"><Loader2 className="h-5 w-5 animate-spin" /> Cargando…</div>
      ) : (
        <Card className="mt-5 overflow-hidden rounded-card border-cos-line shadow-card">
          <div className="grid grid-cols-[56px_1fr_1fr] gap-2 border-b border-cos-line px-4 py-2 text-[11.5px] font-medium uppercase tracking-[0.02em] text-cos-ink-faint">
            <span>Mes</span>
            <span>IVA mensual</span>
            <span>ISR provisional</span>
          </div>
          <div className="divide-y divide-cos-line">
            {MESES.map((m, i) => {
              const cell = byMes.get(i + 1) ?? {};
              return (
                <div key={m} className="grid grid-cols-[56px_1fr_1fr] items-center gap-2 px-4 py-2.5 text-[13.5px]">
                  <span className="font-medium text-cos-ink-soft">{m}</span>
                  <span className={cell.iva ? "text-cos-ink" : "text-cos-ink-faint"}>
                    {cell.iva ? (
                      <>
                        {cell.iva.ivaSaldoFavor && cell.iva.ivaSaldoFavor > 0
                          ? <span className="text-cos-jade-ink">{fmt(cell.iva.ivaSaldoFavor)} a favor</span>
                          : <>a pagar {fmt(cell.iva.ivaPagar)}</>}{" "}
                        <Acuse d={cell.iva} />
                      </>
                    ) : "—"}
                  </span>
                  <span className={cell.isr ? "text-cos-ink" : "text-cos-ink-faint"}>
                    {cell.isr ? <>a pagar {fmt(cell.isr.isrPagar)} <Acuse d={cell.isr} /></> : "—"}
                  </span>
                </div>
              );
            })}
            {/* Anual */}
            <div className="grid grid-cols-[56px_1fr_1fr] items-center gap-2 bg-cos-paper px-4 py-2.5 text-[13.5px]">
              <span className="font-semibold text-cos-ink">Anual</span>
              <span className="col-span-2 text-cos-ink">
                {anual ? (
                  <>
                    {anual.status === "FILED" || anual.status === "PAID" ? "Presentada" : anual.status}
                    {anual.isrPagar != null && <> · ISR {fmt(anual.isrPagar)}</>}{" "}
                    <Acuse d={anual} />
                  </>
                ) : <span className="text-cos-ink-faint">— (sin captura para {year})</span>}
              </span>
            </div>
          </div>
          <div className="border-t border-cos-line px-4 py-2 text-[12px] text-cos-ink-faint">
            {capturadas} declaracion{capturadas === 1 ? "" : "es"} capturada{capturadas === 1 ? "" : "s"} en {year}.
            {capturadas === 0 && " Si esperabas datos aquí, corre el backfill de Syntage o sube los acuses en Declaraciones."}
          </div>
        </Card>
      )}
    </div>
  );
}
