"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, ShieldCheck, AlertTriangle, Check, Landmark } from "lucide-react";
import { Money } from "@/components/ui";
import { Alert, RetryButton } from "@/components/ui/feedback";

// ─────────────────────────────────────────────────────────────────────────────
// Papel de trabajo de la conciliación bancaria.
//
// Presenta la resta tal como la arma el contador —del saldo del banco al saldo
// en libros, pasando por las partidas en conciliación— para que la cifra final
// sea auditable a simple vista en vez de un total que hay que creer.
// ─────────────────────────────────────────────────────────────────────────────

interface Partida {
  id: string;
  fecha: string;
  descripcion?: string;
  concepto?: string;
  monto?: number;
  delta?: number;
  fuente?: string;
}

interface CuentaConciliada {
  bankAccountId: string;
  etiqueta: string;
  saldoInicialEstado: number | null;
  saldoFinalEstado: number | null;
  saldoManual: boolean;
  saldoPropuesto: boolean;
  conciliadoAt: string | null;
  movimientos: number;
  sinRegistrar: number;
}

interface RenglonAuxiliar {
  id: string;
  fecha: string;
  concepto: string;
  folioPoliza: string;
  fuente: string;
  delta: number;
  bankTxId: string | null;
}

interface MovimientoBanco {
  id: string;
  fecha: string;
  descripcion: string;
  monto: number;
  registrado: boolean;
}

interface Conciliacion {
  year: number;
  month: number;
  mesPosteado: boolean;
  saldoEstadoCuenta: number | null;
  saldoInicialEstado: number | null;
  cuentasSinSaldo: string[];
  movimientosNoRegistrados: Partida[];
  totalNoRegistrados: number;
  asientosSinMovimiento: Partida[];
  totalAsientosSinMovimiento: number;
  saldoEsperadoLibros: number | null;
  saldoLibros: number;
  saldoInicialLibros: number;
  diferencia: number | null;
  diferenciaHeredada: number | null;
  conciliado: boolean;
  explicadaPorArrastre: boolean;
  cuentas: CuentaConciliada[];
  auxiliar: RenglonAuxiliar[];
  movimientosBanco: MovimientoBanco[];
  resumen: string;
  sinCuentaBancos: boolean;
}

const fmtFecha = (iso: string) => {
  const MES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  const d = new Date(iso + (iso.length === 10 ? "T12:00:00Z" : ""));
  return `${String(d.getUTCDate()).padStart(2, "0")} ${MES[d.getUTCMonth()]}`;
};

