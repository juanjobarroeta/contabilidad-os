"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Mesa de conciliación split-view (idioma del deck People, p10): movimientos
// del banco a la izquierda, CFDIs del mismo sentido a la derecha, un depósito
// contra varias facturas cuadrando a cero. Todo sobre APIs existentes:
//
//   GET  /api/bancos/conciliacion            → el mes (movimientos sin conciliar)
//   GET  /api/bancos/[cuenta]/match?txId=    → candidatos puntuados + impuestos
//   PATCH /api/bancos/transactions/[txId]    → match / match-multiple /
//                                              match-impuesto (ConciliacionDetalle)
//   POST /api/bancos/[cuenta]/match          → motor de auto-conciliación
//
// Las porciones se asignan en el orden en que se palomean los CFDIs: cada uno
// toma el mínimo entre su saldo y lo que queda del movimiento. Quedar por
// debajo se permite (cobro parcial / comisión) — el backend lo devuelve como
// advertencia y aquí se muestra.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Check, Landmark, Loader2, Sparkles, X } from "lucide-react";
import { Money } from "@/components/ui/Money";
import { StatTile, StatStrip } from "@/components/ui";
import { Alert, RetryButton } from "@/components/ui/feedback";
import { CATEGORIAS_MESA, type SugerenciaMovimiento } from "@/lib/bancos/inferir-movimiento";
import { cn } from "@/lib/utils";

// ── Tipos espejo de las APIs ──────────────────────────────────────────────────
interface Movimiento {
  id: string;
  fecha: string;
  descripcion: string;
  /** Firmado: + depósito, − retiro. */
  monto: number;
  cuentaBancariaId: string;
  // Contraparte extraída de la descripción (spei-descripcion.ts + su barrido).
  // La misma regla que el tab Movimientos: cuando el banco nos dijo QUIÉN, ése
  // es el titular del renglón — no la sintaxis del banco.
  contraparteNombre?: string | null;
  contraparteRfc?: string | null;
  conceptoPago?: string | null;
}
interface Cuenta {
  bankAccountId: string;
  etiqueta: string;
}
/** GET /api/bancos — sólo lo que el encabezado de contexto usa. */
interface CuentaDetalle {
  id: string;
  banco: string;
  numeroCuenta: string;
  lastTransaction: { fecha: string; saldo: number | null } | null;
  stats: { total: number };
}
interface ConciliacionMes {
  /** TODOS los movimientos del mes (el feed ya manda el objeto completo); la
   *  cuenta permite calcular el % conciliado POR CUENTA sin otra consulta. */
  movimientosBanco: { id: string; cuentaBancariaId: string }[];
  movimientosNoRegistrados: Movimiento[];
  totalNoRegistrados: number;
  cuentas: Cuenta[];
  sinCuentaBancos: boolean;
}
interface Candidato {
  id: string;
  uuid: string | null;
  fecha: string;
  folio: string | null;
  serie: string | null;
  metodoPago: string | null;
  total: number;
  cliente: string;
  rfc: string;
  confidence: "alta" | "media" | "baja";
  alreadyMatched: boolean;
  matchedAmount: number;
  remainingBalance: number;
}
interface CandidatoImpuesto {
  id: string;
  etiqueta: string;
  montoEsperado: number | null;
  fechaLimitePago: string | null;
  confidence: "alta" | "media" | "baja";
}

const CONFIANZA: Record<Candidato["confidence"], { t: string; cls: string }> = {
  alta: { t: "alta", cls: "bg-cos-jade-tint text-cos-jade-ink" },
  media: { t: "media", cls: "bg-cos-amber-tint text-cos-amber-ink" },
  baja: { t: "baja", cls: "bg-cos-slate-tint text-cos-ink-soft" },
};

const fFecha = (s: string) =>
  new Date(s).toLocaleDateString("es-MX", { day: "2-digit", month: "2-digit", year: "2-digit" });

