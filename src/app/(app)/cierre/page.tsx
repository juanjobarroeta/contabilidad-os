"use client";

// ─────────────────────────────────────────────────────────────────────────────
// EL CIERRE GUIADO — una sola pantalla conducida por el copiloto.
//
// Antes eran tres columnas con el centro vacío hasta que tocabas un botón: la
// evidencia se repetía en un panel y el asistente vivía aparte, sin saber en
// qué paso estabas. Ahora el copiloto ABRE cada paso con sus cifras ya
// calculadas (apertura cacheada por el hash de la evidencia) y la conversación
// ES la pantalla; la espina de la izquierda sólo dice dónde estás.
//
// La decisión sigue siendo humana: Confirmar/Omitir viven en la barra de
// acción y en la tarjeta de propuesta del copiloto — nunca los ejecuta él.
// ─────────────────────────────────────────────────────────────────────────────

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Ban, Check, ChevronDown, Loader2, Send, ShieldCheck, Sparkles, Wrench } from "lucide-react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { PeriodSelector, usePeriod } from "@/components/contabilidad/PeriodProvider";
import { EspinaPasos } from "@/components/cierre/EspinaPasos";
import { Markdown } from "@/components/ai/Markdown";
import { TOOL_LABELS, useChat, type ChatContexto } from "@/components/ai/useChat";
import { Alert, Loading, RetryButton } from "@/components/ui/feedback";
import { cn } from "@/lib/utils";
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
  const [espinaAbierta, setEspinaAbierta] = useState(false);
  const [motivo, setMotivo] = useState("");
  const finRef = useRef<HTMLDivElement>(null);

  const pasoParam = searchParams.get("paso");
  const [activo, setActivo] = useState<ClavePasoCierre | null>(esClavePaso(pasoParam) ? pasoParam : null);

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

  const pasoActivo: PasoConDecision | null = useMemo(() => {
    if (!cierre) return null;
    const elegido = cierre.pasos.find((p) => p.clave === activo);
    if (elegido) return elegido;
    // Sin elección: el primero que necesita trabajo.
    return (
      cierre.pasos.find((p) => p.estadoCalculado === "bloquea" || p.estadoCalculado === "atencion" || p.estado === "REVISAR") ??
      cierre.pasos.find((p) => p.estadoCalculado !== "no_aplica" && p.estado === "PENDIENTE") ??
      cierre.pasos[0] ??
      null
    );
  }, [cierre, activo]);

  // El chat es el mismo motor del cajón; aquí el contexto lleva periodo y paso.
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
    // Confirmar desde la tarjeta del copiloto cambia el estado del cierre.
    onAccionConfirmada: () => void cargar(),
  });
  const { messages, setMessages, isLoading, activeTool, pendingAction, confirming, enviar, confirmar, cancelar, fijarConversacion } =
    chat;

  // ── El hilo del periodo ────────────────────────────────────────────────────
  // El cierre lo trabaja el equipo a lo largo del mes: la conversación vive en
  // la base (la misma en la que escribe el pase diario), no en la memoria de la
  // pestaña. Antes cambiabas de sección y había que empezar de cero.
  const [hiloListo, setHiloListo] = useState(false);
  useEffect(() => {
    if (!companyId) return;
    let cancelado = false;
    setHiloListo(false);
    (async () => {
      try {
        const res = await fetch(`/api/cierre/conversacion?companyId=${companyId}&year=${year}&month=${month}`);
        const j = (await res.json().catch(() => null)) as
          | { conversationId?: string | null; messages?: { id: string; role: string; content: string; feedback?: "up" | "down" | null }[] }
          | null;
        if (cancelado) return;
        fijarConversacion(j?.conversationId ?? null);
        setMessages(
          (j?.messages ?? [])
            .filter((m) => m.role === "user" || m.role === "assistant")
            .map((m) => ({ id: m.id, role: m.role as "user" | "assistant", content: m.content, feedback: m.feedback ?? null }))
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

  // La apertura del paso: la escribe el copiloto con las cifras ya calculadas y
  // viene cacheada por el hash de la evidencia (sólo cuesta cuando cambia).
  const claveActiva = pasoActivo?.clave;
  const hashActivo = pasoActivo?.hashEvidencia;
  const [abriendo, setAbriendo] = useState(false);
  useEffect(() => {
    if (!companyId || !claveActiva || !hiloListo) return;
    let cancelado = false;
    setAbriendo(true);
    (async () => {
      try {
        const res = await fetch(
          `/api/cierre/paso/resumen?companyId=${companyId}&year=${year}&month=${month}&clave=${claveActiva}`
        );
        const j = (await res.json().catch(() => null)) as { texto?: string; mensajeId?: string | null } | null;
        if (cancelado || !j?.texto) return;
        // La apertura queda anclada en el hilo (una por paso y evidencia): si ya
        // está cargada no se repite, y si es nueva se agrega al final.
        const texto = j.texto;
        const mensajeId = j.mensajeId ?? undefined;
        setMessages((prev) => {
          if (mensajeId ? prev.some((m) => m.id === mensajeId) : prev.some((m) => m.content === texto)) return prev;
          return [...prev, { role: "assistant", content: texto, id: mensajeId }];
        });
      } catch {
        /* la barra de acción y la espina siguen sirviendo sin apertura */
      } finally {
        if (!cancelado) setAbriendo(false);
      }
    })();
    return () => {
      cancelado = true;
    };
    // hashActivo entra a propósito: si la evidencia cambió, la apertura se rehace.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, claveActiva, hashActivo, year, month, hiloListo]);

  useEffect(() => {
    finRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, pendingAction]);

  function seleccionar(clave: ClavePasoCierre) {
    setActivo(clave);
    setAviso(null);
    setOmitiendo(false);
    const params = new URLSearchParams(searchParams.toString());
    params.set("paso", clave);
    params.set("y", String(year));
    params.set("m", String(month));
    router.replace(`/cierre?${params.toString()}`);
  }

  async function decidir(accion: "confirmar" | "omitir" | "reabrir", nota: string | null) {
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
          accion,
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
    void enviar(texto);
  }

  if (!activeCompany) {
    return <div className="p-8 text-sm text-cos-ink-soft">Selecciona una empresa.</div>;
  }

  const decidido = pasoActivo?.estado === "CONFIRMADO" || pasoActivo?.estado === "OMITIDO";
  const bloqueado = pasoActivo?.estadoCalculado === "bloquea" || pasoActivo?.estadoCalculado === "espera";
  const puedeConfirmar = pasoActivo?.requiereConfirmacion && !bloqueado && pasoActivo?.estadoCalculado !== "no_aplica";

  return (
    <div className="mx-auto flex h-full max-w-[1180px] flex-col px-3 py-3 sm:px-6 sm:py-5">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2 sm:mb-4 sm:gap-3">
        <div>
          <p className="text-[12px] text-cos-ink-soft sm:text-[12.5px]">Cierre guiado</p>
          <h1 className="line-clamp-2 text-[18px] font-semibold leading-tight tracking-[-0.02em] text-cos-ink sm:text-[22px]">
            {activeCompany.razonSocial}
          </h1>
          <p className="mt-0.5 text-[12px] text-cos-ink-soft">
            {activeCompany.rfc}
            {cierre && (
              <>
                {" · "}
                {cierre.resumen.confirmados}/{cierre.resumen.aplican} confirmados
                {cierre.resumen.bloquean > 0 && (
                  <span className="text-cos-red-ink">
                    {" · "}
                    {cierre.resumen.bloquean} bloquea{cierre.resumen.bloquean === 1 ? "" : "n"}
                  </span>
                )}
                {cierre.resumen.completo && <span className="text-cos-jade-ink"> · listo para cerrar</span>}
              </>
            )}
          </p>
        </div>
        <PeriodSelector />
      </div>

      {sinPlan ? (
        <div className="rounded-card border border-cos-line bg-cos-card p-6">
          <p className="flex items-center gap-2 text-[15px] font-semibold text-cos-ink">
            <Sparkles className="h-4 w-4 text-cos-brand" /> El cierre guiado es parte del plan Pro
          </p>
          <p className="mt-1 text-[13px] text-cos-ink-soft">
            El copiloto revisa cada día los doce pasos del cierre de esta empresa, te avisa lo que cambió y te acompaña hasta declarar.
          </p>
        </div>
      ) : error ? (
        <Alert tone="danger" action={<RetryButton onClick={cargar} />}>
          {error}
        </Alert>
      ) : loading || !cierre || !pasoActivo ? (
        <Loading label="Revisando el cierre del periodo…" />
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[228px_minmax(0,1fr)] lg:gap-4">
          {/* La espina es un MAPA, no la pantalla: en móvil se colapsa a un
              renglón para que la conversación se quede con el alto. */}
          <div className="lg:contents">
            <button
              type="button"
              onClick={() => setEspinaAbierta((o) => !o)}
              className="flex w-full items-center gap-2 rounded-card border border-cos-line bg-cos-card px-3 py-2 text-left lg:hidden"
              aria-expanded={espinaAbierta}
            >
              <span className="font-mono text-[10px] text-cos-ink-faint">
                {String(pasoActivo.orden + 1).padStart(2, "0")}/12
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-cos-ink">{pasoActivo.titulo}</span>
              <span className="shrink-0 font-mono text-[10.5px] text-cos-ink-soft">
                {cierre.resumen.confirmados}/{cierre.resumen.aplican}
              </span>
              <ChevronDown className={cn("h-4 w-4 shrink-0 text-cos-ink-faint transition-transform", espinaAbierta && "rotate-180")} />
            </button>
            <aside
              className={cn(
                "rounded-card border border-cos-line bg-cos-card p-2 lg:block lg:overflow-y-auto",
                espinaAbierta ? "block max-h-[52vh] overflow-y-auto" : "hidden"
              )}
            >
              <EspinaPasos
                pasos={cierre.pasos}
                activo={pasoActivo.clave}
                onSelect={(c) => {
                  seleccionar(c);
                  setEspinaAbierta(false);
                }}
              />
            </aside>
          </div>

          <section className="flex min-h-[60vh] flex-col rounded-card border border-cos-line bg-cos-card lg:min-h-0">
            <div className="flex items-center justify-between gap-3 border-b border-cos-line px-4 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-[14px] font-semibold text-cos-ink">{pasoActivo.titulo}</p>
                <p className="truncate text-[12px] text-cos-ink-soft">{pasoActivo.detalle ?? pasoActivo.descripcion}</p>
              </div>
              {pasoActivo.fechaLimite && (
                <span
                  className={cn(
                    "shrink-0 rounded-full px-2 py-0.5 font-mono text-[10.5px] font-semibold",
                    (pasoActivo.diasRestantes ?? 0) < 0 ? "bg-cos-red-tint text-cos-red-ink" : "bg-cos-amber-tint text-cos-amber-ink"
                  )}
                >
                  {(pasoActivo.diasRestantes ?? 0) < 0
                    ? `venció hace ${Math.abs(pasoActivo.diasRestantes ?? 0)} d`
                    : `vence en ${pasoActivo.diasRestantes} d`}
                </span>
              )}
            </div>

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
              {!hiloListo && (
                <p className="flex items-center gap-2 text-[13px] text-cos-ink-soft">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Abriendo el hilo del cierre…
                </p>
              )}
              {messages.map((m, i) => (
                <div key={i} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
                  <div
                    className={cn(
                      "max-w-[85%] rounded-card px-3.5 py-2.5 text-[13.5px]",
                      m.role === "user" ? "bg-cos-brand text-white" : "bg-cos-paper text-cos-ink"
                    )}
                  >
                    {m.role === "user" ? m.content : <Markdown>{m.content}</Markdown>}
                  </div>
                </div>
              ))}

              {abriendo && (
                <p className="flex items-center gap-2 text-[13px] text-cos-ink-soft">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Revisando el paso…
                </p>
              )}

              {activeTool && (
                <p className="flex items-center gap-2 text-[12.5px] text-cos-amber-ink">
                  <Wrench className="h-3.5 w-3.5 animate-spin" /> {TOOL_LABELS[activeTool] ?? activeTool}…
                </p>
              )}

              {pendingAction && (
                <div className="rounded-card border border-cos-brand/40 bg-cos-brand-tint p-3">
                  <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-cos-brand-ink">
                    <ShieldCheck className="h-3.5 w-3.5" /> Confirmación requerida
                  </p>
                  <p className="mt-1 text-[12.5px] text-cos-ink">{pendingAction.summary}</p>
                  <p className="mt-1 text-[11px] text-cos-ink-soft">Nada se ejecuta hasta que toques Confirmar.</p>
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      disabled={confirming}
                      onClick={() => void confirmar()}
                      className="rounded-control bg-cos-brand px-3 py-1.5 text-[12.5px] font-semibold text-white disabled:opacity-50"
                    >
                      {confirming ? "Confirmando…" : "Confirmar"}
                    </button>
                    <button type="button" onClick={cancelar} className="text-[12.5px] text-cos-ink-soft">
                      Cancelar
                    </button>
                  </div>
                </div>
              )}
              {aviso && <p className="text-[12.5px] text-cos-red-ink">{aviso}</p>}
              <div ref={finRef} />
            </div>

            {/* Barra de acción: la decisión humana del paso, siempre a la vista. */}
            <div className="border-t border-cos-line px-4 py-2.5">
              {omitiendo ? (
                <div className="mb-2 space-y-2">
                  <input
                    value={motivo}
                    onChange={(e) => setMotivo(e.target.value)}
                    placeholder="Motivo para omitir este paso (queda en bitácora)"
                    className="w-full rounded-control border border-cos-line bg-cos-paper px-2.5 py-1.5 text-[12.5px]"
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={ocupado || motivo.trim().length === 0}
                      onClick={() => void decidir("omitir", motivo.trim())}
                      className="rounded-control bg-cos-ink px-3 py-1.5 text-[12.5px] font-semibold text-white disabled:opacity-50"
                    >
                      Omitir con motivo
                    </button>
                    <button type="button" onClick={() => setOmitiendo(false)} className="text-[12.5px] text-cos-ink-soft">
                      Cancelar
                    </button>
                  </div>
                </div>
              ) : (
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  {decidido ? (
                    <>
                      <span className="inline-flex items-center gap-1.5 text-[12.5px] text-cos-jade-ink">
                        {pasoActivo.estado === "CONFIRMADO" ? <Check className="h-3.5 w-3.5" /> : <Ban className="h-3.5 w-3.5" />}
                        {pasoActivo.estado === "CONFIRMADO" ? "Paso confirmado" : "Paso omitido"}
                      </span>
                      <button
                        type="button"
                        disabled={ocupado}
                        onClick={() => void decidir("reabrir", null)}
                        className="rounded-control border border-cos-line px-2.5 py-1 text-[12px] text-cos-ink hover:bg-cos-paper disabled:opacity-50"
                      >
                        Reabrir
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        disabled={ocupado || !puedeConfirmar}
                        onClick={() => void decidir("confirmar", null)}
                        className="rounded-control bg-cos-brand px-3 py-1.5 text-[12.5px] font-semibold text-white hover:bg-cos-brand-deep disabled:opacity-50"
                      >
                        Confirmar paso
                      </button>
                      {pasoActivo.requiereConfirmacion && !bloqueado && (
                        <button
                          type="button"
                          disabled={ocupado}
                          onClick={() => setOmitiendo(true)}
                          className="rounded-control border border-cos-line px-2.5 py-1.5 text-[12.5px] text-cos-ink hover:bg-cos-paper disabled:opacity-50"
                        >
                          Omitir
                        </button>
                      )}
                      {pasoActivo.estado === "REVISAR" && (
                        <span className="text-[12px] text-cos-amber-ink">La evidencia cambió: revísala antes de confirmar.</span>
                      )}
                      {bloqueado && (
                        <span className="text-[12px] text-cos-ink-soft">
                          {pasoActivo.estadoCalculado === "espera" ? "Un paso anterior bloquea éste." : "Hay un bloqueo activo."}
                        </span>
                      )}
                    </>
                  )}
                </div>
              )}

              <div className="flex items-end gap-2">
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
                  placeholder={`Pregunta sobre ${pasoActivo.titulo.toLowerCase()}…`}
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
          </section>
        </div>
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
