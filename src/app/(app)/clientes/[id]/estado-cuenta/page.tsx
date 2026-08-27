"use client";

// ─────────────────────────────────────────────────────────────────────────────
// ESTADO DE CUENTA DEL CLIENTE — la vista imprimible del entregable de
// cobranza (ver src/lib/clientes/estado-cuenta.ts para el porqué contable).
// Print-first: Cmd+P produce el PDF que el despacho manda; los controles y los
// avisos internos (REP sin cobro) van print:hidden — el cliente recibe cifras,
// no diagnósticos internos.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState, use } from "react";
import Link from "next/link";
import { ChevronLeft, Printer } from "lucide-react";
import { Money } from "@/components/ui/Money";
import { StatTile, StatStrip } from "@/components/ui/StatTile";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/Table";
import { Alert, Loading, RetryButton } from "@/components/ui/feedback";
import type { EstadoDeCuenta } from "@/lib/clientes/estado-cuenta";

const RANGOS = [
  { meses: 3, label: "3 meses" },
  { meses: 6, label: "6 meses" },
  { meses: 12, label: "12 meses" },
] as const;

const TIPO_LABEL: Record<string, string> = {
  FACTURA: "Factura",
  NOTA_CREDITO: "Nota de crédito",
  COBRO: "Cobro",
};