export function ConciliacionWorkbench({
  companyId,
  year,
  month,
  onApplied,
}: {
  companyId: string;
  year: number;
  month: number;
  /** Se llama tras aplicar una conciliación (para refrescar el papel de abajo). */
  onApplied?: () => void;
}) {
  const [data, setData] = useState<ConciliacionMes | null>(null);
  const [cargando, setCargando] = useState(true);
  const [selTx, setSelTx] = useState<Movimiento | null>(null);
  const [cand, setCand] = useState<{
    candidates: Candidato[];
    impuestos: CandidatoImpuesto[];
    /** «¿No es una factura?» — la categoría inferida (identidad/reglas/LLM). */
    sugerencia: SugerenciaMovimiento | null;
    /** Subconjunto de facturas de UNA contraparte que suma EXACTO el
     *  movimiento (sugerirPagoJunto). Un clic las palomea todas. */
    pagoJunto: {
      rfc: string;
      cliente: string;
      suma: number;
      facturas: Array<{ invoiceId: string; monto: number; folio: string }>;
    } | null;
  } | null>(null);
  const [candCargando, setCandCargando] = useState(false);
  const [seleccion, setSeleccion] = useState<string[]>([]); // ids en orden de palomeo
  const [selImpuesto, setSelImpuesto] = useState<string | null>(null);
  const [aplicando, setAplicando] = useState(false);
  const [autoCorriendo, setAutoCorriendo] = useState(false);
  const [aviso, setAviso] = useState<React.ReactNode>("");
  const [error, setError] = useState("");
  // Filtro por cuenta (client-side: el feed ya trae la cuenta de cada
  // movimiento). null = todas. Se resetea al cambiar de período/empresa.
  const [cuentaSel, setCuentaSel] = useState<string | null>(null);
  // Contexto de la cuenta elegida (banco ··4 · saldo del estado de cuenta),
  // del GET /api/bancos existente. Si la consulta falla, la línea no aparece.
  const [detalleCuentas, setDetalleCuentas] = useState<Map<string, CuentaDetalle>>(new Map());

  // Fallo del fetch, SEPARADO de data=null: antes un error dejaba data=null y
  // la mesa entera desaparecía sin decir nada (idéntico al caso "sin cuenta
  // bancaria", que sí es genuino y se oculta a propósito).
  const [errorCarga, setErrorCarga] = useState("");

  const cargar = useCallback(async () => {
    setCargando(true);
    setErrorCarga("");
    try {
      const res = await fetch(`/api/bancos/conciliacion?companyId=${companyId}&year=${year}&month=${month}`);
      const d = await res.json();
      if (!res.ok || !d?.movimientosNoRegistrados) throw new Error();
      setData(d);
    } catch {
      setData(null);
      setErrorCarga("No se pudo cargar la conciliación bancaria. Revisa tu conexión e inténtalo de nuevo.");
    } finally {
      setCargando(false);
    }
  }, [companyId, year, month]);

  useEffect(() => {
    setSelTx(null); setCand(null); setSeleccion([]); setSelImpuesto(null);
    setCuentaSel(null);
    cargar();
  }, [cargar]);

  // Una vez por empresa: el detalle no depende del período.
  useEffect(() => {
    let vivo = true;
    fetch(`/api/bancos?companyId=${companyId}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((xs: CuentaDetalle[]) => {
        if (vivo && Array.isArray(xs)) setDetalleCuentas(new Map(xs.map((c) => [c.id, c])));
      })
      .catch(() => {});
    return () => { vivo = false; };
  }, [companyId]);

  // La derecha nunca abre muerta: al llegar el mes (o cambiar de cuenta) se
  // elige el primer movimiento pendiente, para que los candidatos se enseñen
  // solos — la mesa abría con la caja vacía y parecía rota. Deseleccionar con
  // clic sigue funcionando: esto sólo corre cuando cambian datos o filtro, no
  // cuando el usuario suelta la selección. Tras conciliar, cargar() trae datos
  // nuevos y esto avanza solo al siguiente pendiente.
  useEffect(() => {
    if (!data) return;
    const lista = cuentaSel
      ? data.movimientosNoRegistrados.filter((m) => m.cuentaBancariaId === cuentaSel)
      : data.movimientosNoRegistrados;
    setSelTx((prev) => (prev && lista.some((m) => m.id === prev.id) ? prev : lista[0] ?? null));
  }, [data, cuentaSel]);

  // Candidatos del movimiento elegido.
  useEffect(() => {
    if (!selTx) return;
    let vivo = true;
    setCandCargando(true);
    setCand(null); setSeleccion([]); setSelImpuesto(null);
    fetch(`/api/bancos/${selTx.cuentaBancariaId}/match?txId=${selTx.id}`)
      .then((r) => r.json())
      .then((d) => { if (vivo && Array.isArray(d?.candidates)) setCand({ candidates: d.candidates, impuestos: d.impuestos ?? [], sugerencia: d.sugerencia ?? null, pagoJunto: d.pagoJunto ?? null }); })
      .catch(() => {})
      .finally(() => { if (vivo) setCandCargando(false); });
    return () => { vivo = false; };
  }, [selTx]);

  const etiquetaCuenta = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of data?.cuentas ?? []) m.set(c.bankAccountId, c.etiqueta);
    return m;
  }, [data]);

  // Asignación en orden de palomeo: cada CFDI toma min(su saldo, lo restante).
  const asignaciones = useMemo(() => {
    if (!selTx || !cand) return [];
    let restante = Math.abs(selTx.monto);
    const out: { c: Candidato; aplicar: number }[] = [];
    for (const id of seleccion) {
      const c = cand.candidates.find((x) => x.id === id);
      if (!c) continue;
      const base = c.remainingBalance > 0 ? c.remainingBalance : c.total;
      const aplicar = Math.min(Math.round(base * 100) / 100, Math.round(restante * 100) / 100);
      if (aplicar <= 0) continue;
      out.push({ c, aplicar });
      restante = Math.round((restante - aplicar) * 100) / 100;
    }
    return out;
  }, [selTx, cand, seleccion]);

  const sumaAplicada = asignaciones.reduce((s, a) => s + a.aplicar, 0);
  const diferencia = selTx ? Math.round((Math.abs(selTx.monto) - sumaAplicada) * 100) / 100 : 0;

  function toggle(id: string) {
    setSeleccion((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
    setSelImpuesto(null);
  }

  async function conciliar() {
    if (!selTx || asignaciones.length === 0) return;
    setAplicando(true); setError(""); setAviso("");
    try {
      const body =
        asignaciones.length === 1
          ? { action: "match", invoiceId: asignaciones[0].c.id }
          : {
              action: "match-multiple",
              asignaciones: asignaciones.map((a) => ({ invoiceId: a.c.id, monto: a.aplicar })),
            };
      const res = await fetch(`/api/bancos/transactions/${selTx.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.error ?? "No se pudo conciliar");
      setAviso(
        <>
          Movimiento conciliado contra {asignaciones.length} CFDI
          {asignaciones.length > 1 ? "s" : ""}.
          {d?.advertencia && <> {d.advertencia.mensaje}</>}
          {d?.repSugerido && (
            <>
              {" "}Este cobro PPD necesita complemento de pago —{" "}
              <Link href="/facturas" className="font-medium underline">emitir REP</Link>.
            </>
          )}
        </>
      );
      setSelTx(null);
      await cargar();
      onApplied?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo conciliar");
    } finally {
      setAplicando(false);
    }
  }

  async function conciliarImpuesto() {
    if (!selTx || !selImpuesto) return;
    setAplicando(true); setError(""); setAviso("");
    try {
      const res = await fetch(`/api/bancos/transactions/${selTx.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "match-impuesto", taxDeclarationId: selImpuesto }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.error ?? "No se pudo conciliar el impuesto");
      setAviso("Cargo conciliado contra la declaración — quedó PAGADA.");
      setSelTx(null);
      await cargar();
      onApplied?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo conciliar el impuesto");
    } finally {
      setAplicando(false);
    }
  }

  // Clasificar sin factura (o ignorar): el MISMO PATCH ignore+tag del tab
  // Movimientos — el cierre (postMonth) postea cada tag con su asiento, así
  // que aquí no se escribe ledger, sólo se etiqueta.
  async function clasificar(tag: string | null, label: string) {
    if (!selTx) return;
    setAplicando(true); setError(""); setAviso("");
    try {
      const res = await fetch(`/api/bancos/transactions/${selTx.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "ignore", notes: tag }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.error ?? "No se pudo clasificar");
      setAviso(
        tag
          ? `Clasificado: ${label}. El cierre del mes genera su póliza.`
          : "Movimiento ignorado — no genera póliza."
      );
      setSelTx(null);
      await cargar();
      onApplied?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo clasificar");
    } finally {
      setAplicando(false);
    }
  }

  async function autoConciliar() {
    if (!data || data.cuentas.length === 0) return;
    setAutoCorriendo(true); setError(""); setAviso("");
    try {
      let aplicados = 0;
      for (const c of data.cuentas) {
        const res = await fetch(`/api/bancos/${c.bankAccountId}/match`, { method: "POST" });
        const d = await res.json().catch(() => null);
        if (res.ok) aplicados += d?.autoMatched ?? 0;
      }
      setAviso(
        aplicados > 0
          ? `Auto-conciliación: ${aplicados} movimiento(s) aplicados con confianza alta.`
          : "Auto-conciliación: sin matches de confianza alta — los restantes se concilian aquí a mano."
      );
      setSelTx(null);
      await cargar();
      onApplied?.();
    } finally {
      setAutoCorriendo(false);
    }
  }

  if (cargando) {
    return (
      <div className="mb-6 flex items-center gap-2 rounded-card border border-cos-line bg-cos-card p-8 text-sm text-cos-ink-soft">
        <Loader2 className="h-4 w-4 animate-spin" /> Cotejando banco contra libro…
      </div>
    );
  }
  // ERROR ≠ "sin cuenta": el fallo de red se dice y ofrece reintentar; el
  // return null de abajo queda sólo para el caso genuino (sin cuenta de
  // bancos, la mesa no aplica).
  if (errorCarga) {
    return (
      <div className="mb-6">
        <Alert tone="danger" action={<RetryButton onClick={cargar} />}>{errorCarga}</Alert>
      </div>
    );
  }
  if (!data || data.sinCuentaBancos) return null;

  // Con una cuenta elegida, los tres stats y la lista son DE ESA CUENTA — el
  // % global junto a una lista filtrada diría dos cosas distintas a la vez.
  const deLaCuenta = <T extends { cuentaBancariaId: string }>(xs: T[]) =>
    cuentaSel ? xs.filter((x) => x.cuentaBancariaId === cuentaSel) : xs;
  const pendientes = deLaCuenta(data.movimientosNoRegistrados);
  const total = deLaCuenta(data.movimientosBanco).length;
  const sin = pendientes.length;
  const sinGlobal = data.movimientosNoRegistrados.length;
  // Σ|monto|, NO el neto firmado: +$17k de abonos y −$17k de cargos netean a
  // casi cero, y el tile diría «$92 por conciliar» con 12 movimientos por
  // casar. El neto es del motor (la ecuación del cuadre lo necesita firmado);
  // este tile mide cuánto trabajo hay sobre la mesa.
  const abonos = pendientes.reduce((s, m) => s + (m.monto > 0 ? m.monto : 0), 0);
  const cargos = pendientes.reduce((s, m) => s + (m.monto < 0 ? -m.monto : 0), 0);
  const pct = total > 0 ? ((total - sin) / total) * 100 : 100;

  return (
    <div className="mb-6">
      <StatStrip className="sm:grid-cols-3">
        <StatTile
          label="Conciliado"
          tone={sin === 0 ? "jade" : "ink"}
          value={`${pct.toFixed(1)} %`}
          sub={`${total - sin} de ${total} movimientos del mes`}
        />
        <StatTile label="Sin conciliar" tone={sin === 0 ? "jade" : sin > 20 ? "red" : "amber"} value={sin} />
        <StatTile
          label="Por conciliar"
          tone={sin === 0 ? "jade" : "ink"}
          value={<Money value={abonos + cargos} size={20} />}
          sub={
            abonos > 0 && cargos > 0 ? (
              <>
                abonos <Money value={abonos} className="text-[12px]" muted /> · cargos{" "}
                <Money value={cargos} className="text-[12px]" muted />
              </>
            ) : undefined
          }
        />
      </StatStrip>

      {aviso && (
        <div className="mb-4 flex items-start gap-2 rounded-card bg-cos-jade-tint px-4 py-3 text-sm text-cos-jade-ink">
          <Check className="mt-0.5 h-4 w-4 shrink-0" /> <span className="flex-1">{aviso}</span>
          <button onClick={() => setAviso("")} aria-label="Cerrar aviso"><X className="h-3.5 w-3.5" /></button>
        </div>
      )}
      {error && (
        <div className="mb-4 flex items-center gap-2 rounded-card bg-cos-red-tint px-4 py-3 text-sm text-cos-red-ink">
          <span className="flex-1">{error}</span>
          <button onClick={() => setError("")} aria-label="Cerrar error"><X className="h-3.5 w-3.5" /></button>
        </div>
      )}

      {data.cuentas.length > 1 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {[{ bankAccountId: null as string | null, etiqueta: "Todas las cuentas" }, ...data.cuentas].map((c) => (
            <button
              key={c.bankAccountId ?? "__todas__"}
              onClick={() => { setCuentaSel(c.bankAccountId); setSelTx(null); }}
              className={cn(
                "inline-flex items-center rounded-full border px-3.5 py-1.5 text-[13px] font-medium",
                cuentaSel === c.bankAccountId
                  ? "border-cos-brand bg-cos-brand text-white"
                  : "border-cos-line bg-cos-card text-cos-ink-soft hover:border-cos-brand hover:text-cos-brand-ink"
              )}
            >
              {c.etiqueta}
            </button>
          ))}
        </div>
      )}

      {/* Contexto de la cuenta elegida. El saldo es el del último renglón del
          estado de cuenta (con su fecha) — y sólo cuando el banco lo trae:
          sin saldo no se muestra un cero que nadie midió. El conteo es
          histórico de la cuenta, no del mes (los tiles de arriba ya son del
          mes), por eso dice «en total». */}
      {cuentaSel && detalleCuentas.has(cuentaSel) && (() => {
        const d = detalleCuentas.get(cuentaSel)!;
        return (
          <p className="-mt-2 mb-4 font-mono text-[11px] text-cos-ink-faint">
            {d.banco} ··{d.numeroCuenta.slice(-4)} · {d.stats.total.toLocaleString("es-MX")} movimientos en total
            {d.lastTransaction?.saldo != null && (
              <>
                {" "}· saldo <Money value={d.lastTransaction.saldo} className="text-[11px]" muted /> al{" "}
                {fFecha(d.lastTransaction.fecha)}
              </>
            )}
          </p>
        );
      })()}

      {sin === 0 ? (
        <div className="rounded-card border border-cos-line bg-cos-card px-5 py-4 text-sm text-cos-ink-soft">
          {/* «Compuerta abierta» sólo cuando el MES entero está limpio: con una
              cuenta filtrada en cero pero otras pendientes, decirlo mentiría. */}
          {sinGlobal === 0
            ? "Todos los movimientos del mes están conciliados — la compuerta del cierre está abierta."
            : `Esta cuenta está al corriente; quedan ${sinGlobal} movimiento(s) en otras cuentas.`}
        </div>
      ) : (
        <div className="rounded-card border border-cos-line bg-cos-card">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-cos-line px-5 py-3.5">
            <h2 className="text-sm font-semibold text-cos-ink">Mesa de conciliación</h2>
            <button
              onClick={autoConciliar}
              disabled={autoCorriendo}
              className="inline-flex items-center gap-1.5 rounded-control border border-cos-line bg-cos-card px-3 py-1.5 text-[13px] font-medium text-cos-ink hover:bg-cos-paper disabled:opacity-50"
            >
              {autoCorriendo ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
              Correr auto-conciliación
            </button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 lg:divide-x lg:divide-cos-line">
            {/* ── Izquierda: movimientos del banco ── */}
            <section>
              <p className="border-b border-cos-line-soft px-5 py-2.5 font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-cos-ink-faint">
                Movimientos del banco · {sin} sin conciliar{cuentaSel ? " en esta cuenta" : ""}
              </p>
              <ul className="max-h-[430px] overflow-y-auto">
                {pendientes.map((m) => {
                  const activo = selTx?.id === m.id;
                  return (
                    <li key={m.id}>
                      <button
                        onClick={() => setSelTx(activo ? null : m)}
                        className={cn(
                          "flex w-full items-baseline justify-between gap-3 border-b border-cos-line-soft px-5 py-2.5 text-left",
                          activo
                            ? "bg-cos-brand-tint shadow-[inset_3px_0_0_var(--brand)]"
                            : "hover:bg-cos-paper"
                        )}
                      >
                        <span className="min-w-0">
                          {/* La contraparte extraída manda; la cadena cruda del
                              banco sólo cuando no hay nada mejor (misma regla,
                              con el mismo porqué, que el tab Movimientos). */}
                          <span className="block truncate text-[13px] font-medium text-cos-ink">
                            {m.contraparteNombre || m.descripcion || "(sin descripción)"}
                          </span>
                          <span className="block truncate font-mono text-[11px] text-cos-ink-faint">
                            {fFecha(m.fecha)}
                            {m.contraparteRfc && <> · <span className="text-cos-ink-soft">{m.contraparteRfc}</span></>}
                            {m.conceptoPago && ` · ${m.conceptoPago}`}
                            {!m.contraparteNombre && " · sin identificar"}
                            {etiquetaCuenta.get(m.cuentaBancariaId) && ` · ${etiquetaCuenta.get(m.cuentaBancariaId)}`}
                          </span>
                        </span>
                        <Money
                          value={m.monto}
                          className={cn("text-[13px]", m.monto < 0 && "text-cos-red-ink")}
                        />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>

            {/* ── Derecha: CFDIs candidatos ── */}
            <section className="border-t border-cos-line lg:border-t-0">
              <p className="border-b border-cos-line-soft px-5 py-2.5 font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-cos-ink-faint">
                {selTx
                  ? `CFDI candidatos · ${seleccion.length} seleccionados`
                  : "CFDI candidatos"}
              </p>
              {!selTx ? (
                <div className="flex h-full min-h-[200px] items-center justify-center px-8 py-10 text-center text-sm text-cos-ink-soft">
                  <span>
                    <Landmark className="mx-auto mb-2 h-6 w-6 opacity-30" />
                    Elige un movimiento a la izquierda para ver sus candidatos —
                    del mismo sentido, ±30 días, puntuados por monto, fecha e identidad.
                  </span>
                </div>
              ) : candCargando ? (
                <p className="flex items-center gap-2 px-5 py-6 text-sm text-cos-ink-soft">
                  <Loader2 className="h-4 w-4 animate-spin" /> Buscando candidatos…
                </p>
              ) : (
                <>
                  {!cand || (cand.candidates.length === 0 && cand.impuestos.length === 0) ? (
                    <p className="px-5 py-6 text-sm text-cos-ink-soft">
                      Sin CFDIs de este sentido en ±30 días que quepan en este movimiento. Puede ser un
                      traspaso propio, una comisión, un documento que aún no se sincroniza — o un{" "}
                      {selTx.monto > 0 ? "ingreso" : "gasto"} que no se facturó.
                    </p>
                  ) : (
                    <>
                  {cand.pagoJunto && (
                    <div className="mx-4 mt-3 flex flex-wrap items-center justify-between gap-2 rounded-card border border-cos-brand/30 bg-cos-brand-tint px-3 py-2.5">
                      <p className="text-[12.5px] text-cos-brand-ink">
                        <b>Pago junto:</b> {cand.pagoJunto.facturas.length} facturas de {cand.pagoJunto.cliente} suman
                        exacto <Money value={cand.pagoJunto.suma} size={12} /> ({cand.pagoJunto.facturas.map((f) => f.folio).join(" + ")}).
                      </p>
                      <button
                        type="button"
                        onClick={() => { setSeleccion(cand.pagoJunto!.facturas.map((f) => f.invoiceId)); setSelImpuesto(null); }}
                        className="rounded-control bg-cos-brand px-2.5 py-1 text-[12px] font-semibold text-white hover:bg-cos-brand-deep"
                      >
                        Palomearlas
                      </button>
                    </div>
                  )}
                  <ul className="max-h-[330px] overflow-y-auto">
                    {cand.candidates.map((c) => {
                      const idx = seleccion.indexOf(c.id);
                      const marcado = idx >= 0;
                      const asig = asignaciones.find((a) => a.c.id === c.id);
                      return (
                        <li key={c.id}>
                          <label
                            className={cn(
                              "flex cursor-pointer items-baseline gap-3 border-b border-cos-line-soft px-5 py-2.5",
                              marcado ? "bg-cos-brand-tint" : "hover:bg-cos-paper"
                            )}
                          >
                            <input
                              type="checkbox"
                              checked={marcado}
                              onChange={() => toggle(c.id)}
                              className="translate-y-0.5 accent-[--brand]"
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[13px] font-medium text-cos-ink">
                                {c.serie || c.folio ? `${c.serie ?? ""}-${c.folio ?? ""} · ` : ""}
                                {c.cliente}
                              </span>
                              <span className="font-mono text-[11px] text-cos-ink-faint">
                                {fFecha(c.fecha)}
                                {c.metodoPago && ` · ${c.metodoPago}`}
                                {c.alreadyMatched && c.remainingBalance > 0 && (
                                  <> · saldo <Money value={c.remainingBalance} className="text-[11px]" muted /></>
                                )}
                              </span>
                            </span>
                            <span className="text-right">
                              <Money value={c.total} className="block text-[13px]" />
                              {marcado && asig && asig.aplicar < c.total && (
                                <span className="block font-mono text-[11px] text-cos-brand-ink">
                                  aplica <Money value={asig.aplicar} className="text-[11px] text-cos-brand-ink" />
                                </span>
                              )}
                            </span>
                            <span className="flex flex-col items-end gap-0.5">
                              <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", CONFIANZA[c.confidence].cls)}>
                                {CONFIANZA[c.confidence].t}
                              </span>
                              {/* El porqué de la confianza: el RFC que el banco
                                  escribió en el SPEI es el del receptor de este
                                  CFDI. Es la señal más fuerte del scoring
                                  (PUNTOS_RFC_EXACTO) — merece verse. */}
                              {selTx?.contraparteRfc && c.rfc === selTx.contraparteRfc && (
                                <span className="rounded-full bg-cos-jade-tint px-2 py-0.5 text-[10px] font-semibold text-cos-jade-ink">
                                  RFC coincide
                                </span>
                              )}
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>

                  {/* Impuestos: el cargo paga una declaración (SIPARE / línea de captura). */}
                  {selTx.monto < 0 && cand.impuestos.length > 0 && (
                    <div className="border-t border-cos-line-soft">
                      <p className="px-5 pt-2.5 font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-cos-ink-faint">
                        ¿O paga una declaración?
                      </p>
                      <ul>
                        {cand.impuestos.map((i) => (
                          <li key={i.id}>
                            <label className={cn("flex cursor-pointer items-baseline gap-3 px-5 py-2", selImpuesto === i.id ? "bg-cos-brand-tint" : "hover:bg-cos-paper")}>
                              <input
                                type="radio"
                                name="impuesto"
                                checked={selImpuesto === i.id}
                                onChange={() => { setSelImpuesto(i.id); setSeleccion([]); }}
                                className="translate-y-0.5 accent-[--brand]"
                              />
                              <span className="flex-1 text-[13px] text-cos-ink">{i.etiqueta}</span>
                              {i.montoEsperado != null && <Money value={i.montoEsperado} className="text-[13px]" />}
                              <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", CONFIANZA[i.confidence].cls)}>
                                {CONFIANZA[i.confidence].t}
                              </span>
                            </label>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* ── Suma aplicada y acción ── */}
                  <div className="flex flex-wrap items-center justify-between gap-3 border-t border-cos-line bg-cos-paper px-5 py-3">
                    {selImpuesto ? (
                      <>
                        <span className="text-[13px] text-cos-ink-soft">
                          El cargo queda MATCHED y la declaración PAGADA, en una sola transacción.
                        </span>
                        <button
                          onClick={conciliarImpuesto}
                          disabled={aplicando}
                          className="inline-flex items-center gap-1.5 rounded-control bg-cos-brand px-4 py-2 text-sm font-medium text-white hover:bg-cos-brand-deep disabled:opacity-50"
                        >
                          {aplicando && <Loader2 className="h-4 w-4 animate-spin" />}
                          Conciliar impuesto
                        </button>
                      </>
                    ) : (
                      <>
                        <div className="text-[13px]">
                          <span className="text-cos-ink-soft">Suma aplicada </span>
                          <Money value={sumaAplicada} className="text-[13px]" />
                          <span className="mx-2 text-cos-line">·</span>
                          <span className="text-cos-ink-soft">Diferencia contra el {selTx.monto > 0 ? "depósito" : "retiro"} </span>
                          <Money
                            value={diferencia}
                            className={cn("text-[13px]", diferencia === 0 ? "text-cos-jade-ink" : "text-cos-amber-ink")}
                          />
                          {diferencia === 0 && sumaAplicada > 0 && (
                            <Check className="ml-1 inline h-3.5 w-3.5 text-cos-jade-ink" />
                          )}
                          {diferencia > 0 && sumaAplicada > 0 && (
                            <span className="ml-2 text-[11px] text-cos-ink-faint">
                              se permite parcial; queda advertencia
                            </span>
                          )}
                        </div>
                        <button
                          onClick={conciliar}
                          disabled={aplicando || asignaciones.length === 0}
                          className="inline-flex items-center gap-1.5 rounded-control bg-cos-brand px-4 py-2 text-sm font-medium text-white hover:bg-cos-brand-deep disabled:opacity-50"
                        >
                          {aplicando && <Loader2 className="h-4 w-4 animate-spin" />}
                          Conciliar selección
                        </button>
                      </>
                    )}
                  </div>
                  <p className="border-t border-cos-line-soft px-5 py-2 text-[11px] text-cos-ink-faint">
                    Al conciliar queda el rastro en bitácora: quién aplicó, a qué hora y contra qué CFDI.
                  </p>
                    </>
                  )}

                  {/* ── ¿No es una factura? La mesa también clasifica lo demás
                      —préstamos, aportaciones, traspasos, nómina— con el MISMO
                      PATCH del tab Movimientos; el cierre postea cada tag con
                      su asiento. Antes esto obligaba a cambiar de tab. */}
                  <div className="border-t border-cos-line px-5 py-3.5">
                    <p className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-cos-ink-faint">
                      ¿No es una factura?
                    </p>
                    {cand?.sugerencia && (
                      <div className="mt-2 flex flex-wrap items-center gap-2 rounded-card bg-cos-brand-tint px-3.5 py-2.5">
                        {/* La EVIDENCIA junto al veredicto: el usuario decide
                            con ella, no con fe en el sistema. */}
                        <span className="min-w-[200px] flex-1 text-[13px] text-cos-ink">
                          Parece <b>{cand.sugerencia.etiqueta}</b> — {cand.sugerencia.porQue}.
                        </span>
                        <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", CONFIANZA[cand.sugerencia.confianza].cls)}>
                          {cand.sugerencia.confianza}
                        </span>
                        <button
                          onClick={() => clasificar(cand.sugerencia!.tag, cand.sugerencia!.etiqueta)}
                          disabled={aplicando}
                          className="rounded-control bg-cos-brand px-3 py-1.5 text-[13px] font-medium text-white hover:bg-cos-brand-deep disabled:opacity-50"
                        >
                          Aplicar
                        </button>
                      </div>
                    )}
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {CATEGORIAS_MESA.map((c) => (
                        <button
                          key={c.tag ?? "__ignorar__"}
                          onClick={() => clasificar(c.tag, c.label)}
                          disabled={aplicando}
                          className="rounded-full border border-cos-line bg-cos-card px-3 py-1.5 text-[12.5px] font-medium text-cos-ink-soft hover:border-cos-brand hover:text-cos-brand-ink disabled:opacity-50"
                        >
                          {c.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