export function ConciliacionBancariaPanel({
  companyId, year, month,
}: { companyId: string; year: number; month: number }) {
  const [data, setData] = useState<Conciliacion | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [edit, setEdit] = useState<Record<string, { final: string; inicial: string }>>({});

  const cargar = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/bancos/conciliacion?companyId=${companyId}&year=${year}&month=${month}`);
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "No se pudo cargar la conciliación");
      setData(j);
      setEdit({});
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setLoading(false);
    }
  }, [companyId, year, month]);

  useEffect(() => { cargar(); }, [cargar]);

  async function accion(bankAccountId: string, cuerpo: Record<string, unknown>) {
    setBusy(bankAccountId);
    setError("");
    try {
      const res = await fetch("/api/bancos/conciliacion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId, bankAccountId, year, month, ...cuerpo }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "No se pudo guardar");
      setData(j);
      setEdit({});
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setBusy(null);
    }
  }

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center gap-2 py-12 text-sm text-cos-ink-soft">
        <Loader2 className="h-5 w-5 animate-spin" /> Cargando conciliación…
      </div>
    );
  }
  if (!data) {
    return (
      <Alert tone="danger" action={<RetryButton onClick={cargar} />}>
        {error || "No se pudo cargar la conciliación"}
      </Alert>
    );
  }
  if (data.sinCuentaBancos) {
    return <p className="py-8 text-center text-sm text-cos-ink-soft">{data.resumen}</p>;
  }

  const estado = data.conciliado
    ? { tono: "bg-cos-jade-tint text-cos-jade-ink", Icon: ShieldCheck }
    : { tono: "bg-cos-amber-tint text-cos-amber-ink", Icon: AlertTriangle };

  return (
    <div className="space-y-4">
      {error && (
        <Alert tone="danger" action={<RetryButton onClick={cargar} />}>{error}</Alert>
      )}

      <div className={`flex items-start gap-2 rounded-card px-4 py-3 text-sm ${estado.tono}`}>
        <estado.Icon className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{data.resumen}</span>
      </div>

      {/* El papel de trabajo: del banco a los libros */}
      <div className="overflow-hidden rounded-card border border-cos-line bg-cos-card">
        <div className="border-b border-cos-line px-4 py-3">
          <h3 className="text-[14px] font-semibold text-cos-ink">Conciliación del mes</h3>
          <p className="mt-0.5 text-[12px] text-cos-ink-soft">
            Del saldo que reporta el banco al saldo del auxiliar de Bancos.
          </p>
        </div>
        <div className="space-y-2 p-4 text-[14px]">
          <Renglon label="Saldo según estado(s) de cuenta" valor={data.saldoEstadoCuenta} />
          <Renglon
            label={`− Movimientos del banco no registrados (${data.movimientosNoRegistrados.length})`}
            valor={data.totalNoRegistrados === 0 ? 0 : -data.totalNoRegistrados}
          />
          <Renglon
            label={`+ Asientos sin movimiento bancario (${data.asientosSinMovimiento.length})`}
            valor={data.totalAsientosSinMovimiento}
          />
          <div className="border-t border-cos-line-soft pt-2">
            <Renglon label="= Saldo esperado en libros" valor={data.saldoEsperadoLibros} />
          </div>
          <Renglon label="Saldo real del auxiliar de Bancos" valor={data.saldoLibros} />
          <div className="border-t border-cos-line-soft pt-2">
            <Renglon label="Diferencia" valor={data.diferencia} fuerte />
          </div>
          {data.diferenciaHeredada != null && Math.abs(data.diferenciaHeredada) > 0.5 && (
            <p className="pt-1 text-[12px] text-cos-ink-soft">
              De esa diferencia, <Money value={data.diferenciaHeredada} size={12} /> ya venía del mes
              anterior (el libro y el banco arrancaron el mes desfasados).
            </p>
          )}
        </div>
      </div>

      {/* Saldos por cuenta bancaria */}
      <div className="overflow-hidden rounded-card border border-cos-line bg-cos-card">
        <div className="border-b border-cos-line px-4 py-3">
          <h3 className="flex items-center gap-1.5 text-[14px] font-semibold text-cos-ink">
            <Landmark className="h-4 w-4 text-cos-ink-soft" /> Saldos por cuenta
          </h3>
          <p className="mt-0.5 text-[12px] text-cos-ink-soft">
            El saldo se toma del estado de cuenta importado. Captúralo a mano si la cuenta no tiene PDF.
          </p>
        </div>
        {data.cuentas.length === 0 ? (
          <p className="px-4 py-6 text-center text-[13px] text-cos-ink-soft">
            Esta empresa no tiene cuentas bancarias dadas de alta.
          </p>
        ) : (
          data.cuentas.map((c) => {
            const e = edit[c.bankAccountId] ?? {
              final: c.saldoFinalEstado?.toString() ?? "",
              inicial: c.saldoInicialEstado?.toString() ?? "",
            };
            return (
              <div key={c.bankAccountId} className="border-t border-cos-line-soft px-4 py-3 first:border-t-0">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-[13.5px] font-medium text-cos-ink">{c.etiqueta}</p>
                    <p className="text-[12px] text-cos-ink-soft">
                      {c.movimientos} movimiento(s)
                      {c.sinRegistrar > 0 ? ` · ${c.sinRegistrar} sin registrar` : ""}
                      {c.saldoPropuesto ? " · saldo tomado del estado importado" : ""}
                      {c.saldoManual ? " · saldo capturado a mano" : ""}
                    </p>
                  </div>
                  {c.conciliadoAt ? (
                    <span className="inline-flex items-center gap-1 rounded bg-cos-jade-tint px-2 py-0.5 text-[11.5px] font-medium text-cos-jade-ink">
                      <Check className="h-3 w-3" /> Firmada
                    </span>
                  ) : null}
                </div>
                <div className="mt-2 flex flex-wrap items-end gap-2">
                  <label className="text-[12px] text-cos-ink-soft">
                    Saldo inicial
                    <input
                      type="number" step="0.01" value={e.inicial}
                      onChange={(ev) => setEdit((p) => ({ ...p, [c.bankAccountId]: { ...e, inicial: ev.target.value } }))}
                      className="mt-0.5 block w-[140px] rounded-control border border-cos-line bg-cos-card px-2 py-1.5 font-mono text-[13px] text-cos-ink outline-none"
                    />
                  </label>
                  <label className="text-[12px] text-cos-ink-soft">
                    Saldo final
                    <input
                      type="number" step="0.01" value={e.final}
                      onChange={(ev) => setEdit((p) => ({ ...p, [c.bankAccountId]: { ...e, final: ev.target.value } }))}
                      className="mt-0.5 block w-[140px] rounded-control border border-cos-line bg-cos-card px-2 py-1.5 font-mono text-[13px] text-cos-ink outline-none"
                    />
                  </label>
                  <button
                    onClick={() => accion(c.bankAccountId, { accion: "saldo", saldoFinalEstado: e.final, saldoInicialEstado: e.inicial })}
                    disabled={busy === c.bankAccountId}
                    className="rounded-control border border-cos-line px-3 py-1.5 text-[12.5px] font-medium text-cos-ink hover:bg-cos-paper disabled:opacity-50"
                  >
                    {busy === c.bankAccountId ? "Guardando…" : "Guardar saldo"}
                  </button>
                  <button
                    onClick={() => accion(c.bankAccountId, { accion: "firmar", conciliado: !c.conciliadoAt })}
                    disabled={busy === c.bankAccountId}
                    className="rounded-control border border-cos-line px-3 py-1.5 text-[12.5px] font-medium text-cos-brand-ink hover:bg-cos-brand-tint disabled:opacity-50"
                  >
                    {c.conciliadoAt ? "Quitar firma" : "Dar por conciliada"}
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      <Partidas
        titulo="Movimientos del banco no registrados en contabilidad"
        ayuda="Están en el estado de cuenta pero no llegaron al libro: quedaron sin conciliar, así que el cierre del mes no los postea."
        filas={data.movimientosNoRegistrados.map((m) => ({
          id: m.id, fecha: m.fecha, texto: m.descripcion ?? "", monto: m.monto ?? 0, nota: null,
        }))}
      />
      <Partidas
        titulo="Asientos en Bancos sin movimiento bancario"
        ayuda="Están en el libro pero no en el estado de cuenta: pólizas manuales, saldos de apertura o módulos satélite."
        filas={data.asientosSinMovimiento.map((a) => ({
          id: a.id, fecha: a.fecha, texto: a.concepto ?? "", monto: a.delta ?? 0, nota: a.fuente ?? null,
        }))}
      />

      {/* Los DOS lados del cotejo, completos: el auxiliar de Bancos (con el
          folio de la póliza de cada asiento — el mismo del libro diario y del
          XML) frente a los movimientos del estado de cuenta. Colapsados por
          defecto: son el soporte del papel, no su resumen. */}
      <LadoDetalle
        titulo="Auxiliar de Bancos (libros)"
        ayuda="Cada asiento con su folio de póliza — el mismo que ves en el libro diario y el que lleva el XML de pólizas del SAT."
        vacio="El mes no tiene asientos en la cuenta de Bancos. Si ya importaste los movimientos, cierra el mes en «Cierres mensuales» para generarlos."
        filas={data.auxiliar.map((a) => ({
          id: a.id,
          fecha: a.fecha,
          texto: a.concepto,
          monto: a.delta,
          folio: `#${a.folioPoliza}`,
          nota: a.fuente,
          alerta: a.bankTxId == null,
        }))}
        notaAlerta="sin movimiento bancario"
      />
      <LadoDetalle
        titulo="Movimientos del estado de cuenta"
        ayuda="Todos los movimientos del banco en el mes, marcando cuáles llegaron al libro."
        vacio="No hay movimientos bancarios importados en este mes."
        filas={data.movimientosBanco.map((m) => ({
          id: m.id,
          fecha: m.fecha,
          texto: m.descripcion,
          monto: m.monto,
          folio: null,
          nota: null,
          alerta: !m.registrado,
        }))}
        notaAlerta="sin registrar"
      />
    </div>
  );
}

