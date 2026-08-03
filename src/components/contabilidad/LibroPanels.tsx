"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Libro diario, auxiliar de cuenta y balance general — la capa visible de las
// pólizas. El folio que se muestra es el MISMO NumUnIdenPol del XML del Anexo
// 24 (misma agrupación derivada — ver lib/contabilidad/libro.ts). Drill-down:
// balanza → auxiliar → póliza → CFDI (representación impresa).
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, Scale, ScrollText, CheckCircle2, AlertTriangle, X } from "lucide-react";
import { Money } from "@/components/ui";
import { formatCurrency } from "@/lib/utils";
import { RepresentacionImpresa } from "@/components/facturas/RepresentacionImpresa";

const FUENTE_LABEL: Record<string, string> = {
  CFDI: "CFDI", NOMINA: "Nómina", BANCO: "Banco", MANUAL: "Manual",
  APERTURA: "Apertura", CIERRE: "Cierre", CONSTRUCCION: "Construcción",
  FLOTA: "Flota", PADEL: "Padel", PURIFICADORA: "Purificadora",
  RESTAURANTE: "Restaurante", AUTOMOTRIZ: "Automotriz", JCPT: "JCPT",
};

interface PolizaVista {
  folio: string;
  fecha: string;
  concepto: string;
  fuente: string;
  referencia: string | null;
  referenciaTipo: string | null;
  totalCargos: number;
  totalAbonos: number;
  cuadrada: boolean;
  transacciones: Array<{ entryId: string; numCta: string; desCta: string; concepto: string; cargo: number; abono: number }>;
}

function Cargando() {
  return (
    <div className="flex items-center gap-2 text-sm text-cos-ink-soft py-8 justify-center">
      <Loader2 className="h-4 w-4 animate-spin" /> Cargando…
    </div>
  );
}

function Vacio({ texto }: { texto: string }) {
  return (
    <div className="bg-cos-card border border-dashed border-cos-line rounded-xl p-12 text-center">
      <ScrollText className="h-10 w-10 text-cos-ink-soft mx-auto mb-3 opacity-30" />
      <p className="text-sm text-cos-ink-soft">{texto}</p>
    </div>
  );
}

// ── Libro diario ─────────────────────────────────────────────────────────────

