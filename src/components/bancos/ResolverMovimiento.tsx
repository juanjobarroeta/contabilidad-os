"use client";

// ─────────────────────────────────────────────────────────────────────────────
// RESOLVER UN MOVIMIENTO — el panel único.
//
// Todo lo que hace falta para decidir qué es un movimiento del banco: sus
// candidatos puntuados, el pago junto, la búsqueda manual de facturas, la
// charola con montos editables, los pagos de impuestos, el comprobante de
// Banxico y las categorías sin factura.
//
// Vive aparte porque estaba DUPLICADO. La mesa y la lista de Movimientos
// resolvían el mismo movimiento con capacidades distintas —una dejaba editar
// los montos y la otra los repartía sola; una tenía la búsqueda manual y la
// otra no— así que el resultado dependía de en qué pestaña estabas parado. Y
// cada función nueva aterrizaba en una sola de las dos: el comprobante CEP
// quedó en Movimientos, la tarjeta de anticipos en la mesa.
//
// Al montarse en ambas, la deriva deja de ser cuestión de disciplina.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeftRight, Ban, Banknote, Building2, ChevronDown, Loader2, Search,
  SlidersHorizontal, Users, X,
} from "lucide-react";
import { Money } from "@/components/ui/Money";
import { Chip } from "@/components/ui";
import type { SugerenciaMovimiento } from "@/lib/bancos/inferir-movimiento";
import {
  CONF_TONO, FAMILIA_LOTE, fmtFechaCorta, tokenDeDescripcion,
  type CandidatoFactura, type CandidatoImpuesto, type CepMovimiento,
  type FacturaBuscada, type MovimientoResoluble, type PagoJuntoSugerido,
  type SeleccionFactura,
} from "./resolver-tipos";

/** Categorías sin factura: un toque las ignora CON su tag, que es lo que
 *  `postMonth` sabe postear. Deben ser las mismas en toda la aplicación. */
const CATEGORIAS: { tag: string | null; label: string; icon: typeof Banknote }[] = [
  { tag: "TAX_PAYMENT",          label: "Pago de impuestos",        icon: Building2 },
  { tag: "PAYROLL_NO_CFDI",      label: "Nómina sin CFDI",          icon: Users },
  { tag: "PAYROLL_DISPERSED",    label: "Dispersión de nómina ya timbrada", icon: Users },
  // Cobrado/pagado sin factura: pasivo y activo, no ingreso ni gasto. No
  // archivan el movimiento — lo mandan a la lista de anticipos sin CFDI.
  { tag: "ANTICIPO_CLIENTE",     label: "Anticipo de cliente (falta CFDI)",  icon: Banknote },
  { tag: "ANTICIPO_PROVEEDOR",   label: "Anticipo a proveedor (falta CFDI)", icon: Banknote },
  { tag: "LOAN_RECEIVED",        label: "Préstamo recibido",        icon: Banknote },
  { tag: "LOAN_GIVEN",           label: "Préstamo otorgado",        icon: Banknote },
  { tag: "CAPITAL_CONTRIBUTION", label: "Aportación de capital",    icon: Building2 },
  { tag: "IVA_COMISION",         label: "IVA de comisión bancaria", icon: Banknote },
  { tag: "RENT",                 label: "Renta sin CFDI",           icon: Building2 },
  { tag: "FINANCIAL_INCOME",     label: "Intereses ganados",        icon: Banknote },
  { tag: "NON_DEDUCTIBLE",       label: "No deducible",             icon: Ban },
  { tag: "INTERNAL_TRANSFER",    label: "Transferencia entre cuentas", icon: ArrowLeftRight },
  { tag: null,                   label: "Ignorar",                  icon: X },
];

/** Lo que el servidor devuelve al conciliar el cobro de una PPD: hay que
 *  timbrar el complemento de pago. */
export interface RepSugerido {
  txId: string;
  invoiceId: string;
  cliente: string;
  monto: number;
  fecha: string;
}

