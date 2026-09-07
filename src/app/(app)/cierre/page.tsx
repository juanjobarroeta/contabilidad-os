"use client";

// ─────────────────────────────────────────────────────────────────────────────
// EL CIERRE GUIADO — una acción a la vez.
//
// Antes esta pantalla era la conversación con doce pasos alrededor, y había que
// ser contador (y adivinar qué preguntar) para sacarle algo: encabezado de un
// paso sobre un hilo que hablaba de otro, tres fracciones distintas y ningún
// movimiento obvio.
//
// Ahora abre con LO ÚNICO que toca hacer, dicho como se lo dirías a alguien que
// no es contador, con el botón que lo hace y un «¿por qué?» que despliega el
// detalle del copiloto y las cifras. Lo demás —lo que sigue, la conversación y
// los doce pasos— va debajo, plegado.
//
// La decisión sigue siendo humana: nada se ejecuta sin un tap.
// ─────────────────────────────────────────────────────────────────────────────

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Ban,
  Check,
  ChevronDown,
  ExternalLink,
  Loader2,
  MessageCircle,
  Send,
  ShieldCheck,
  Sparkles,
  Wrench,
} from "lucide-react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { PeriodSelector, usePeriod } from "@/components/contabilidad/PeriodProvider";
import { EspinaPasos } from "@/components/cierre/EspinaPasos";
import { Markdown } from "@/components/ai/Markdown";
import { TOOL_LABELS, useChat, type ChatContexto } from "@/components/ai/useChat";
import { Alert, Loading, RetryButton } from "@/components/ui/feedback";
import { cn } from "@/lib/utils";
import { accionesDelCierre, avanceDelCierre, type AccionCierre } from "@/lib/cierre/acciones";
import { estadoDelPeriodo } from "@/lib/cierre/estado-periodo";
import { PASO_LLANO } from "@/lib/cierre/lenguaje";
import type { CierreEvaluado, PasoConDecision } from "@/lib/cierre/evaluar";
import { esClavePaso, type ClavePasoCierre } from "@/lib/cierre/claves";

function CierrePageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { activeCompany } = useCompany();
  const { year, month, setPeriod } = usePeriod();

  const [cierre, setCierre] = useState<CierreEvaluado | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sinPlan, setSinPlan] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [omitiendo, setOmitiendo] = useState(false);
  const [motivo, setMotivo] = useState("");
  const [porque, setPorque] = useState(false);
  const [verPasos, setVerPasos] = useState(false);
  const [verChat, setVerChat] = useState(false);
  const finRef = useRef<HTMLDivElement>(null);

  // La acción elegida a mano (desde «lo que sigue» o desde los doce pasos).
  const claveParam = searchParams.get("accion");
  const [elegida, setElegida] = useState<string | null>(claveParam);
  const pasoParam = searchParams.get("paso");
  const [pasoElegido, setPasoElegido] = useState<ClavePasoCierre | null>(esClavePaso(pasoParam) ? pasoParam : null);

  useEffect(() => {
    const y = Number(searchParams.get("y"));
    const m = Number(searchParams.get("m"));
    if (y >= 2000 && m >= 1 && m <= 12 && (y !== year || m !== month)) setPeriod(y, m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const companyId = activeCompany?.id;

  const cargar = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/cierre/estado?companyId=${companyId}&year=${year}&month=${month}`);
      if (res.status === 402) {
        setSinPlan(true);
        setCierre(null);
        return;
      }
      const j = (await res.json().catch(() => null)) as CierreEvaluado | { error?: string } | null;
      if (!res.ok || !j || !("pasos" in j)) throw new Error((j as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
      setSinPlan(false);
      setCierre(j);
    } catch {
      setCierre(null);
      setError("No se pudo cargar el cierre del periodo.");
    } finally {
      setLoading(false);
    }
  }, [companyId, year, month]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  // ── Qué toca ahora ─────────────────────────────────────────────────────────
  const acciones = useMemo(() => (cierre ? accionesDelCierre(cierre) : []), [cierre]);
  const avance = useMemo(() => (cierre ? avanceDelCierre(cierre) : { listos: 0, total: 0 }), [cierre]);
  // Un mes ya declarado ante el SAT no es trabajo pendiente: lo cerró el
  // contribuyente. Lo que haya quedado suelto se muestra como observación.
  const periodo = useMemo(
    () => (cierre ? estadoDelPeriodo(cierre) : { declarado: false, detalle: null, pagado: false }),
    [cierre]
  );
  const accion: AccionCierre | null = useMemo(() => {
    if (periodo.declarado && !elegida) return null;
    if (acciones.length === 0) return null;
    return acciones.find((a) => a.clave === elegida) ?? acciones.find((a) => a.paso === pasoElegido) ?? acciones[0];
  }, [acciones, elegida, pasoElegido, periodo.declarado]);

  // El paso activo es el de la acción; sin acciones, el primero sin decidir.
  const pasoActivo: PasoConDecision | null = useMemo(() => {
    if (!cierre) return null;
    const clave = accion?.paso ?? pasoElegido;
    return (
      cierre.pasos.find((p) => p.clave === clave) ??
      cierre.pasos.find((p) => p.estadoCalculado !== "no_aplica" && p.estado === "PENDIENTE") ??
      cierre.pasos[0] ??
      null
    );
  }, [cierre, accion, pasoElegido]);

  const leerContexto = useCallback(
    (): ChatContexto => ({
      ruta: `/cierre?y=${year}&m=${month}${pasoActivo ? `&paso=${pasoActivo.clave}` : ""}`,
      cierre: { year, month, paso: pasoActivo?.clave },
    }),
    [year, month, pasoActivo]
  );

  const chat = useChat({
    companyId: companyId ?? null,
    contexto: leerContexto,
    onAccionConfirmada: () => void cargar(),
  });
  const {
    messages,
    setMessages,
    isLoading,
    activeTool,
    pendingAction,
    setPendingAction,
    confirming,
    enviar,
    confirmar,
    cancelar,
    fijarConversacion,
  } = chat;

  // ── El hilo del periodo ────────────────────────────────────────────────────
  // La conversación vive en la base (la misma en la que escribe el pase diario),
  // no en la memoria de la pestaña.
  const [hiloListo, setHiloListo] = useState(false);
  useEffect(() => {
    if (!companyId) return;
    let cancelado = false;
    setHiloListo(false);
    (async () => {
      try {
        const res = await fetch(`/api/cierre/conversacion?companyId=${companyId}&year=${year}&month=${month}`);
        const j = (await res.json().catch(() => null)) as
          | {
              conversationId?: string | null;
              messages?: { id: string; role: string; content: string; feedback?: "up" | "down" | null; paso?: string | null }[];
            }
          | null;
        if (cancelado) return;
        fijarConversacion(j?.conversationId ?? null);
        setMessages(
          (j?.messages ?? [])
            .filter((m) => m.role === "user" || m.role === "assistant")
            .map((m) => ({
              id: m.id,
              role: m.role as "user" | "assistant",
              content: m.content,
              feedback: m.feedback ?? null,
              paso: m.paso ?? null,
            }))
        );
      } catch {
        /* sin hilo previo se sigue pudiendo conversar; el turno lo crea */
      } finally {
        if (!cancelado) setHiloListo(true);
      }
    })();
    return () => {
      cancelado = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, year, month]);

  // ── El detalle del paso: el «¿por qué?» y la tarjeta que el paso propone ────
  const claveActiva = pasoActivo?.clave;
  const hashActivo = pasoActivo?.hashEvidencia;
  const [detalle, setDetalle] = useState<string | null>(null);
  const [abriendo, setAbriendo] = useState(false);
  useEffect(() => {
    if (!companyId || !claveActiva || !hiloListo) return;
    let cancelado = false;
    setAbriendo(true);
    setDetalle(null);
    (async () => {
      try {
        const res = await fetch(
          `/api/cierre/paso/resumen?companyId=${companyId}&year=${year}&month=${month}&clave=${claveActiva}`
        );
        const j = (await res.json().catch(() => null)) as {
          texto?: string;
          mensajeId?: string | null;
          pendingAction?: { type: string; summary: string; token: string; expiresAt: number } | null;
        } | null;
        if (cancelado) return;
        // La tarjeta que el paso deja puesta: el copiloto propone al abrir, sin
        // que haya que pedírselo. Nada se ejecuta hasta que el humano confirma.
        if (j?.pendingAction) setPendingAction(j.pendingAction);
        if (!j?.texto) return;
        setDetalle(j.texto);
        const texto = j.texto;
        const mensajeId = j.mensajeId ?? undefined;
        setMessages((prev) => {
          if (mensajeId ? prev.some((m) => m.id === mensajeId) : prev.some((m) => m.content === texto)) return prev;
          return [...prev, { role: "assistant", content: texto, id: mensajeId, paso: claveActiva }];
        });
      } catch {
        /* la tarjeta y los enlaces siguen sirviendo sin el detalle */
      } finally {
        if (!cancelado) setAbriendo(false);
      }
    })();
    return () => {
      cancelado = true;
    };
    // hashActivo entra a propósito: si la evidencia cambió, el detalle se rehace.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, claveActiva, hashActivo, year, month, hiloListo]);

  useEffect(() => {
    if (verChat) finRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, pendingAction, verChat]);

  const tituloDePaso = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of cierre?.pasos ?? []) m.set(p.clave, PASO_LLANO[p.clave] ?? p.titulo);
    return m;
  }, [cierre]);

  function elegir(a: AccionCierre) {
    setElegida(a.clave);
    setPasoElegido(a.paso);
    setPorque(false);
    setAviso(null);
    const params = new URLSearchParams(searchParams.toString());
    params.set("accion", a.clave);
    params.set("paso", a.paso);
    params.set("y", String(year));
    params.set("m", String(month));
    router.replace(`/cierre?${params.toString()}`);
  }

  function elegirPaso(clave: ClavePasoCierre) {
    const dePaso = acciones.find((a) => a.paso === clave);
    if (dePaso) return elegir(dePaso);
    setElegida(null);
    setPasoElegido(clave);
    setPorque(false);
    setVerPasos(false);
  }

  async function decidir(accionPaso: "confirmar" | "omitir" | "reabrir", nota: string | null) {
    if (!pasoActivo || !companyId) return;
    setOcupado(true);
    setAviso(null);
    try {
      const res = await fetch("/api/cierre/paso", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId,
          year,
          month,
          clave: pasoActivo.clave,
          accion: accionPaso,
          hashEsperado: pasoActivo.hashEvidencia,
          nota,
        }),
      });
      const j = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; cierre?: CierreEvaluado } | null;
      if (j?.cierre) setCierre(j.cierre);
      if (!res.ok) setAviso(j?.error ?? "No se pudo registrar la decisión.");
      else {
        setOmitiendo(false);
        setMotivo("");
        setElegida(null);
      }
    } catch {
      setAviso("No se pudo registrar la decisión.");
    } finally {
      setOcupado(false);
    }
  }

  function mandar() {
    const texto = input.trim();
    if (!texto || isLoading) return;
    setInput("");
    setVerChat(true);
    void enviar(texto);
  }

  if (!activeCompany) {
    return <div className="p-8 text-sm text-cos-ink-soft">Selecciona una empresa.</div>;
  }

  const decidido = pasoActivo?.estado === "CONFIRMADO" || pasoActivo?.estado === "OMITIDO";
  const bloqueado = pasoActivo?.estadoCalculado === "bloquea" || pasoActivo?.estadoCalculado === "espera";
  const puedeConfirmar = pasoActivo?.requiereConfirmacion && !bloqueado && pasoActivo?.estadoCalculado !== "no_aplica";
  const pct = avance.total > 0 ? Math.round((avance.listos / avance.total) * 100) : 0;
  const siguen = acciones.filter((a) => a.clave !== accion?.clave);

  return (
    <div className="mx-auto flex h-full max-w-[860px] flex-col gap-3 overflow-y-auto px-3 py-3 sm:px-6 sm:py-5">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[12px] text-cos-ink-soft">Cierre del mes</p>
          <h1 className="line-clamp-2 text-[18px] font-semibold leading-tight tracking-[-0.02em] text-cos-ink sm:text-[22px]">
            {activeCompany.razonSocial}
          </h1>
        </div>
        <PeriodSelector />
      </div>

      {sinPlan ? (
        <div className="rounded-card border border-cos-line bg-cos-card p-6">
          <p className="flex items-center gap-2 text-[15px] font-semibold text-cos-ink">
            <Sparkles className="h-4 w-4 text-cos-brand" /> El cierre guiado es parte del plan Pro
          </p>
          <p className="mt-1 text-[13px] text-cos-ink-soft">
            El copiloto revisa cada día lo que falta para cerrar el mes de esta empresa, te avisa lo que cambió y te acompaña hasta declarar.
          </p>
        </div>
      ) : error ? (
        <Alert tone="danger" action={<RetryButton onClick={cargar} />}>
          {error}
        </Alert>
      ) : loading || !cierre ? (
        <Loading label="Revisando el cierre del periodo…" />
      ) : (
        <>
          {/* Avance: una sola barra, sin números repetidos. */}
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-cos-paper">
            <div
              className={cn("h-full rounded-full transition-all", periodo.declarado ? "bg-cos-jade-ink" : "bg-cos-brand")}
              style={{ width: `${pct}%` }}
            />
          </div>

          {/* AHORA: lo único que toca. */}
          <section className="rounded-card border border-cos-line bg-cos-card p-4 sm:p-5">
            {accion ? (
              <>
                <p className="font-mono text-[10.5px] uppercase tracking-wide text-cos-ink-faint">
                  {tituloDePaso.get(accion.paso) ?? accion.pasoTitulo}
                  {accion.urgencia === "bloquea" && <span className="ml-2 text-cos-red-ink">detiene el cierre</span>}
                  {accion.diasRestantes != null && (
                    <span className={cn("ml-2", accion.diasRestantes < 0 ? "text-cos-red-ink" : "text-cos-amber-ink")}>
                      {accion.diasRestantes < 0
                        ? `venció hace ${Math.abs(accion.diasRestantes)} d`
                        : `vence en ${accion.diasRestantes} d`}
                    </span>
                  )}
                </p>
                <h2 className="mt-1 text-[17px] font-semibold leading-snug tracking-[-0.01em] text-cos-ink sm:text-[19px]">
                  {accion.hacer}
                </h2>
                {accion.que && <p className="mt-1.5 text-[13.5px] leading-relaxed text-cos-ink-soft">{accion.que}</p>}
                <p className="mt-2 text-[12.5px] text-cos-ink">{accion.dato}</p>

                {/* La propuesta del copiloto: el tap ES la autorización. */}
                {pendingAction && (
                  <div className="mt-3 rounded-card border border-cos-brand/40 bg-cos-brand-tint p-3">
                    <p className="flex items-center gap-1.5 text-[12px] font-semibold text-cos-brand-ink">
                      <ShieldCheck className="h-3.5 w-3.5" /> Se puede hacer desde aquí
                    </p>
                    <p className="mt-1 text-[12.5px] text-cos-ink">{pendingAction.summary}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        disabled={confirming}
                        onClick={() => void confirmar()}
                        className="rounded-control bg-cos-brand px-3.5 py-2 text-[13px] font-semibold text-white hover:bg-cos-brand-deep disabled:opacity-50"
                      >
                        {confirming ? "Haciéndolo…" : "Hacerlo"}
                      </button>
                      <button type="button" onClick={cancelar} className="text-[12.5px] text-cos-ink-soft">
                        Ahora no
                      </button>
                    </div>
                  </div>
                )}

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {accion.cta && (
                    <Link
                      href={accion.cta.href}
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-control px-3.5 py-2 text-[13px] font-semibold",
                        pendingAction
                          ? "border border-cos-line text-cos-ink hover:bg-cos-paper"
                          : "bg-cos-brand text-white hover:bg-cos-brand-deep"
                      )}
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      {accion.cta.label}
                    </Link>
                  )}
                  <button
                    type="button"
                    onClick={() => setPorque((v) => !v)}
                    className="inline-flex items-center gap-1 rounded-control border border-cos-line px-3 py-2 text-[12.5px] text-cos-ink hover:bg-cos-paper"
                  >
                    ¿Por qué? <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", porque && "rotate-180")} />
                  </button>
                  {pasoActivo?.requiereConfirmacion && !decidido && (
                    <button
                      type="button"
                      disabled={ocupado}
                      onClick={() => setOmitiendo(true)}
                      className="text-[12.5px] text-cos-ink-soft hover:text-cos-ink disabled:opacity-50"
                    >
                      No aplica
                    </button>
                  )}
                </div>
              </>
            ) : periodo.declarado ? (
              <>
                <p className="font-mono text-[10.5px] uppercase tracking-wide text-cos-jade-ink">Mes cerrado</p>
                <h2 className="mt-1 flex items-start gap-2 text-[17px] font-semibold leading-snug text-cos-ink sm:text-[19px]">
                  <Check className="mt-0.5 h-5 w-5 shrink-0 text-cos-jade-ink" />
                  Este mes ya se declaró ante el SAT.
                </h2>
                <p className="mt-1.5 text-[13.5px] leading-relaxed text-cos-ink-soft">
                  {periodo.detalle ?? "La declaración del periodo está presentada."}
                  {periodo.pagado ? " El pago está ligado a su movimiento del banco." : ""}
                </p>
                {acciones.length > 0 && (
                  <p className="mt-2 text-[12.5px] text-cos-amber-ink">
                    Quedaron {acciones.length} observacion{acciones.length === 1 ? "" : "es"} de contabilidad. No detienen
                    nada: el mes ya está presentado.
                  </p>
                )}
              </>
            ) : (
              <>
                <p className="font-mono text-[10.5px] uppercase tracking-wide text-cos-ink-faint">
                  {pasoActivo ? (tituloDePaso.get(pasoActivo.clave) ?? pasoActivo.titulo) : "Cierre"}
                </p>
                <h2 className="mt-1 text-[17px] font-semibold leading-snug text-cos-ink sm:text-[19px]">
                  {cierre.resumen.completo
                    ? "El mes está cerrado: nada pendiente."
                    : decidido
                      ? "Esta parte ya quedó revisada."
                      : "Nada pendiente aquí: dalo por revisado."}
                </h2>
                <p className="mt-1.5 text-[13.5px] leading-relaxed text-cos-ink-soft">
                  {decidido
                    ? "Si vuelves a tocar los datos de este mes, esta parte se marca sola para revisarla otra vez."
                    : "Los datos de esta parte están completos. Al darla por revisada queda firmada con tu nombre y la fecha."}
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {decidido ? (
                    <>
                      <span className="inline-flex items-center gap-1.5 text-[12.5px] text-cos-jade-ink">
                        {pasoActivo?.estado === "CONFIRMADO" ? <Check className="h-3.5 w-3.5" /> : <Ban className="h-3.5 w-3.5" />}
                        {pasoActivo?.estado === "CONFIRMADO" ? "Revisado" : "Marcado como no aplica"}
                      </span>
                      <button
                        type="button"
                        disabled={ocupado}
                        onClick={() => void decidir("reabrir", null)}
                        className="rounded-control border border-cos-line px-3 py-1.5 text-[12.5px] text-cos-ink hover:bg-cos-paper disabled:opacity-50"
                      >
                        Volver a abrir
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      disabled={ocupado || !puedeConfirmar}
                      onClick={() => void decidir("confirmar", null)}
                      className="rounded-control bg-cos-brand px-3.5 py-2 text-[13px] font-semibold text-white hover:bg-cos-brand-deep disabled:opacity-50"
                    >
                      Darlo por revisado
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setPorque((v) => !v)}
                    className="inline-flex items-center gap-1 rounded-control border border-cos-line px-3 py-2 text-[12.5px] text-cos-ink hover:bg-cos-paper"
                  >
                    ¿Por qué? <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", porque && "rotate-180")} />
                  </button>
                </div>
              </>
            )}

            {omitiendo && (
              <div className="mt-3 space-y-2 rounded-card border border-cos-line bg-cos-paper p-3">
                <input
                  value={motivo}
                  onChange={(e) => setMotivo(e.target.value)}
                  placeholder="¿Por qué no aplica? (queda en la bitácora)"
                  className="w-full rounded-control border border-cos-line bg-cos-card px-2.5 py-1.5 text-[12.5px]"
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={ocupado || motivo.trim().length === 0}
                    onClick={() => void decidir("omitir", motivo.trim())}
                    className="rounded-control bg-cos-ink px-3 py-1.5 text-[12.5px] font-semibold text-white disabled:opacity-50"
                  >
                    Marcar como no aplica
                  </button>
                  <button type="button" onClick={() => setOmitiendo(false)} className="text-[12.5px] text-cos-ink-soft">
                    Cancelar
                  </button>
                </div>
              </div>
            )}

            {/* El «¿por qué?»: el detalle del copiloto con las cifras. */}
            {porque && (
              <div className="mt-3 rounded-card border border-cos-line bg-cos-paper p-3 text-[13px] text-cos-ink">
                {abriendo && !detalle ? (
                  <p className="flex items-center gap-2 text-cos-ink-soft">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Revisando…
                  </p>
                ) : detalle ? (
                  <Markdown>{detalle}</Markdown>
                ) : (
                  <p className="text-cos-ink-soft">{pasoActivo?.detalle ?? pasoActivo?.descripcion}</p>
                )}
              </div>
            )}

            {aviso && <p className="mt-2 text-[12.5px] text-cos-red-ink">{aviso}</p>}
          </section>

          {/* Lo que sigue: a la vista, numerado. La lista ES el mapa — tener el
              avance en un sitio y el índice en otro era la mitad de la confusión. */}
          {siguen.length > 0 && (
            <section className="rounded-card border border-cos-line bg-cos-card">
              <p className="px-4 pt-3 text-[12px] font-medium uppercase tracking-wide text-cos-ink-faint">
                {periodo.declarado ? "Observaciones del mes" : `Después de esto (${siguen.length})`}
              </p>
              <ul className="mt-1">
                {siguen.map((a, i) => (
                  <li key={a.clave}>
                    <button
                      type="button"
                      onClick={() => elegir(a)}
                      className="flex w-full items-start gap-3 border-t border-cos-line-soft px-4 py-3 text-left hover:bg-cos-paper"
                    >
                      <span className="mt-0.5 font-mono text-[11px] text-cos-ink-faint">
                        {String(i + 2).padStart(2, "0")}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13.5px] text-cos-ink">{a.hacer}</span>
                        <span className="block text-[12px] text-cos-ink-soft">{a.dato}</span>
                      </span>
                      {a.urgencia === "bloquea" && !periodo.declarado && (
                        <span className="mt-0.5 shrink-0 text-[10.5px] text-cos-red-ink">detiene</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
              <p className="border-t border-cos-line px-4 py-2.5 text-[12px] text-cos-ink-soft">
                {avance.listos} de {avance.total} partes del mes ya están listas.
              </p>
            </section>
          )}

          {/* La conversación: apoyo, no pantalla. */}
          <section className="rounded-card border border-cos-line bg-cos-card">
            <button
              type="button"
              onClick={() => setVerChat((v) => !v)}
              className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left"
              aria-expanded={verChat}
            >
              <span className="flex items-center gap-2 text-[13px] font-medium text-cos-ink">
                <MessageCircle className="h-4 w-4 text-cos-ink-faint" /> Preguntar al copiloto
              </span>
              <ChevronDown className={cn("h-4 w-4 text-cos-ink-faint transition-transform", verChat && "rotate-180")} />
            </button>
            {verChat && (
              <div className="border-t border-cos-line">
                <div className="max-h-[46vh] space-y-3 overflow-y-auto px-4 py-3">
                  {!hiloListo && (
                    <p className="flex items-center gap-2 text-[13px] text-cos-ink-soft">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Abriendo el hilo…
                    </p>
                  )}
                  {messages.map((m, i) => (
                    <div key={i} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
                      <div
                        className={cn(
                          "max-w-[88%] rounded-card px-3.5 py-2.5 text-[13.5px]",
                          m.role === "user" ? "bg-cos-brand text-white" : "bg-cos-paper text-cos-ink"
                        )}
                      >
                        {m.paso && (
                          <p className="mb-1 font-mono text-[10.5px] uppercase tracking-wide text-cos-ink-faint">
                            {tituloDePaso.get(m.paso) ?? m.paso}
                          </p>
                        )}
                        {m.role === "user" ? m.content : <Markdown>{m.content}</Markdown>}
                      </div>
                    </div>
                  ))}
                  {activeTool && (
                    <p className="flex items-center gap-2 text-[12.5px] text-cos-amber-ink">
                      <Wrench className="h-3.5 w-3.5 animate-spin" /> {TOOL_LABELS[activeTool] ?? activeTool}…
                    </p>
                  )}
                  <div ref={finRef} />
                </div>
                <div className="flex items-end gap-2 border-t border-cos-line px-4 py-2.5">
                  <textarea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        mandar();
                      }
                    }}
                    rows={1}
                    placeholder="Pregunta lo que quieras de este mes…"
                    className="max-h-28 flex-1 resize-none rounded-control border border-cos-line bg-cos-paper px-3 py-2 text-[13.5px] focus:border-cos-brand focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={mandar}
                    disabled={isLoading || !input.trim()}
                    className="rounded-control bg-cos-brand p-2 text-white disabled:opacity-40"
                    aria-label="Enviar"
                  >
                    {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  </button>
                </div>
              </div>
            )}
          </section>

          <Link
            href={`/cierre/negocio?y=${year}&m=${month}`}
            className="inline-flex items-center gap-1.5 self-start text-[12.5px] text-cos-ink-soft hover:text-cos-ink"
          >
            Ver cómo se lo cuento al dueño del negocio <ExternalLink className="h-3.5 w-3.5" />
          </Link>

          {/* Los doce pasos: mapa, para quien lo quiera. */}
          <section className="rounded-card border border-cos-line bg-cos-card">
            <button
              type="button"
              onClick={() => setVerPasos((v) => !v)}
              className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left"
              aria-expanded={verPasos}
            >
              <span className="text-[13px] font-medium text-cos-ink">Ver las doce partes del cierre (detalle contable)</span>
              <ChevronDown className={cn("h-4 w-4 text-cos-ink-faint transition-transform", verPasos && "rotate-180")} />
            </button>
            {verPasos && (
              <div className="border-t border-cos-line p-2">
                <EspinaPasos pasos={cierre.pasos} activo={pasoActivo?.clave ?? cierre.pasos[0]?.clave} onSelect={elegirPaso} />
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

export default function CierrePage() {
  return (
    <Suspense fallback={<Loading label="Cargando…" />}>
      <CierrePageInner />
    </Suspense>
  );
}