export default function EstadoCuentaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [meses, setMeses] = useState<number>(3);
  const [data, setData] = useState<EstadoDeCuenta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const hasta = new Date();
      const desde = new Date(Date.UTC(hasta.getUTCFullYear(), hasta.getUTCMonth() - meses, 1));
      const qs = new URLSearchParams({
        desde: desde.toISOString().slice(0, 10),
        hasta: hasta.toISOString().slice(0, 10),
      });
      const res = await fetch(`/api/clientes/${id}/estado-cuenta?${qs}`);
      const j = await res.json().catch(() => null);
      if (!res.ok) throw new Error(j?.error ?? `HTTP ${res.status}`);
      setData(j as EstadoDeCuenta);
    } catch (e) {
      setData(null);
      setError(e instanceof Error ? e.message : "No se pudo cargar el estado de cuenta.");
    } finally {
      setLoading(false);
    }
  }, [id, meses]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  return (
    <div className="print-report mx-auto max-w-[880px] px-6 py-7 print:max-w-none print:p-0">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link
          href="/clientes"
          className="inline-flex items-center gap-1 text-[13px] text-cos-ink-soft hover:text-cos-ink"
        >
          <ChevronLeft className="h-4 w-4" /> Clientes
        </Link>
        <div className="flex items-center gap-2">
          <div className="flex rounded-control border border-cos-line p-0.5">
            {RANGOS.map((r) => (
              <button
                key={r.meses}
                type="button"
                onClick={() => setMeses(r.meses)}
                className={`rounded-[8px] px-2.5 py-1 text-[12.5px] font-medium ${
                  meses === r.meses ? "bg-cos-slate-tint text-cos-ink" : "text-cos-ink-soft hover:text-cos-ink"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => window.print()}
            disabled={!data}
            className="inline-flex items-center gap-1.5 rounded-control bg-cos-brand px-3 py-1.5 text-[13px] font-medium text-white hover:bg-cos-brand-deep disabled:opacity-50"
          >
            <Printer className="h-3.5 w-3.5" /> Imprimir / PDF
          </button>
        </div>
      </div>

      {error && (
        <div className="print:hidden">
          <Alert tone="danger" action={<RetryButton onClick={cargar} />}>
            {error}
          </Alert>
        </div>
      )}
      {loading && <Loading label="Armando el estado de cuenta…" />}

      {data && !loading && (
        <>
          <header className="mb-5 border-b border-cos-line pb-4">
            <p className="text-[13px] text-cos-ink-soft">
              {data.empresa.razonSocial} · {data.empresa.rfc}
            </p>
            <h1 className="mt-1 text-[24px] font-semibold tracking-[-0.02em] text-cos-ink">
              Estado de cuenta
            </h1>
            <div className="mt-2 flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-[15px] font-medium text-cos-ink">
                {data.cliente.razonSocial}{" "}
                <span className="font-mono text-[12px] text-cos-ink-soft">{data.cliente.rfc}</span>
              </p>
              <p className="text-[12.5px] text-cos-ink-soft">
                Del {data.desde} al {data.hasta} · corte {data.generado}
              </p>
            </div>
          </header>

          <StatStrip className="mb-5">
            <StatTile label="Saldo inicial" value={<Money value={data.saldoInicial} size={20} />} />
            <StatTile label="Cargos del periodo" value={<Money value={data.cargos} size={20} />} />
            <StatTile label="Abonos del periodo" value={<Money value={data.abonos} size={20} />} tone="jade" />
            <StatTile
              label="Saldo final"
              value={<Money value={data.saldoFinal} size={22} />}
              tone={data.saldoFinal > 0.005 ? "amber" : "jade"}
            />
          </StatStrip>

          {data.avisos.length > 0 && (
            <div className="mb-4 space-y-2 print:hidden">
              {data.avisos.map((a, i) => (
                <Alert key={i} tone="warning">
                  {a}
                </Alert>
              ))}
            </div>
          )}

          <section className="mb-6">
            <h2 className="mb-2 text-[15px] font-semibold text-cos-ink">Movimientos</h2>
            {data.movimientos.length === 0 ? (
              <p className="text-[13px] text-cos-ink-soft">Sin movimientos en el periodo.</p>
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Fecha</TH>
                    <TH>Tipo</TH>
                    <TH>Referencia</TH>
                    <TH numeric>Cargo</TH>
                    <TH numeric>Abono</TH>
                    <TH numeric>Saldo</TH>
                  </TR>
                </THead>
                <TBody>
                  {data.movimientos.map((m, i) => (
                    <TR key={i}>
                      <TD className="whitespace-nowrap text-[12.5px]">{m.fecha}</TD>
                      <TD className="text-[12.5px]">{TIPO_LABEL[m.tipo] ?? m.tipo}</TD>
                      <TD className="max-w-[220px] truncate text-[12.5px] text-cos-ink-soft">{m.referencia}</TD>
                      <TD numeric>{m.cargo > 0 ? <Money value={m.cargo} /> : "—"}</TD>
                      <TD numeric>{m.abono > 0 ? <Money value={m.abono} muted /> : "—"}</TD>
                      <TD numeric>
                        <Money value={m.saldo} />
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </section>

          <section>
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-[15px] font-semibold text-cos-ink">Facturas abiertas al corte</h2>
              <p className="text-[12px] text-cos-ink-soft">
                Antigüedad: 0–30 <Money value={data.aging["0-30"]} size={12} /> · 31–60{" "}
                <Money value={data.aging["31-60"]} size={12} /> · 61–90{" "}
                <Money value={data.aging["61-90"]} size={12} /> · 90+{" "}
                <Money value={data.aging["90+"]} size={12} />
              </p>
            </div>
            {data.abiertas.length === 0 ? (
              <p className="text-[13px] text-cos-jade-ink">
                Sin facturas pendientes de cobro — cartera al corriente.
              </p>
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Fecha</TH>
                    <TH>Referencia</TH>
                    <TH numeric>Total</TH>
                    <TH numeric>Cobrado</TH>
                    <TH numeric>Saldo</TH>
                    <TH numeric>Días</TH>
                    <TH center>REP</TH>
                  </TR>
                </THead>
                <TBody>
                  {data.abiertas.map((f) => (
                    <TR key={f.referencia + f.fecha}>
                      <TD className="whitespace-nowrap text-[12.5px]">{f.fecha}</TD>
                      <TD className="text-[12.5px]">{f.referencia}</TD>
                      <TD numeric>
                        <Money value={f.total} />
                      </TD>
                      <TD numeric>{f.cobrado > 0 ? <Money value={f.cobrado} muted /> : "—"}</TD>
                      <TD numeric>
                        <Money value={f.saldo} />
                      </TD>
                      <TD numeric className={f.diasVencida > 60 ? "text-cos-red-ink" : undefined}>
                        {f.diasVencida}
                      </TD>
                      <TD center className="text-[12px]">
                        {f.repEmitido ? "✓" : "—"}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
            {data.notasCreditoPeriodo > 0.005 && (
              <p className="mt-2 text-[12px] text-cos-ink-soft">
                Notas de crédito del periodo: <Money value={data.notasCreditoPeriodo} size={12} /> —
                abonan al saldo general.
              </p>
            )}
          </section>

          <footer className="mt-8 border-t border-cos-line pt-3 text-[11px] text-cos-ink-faint">
            Cobros con evidencia bancaria conciliada. Documento informativo — no sustituye a los CFDI.
          </footer>
        </>
      )}
    </div>
  );
}