/** Tabla colapsable de un lado del cotejo (auxiliar o estado de cuenta). */
function LadoDetalle({
  titulo, ayuda, vacio, filas, notaAlerta,
}: {
  titulo: string;
  ayuda: string;
  vacio: string;
  filas: {
    id: string; fecha: string; texto: string; monto: number;
    folio: string | null; nota: string | null; alerta: boolean;
  }[];
  notaAlerta: string;
}) {
  const [abierto, setAbierto] = useState(false);
  const alertas = filas.filter((f) => f.alerta).length;
  return (
    <div className="overflow-hidden rounded-card border border-cos-line bg-cos-card">
      <button
        type="button"
        onClick={() => setAbierto((o) => !o)}
        className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-cos-paper"
      >
        <span>
          <span className="text-[14px] font-semibold text-cos-ink">
            {titulo} <span className="ml-1 font-mono text-[12px] text-cos-ink-faint">{filas.length}</span>
            {alertas > 0 && (
              <span className="ml-2 rounded bg-cos-amber-tint px-1.5 py-0.5 text-[11px] font-medium text-cos-amber-ink">
                {alertas} {notaAlerta}
              </span>
            )}
          </span>
          <span className="mt-0.5 block text-[12px] text-cos-ink-soft">{ayuda}</span>
        </span>
        <span className="ml-3 shrink-0 text-[12.5px] font-medium text-cos-brand-ink">
          {abierto ? "Ocultar" : "Ver detalle"}
        </span>
      </button>
      {abierto &&
        (filas.length === 0 ? (
          <p className="border-t border-cos-line-soft px-4 py-5 text-center text-[13px] text-cos-ink-soft">{vacio}</p>
        ) : (
          <div className="max-h-[420px] overflow-y-auto border-t border-cos-line-soft">
            <table className="w-full text-[13px]">
              <tbody>
                {filas.map((f) => (
                  <tr key={f.id} className={`border-t border-cos-line-soft first:border-t-0 ${f.alerta ? "bg-cos-amber-tint/40" : ""}`}>
                    <td className="w-[64px] px-4 py-2 font-mono text-[12px] text-cos-ink-soft">{fmtFecha(f.fecha)}</td>
                    {f.folio !== null && (
                      <td className="w-[64px] px-1 py-2 font-mono text-[12px] text-cos-ink-soft">{f.folio}</td>
                    )}
                    <td className="px-2 py-2 text-cos-ink">
                      <span className="line-clamp-2">{f.texto}</span>
                      {(f.nota || f.alerta) && (
                        <span className="mt-0.5 block text-[11.5px] text-cos-ink-faint">
                          {[f.nota, f.alerta ? notaAlerta : null].filter(Boolean).join(" · ")}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right align-top"><Money value={f.monto} sign size={13} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </div>
  );
}

function Renglon({ label, valor, fuerte }: { label: string; valor: number | null; fuerte?: boolean }) {
  return (
    <div className={`flex items-center justify-between ${fuerte ? "font-semibold text-cos-ink" : "text-cos-ink-soft"}`}>
      <span>{label}</span>
      {valor == null ? (
        <span className="text-cos-ink-faint">—</span>
      ) : (
        <Money value={valor} size={fuerte ? 15 : 13} weight={fuerte ? 700 : 500} />
      )}
    </div>
  );
}

function Partidas({
  titulo, ayuda, filas,
}: {
  titulo: string;
  ayuda: string;
  filas: { id: string; fecha: string; texto: string; monto: number; nota: string | null }[];
}) {
  return (
    <div className="overflow-hidden rounded-card border border-cos-line bg-cos-card">
      <div className="border-b border-cos-line px-4 py-3">
        <h3 className="text-[14px] font-semibold text-cos-ink">
          {titulo} <span className="ml-1 font-mono text-[12px] text-cos-ink-faint">{filas.length}</span>
        </h3>
        <p className="mt-0.5 text-[12px] text-cos-ink-soft">{ayuda}</p>
      </div>
      {filas.length === 0 ? (
        <p className="px-4 py-5 text-center text-[13px] text-cos-ink-soft">Ninguna — nada pendiente por aquí.</p>
      ) : (
        <table className="w-full text-[13px]">
          <tbody>
            {filas.map((f) => (
              <tr key={f.id} className="border-t border-cos-line-soft">
                <td className="w-[70px] px-4 py-2 font-mono text-[12px] text-cos-ink-soft">{fmtFecha(f.fecha)}</td>
                <td className="px-2 py-2 text-cos-ink">
                  {f.texto}
                  {f.nota && <span className="ml-1.5 text-[11.5px] text-cos-ink-faint">({f.nota})</span>}
                </td>
                <td className="px-4 py-2 text-right"><Money value={f.monto} sign size={13} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
