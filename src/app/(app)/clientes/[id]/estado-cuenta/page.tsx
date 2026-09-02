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
import { RepresentacionImpresa } from "@/components/facturas/RepresentacionImpresa";
import { ChevronLeft, Printer } from "lucide-react";
import { Money } from "@/components/ui/Money";
import { StatTile, StatStrip } from "@/components/ui/StatTile";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/Table";
import { Alert, Loading, RetryButton } from "@/components/ui/feedback";
import type { EstadoDeCuenta } from "@/lib/clientes/estado-cuenta";

// Hub del cliente (decisión del owner, pág. 8): el estado de cuenta ES la
// página del cliente — ficha, REPs y facturas viven aquí, sin rutas nuevas.
interface FichaCliente {
  rfc: string;
  razonSocial: string;
  email: string | null;
  phone: string | null;
  codigoPostal: string | null;
  facturapiId: string | null;
  situacion69b: string | null;
  facturas: number;
}
interface RepEmitido { id: string; uuid: string | null; folio: string | null; fecha: string; total: number }
interface RepPendiente {
  invoiceId: string;
  serie: string | null;
  folio: string | null;
  totalPagado: number;
  pagosSinRep: number;
}
type EstadoHub = EstadoDeCuenta & { empresaId: string; cliente: FichaCliente; repsEmitidos: RepEmitido[] };

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
  // ?direccion=proveedor → cuentas por pagar (cargos = EGRESO recibidos,
  // abonos = pagos del banco). Se lee de la URL para no exigir Suspense.
  const esProveedor =
    typeof window !== "undefined" && new URLSearchParams(window.location.search).get("direccion") === "proveedor";
  const [meses, setMeses] = useState<number>(3);
  const [data, setData] = useState<EstadoHub | null>(null);
  const [pendientesRep, setPendientesRep] = useState<RepPendiente[] | null>(null);
  const [emitiendoRep, setEmitiendoRep] = useState<string | null>(null);
  // Ver el CFDI aquí mismo: el link a /facturas?q= sacaba del estado de
  // cuenta (y con el filtro del mes en curso, la búsqueda fallaba).
  const [verFacturaId, setVerFacturaId] = useState<string | null>(null);
  const [avisoRep, setAvisoRep] = useState<string | null>(null);
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
        ...(esProveedor ? { direccion: "proveedor" } : {}),
      });
      const res = await fetch(`/api/clientes/${id}/estado-cuenta?${qs}`);
      const j = await res.json().catch(() => null);
      if (!res.ok) throw new Error(j?.error ?? `HTTP ${res.status}`);
      const hub = j as EstadoHub;
      setData(hub);
      // Pendientes de REP de ESTE cliente (detector global filtrado).
      fetch(`/api/facturas/complemento-pagos?companyId=${hub.empresaId}&customerId=${id}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!d) return setPendientesRep([]);
          type Det = {
            invoice: { id: string; serie: string | null; folio: string | null };
            pendingAmount: number;
            needsRep: boolean;
          };
          setPendientesRep(
            ((d.pendientes ?? []) as Det[])
              .filter((pe) => pe.needsRep)
              .map((pe) => ({
                invoiceId: pe.invoice.id,
                serie: pe.invoice.serie,
                folio: pe.invoice.folio,
                totalPagado: pe.pendingAmount,
                pagosSinRep: 1,
              })),
          );
        })
        .catch(() => setPendientesRep([]));
    } catch (e) {
      setData(null);
      setError(e instanceof Error ? e.message : "No se pudo cargar el estado de cuenta.");
    } finally {
      setLoading(false);
    }
  }, [id, meses, esProveedor]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function emitirRep(invoiceId: string) {
    if (!data) return;
    if (!confirm("¿Timbrar el complemento de pago? Se emite un CFDI real ante el SAT.")) return;
    setEmitiendoRep(invoiceId);
    setAvisoRep(null);
    try {
      const res = await fetch("/api/facturas/complemento-pagos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: data.empresaId, invoiceId }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) throw new Error(j?.error ?? `HTTP ${res.status}`);
      setAvisoRep(`Complemento timbrado (parcialidad ${j?.numParcialidad ?? ""}).`);
      await cargar();
    } catch (e) {
      setAvisoRep(e instanceof Error ? e.message : "No se pudo timbrar el complemento.");
    } finally {
      setEmitiendoRep(null);
    }
  }

  return (
    <div className="print-report mx-auto max-w-[880px] px-6 py-7 print:max-w-none print:p-0">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link
          href={esProveedor ? "/proveedores" : "/clientes"}
          className="inline-flex items-center gap-1 text-[13px] text-cos-ink-soft hover:text-cos-ink"
        >
          <ChevronLeft className="h-4 w-4" /> {esProveedor ? "Proveedores" : "Clientes"}
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
              Estado de cuenta{esProveedor ? " del proveedor" : ""}
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
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-cos-ink-soft">
              {data.cliente.email && <span>{data.cliente.email}</span>}
              {data.cliente.phone && <span>{data.cliente.phone}</span>}
              {data.cliente.codigoPostal && <span>CP {data.cliente.codigoPostal}</span>}
              <span className="print:hidden">
                <Link href={`/facturas?q=${encodeURIComponent(data.cliente.rfc)}`} className="text-cos-brand-ink hover:underline">
                  {data.cliente.facturas} factura{data.cliente.facturas === 1 ? "" : "s"} →
                </Link>
              </span>
              {data.cliente.situacion69b && (
                <span className={`print:hidden rounded-full px-2 py-0.5 text-[10.5px] font-semibold ${
                  data.cliente.situacion69b === "DEFINITIVO" ? "bg-cos-red-tint text-cos-red-ink" : "bg-cos-amber-tint text-cos-amber-ink"
                }`}>
                  69-B {data.cliente.situacion69b.toLowerCase()}
                </span>
              )}
              {!data.cliente.facturapiId && !data.cliente.codigoPostal && (
                <span className="print:hidden rounded-full bg-cos-amber-tint px-2 py-0.5 text-[10.5px] font-medium text-cos-amber-ink" title="Captura su CP para poder timbrarle">
                  Falta CP
                </span>
              )}
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
              <h2 className="text-[15px] font-semibold text-cos-ink">
                {esProveedor ? "Facturas por pagar al corte" : "Facturas abiertas al corte"}
              </h2>
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

          {!esProveedor && (
          <section className="mt-6 print:hidden">
            <h2 className="mb-2 text-[15px] font-semibold text-cos-ink">Complementos de pago</h2>
            {avisoRep && (
              <p className="mb-2 text-[12.5px] text-cos-brand-ink">{avisoRep}</p>
            )}
            {pendientesRep && pendientesRep.length > 0 && (
              <div className="mb-3 space-y-2">
                {pendientesRep.map((pr) => (
                  <div key={pr.invoiceId} className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-cos-amber-ink/25 bg-cos-amber-tint px-3 py-2.5">
                    <p className="text-[13px] text-cos-amber-ink">
                      <b>{[pr.serie, pr.folio].filter(Boolean).join("-") || "PPD"}</b>: cobrado{" "}
                      <Money value={pr.totalPagado} size={13} /> sin complemento — vence el día 5 del mes siguiente al cobro.
                    </p>
                    <button
                      type="button"
                      onClick={() => emitirRep(pr.invoiceId)}
                      disabled={emitiendoRep !== null}
                      className="rounded-control bg-cos-brand px-3 py-1.5 text-[12.5px] font-semibold text-white hover:bg-cos-brand-deep disabled:opacity-50"
                    >
                      {emitiendoRep === pr.invoiceId ? "Timbrando…" : "Emitir REP"}
                    </button>
                  </div>
                ))}
              </div>
            )}
            {data.repsEmitidos.length > 0 ? (
              <Table>
                <THead>
                  <TR>
                    <TH>Fecha</TH>
                    <TH>Folio</TH>
                    <TH>Folio fiscal</TH>
                    <TH numeric>Monto</TH>
                  </TR>
                </THead>
                <TBody>
                  {data.repsEmitidos.map((rep) => (
                    <TR key={rep.id}>
                      <TD className="whitespace-nowrap text-[12.5px]">{String(rep.fecha).slice(0, 10)}</TD>
                      <TD className="text-[12.5px]">{rep.folio ?? "—"}</TD>
                      <TD className="max-w-[260px] truncate font-mono text-[11.5px] text-cos-ink-soft">
                        {rep.uuid ? (
                          <button
                            type="button"
                            onClick={() => setVerFacturaId(rep.id)}
                            className="hover:text-cos-brand-ink hover:underline"
                          >
                            {rep.uuid}
                          </button>
                        ) : "—"}
                      </TD>
                      <TD numeric><Money value={rep.total} size={12} /></TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            ) : (
              (!pendientesRep || pendientesRep.length === 0) && (
                <p className="text-[13px] text-cos-ink-soft">Sin complementos: este cliente no tiene cobros PPD que los requieran.</p>
              )
            )}
          </section>
          )}

          <footer className="mt-8 border-t border-cos-line pt-3 text-[11px] text-cos-ink-faint">
            Cobros con evidencia bancaria conciliada. Documento informativo — no sustituye a los CFDI.
          </footer>
        </>
      )}
      {verFacturaId && (
        <RepresentacionImpresa invoiceId={verFacturaId} onClose={() => setVerFacturaId(null)} />
      )}
    </div>
  );
}