export function ResolverMovimiento({
  tx, companyId, onCambio, onToast, onVerFactura, onRepSugerido, onResuelto,
}: {
  tx: MovimientoResoluble;
  companyId: string;
  /** Recargar las listas de quien monta el panel. */
  onCambio: () => void | Promise<void>;
  onToast: (mensaje: string) => void;
  onVerFactura?: (invoiceId: string) => void;
  /** Cobro de una PPD: hay que timbrar el complemento de pago. */
  onRepSugerido?: (r: RepSugerido) => void;
  /** El movimiento dejó de estar pendiente: cerrar el panel. */
  onResuelto: () => void;
}) {
  const [candidatos, setCandidatos] = useState<CandidatoFactura[]>([]);
  const [cargando, setCargando] = useState(true);
  const [pagoJunto, setPagoJunto] = useState<PagoJuntoSugerido | null>(null);
  const [impuestos, setImpuestos] = useState<CandidatoImpuesto[]>([]);
  const [cep, setCep] = useState<CepMovimiento | null>(null);
  // Categoría SUGERIDA por el servidor, con su evidencia. Vivía sólo en la
  // mesa; al compartir el panel la gana también la lista de Movimientos.
  const [sugerencia, setSugerencia] = useState<SugerenciaMovimiento | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [multiOcupado, setMultiOcupado] = useState(false);
  const [seleccion, setSeleccion] = useState<SeleccionFactura[]>([]);

  // Búsqueda manual de facturas: SIN ventana de fechas, que es lo que la hace
  // el último recurso cuando el score no encontró nada.
  const [manualAbierta, setManualAbierta] = useState(false);
  const [manualTipo, setManualTipo] = useState<"INGRESO" | "EGRESO" | "NOMINA">(
    tx.monto < 0 ? "EGRESO" : "INGRESO",
  );
  const [manualQuery, setManualQuery] = useState("");
  const [manualCargando, setManualCargando] = useState(false);
  const [manualResultados, setManualResultados] = useState<FacturaBuscada[]>([]);

  // Categorizar TODOS los similares, con regla guardada y retroactiva.
  const [similaresAbierto, setSimilaresAbierto] = useState(false);
  const [similarToken, setSimilarToken] = useState("");
  const [similarFamilia, setSimilarFamilia] = useState("NON_DEDUCTIBLE");
  const [similarCount, setSimilarCount] = useState<number | null>(null);
  const [similarOcupado, setSimilarOcupado] = useState(false);
  const similarSigno: "CREDITO" | "DEBITO" = tx.monto >= 0 ? "CREDITO" : "DEBITO";

  // ── Carga ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    let vivo = true;
    setCargando(true);
    setCandidatos([]); setImpuestos([]); setPagoJunto(null); setCep(null); setSeleccion([]);
    setSugerencia(null);
    setManualAbierta(false); setManualQuery(""); setManualResultados([]);
    setManualTipo(tx.monto < 0 ? "EGRESO" : "INGRESO");
    setSimilaresAbierto(false); setSimilarToken(""); setSimilarCount(null);

    fetch(`/api/bancos/transactions/${tx.id}/cep`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (vivo && d) setCep(d); })
      .catch(() => {});

    fetch(`/api/bancos/${tx.bankAccountId}/match?txId=${tx.id}`)
      .then((r) => r.json())
      .then((data) => {
        if (!vivo) return;
        setCandidatos(data.candidates ?? []);
        setImpuestos(data.impuestos ?? []);
        setPagoJunto(data.pagoJunto ?? null);
        setSugerencia(data.sugerencia ?? null);
      })
      .catch(() => {})
      .finally(() => { if (vivo) setCargando(false); });

    return () => { vivo = false; };
  }, [tx.id, tx.bankAccountId, tx.monto]);

  // Búsqueda manual (debounced).
  useEffect(() => {
    if (!manualAbierta) return;
    let cancelado = false;
    const t = setTimeout(async () => {
      setManualCargando(true);
      try {
        const params = new URLSearchParams({ companyId, tipo: manualTipo, take: "20", unmatchedOnly: "true" });
        if (manualQuery.trim()) params.set("q", manualQuery.trim());
        const res = await fetch(`/api/facturas?${params}`);
        const data = await res.json();
        if (!cancelado) setManualResultados(Array.isArray(data) ? data : []);
      } catch {
        if (!cancelado) setManualResultados([]);
      } finally {
        if (!cancelado) setManualCargando(false);
      }
    }, 250);
    return () => { cancelado = true; clearTimeout(t); };
  }, [manualAbierta, manualTipo, manualQuery, companyId]);

  // Cuenta los similares sin conciliar cada vez que cambia el patrón.
  useEffect(() => {
    if (!similaresAbierto || !similarToken.trim()) { setSimilarCount(null); return; }
    let cancelado = false;
    const t = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ companyId, patron: similarToken.trim(), signo: similarSigno });
        const res = await fetch(`/api/bancos/sugerencias/lote?${params}`);
        const data = await res.json().catch(() => ({}));
        if (!cancelado) setSimilarCount(typeof data.count === "number" ? data.count : null);
      } catch {
        if (!cancelado) setSimilarCount(null);
      }
    }, 300);
    return () => { cancelado = true; clearTimeout(t); };
  }, [similaresAbierto, similarToken, similarSigno, companyId]);

  const terminar = useCallback(async () => {
    onResuelto();
    await onCambio();
  }, [onResuelto, onCambio]);

  // ── Acciones ──────────────────────────────────────────────────────────────
  async function conciliar(invoiceId: string) {
    const res = await fetch(`/api/bancos/transactions/${tx.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "match", invoiceId }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      onToast(data?.error ?? "No se pudo conciliar");
      return;
    }
    const data = await res.json().catch(() => null);
    onToast("Movimiento conciliado");
    // Cobro de una PPD → sugerir el REP (el IVA se causa en el mes del pago y
    // el complemento vence el quinto día natural del mes siguiente).
    if (data?.repSugerido) onRepSugerido?.({ txId: tx.id, ...data.repSugerido });
    await terminar();
  }

  async function conciliarImpuesto(taxDeclarationId: string, etiqueta: string) {
    setOcupado(true);
    try {
      const res = await fetch(`/api/bancos/transactions/${tx.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "match-impuesto", taxDeclarationId }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) { onToast(`Pago conciliado: ${etiqueta}`); await terminar(); }
      else onToast(data?.error ?? "No se pudo conciliar el pago de impuestos");
    } finally { setOcupado(false); }
  }

  async function aplicarPagoJunto() {
    if (!pagoJunto) return;
    setMultiOcupado(true);
    try {
      const res = await fetch(`/api/bancos/transactions/${tx.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "match-multiple",
          asignaciones: pagoJunto.facturas.map((f) => ({ invoiceId: f.invoiceId, monto: f.monto })),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        onToast(`Pago junto aplicado: ${pagoJunto.facturas.length} facturas de ${pagoJunto.cliente}`);
        await terminar();
      } else onToast(data?.error ?? "No se pudo aplicar el pago junto");
    } finally { setMultiOcupado(false); }
  }

  function alternar(f: { id: string; label: string; total: number }) {
    setSeleccion((prev) =>
      prev.some((s) => s.id === f.id)
        ? prev.filter((s) => s.id !== f.id)
        : [...prev, { id: f.id, label: f.label, total: f.total, monto: f.total.toFixed(2) }],
    );
  }

  async function conciliarMultiple() {
    const asignaciones = seleccion.map((s) => ({ invoiceId: s.id, monto: Number(s.monto) }));
    if (asignaciones.some((a) => !Number.isFinite(a.monto) || a.monto <= 0)) {
      onToast("Revise los montos asignados: deben ser mayores a cero");
      return;
    }
    setMultiOcupado(true);
    try {
      const res = await fetch(`/api/bancos/transactions/${tx.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "match-multiple", asignaciones }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        onToast(data?.advertencia?.mensaje
          ? `Conciliado con ${asignaciones.length} facturas. ${data.advertencia.mensaje}`
          : `Conciliado con ${asignaciones.length} factura${asignaciones.length === 1 ? "" : "s"}`);
        await terminar();
      } else onToast(data?.error ?? "No se pudo conciliar");
    } finally { setMultiOcupado(false); }
  }

  async function categorizar(tag: string | null, label: string) {
    setOcupado(true);
    try {
      const res = await fetch(`/api/bancos/transactions/${tx.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "ignore", notes: tag }),
      });
      if (res.ok) { onToast(`Categorizado: ${label}`); await terminar(); }
      else onToast("No se pudo categorizar");
    } finally { setOcupado(false); }
  }

  function abrirSimilares() {
    if (similaresAbierto) { setSimilaresAbierto(false); return; }
    setSimilaresAbierto(true);
    setSimilarToken(tokenDeDescripcion(tx.descripcion));
    setSimilarFamilia("NON_DEDUCTIBLE");
    setSimilarCount(null);
  }

  async function categorizarSimilares() {
    const patron = similarToken.trim();
    if (!patron) { onToast("Escribe un patrón para agrupar"); return; }
    const label = FAMILIA_LOTE.find((f) => f.familia === similarFamilia)?.label ?? similarFamilia;
    setSimilarOcupado(true);
    try {
      const res = await fetch("/api/bancos/sugerencias/lote", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          txIds: [tx.id], familia: similarFamilia, patron, signo: similarSigno,
          crearRegla: true, retroactivo: true,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const n = (data?.lote?.aprobados ?? 0) + (data?.retro?.aprobados ?? 0);
        onToast(`${n} movimiento(s) categorizados como "${label}". Regla guardada.`);
        setSimilaresAbierto(false);
        await terminar();
      } else onToast(data?.error ?? "No se pudieron categorizar los similares");
    } finally { setSimilarOcupado(false); }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  const abs = Math.abs(tx.monto);
  const asignado = seleccion.reduce((s, x) => s + (Number(x.monto) || 0), 0);
  const restante = abs - asignado;
  const excede = asignado > abs * 1.01;
  const fmt = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

  return (
    <div className="mt-3 flex flex-col gap-3">
      {/* El detalle fino y la cadena CRUDA del banco. Nunca se esconde: el
          estado de cuenta es la fuente de verdad y quien concilia a mano
          necesita poder leerla tal cual. */}
      {(tx.contraparteClabe || tx.claveRastreo || tx.contraparteNombre) && (
        <div className="rounded-control bg-cos-paper px-3 py-2.5 text-[12.5px] text-cos-ink-soft">
          {tx.contraparteClabe && (
            <div>CLABE <span className="font-mono text-cos-ink">{tx.contraparteClabe}</span></div>
          )}
          {tx.claveRastreo && (
            <div className="mt-0.5">
              Clave de rastreo <span className="font-mono text-cos-ink">{tx.claveRastreo}</span>
            </div>
          )}
          <div className="mt-1.5 break-words border-t border-cos-line pt-1.5 text-[11.5px] text-cos-ink-faint">
            {tx.descripcion}
          </div>
        </div>
      )}

      {/* COMPROBANTE DE BANXICO. No es adorno: el CEP prueba que ESE importe
          llegó a la cuenta de ESE beneficiario en ESA fecha — la evidencia de
          materialidad que se le enseña al SAT. Y le enseña a quien concilia DE
          DÓNDE salió el RFC, para que la sugerencia no parezca adivinada. */}
      {cep && (
        <div className="rounded-control border border-cos-line bg-cos-paper px-3 py-2.5 text-[12.5px]">
          <div className="flex items-center justify-between gap-2">
            <p className="font-semibold text-cos-ink">
              Comprobante de Banxico
              {cep.estado && (
                <span className={"ml-2 rounded-full px-2 py-0.5 text-[11.5px] font-medium " +
                  (/devuel/i.test(cep.estado)
                    ? "bg-cos-amber-tint text-cos-amber-ink"
                    : "bg-cos-brand-tint text-cos-brand-ink")}>
                  {cep.estado}
                </span>
              )}
            </p>
            <a href={`/api/bancos/transactions/${tx.id}/cep?xml=1`}
              className="flex-none text-[12.5px] font-semibold text-cos-brand-ink hover:underline">
              Descargar XML
            </a>
          </div>
          <div className="mt-1.5 grid gap-1 border-t border-cos-line pt-1.5 text-cos-ink-soft sm:grid-cols-2">
            <div>
              <p className="text-[11.5px] uppercase tracking-wide text-cos-ink-faint">Ordenante</p>
              <p className="text-cos-ink">{cep.ordenanteNombre ?? "—"}</p>
              <p className="font-mono text-[11.5px]">{cep.ordenanteRfc ?? "—"}{cep.ordenanteBanco ? ` · ${cep.ordenanteBanco}` : ""}</p>
            </div>
            <div>
              <p className="text-[11.5px] uppercase tracking-wide text-cos-ink-faint">Beneficiario</p>
              <p className="text-cos-ink">{cep.beneficiarioNombre ?? "—"}</p>
              <p className="font-mono text-[11.5px]">{cep.beneficiarioRfc ?? "—"}{cep.beneficiarioBanco ? ` · ${cep.beneficiarioBanco}` : ""}</p>
            </div>
          </div>
          {cep.concepto && (
            <p className="mt-1.5 border-t border-cos-line pt-1.5 text-[11.5px] text-cos-ink-faint">
              Concepto: {cep.concepto}
            </p>
          )}
        </div>
      )}

      {/* Pago junto: N facturas de la MISMA contraparte suman exacto el
          movimiento — la combinación es única, por eso se ofrece en un gesto. */}
      {!cargando && pagoJunto && (
        <div className="rounded-control border border-cos-brand/30 bg-cos-brand-tint px-3 py-2.5">
          <p className="text-[13px] font-semibold text-cos-brand-ink">
            Pago junto: {pagoJunto.facturas.length} facturas de {pagoJunto.cliente} suman exacto <Money value={pagoJunto.suma} size={13} />
          </p>
          <p className="mt-0.5 text-[12px] text-cos-ink-soft">
            {pagoJunto.facturas.map((f) => `${f.folio} (${f.monto.toLocaleString("es-MX", { style: "currency", currency: "MXN" })})`).join(" + ")}
          </p>
          <button onClick={aplicarPagoJunto} disabled={multiOcupado}
            className="mt-2 rounded-control bg-cos-brand px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-cos-brand-deep disabled:opacity-50">
            {multiOcupado ? "Aplicando…" : `Conciliar las ${pagoJunto.facturas.length} facturas`}
          </button>
        </div>
      )}

      {cargando ? (
        <span className="inline-flex items-center gap-2 text-[13px] text-cos-ink-faint">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Buscando facturas…
        </span>
      ) : candidatos.length > 0 ? (
        <>
          <p className="text-[12.5px] font-semibold text-cos-ink">Coincidencias sugeridas</p>
          <div className="flex flex-col gap-2">
            {candidatos.map((c) => (
              <div key={c.id} className="flex items-center justify-between gap-3 rounded-control bg-cos-paper px-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-[13.5px] font-medium text-cos-ink">{c.cliente}</p>
                  <p className="text-[12px] text-cos-ink-faint">
                    <span className="font-mono">{c.rfc}</span> · {fmtFechaCorta(c.fecha)} · <Money value={c.total} size={12} muted />
                  </p>
                </div>
                <div className="flex flex-none items-center gap-2">
                  <Chip tone={CONF_TONO[c.confidence]} label={c.confidence} />
                  <button onClick={() => alternar({ id: c.id, label: c.cliente, total: c.total })}
                    className={"rounded-control border px-3 py-1.5 text-[13px] font-semibold " + (seleccion.some((s) => s.id === c.id) ? "border-cos-brand bg-cos-brand-tint text-cos-brand-ink" : "border-cos-line bg-cos-card text-cos-ink-soft hover:border-cos-brand hover:text-cos-brand-ink")}>
                    {seleccion.some((s) => s.id === c.id) ? "Quitar" : "Agregar"}
                  </button>
                  <button onClick={() => conciliar(c.id)}
                    className="rounded-control bg-cos-brand px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-cos-brand-deep">
                    Conciliar
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <span className="text-[13px] text-cos-ink-faint">Sin coincidencias automáticas.</span>
      )}

      {/* Pagos de impuestos pendientes (sólo egresos): declaraciones SIPARE /
          línea de captura sin pagar. Un tap marca pago PAID + movimiento MATCHED. */}
      {!cargando && impuestos.length > 0 && (
        <>
          <p className="text-[12.5px] font-semibold text-cos-ink">Pagos de impuestos pendientes</p>
          <div className="flex flex-col gap-2">
            {impuestos.map((c) => (
              <div key={c.id} className="flex items-center justify-between gap-3 rounded-control bg-cos-paper px-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-[13.5px] font-medium text-cos-ink">{c.etiqueta}</p>
                  <p className="text-[12px] text-cos-ink-faint">
                    {c.montoEsperado != null
                      ? <Money value={c.montoEsperado} size={12} muted />
                      : <span>Monto según SUA (sin estimado)</span>}
                    {c.fechaLimitePago && <> · vence {fmtFechaCorta(c.fechaLimitePago)}</>}
                  </p>
                </div>
                <div className="flex flex-none items-center gap-2">
                  <Chip tone={CONF_TONO[c.confidence]} label={c.confidence} />
                  <button onClick={() => conciliarImpuesto(c.id, c.etiqueta)} disabled={ocupado}
                    className="rounded-control bg-cos-brand px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-cos-brand-deep disabled:opacity-50">
                    Conciliar
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Charola: facturas agregadas con monto asignado EDITABLE por línea. El
          reparto automático es un punto de partida, no una decisión que el
          sistema pueda tomar por el contador. */}
      {seleccion.length > 0 && (
        <div className="rounded-control border border-cos-brand bg-cos-brand-tint/40 p-3">
          <p className="text-[12.5px] font-semibold text-cos-ink">
            Conciliación múltiple · {seleccion.length} factura{seleccion.length === 1 ? "" : "s"} seleccionada{seleccion.length === 1 ? "" : "s"}
          </p>
          <div className="mt-2 flex flex-col gap-1.5">
            {seleccion.map((s) => (
              <div key={s.id} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[13px] text-cos-ink">{s.label}</span>
                <input type="number" step="0.01" min="0" value={s.monto}
                  onChange={(e) => setSeleccion((prev) => prev.map((x) => (x.id === s.id ? { ...x, monto: e.target.value } : x)))}
                  aria-label={`Monto asignado a ${s.label}`}
                  className="w-[120px] rounded-control border border-cos-line bg-cos-card px-2 py-1 text-right font-mono text-[12.5px] text-cos-ink outline-none focus:border-cos-brand" />
                <button onClick={() => alternar(s)} title="Quitar de la selección"
                  className="grid h-6 w-6 flex-none place-items-center rounded-control text-cos-ink-faint hover:bg-cos-paper hover:text-cos-ink">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
          <div className="mt-2 flex flex-col gap-0.5 border-t border-dashed border-cos-line pt-2 text-[12.5px]">
            <div className="flex justify-between">
              <span className="text-cos-ink-soft">Suma asignada</span>
              <span className={"font-mono font-semibold " + (excede ? "text-cos-red-ink" : "text-cos-ink")}>{fmt(asignado)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-cos-ink-soft">Monto del movimiento</span>
              <span className="font-mono text-cos-ink">{fmt(abs)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-cos-ink-soft">Restante</span>
              <span className={"font-mono " + (excede ? "text-cos-red-ink" : "text-cos-ink")}>{fmt(restante)}</span>
            </div>
          </div>
          {excede && (
            <p className="mt-1.5 text-[12px] text-cos-red-ink">La suma asignada excede el monto del movimiento.</p>
          )}
          {!excede && restante > abs * 0.01 && (
            <p className="mt-1.5 text-[12px] text-cos-amber-ink">
              Lo que quede sin asignar se registra como <b>anticipo</b>, no como cobro de una
              factura. El cierre lo reporta.
            </p>
          )}
          <button onClick={conciliarMultiple} disabled={multiOcupado || seleccion.length < 1 || excede}
            className="mt-2.5 w-full rounded-control bg-cos-brand px-3 py-2 text-[13px] font-semibold text-white hover:bg-cos-brand-deep disabled:opacity-50">
            {multiOcupado ? "Conciliando…" : `Conciliar ${seleccion.length} factura${seleccion.length === 1 ? "" : "s"}`}
          </button>
        </div>
      )}

      {/* Búsqueda manual: SIN ventana de fechas y por importe además de texto.
          Es el camino de quien YA sabe qué factura es. */}
      <div className="rounded-control border border-cos-line">
        <button onClick={() => setManualAbierta((o) => !o)}
          className="flex w-full items-center gap-2 px-3 py-2.5 text-[13px] text-cos-ink-faint hover:text-cos-brand-ink">
          <Search className="h-[15px] w-[15px]" /> Buscar otra factura por cliente, folio o monto…
          <ChevronDown className={"ml-auto h-3.5 w-3.5 transition-transform " + (manualAbierta ? "rotate-180" : "")} />
        </button>
        {manualAbierta && (
          <div className="border-t border-cos-line-soft p-2.5">
            <div className="mb-2 flex gap-1.5">
              {(["INGRESO", "EGRESO", "NOMINA"] as const).map((t) => (
                <button key={t} onClick={() => setManualTipo(t)}
                  className={"rounded-full px-2.5 py-1 text-[12px] font-medium " + (manualTipo === t ? "bg-cos-brand text-white" : "bg-cos-paper text-cos-ink-soft hover:bg-cos-line-soft")}>
                  {t === "INGRESO" ? "Ingresos" : t === "EGRESO" ? "Gastos" : "Nómina"}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 rounded-control border border-cos-line px-2.5 py-1.5">
              <Search className="h-4 w-4 text-cos-ink-faint" />
              <input value={manualQuery} onChange={(e) => setManualQuery(e.target.value)} autoFocus
                placeholder="Cliente, RFC, UUID, folio, importe…"
                className="w-full bg-transparent text-[13px] outline-none placeholder:text-cos-ink-faint" />
            </div>
            <div className="mt-2 max-h-[40vh] overflow-y-auto">
              {manualCargando ? (
                <div className="flex items-center gap-2 py-3 text-[12.5px] text-cos-ink-faint">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Buscando…
                </div>
              ) : manualResultados.length === 0 ? (
                <p className="py-3 text-center text-[12.5px] text-cos-ink-faint">Sin facturas por conciliar con ese criterio.</p>
              ) : manualResultados.map((f) => (
                <div key={f.id} className="flex items-center justify-between gap-3 border-b border-cos-line-soft py-2 last:border-0">
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-medium text-cos-ink">{f.customer?.razonSocial ?? "—"}</p>
                    <p className="text-[11.5px] text-cos-ink-faint">
                      <span className="font-mono">{f.customer?.rfc ?? "—"}</span>
                      {f.folio ? ` · ${f.serie ?? ""}${f.folio}` : ""} · {fmtFechaCorta(f.fecha)} · <Money value={f.total} size={11.5} muted />
                    </p>
                  </div>
                  <div className="flex flex-none items-center gap-1.5">
                    <button onClick={() => alternar({ id: f.id, label: f.customer?.razonSocial ?? "Factura", total: f.total })}
                      className={"rounded-control border px-3 py-1.5 text-[12.5px] font-semibold " + (seleccion.some((s) => s.id === f.id) ? "border-cos-brand bg-cos-brand-tint text-cos-brand-ink" : "border-cos-line bg-cos-card text-cos-ink-soft hover:border-cos-brand hover:text-cos-brand-ink")}>
                      {seleccion.some((s) => s.id === f.id) ? "Quitar" : "Agregar"}
                    </button>
                    {onVerFactura && (
                      <button onClick={() => onVerFactura(f.id)}
                        className="rounded-control border border-cos-line px-2.5 py-1.5 text-[12.5px] font-medium text-cos-ink-soft hover:border-cos-brand hover:text-cos-brand-ink">
                        Ver
                      </button>
                    )}
                    <button onClick={() => conciliar(f.id)}
                      className="rounded-control bg-cos-brand px-3 py-1.5 text-[12.5px] font-semibold text-white hover:bg-cos-brand-deep">
                      Conciliar
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-3">
        <span className="h-px flex-1 bg-cos-line-soft" />
        <span className="text-[12px] text-cos-ink-faint">o categoriza sin factura</span>
        <span className="h-px flex-1 bg-cos-line-soft" />
      </div>

      {/* LA EVIDENCIA JUNTO AL VEREDICTO: el usuario decide con ella, no con fe
          en el sistema. Por eso la sugerencia dice POR QUÉ y con qué confianza,
          y el botón aplica esa categoría de un toque. */}
      {sugerencia && (
        <div className="flex flex-wrap items-center gap-2 rounded-control bg-cos-brand-tint px-3.5 py-2.5">
          <span className="min-w-[200px] flex-1 text-[13px] text-cos-ink">
            Parece <b>{sugerencia.etiqueta}</b> — {sugerencia.porQue}.
          </span>
          <span className={"rounded-full px-2 py-0.5 text-[11px] font-semibold " +
            (sugerencia.confianza === "alta"
              ? "bg-cos-jade-tint text-cos-jade-ink"
              : "bg-cos-amber-tint text-cos-amber-ink")}>
            {sugerencia.confianza}
          </span>
          <button onClick={() => categorizar(sugerencia.tag, sugerencia.etiqueta)} disabled={ocupado}
            className="rounded-control bg-cos-brand px-3 py-1.5 text-[13px] font-medium text-white hover:bg-cos-brand-deep disabled:opacity-50">
            Aplicar
          </button>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {CATEGORIAS.map(({ tag, label, icon: Icon }) => (
          <button key={label} onClick={() => categorizar(tag, label)} disabled={ocupado}
            className={"inline-flex items-center gap-2 rounded-control border border-cos-line bg-cos-card px-3 py-2 text-[13px] font-medium hover:border-cos-brand hover:bg-cos-brand-tint hover:text-cos-brand-ink disabled:opacity-50 " + (tag === null ? "text-cos-ink-faint" : "text-cos-ink-soft")}>
            <Icon className="h-[15px] w-[15px] opacity-70" /> {label}
          </button>
        ))}
      </div>

      {/* Categorizar TODOS los similares: deriva un token del concepto, cuenta
          los que coinciden, deja elegir la familia (los restaurantes pueden ser
          parcialmente deducibles — no se agrupan a ciegas), guarda la regla y
          la aplica retroactivamente. */}
      <div className="rounded-control border border-cos-line">
        <button onClick={abrirSimilares}
          className="flex w-full items-center gap-2 px-3 py-2.5 text-[13px] font-semibold text-cos-brand-ink hover:bg-cos-brand-tint/40">
          <SlidersHorizontal className="h-[15px] w-[15px]" /> Categorizar todos los similares…
          <ChevronDown className={"ml-auto h-3.5 w-3.5 transition-transform " + (similaresAbierto ? "rotate-180" : "")} />
        </button>
        {similaresAbierto && (
          <div className="flex flex-col gap-2.5 border-t border-cos-line-soft p-3">
            <label className="block">
              <span className="text-[11.5px] font-medium uppercase tracking-[0.02em] text-cos-ink-faint">Patrón a agrupar</span>
              <input value={similarToken} onChange={(e) => setSimilarToken(e.target.value.toUpperCase())}
                placeholder="Ej. RAPPI, OPENAI…"
                className="mt-1 w-full rounded-control border border-cos-line bg-cos-card px-3 py-2 font-mono text-[13px] uppercase text-cos-ink outline-none focus:border-cos-brand" />
            </label>
            <label className="block">
              <span className="text-[11.5px] font-medium uppercase tracking-[0.02em] text-cos-ink-faint">Clasificar como</span>
              <select value={similarFamilia} onChange={(e) => setSimilarFamilia(e.target.value)}
                className="mt-1 w-full rounded-control border border-cos-line bg-cos-card px-3 py-2 text-[13px] text-cos-ink outline-none focus:border-cos-brand">
                {FAMILIA_LOTE.map((f) => <option key={f.familia} value={f.familia}>{f.label}</option>)}
              </select>
            </label>
            <p className="text-[12.5px] text-cos-ink-soft">
              {similarToken.trim()
                ? similarCount == null
                  ? "Contando movimientos similares…"
                  : <>Se categorizarán <b>{similarCount}</b> movimiento{similarCount === 1 ? "" : "s"} sin conciliar que contienen <span className="font-mono">{similarToken.trim()}</span>. Se recordará como regla.</>
                : "Escribe un patrón para agrupar los movimientos similares."}
            </p>
            <button onClick={categorizarSimilares} disabled={similarOcupado || !similarToken.trim() || similarCount === 0}
              className="w-full rounded-control bg-cos-brand px-3 py-2 text-[13px] font-semibold text-white hover:bg-cos-brand-deep disabled:opacity-50">
              {similarOcupado ? "Categorizando…" : similarCount != null && similarCount > 0 ? `Categorizar ${similarCount} similares` : "Categorizar similares"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