export function LibroDiarioPanel({ companyId, year, month }: { companyId: string; year: number; month: number }) {
  const [polizas, setPolizas] = useState<PolizaVista[]>([]);
  const [invoiceIdPorUuid, setInvoiceIdPorUuid] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [abierta, setAbierta] = useState<string | null>(null);
  const [repInvoiceId, setRepInvoiceId] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const res = await fetch(`/api/contabilidad/libro-diario?companyId=${companyId}&year=${year}&month=${month}`);
      const d = await res.json();
      setPolizas(d.polizas ?? []);
      setInvoiceIdPorUuid(d.invoiceIdPorUuid ?? {});
      setLoading(false);
    })();
  }, [companyId, year, month]);

  if (loading) return <Cargando />;
  if (polizas.length === 0) return <Vacio texto="Sin pólizas en este periodo. Cierra el mes desde «Cierres mensuales»." />;

  const totalCargos = polizas.reduce((s, p) => s + p.totalCargos, 0);
  const totalAbonos = polizas.reduce((s, p) => s + p.totalAbonos, 0);

  return (
    <div>
      <p className="text-xs text-cos-ink-soft mb-3">
        {polizas.length} póliza{polizas.length === 1 ? "" : "s"} · el folio coincide con el XML de Pólizas del Periodo (Anexo 24)
        · cargos {formatCurrency(totalCargos)} · abonos {formatCurrency(totalAbonos)}
      </p>
      <div className="bg-cos-card border border-cos-line rounded-xl overflow-hidden">
        {polizas.map((p) => {
          const abiertaEsta = abierta === p.folio;
          return (
            <div key={p.folio} className="border-b border-cos-line last:border-0">
              <button
                onClick={() => setAbierta(abiertaEsta ? null : p.folio)}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-cos-paper/50"
              >
                {abiertaEsta ? <ChevronDown className="h-4 w-4 text-cos-ink-faint" /> : <ChevronRight className="h-4 w-4 text-cos-ink-faint" />}
                <span className="font-mono text-xs text-cos-ink-soft w-10">#{p.folio}</span>
                <span className="font-mono text-xs text-cos-ink-soft w-20">{p.fecha}</span>
                <span className="flex-1 min-w-0 truncate text-sm text-cos-ink">{p.concepto}</span>
                <span className="rounded-full bg-cos-slate-tint px-2 py-0.5 text-[11px] text-cos-ink-soft">{FUENTE_LABEL[p.fuente] ?? p.fuente}</span>
                <span className="font-mono text-xs w-28 text-right">{formatCurrency(p.totalCargos)}</span>
                {p.cuadrada ? (
                  <CheckCircle2 className="h-4 w-4 text-cos-jade-ink" aria-label="Cuadrada" />
                ) : (
                  <AlertTriangle className="h-4 w-4 text-cos-amber-ink" aria-label="Descuadrada" />
                )}
              </button>
              {abiertaEsta && (
                <div className="px-11 pb-3">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-cos-ink-faint">
                        <th className="text-left py-1 font-medium">Cuenta</th>
                        <th className="text-left py-1 font-medium">Concepto</th>
                        <th className="text-right py-1 font-medium">Cargo</th>
                        <th className="text-right py-1 font-medium">Abono</th>
                      </tr>
                    </thead>
                    <tbody>
                      {p.transacciones.map((t) => (
                        <tr key={t.entryId} className="border-t border-cos-line/60">
                          <td className="py-1 pr-3 font-mono whitespace-nowrap">{t.numCta} <span className="font-sans text-cos-ink-soft">{t.desCta}</span></td>
                          <td className="py-1 pr-3 text-cos-ink-soft">{t.concepto}</td>
                          <td className="py-1 text-right font-mono">{t.cargo > 0 ? formatCurrency(t.cargo) : "—"}</td>
                          <td className="py-1 text-right font-mono">{t.abono > 0 ? formatCurrency(t.abono) : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {p.referenciaTipo === "CFDI" && p.referencia && invoiceIdPorUuid[p.referencia] && (
                    <button
                      onClick={() => setRepInvoiceId(invoiceIdPorUuid[p.referencia!])}
                      className="mt-2 text-[11.5px] font-medium text-cos-brand-ink underline hover:opacity-80"
                    >
                      Ver CFDI {p.referencia.slice(0, 8)}…
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {repInvoiceId && <RepresentacionImpresa invoiceId={repInvoiceId} onClose={() => setRepInvoiceId(null)} />}
    </div>
  );
}

// ── Auxiliar de cuenta (modal, drill-down desde la balanza) ──────────────────

interface AuxiliarData {
  cuenta: string;
  nombre: string;
  saldoInicial: number;
  movimientos: Array<{
    entryId: string; fecha: string; folioPoliza: string; concepto: string;
    fuente: string; referencia: string | null; referenciaTipo: string | null;
    cargo: number; abono: number; saldo: number;
  }>;
  totalCargos: number;
  totalAbonos: number;
  saldoFinal: number;
  invoiceIdPorUuid: Record<string, string>;
}

export function AuxiliarCuentaModal({
  companyId, year, month, cuenta, onClose,
}: { companyId: string; year: number; month: number; cuenta: string; onClose: () => void }) {
  const [data, setData] = useState<AuxiliarData | null>(null);
  const [loading, setLoading] = useState(true);
  const [repInvoiceId, setRepInvoiceId] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const res = await fetch(`/api/contabilidad/auxiliar?companyId=${companyId}&year=${year}&month=${month}&cuenta=${encodeURIComponent(cuenta)}`);
      setData(res.ok ? await res.json() : null);
      setLoading(false);
    })();
  }, [companyId, year, month, cuenta]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-10" onClick={onClose}>
      <div className="w-full max-w-[860px] rounded-xl border border-cos-line bg-cos-card shadow-card" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-cos-line px-5 py-3">
          <div>
            <p className="text-sm font-semibold text-cos-ink">
              Auxiliar · <span className="font-mono">{cuenta}</span> {data?.nombre ?? ""}
            </p>
            <p className="text-xs text-cos-ink-soft">{String(month).padStart(2, "0")}/{year}</p>
          </div>
          <button onClick={onClose} className="rounded p-1 text-cos-ink-faint hover:bg-cos-paper"><X className="h-4 w-4" /></button>
        </div>
        <div className="p-5">
          {loading ? (
            <Cargando />
          ) : !data ? (
            <p className="text-sm text-cos-red-ink">No se pudo cargar el auxiliar.</p>
          ) : (
            <>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-cos-ink-faint border-b border-cos-line">
                    <th className="text-left py-1.5 font-medium">Fecha</th>
                    <th className="text-left py-1.5 font-medium">Póliza</th>
                    <th className="text-left py-1.5 font-medium">Concepto</th>
                    <th className="text-right py-1.5 font-medium">Cargo</th>
                    <th className="text-right py-1.5 font-medium">Abono</th>
                    <th className="text-right py-1.5 font-medium">Saldo</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b border-cos-line/60 text-cos-ink-soft">
                    <td className="py-1.5" colSpan={5}>Saldo inicial</td>
                    <td className="py-1.5 text-right font-mono font-semibold"><Money value={data.saldoInicial} /></td>
                  </tr>
                  {data.movimientos.map((m) => (
                    <tr key={m.entryId} className="border-b border-cos-line/60">
                      <td className="py-1.5 font-mono whitespace-nowrap">{m.fecha}</td>
                      <td className="py-1.5 font-mono">#{m.folioPoliza}</td>
                      <td className="py-1.5 pr-2">
                        <span className="text-cos-ink">{m.concepto}</span>{" "}
                        {m.referenciaTipo === "CFDI" && m.referencia && data.invoiceIdPorUuid[m.referencia] && (
                          <button onClick={() => setRepInvoiceId(data.invoiceIdPorUuid[m.referencia!])}
                            className="text-[10.5px] font-medium text-cos-brand-ink underline hover:opacity-80">CFDI</button>
                        )}
                      </td>
                      <td className="py-1.5 text-right font-mono">{m.cargo > 0 ? formatCurrency(m.cargo) : "—"}</td>
                      <td className="py-1.5 text-right font-mono">{m.abono > 0 ? formatCurrency(m.abono) : "—"}</td>
                      <td className="py-1.5 text-right font-mono"><Money value={m.saldo} /></td>
                    </tr>
                  ))}
                  <tr className="font-semibold">
                    <td className="py-1.5" colSpan={3}>Totales del periodo</td>
                    <td className="py-1.5 text-right font-mono">{formatCurrency(data.totalCargos)}</td>
                    <td className="py-1.5 text-right font-mono">{formatCurrency(data.totalAbonos)}</td>
                    <td className="py-1.5 text-right font-mono"><Money value={data.saldoFinal} /></td>
                  </tr>
                </tbody>
              </table>
              {data.movimientos.length === 0 && (
                <p className="mt-3 text-xs text-cos-ink-soft">Sin movimientos en el periodo — el saldo viene de meses anteriores.</p>
              )}
            </>
          )}
        </div>
      </div>
      {repInvoiceId && <RepresentacionImpresa invoiceId={repInvoiceId} onClose={() => setRepInvoiceId(null)} />}
    </div>
  );
}

// ── Balance general ──────────────────────────────────────────────────────────

interface BalanceGeneralData {
  activo: Array<{ cuenta: string; nombre: string; monto: number }>;
  pasivo: Array<{ cuenta: string; nombre: string; monto: number }>;
  capital: Array<{ cuenta: string; nombre: string; monto: number }>;
  totalActivo: number;
  totalPasivo: number;
  totalCapital: number;
  resultadoEnCurso: number;
  descuadre: number;
}

export function BalanceGeneralPanel({ companyId, year, month }: { companyId: string; year: number; month: number }) {
  const [data, setData] = useState<BalanceGeneralData | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const res = await fetch(`/api/contabilidad/balance-general?companyId=${companyId}&year=${year}&month=${month}`);
      setData(res.ok ? await res.json() : null);
      setLoading(false);
    })();
  }, [companyId, year, month]);

  if (loading) return <Cargando />;
  if (!data || (data.activo.length === 0 && data.pasivo.length === 0 && data.capital.length === 0)) {
    return <Vacio texto="Sin saldos acumulados a este periodo. Cierra meses desde «Cierres mensuales»." />;
  }

  const cuadra = Math.abs(data.descuadre) < 0.01;

  return (
    <div>
      <div className={`mb-4 flex items-center gap-2 rounded-lg border px-4 py-2.5 text-sm ${
        cuadra ? "border-cos-jade-ink/25 bg-cos-jade-tint text-cos-jade-ink" : "border-cos-amber-ink/25 bg-cos-amber-tint text-cos-amber-ink"
      }`}>
        {cuadra ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
        {cuadra
          ? "La ecuación contable cuadra: Activo = Pasivo + Capital (incluido el resultado en curso)."
          : `Descuadre de ${formatCurrency(Math.abs(data.descuadre))} — revisa periodos sin cerrar o asientos descuadrados.`}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Seccion titulo="Activo" icon={<Scale className="h-4 w-4" />} filas={data.activo} total={data.totalActivo} />
        <div className="space-y-4">
          <Seccion titulo="Pasivo" filas={data.pasivo} total={data.totalPasivo} />
          <Seccion
            titulo="Capital contable"
            filas={[
              ...data.capital,
              ...(Math.abs(data.resultadoEnCurso) >= 0.01
                ? [{ cuenta: "—", nombre: "Resultado del ejercicio (en curso, sin traspasar)", monto: data.resultadoEnCurso }]
                : []),
            ]}
            total={data.totalCapital + data.resultadoEnCurso}
          />
        </div>
      </div>
    </div>
  );
}

function Seccion({ titulo, filas, total, icon }: {
  titulo: string;
  filas: Array<{ cuenta: string; nombre: string; monto: number }>;
  total: number;
  icon?: React.ReactNode;
}) {
  return (
    <div className="bg-cos-card border border-cos-line rounded-xl overflow-hidden">
      <div className="flex items-center gap-2 border-b border-cos-line bg-cos-paper px-4 py-2.5 text-xs font-semibold text-cos-ink">
        {icon} {titulo}
      </div>
      <table className="w-full text-sm">
        <tbody>
          {filas.map((f, i) => (
            <tr key={`${f.cuenta}-${i}`} className="border-b border-cos-line/60 last:border-0">
              <td className="px-4 py-1.5 font-mono text-xs text-cos-ink-soft w-20">{f.cuenta}</td>
              <td className="px-4 py-1.5">{f.nombre}</td>
              <td className="px-4 py-1.5 text-right font-mono text-xs"><Money value={f.monto} /></td>
            </tr>
          ))}
          <tr className="bg-cos-paper font-semibold">
            <td className="px-4 py-2" colSpan={2}>Total {titulo.toLowerCase()}</td>
            <td className="px-4 py-2 text-right font-mono text-xs"><Money value={total} /></td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
