"use client";

// ─────────────────────────────────────────────────────────────────────────────
// EL CHAT DEL COPILOTO (v2).
//
// La entrada es la mascota (<CopilotoMascota/>): en escritorio el panel flota
// anclado a ella; en móvil (<1024px) sigue siendo el cajón a pantalla completa.
// El motor es el mismo useChat que usa el cierre: un solo turno, un solo
// protocolo SSE y un solo contrato de confirmación por tap.
//
// Lo nuevo: las conversaciones se recuerdan («retomar»), el copiloto tiene una
// memoria explícita («Lo que recuerdo» = notas del expediente que él escribió),
// las respuestas traen tarjetas y botones, y la fila de sugerencias cambia con
// la pantalla.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { usePathname } from "next/navigation";
import { useCompany } from "@/components/layout/CompanyProvider";
import {
  X, Loader2, Plus, Lock, Users, Trash2, ArrowLeft, CheckCircle2, ShieldCheck, ThumbsUp, ThumbsDown,
  History, ArrowDownRight, ArrowUp, Bookmark, Zap, CircleHelp,
  SlidersHorizontal, ListChecks,
} from "lucide-react";
import { Markdown } from "./Markdown";
import { TOOL_LABELS, useChat, type ChatContexto, type Message } from "./useChat";
import { AccionesChat, ChatCard, PildoraRef } from "./ChatCards";
import { CopilotoMascota } from "./CopilotoMascota";
import { useModoMascota, usePielMascota, useRail } from "./useRailCopiloto";
import { ResumenCopiloto } from "./ResumenCopiloto";
import { PetFace } from "./PetSkin";
import { PetPensando } from "./PetPensando";
import { PersonalizarCopiloto } from "./PersonalizarCopiloto";
import { colorDe, nombreDe } from "@/lib/copiloto/personajes";
import { colocarJunto, type Caja } from "@/lib/copiloto/colocar";
import { sugerenciasPara, tituloDeRuta } from "@/lib/copiloto/sugerencias";
import type { Accion, Card, RefCopiloto } from "@/lib/copiloto/tarjetas";
import { cn } from "@/lib/utils";

type Visibility = "PRIVATE" | "COMPANY";
interface ConvSummary {
  id: string;
  title: string;
  visibility: Visibility;
  updatedAt: string;
  mine: boolean;
  autor: string | null;
  pending?: boolean;
  snippet?: string;
}
interface Recuerdo {
  id: string;
  texto: string;
  detalle?: string;
}

const ANCHO_PANEL = 400;
const ALTO_PANEL = 600;
const BREAK_ESCRITORIO = 1024;
const DIAS_RETOMAR = 7;
const llaveRetomar = (companyId: string) => `cos-retomar-hasta:${companyId}`;

const fmtFecha = (iso: string) => {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("es-MX", { day: "2-digit", month: "short" });
};

function cuandoFue(iso: string): string {
  const d = new Date(iso);
  const dias = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (dias <= 0) return "hoy";
  if (dias === 1) return "ayer";
  return `hace ${dias} días`;
}

const BOTON_ICONO = "grid h-[30px] w-[30px] flex-none place-items-center rounded-lg text-cos-ink-soft hover:bg-cos-paper hover:text-cos-ink";

export function ChatPanel() {
  const { activeCompany } = useCompany();
  const companyId = activeCompany?.id ?? null;
  const [isOpen, setIsOpen] = useState(false);
  const [view, setView] = useState<"chat" | "history" | "cust" | "resumen">("chat");
  const [input, setInput] = useState("");
  const [refPendiente, setRefPendiente] = useState<RefCopiloto | null>(null);
  const pathname = usePathname() ?? "/";
  const enCierre = pathname.startsWith("/cierre");
  const [modo, setModo] = useModoMascota();
  const [piel, setPiel] = usePielMascota();
  const nombrePet = nombreDe(piel);
  // Feedback: id del mensaje al que se le está escribiendo una corrección.
  const [correccionPara, setCorreccionPara] = useState<string | null>(null);
  const [correccionTexto, setCorreccionTexto] = useState("");
  // Conversación actual + historial + memoria.
  const [visibility, setVisibility] = useState<Visibility>("PRIVATE");
  const [isMine, setIsMine] = useState(true);
  const [conversations, setConversations] = useState<ConvSummary[]>([]);
  const [memoria, setMemoria] = useState<Recuerdo[]>([]);
  const [retomarDescartado, setRetomarDescartado] = useState(false);
  // «Ahora en …»: separadores de ruta. Sólo contexto en pantalla; la ruta ya
  // viaja al modelo en cada turno (contexto.ruta) y no se persiste.
  const [marcadores, setMarcadores] = useState<Array<{ antesDe: number; texto: string }>>([]);
  // Mascota ↔ panel.
  const [cajaMascota, setCajaMascota] = useState<Caja | null>(null);
  const [saltos, setSaltos] = useState(0);
  const [aCasa, setACasa] = useState(0);
  const [escritorio, setEscritorio] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const prevCompanyRef = useRef<string | null>(null);
  const railCopiloto = useRail(companyId);
  const necesito = useMemo(() => railCopiloto.rail?.necesito ?? [], [railCopiloto.rail]);

  const leerContexto = useCallback((): ChatContexto => {
    const ruta = window.location.pathname + window.location.search;
    const ctx: ChatContexto = { ruta };
    // En /cierre el periodo y el paso van en la URL: con ellos el copiloto
    // recibe el estado de los doce pasos y las cifras ya calculadas.
    if (window.location.pathname.startsWith("/cierre")) {
      const q = new URLSearchParams(window.location.search);
      const year = Number(q.get("y"));
      const month = Number(q.get("m"));
      if (year >= 2000 && month >= 1 && month <= 12) {
        ctx.cierre = { year, month, paso: q.get("paso") ?? undefined };
      }
    }
    return ctx;
  }, []);

  const loadConversationsRef = useRef<(() => void) | null>(null);

  const {
    messages,
    setMessages,
    isLoading,
    activeTool,
    pendingAction,
    setPendingAction,
    confirming,
    conversationId,
    fijarConversacion,
    retomarAgente,
    enviar,
    confirmar: confirmAction,
    cancelar: cancelAction,
    enviarFeedback,
    reset: resetChat,
  } = useChat({
    companyId,
    contexto: leerContexto,
    onTurnoTerminado: () => loadConversationsRef.current?.(),
  });

  const loadConversations = useCallback(async () => {
    if (!companyId) return;
    try {
      const [rc, rm] = await Promise.all([
        fetch(`/api/ai/conversations?companyId=${companyId}`),
        fetch(`/api/ai/memoria?companyId=${companyId}`),
      ]);
      if (rc.ok) setConversations(await rc.json());
      if (rm.ok) setMemoria(await rm.json());
    } catch {
      /* offline — el historial puede esperar */
    }
  }, [companyId]);
  loadConversationsRef.current = loadConversations;

  const newChat = useCallback(() => {
    resetChat();
    setVisibility("PRIVATE");
    setIsMine(true);
    setView("chat");
    setMarcadores([]);
    setRefPendiente(null);
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [resetChat]);

  const openConversation = useCallback(
    async (id: string) => {
      resetChat();
      setView("chat");
      const res = await fetch(`/api/ai/conversations/${id}`);
      if (!res.ok) return;
      const data = await res.json();
      setMessages(
        (data.messages ?? []).map((m: Message) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          feedback: m.feedback ?? null,
          ...(m.cards ? { cards: m.cards } : {}),
          ...(m.ref ? { ref: m.ref } : {}),
        })),
      );
      fijarConversacion(data.id);
      setVisibility(data.visibility);
      setIsMine(!!data.mine);
      setMarcadores([]);
      setPendingAction(data.pendingAction ?? null);
      if (data.activeManagedRun?.requestId) void retomarAgente(data.activeManagedRun.id, data.activeManagedRun.requestId);
    },
    [setMessages, fijarConversacion, setPendingAction, resetChat, retomarAgente],
  );

  async function deleteConversation(id: string) {
    if (!window.confirm("¿Borrar esta conversación?")) return;
    const response = await fetch(`/api/ai/conversations/${id}`, { method: "DELETE" });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      window.alert(error.error ?? "No se pudo borrar la conversación.");
      return;
    }
    if (id === conversationId) newChat();
    await loadConversations();
  }

  async function olvidar(id: string) {
    if (!companyId) return;
    setMemoria((m) => m.filter((r) => r.id !== id)); // optimista
    const res = await fetch(`/api/ai/memoria/${id}?companyId=${companyId}`, { method: "DELETE" }).catch(() => null);
    if (!res?.ok) await loadConversations();
  }

  async function toggleVisibility() {
    if (!conversationId || !isMine) return;
    const next: Visibility = visibility === "PRIVATE" ? "COMPANY" : "PRIVATE";
    setVisibility(next); // optimista
    await fetch(`/api/ai/conversations/${conversationId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visibility: next }),
    });
    await loadConversations();
  }

  // Reset al cambiar de empresa; recarga historial y memoria.
  useEffect(() => {
    if (companyId && prevCompanyRef.current !== companyId) {
      if (prevCompanyRef.current !== null) newChat();
      prevCompanyRef.current = companyId;
      void loadConversations();
      try {
        const hasta = Number(localStorage.getItem(llaveRetomar(companyId)) ?? 0);
        setRetomarDescartado(hasta > Date.now());
      } catch {
        setRetomarDescartado(false);
      }
    }
  }, [companyId, loadConversations, newChat]);

  useEffect(() => {
    if (isOpen) void loadConversations();
  }, [isOpen, loadConversations]);

  // El resumen se pide fresco al abrirlo (la caché de un minuto sirve a la
  // mascota y a las sugerencias, no a quien lo vino a leer).
  const recargarRail = railCopiloto.recargar;
  useEffect(() => {
    if (isOpen && view === "resumen") recargarRail();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, view]);

  // Escritorio (panel flotante) vs. móvil (cajón).
  useEffect(() => {
    const medir = () => setEscritorio(window.innerWidth >= BREAK_ESCRITORIO);
    medir();
    window.addEventListener("resize", medir);
    return () => window.removeEventListener("resize", medir);
  }, []);

  // Separador «Ahora en …» cuando cambia la ruta con una conversación abierta.
  const rutaPrev = useRef(pathname);
  useEffect(() => {
    const antes = rutaPrev.current.split("?")[0];
    rutaPrev.current = pathname;
    if (antes === pathname.split("?")[0] || messages.length === 0) return;
    const texto = `Ahora en ${tituloDeRuta(pathname)}`;
    setMarcadores((ms) => {
      const ultimo = ms[ms.length - 1];
      // Dos cambios seguidos sin mensajes en medio: vale el último.
      if (ultimo && ultimo.antesDe === messages.length) return [...ms.slice(0, -1), { antesDe: messages.length, texto }];
      return [...ms, { antesDe: messages.length, texto }];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // Auto-scroll
  useEffect(() => {
    if (view === "chat") messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, activeTool, view, isLoading]);

  // Focus input al abrir
  useEffect(() => {
    if (isOpen && view === "chat") inputRef.current?.focus();
  }, [isOpen, view]);

  // Esc cierra el panel.
  useEffect(() => {
    if (!isOpen) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setIsOpen(false);
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [isOpen]);

  // ── Mobile (PWA) keyboard fix ──────────────────────────────────────────────
  const [vvBox, setVvBox] = useState<{ height: number; top: number } | null>(null);
  useEffect(() => {
    if (!isOpen) return;
    const vv = window.visualViewport;
    const narrow = () => window.innerWidth < BREAK_ESCRITORIO;
    const update = () => {
      if (vv && narrow()) {
        setVvBox({ height: Math.round(vv.height), top: Math.round(vv.offsetTop) });
        requestAnimationFrame(() => messagesEndRef.current?.scrollIntoView({ block: "end" }));
      } else {
        setVvBox(null);
      }
    };
    update();
    vv?.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    const prevOverflow = document.body.style.overflow;
    if (narrow()) document.body.style.overflow = "hidden";
    return () => {
      vv?.removeEventListener("resize", update);
      vv?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      document.body.style.overflow = prevOverflow;
      setVvBox(null);
    };
  }, [isOpen]);

  // Manda un turno (con la referencia pendiente, si la hay).
  const mandar = useCallback(
    (texto: string, ref?: RefCopiloto | null) => {
      const t = texto.trim() || (ref ? "Explícame esto" : "");
      if (!t || isLoading) return;
      setRefPendiente(null);
      void enviar(t, ref ? { ref } : undefined);
    },
    [enviar, isLoading],
  );

  // Abrir desde cualquier parte vía `cos:ask-ai` {seed?, send?, ref?}. Con
  // `seed` arranca una conversación nueva con el texto en el compositor (o lo
  // manda, con `send`). `ref` adjunta el elemento como píldora.
  useEffect(() => {
    const open = (e: Event) => {
      setIsOpen(true);
      setSaltos((s) => s + 1);
      const detail = (e as CustomEvent<{ seed?: string; send?: boolean; ref?: RefCopiloto; conversationId?: string; companyId?: string }>).detail;
      if (detail?.conversationId) {
        if (detail.companyId === companyId) void openConversation(detail.conversationId);
        return;
      }
      if (detail?.seed || detail?.ref) {
        newChat();
        if (detail.send) {
          setTimeout(() => mandar(detail.seed ?? "", detail.ref ?? null), 0);
        } else {
          setInput(detail.seed ?? "");
          setRefPendiente(detail.ref ?? null);
          setTimeout(() => inputRef.current?.focus(), 60);
        }
      }
    };
    window.addEventListener("cos:ask-ai", open);
    return () => window.removeEventListener("cos:ask-ai", open);
  }, [newChat, mandar, companyId, openConversation]);

  const sendMessage = useCallback(() => {
    const texto = input.trim();
    if ((!texto && !refPendiente) || isLoading) return;
    setInput("");
    if (inputRef.current) inputRef.current.style.height = "auto";
    mandar(texto, refPendiente);
  }, [input, isLoading, mandar, refPendiente]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  // ── Mascota → chat ─────────────────────────────────────────────────────────
  const toggle = useCallback(() => setIsOpen((o) => !o), []);
  const preguntarMas = useCallback(
    (ref: RefCopiloto) => {
      setIsOpen(true);
      newChat();
      setTimeout(() => mandar("Explícame esto", ref), 0);
    },
    [newChat, mandar],
  );
  const turnoDesdeMascota = useCallback(
    (seed: string, ref?: RefCopiloto) => {
      setIsOpen(true);
      newChat();
      setTimeout(() => mandar(seed, ref ?? null), 0);
    },
    [newChat, mandar],
  );
  const cerrarAlArrastrar = useCallback(() => setIsOpen(false), []);

  // ── Retomar ────────────────────────────────────────────────────────────────
  const retomar = useMemo(() => {
    if (retomarDescartado || messages.length > 0) return null;
    const limite = Date.now() - DIAS_RETOMAR * 86_400_000;
    return (
      conversations.find((c) => c.mine && c.pending && new Date(c.updatedAt).getTime() >= limite && c.id !== conversationId) ??
      null
    );
  }, [conversations, messages.length, retomarDescartado, conversationId]);

  const descartarRetomar = () => {
    if (!companyId) return;
    const manana = new Date();
    manana.setHours(24, 0, 0, 0);
    try {
      localStorage.setItem(llaveRetomar(companyId), String(manana.getTime()));
    } catch {
      /* vale para esta visita */
    }
    setRetomarDescartado(true);
  };

  const sugerencias = useMemo(() => sugerenciasPara(pathname, necesito), [pathname, necesito]);

  // ── Colocación del panel ───────────────────────────────────────────────────
  const flotante = escritorio;
  const posPanel = useMemo(() => {
    if (!flotante || !cajaMascota || typeof window === "undefined") return null;
    const w = Math.min(ANCHO_PANEL, window.innerWidth - 24);
    const h = Math.min(ALTO_PANEL, window.innerHeight - 24);
    return { ...colocarJunto(cajaMascota, w, h, window.innerWidth, window.innerHeight, "panel"), w, h };
  }, [flotante, cajaMascota]);

  if (!activeCompany) return null;

  const contexto =
    view === "cust"
      ? "Elige cómo te acompaña"
      : view === "resumen"
        ? necesito.length
          ? `${necesito.length} ${necesito.length === 1 ? "pendiente tuyo" : "pendientes tuyos"}`
          : "Nada pendiente de tu lado"
      : view === "history"
      ? `${memoria.length} ${memoria.length === 1 ? "cosa recordada" : "cosas recordadas"} · ${conversations.length} ${conversations.length === 1 ? "conversación" : "conversaciones"}`
      : `${tituloDeRuta(pathname)} · ${activeCompany.razonSocial}`;

  const renderMensaje = (msg: Message, i: number) => {
    const esUltimo = i === messages.length - 1;
    const tarjetas = (msg.cards ?? []).filter((c) => c.type !== "acciones" && c.type !== "memoria");
    const memorias = (msg.cards ?? []).filter((c): c is Extract<Card, { type: "memoria" }> => c.type === "memoria");
    const acciones: Accion[] = (msg.cards ?? []).flatMap((c) => (c.type === "acciones" ? c.acciones : []));
    if (msg.role === "user") {
      return (
        <div className="flex max-w-[92%] flex-col items-end gap-[7px] self-end">
          {msg.ref && <PildoraRef refC={msg.ref} origen={msg.ref.ruta ? tituloDeRuta(msg.ref.ruta) : undefined} />}
          <div className="whitespace-pre-wrap rounded-[13px] rounded-br bg-cos-brand px-3 py-[9px] text-[13.5px] leading-normal text-white">
            {msg.content}
          </div>
        </div>
      );
    }
    return (
      <div className="flex max-w-[92%] flex-col gap-[7px] self-start">
        {msg.content.trim() && (
          <div className="rounded-[13px] rounded-bl border border-cos-line-soft bg-cos-paper px-3 py-[9px] text-[13.5px] leading-normal text-cos-ink">
            <Markdown>{msg.content}</Markdown>
          </div>
        )}
        {tarjetas.map((c, k) => (
          <ChatCard key={k} card={c} inicios={c.type === "pasos" ? msg.pasosInicios : undefined} />
        ))}
        {memorias.map((c, k) => (
          <ChatCard key={`m${k}`} card={c} />
        ))}
        {acciones.length > 0 && !(isLoading && esUltimo) && (
          <AccionesChat acciones={acciones} onTurno={(seed) => mandar(seed)} deshabilitado={isLoading} />
        )}
        {/* Feedback — sólo respuestas persistidas del asistente. El pulgar
            abajo abre una corrección: «¿qué debió responder?» */}
        {msg.id && !(isLoading && esUltimo) && (
          <div className="flex items-center gap-1">
            <button
              onClick={() => enviarFeedback(msg.id!, msg.feedback === "up" ? null : "up")}
              title="Respuesta útil"
              className={cn("rounded p-1", msg.feedback === "up" ? "text-cos-jade-ink" : "text-cos-ink-faint hover:text-cos-ink")}
            >
              <ThumbsUp className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => {
                if (msg.feedback === "down") {
                  enviarFeedback(msg.id!, null);
                  setCorreccionPara(null);
                  return;
                }
                enviarFeedback(msg.id!, "down");
                setCorreccionPara(msg.id!);
                setCorreccionTexto("");
              }}
              title="Respuesta incorrecta o incompleta"
              className={cn("rounded p-1", msg.feedback === "down" ? "text-cos-red-ink" : "text-cos-ink-faint hover:text-cos-ink")}
            >
              <ThumbsDown className="h-3.5 w-3.5" />
            </button>
            {correccionPara === msg.id && (
              <div className="ml-1 flex flex-1 items-end gap-1">
                <textarea
                  value={correccionTexto}
                  onChange={(e) => setCorreccionTexto(e.target.value)}
                  placeholder="¿Qué debió responder? (opcional)"
                  rows={1}
                  className="min-w-0 flex-1 resize-none rounded-control border border-cos-line bg-cos-card px-2 py-1 text-[12px] focus:border-cos-brand focus:outline-none"
                />
                <button
                  onClick={() => {
                    enviarFeedback(msg.id!, "down", correccionTexto);
                    setCorreccionPara(null);
                  }}
                  className="rounded-control bg-cos-brand px-2 py-1 text-[12px] font-medium text-white hover:bg-cos-brand-deep"
                >
                  Enviar
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  const separador = (texto: string, key: string) => (
    <div key={key} className="self-center py-0.5 font-mono text-[10px] uppercase tracking-[.08em] text-cos-ink-faint">
      {texto}
    </div>
  );

  const panel = (
    <div
      role="dialog"
      aria-label={nombrePet}
      className={cn(
        "z-[62] flex flex-col overflow-hidden border-cos-line bg-cos-card print:hidden",
        flotante
          ? "cos-pet-panel fixed rounded-[20px] border shadow-[0_30px_70px_-24px_oklch(0.25_0.06_258/0.5)]"
          : cn(
              "fixed right-0 top-0 h-dvh w-full border-l shadow-2xl transition-transform duration-300 sm:w-[440px]",
              isOpen ? "translate-x-0" : "translate-x-full",
            ),
        flotante && !isOpen && "hidden",
      )}
      style={
        flotante
          ? posPanel
            ? { left: posPanel.x, top: posPanel.y, width: posPanel.w, height: posPanel.h }
            : { right: 12, bottom: 12, width: ANCHO_PANEL, height: Math.min(ALTO_PANEL, 600) }
          : vvBox
            ? { height: `${vvBox.height}px`, top: `${vvBox.top}px` }
            : undefined
      }
    >
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-cos-line-soft py-3 pl-3.5 pr-2.5">
        {view !== "chat" ? (
          <button onClick={() => setView("chat")} className={BOTON_ICONO} title="Volver">
            <ArrowLeft className="h-4 w-4" />
          </button>
        ) : (
          <PetFace char={piel.char} color={colorDe(piel)} />
        )}
        <div className="ml-0.5 min-w-0 flex-1">
          <h3 className="truncate text-[14.5px] font-semibold text-cos-ink">
            {view === "history"
              ? "Historial y memoria"
              : view === "cust"
                ? "Personalizar"
                : view === "resumen"
                  ? "Resumen"
                  : nombrePet}
          </h3>
          <p className="truncate text-[11.5px] text-cos-ink-faint">{contexto}</p>
        </div>
        {view === "chat" && conversationId && isMine && (
          <button
            onClick={toggleVisibility}
            title={visibility === "COMPANY" ? "Compartida con el equipo — clic para hacerla privada" : "Privada — clic para compartir con el equipo"}
            className={cn(BOTON_ICONO, visibility === "COMPANY" && "bg-cos-brand-tint text-cos-brand-ink")}
          >
            {visibility === "COMPANY" ? <Users className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
          </button>
        )}
        <button
          onClick={() => setView(view === "resumen" ? "chat" : "resumen")}
          className={cn(BOTON_ICONO, "relative", view === "resumen" && "bg-cos-brand-tint text-cos-brand-ink")}
          title="Resumen: lo que hice, lo que necesito de ti y cómo vamos"
        >
          <ListChecks className="h-4 w-4" />
          {/* Cuenta lo que necesita de TI, no los problemas que hay: un
              número que el usuario no puede bajar sólo enseña a ignorarlo. */}
          {necesito.length > 0 && view !== "resumen" && (
            <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-cos-amber px-1 text-[9px] font-bold text-white">
              {necesito.length}
            </span>
          )}
        </button>
        <button
          onClick={() => setView(view === "cust" ? "chat" : "cust")}
          className={cn(BOTON_ICONO, view === "cust" && "bg-cos-brand-tint text-cos-brand-ink")}
          title="Personalizar copiloto"
        >
          <SlidersHorizontal className="h-4 w-4" />
        </button>
        <button
          onClick={() => setView(view === "history" ? "chat" : "history")}
          className={cn(BOTON_ICONO, view === "history" && "bg-cos-brand-tint text-cos-brand-ink")}
          title="Historial y memoria"
        >
          <History className="h-4 w-4" />
        </button>
        <button onClick={newChat} className={BOTON_ICONO} title="Nueva conversación">
          <Plus className="h-4 w-4" />
        </button>
        {flotante && modo === "pet" && (
          <button onClick={() => setACasa((n) => n + 1)} className={BOTON_ICONO} title="Mandar a la esquina">
            <ArrowDownRight className="h-4 w-4" />
          </button>
        )}
        <button onClick={() => setIsOpen(false)} className={BOTON_ICONO} title="Cerrar">
          <X className="h-4 w-4" />
        </button>
      </div>

      {view === "resumen" ? (
        <ResumenCopiloto
          {...railCopiloto}
          onPreguntar={(seed) => {
            setView("chat");
            newChat();
            setTimeout(() => mandar(seed), 0);
          }}
          onNavegar={() => {
            if (!flotante) setIsOpen(false);
          }}
        />
      ) : view === "cust" ? (
        <PersonalizarCopiloto piel={piel} onCambio={setPiel} />
      ) : view === "history" ? (
        /* ── Historial y memoria ── */
        <div className="flex-1 overflow-y-auto overscroll-contain px-3 pb-4 pt-1">
          <p className="px-1 pb-2 pt-3.5 font-mono text-[10px] font-semibold uppercase tracking-[.12em] text-cos-ink-faint">
            Lo que recuerdo de {activeCompany.razonSocial}
          </p>
          {memoria.length === 0 ? (
            <p className="p-1 text-[12.5px] text-cos-ink-faint">Nada guardado. Aprendo de lo que me pidas.</p>
          ) : (
            memoria.map((r) => (
              <div key={r.id} className="mb-1.5 flex items-start gap-[9px] rounded-[10px] bg-cos-paper px-[11px] py-2.5 text-[13px] leading-[1.45] text-cos-ink">
                <Bookmark className="mt-0.5 h-3.5 w-3.5 flex-none text-cos-brand-ink" />
                <span className="flex-1" title={r.detalle}>{r.texto}</span>
                <button onClick={() => olvidar(r.id)} className="text-[11.5px] font-semibold text-cos-ink-faint hover:text-cos-red-ink">
                  Olvidar
                </button>
              </div>
            ))
          )}
          <p className="px-1 pb-2 pt-3.5 font-mono text-[10px] font-semibold uppercase tracking-[.12em] text-cos-ink-faint">Conversaciones</p>
          {conversations.length === 0 ? (
            <p className="p-1 text-[12.5px] text-cos-ink-faint">Aún no hay conversaciones.</p>
          ) : (
            conversations.map((c) => (
              <div
                key={c.id}
                className={cn(
                  "group mb-0.5 flex items-start gap-1 rounded-[10px] px-[11px] py-2.5",
                  c.id === conversationId ? "bg-cos-brand-tint" : "hover:bg-cos-paper",
                )}
              >
                <button onClick={() => openConversation(c.id)} className="min-w-0 flex-1 text-left">
                  <div className="flex items-center gap-[7px] text-[13.5px] font-semibold text-cos-ink">
                    {c.visibility === "COMPANY" && <Users className="h-3.5 w-3.5 flex-none text-cos-brand-ink" />}
                    <span className="truncate">{c.title}</span>
                    {c.pending && (
                      <span className="flex-none rounded-[5px] bg-cos-amber-tint px-1.5 py-px font-mono text-[9.5px] font-semibold text-cos-amber-ink">
                        pendiente
                      </span>
                    )}
                    {c.id === conversationId && (
                      <span className="flex-none rounded-[5px] bg-cos-card px-1.5 py-px font-mono text-[9.5px] font-semibold text-cos-brand-ink">
                        actual
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-[11.5px] text-cos-ink-faint">
                    {fmtFecha(c.updatedAt)} · {!c.mine && c.autor ? c.autor : activeCompany.razonSocial}
                  </div>
                  {c.snippet && <div className="mt-1 truncate text-[12.5px] text-cos-ink-soft">{c.snippet}</div>}
                </button>
                {c.mine && (
                  <button
                    onClick={() => deleteConversation(c.id)}
                    className="flex-none rounded-control p-1.5 text-cos-ink-faint opacity-0 hover:bg-cos-red-tint hover:text-cos-red-ink focus:opacity-100 group-hover:opacity-100"
                    title="Borrar"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            ))
          )}
          {/* Preferencia de entrada. Luego vivirá en Configuración. */}
          <div className="mt-4 flex items-center justify-between rounded-[10px] border border-cos-line-soft px-[11px] py-2.5">
            <span className="text-[12.5px] text-cos-ink-soft">Entrada al copiloto</span>
            <div className="flex rounded-lg bg-cos-paper p-0.5">
              {(["pet", "classic"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setModo(m)}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-[12px] font-semibold",
                    modo === m ? "bg-cos-card text-cos-ink shadow-card" : "text-cos-ink-faint hover:text-cos-ink",
                  )}
                >
                  {m === "pet" ? "Mascota" : "Botón fijo"}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <>
          {/* Messages */}
          <div className="flex flex-1 flex-col gap-3 overflow-y-auto overscroll-contain px-3.5 py-4">
            {messages.length === 0 &&
              (retomar ? (
                <div className="flex max-w-[92%] flex-col gap-[7px] self-start">
                  <div className="rounded-[13px] rounded-bl border border-cos-line-soft bg-cos-paper px-3 py-[9px] text-[13.5px] leading-normal text-cos-ink">
                    Retomo donde nos quedamos:
                  </div>
                  <ChatCard
                    card={{
                      type: "retomar",
                      cuando: cuandoFue(retomar.updatedAt),
                      titulo: retomar.title,
                      nota: retomar.snippet ?? "",
                    }}
                  />
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      onClick={() => openConversation(retomar.id)}
                      className="inline-flex items-center gap-1.5 rounded-[9px] border border-cos-brand bg-cos-brand px-[11px] py-[7px] text-[12.5px] font-semibold text-white hover:bg-cos-brand-deep"
                    >
                      Seguir con esto
                    </button>
                    <button
                      onClick={descartarRetomar}
                      className="inline-flex items-center gap-1.5 rounded-[9px] border border-cos-line bg-cos-card px-[11px] py-[7px] text-[12.5px] font-semibold text-cos-ink hover:bg-cos-paper"
                    >
                      Más tarde
                    </button>
                  </div>
                </div>
              ) : (
                <div className="max-w-[92%] self-start rounded-[13px] rounded-bl border border-cos-line-soft bg-cos-paper px-3 py-[9px] text-[13.5px] leading-normal text-cos-ink">
                  ¿En qué te ayudo? Tengo presente lo que hemos hablado antes.
                </div>
              ))}

            {messages.map((msg, i) => [
              ...marcadores.filter((m) => m.antesDe === i).map((m, k) => separador(m.texto, `sep${i}-${k}`)),
              <div key={i} className="contents">
                {renderMensaje(msg, i)}
              </div>,
            ])}
            {marcadores.filter((m) => m.antesDe >= messages.length && messages.length > 0).map((m, k) => separador(m.texto, `sepf${k}`))}

            {isLoading && (activeTool || messages[messages.length - 1]?.role === "user") && (
              <PetPensando
                char={piel.char}
                color={colorDe(piel)}
                nombre={nombrePet}
                texto={activeTool ? `${TOOL_LABELS[activeTool] || activeTool}…` : "Pensando…"}
              />
            )}

            {/* Tarjeta de confirmación: el asistente PROPUSO una acción reversible.
                El tap de "Confirmar" es lo único que la ejecuta. */}
            {pendingAction && !isLoading && (
              <div className="rounded-[13px] border border-cos-brand/40 bg-cos-brand-tint/60 p-3.5">
                <div className="flex items-center gap-1.5 text-[12px] font-semibold text-cos-brand-ink">
                  <ShieldCheck className="h-4 w-4" /> Confirmación requerida
                </div>
                <p className="mt-1.5 text-[13.5px] leading-relaxed text-cos-ink">{pendingAction.summary}</p>
                <p className="mt-1 text-[11.5px] text-cos-ink-faint">Nada se ejecuta hasta que toques Confirmar. Esta acción es reversible.</p>
                <div className="mt-3 flex items-center gap-2">
                  <button
                    onClick={confirmAction}
                    disabled={confirming}
                    className="inline-flex items-center gap-1.5 rounded-control bg-cos-jade px-3.5 py-2 text-[13px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                  >
                    {confirming ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                    Confirmar
                  </button>
                  <button
                    onClick={cancelAction}
                    disabled={confirming}
                    className="inline-flex items-center gap-1.5 rounded-control border border-cos-line bg-cos-card px-3.5 py-2 text-[13px] font-semibold text-cos-ink transition-colors hover:bg-cos-paper disabled:opacity-50"
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            )}


            <div ref={messagesEndRef} />
          </div>

          {/* Sugerencias de la pantalla */}
          {sugerencias.length > 0 && (
            <div className="cos-no-scrollbar flex gap-1.5 overflow-x-auto border-t border-cos-line-soft px-3.5 pb-0.5 pt-2.5">
              {sugerencias.map((s) => (
                <button
                  key={s.texto}
                  onClick={() => mandar(s.seed)}
                  disabled={isLoading}
                  className={cn(
                    "inline-flex flex-none items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1.5 text-[12px] font-medium hover:border-cos-brand disabled:opacity-50",
                    s.tipo === "accion"
                      ? "border-transparent bg-cos-brand-tint text-cos-brand-ink"
                      : "border-cos-line bg-cos-card text-cos-ink-soft",
                  )}
                >
                  {s.tipo === "accion" ? <Zap className="h-[13px] w-[13px]" /> : <CircleHelp className="h-[13px] w-[13px]" />}
                  {s.texto}
                </button>
              ))}
            </div>
          )}

          {/* Input */}
          <div className="px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2">
            <div className="rounded-[13px] border border-cos-line bg-cos-canvas py-1.5 pl-[11px] pr-1.5 focus-within:border-cos-brand">
              {refPendiente && (
                <div className="pb-[5px] pt-[3px]">
                  <PildoraRef
                    refC={refPendiente}
                    origen={refPendiente.ruta ? tituloDeRuta(refPendiente.ruta) : undefined}
                    onQuitar={() => setRefPendiente(null)}
                  />
                </div>
              )}
              <div className="flex items-end gap-1.5">
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Pregunta o pide algo…"
                  rows={1}
                  enterKeyHint="send"
                  className="max-h-[110px] flex-1 resize-none border-0 bg-transparent py-1.5 text-base leading-[1.45] text-cos-ink outline-none focus:outline-none focus-visible:outline-none sm:text-[13.5px]"
                  onInput={(e) => {
                    const target = e.target as HTMLTextAreaElement;
                    target.style.height = "auto";
                    target.style.height = Math.min(target.scrollHeight, 110) + "px";
                  }}
                />
                <button
                  onClick={sendMessage}
                  disabled={(!input.trim() && !refPendiente) || isLoading}
                  title="Enviar"
                  className="grid h-8 w-8 flex-none place-items-center rounded-[9px] bg-cos-brand text-white transition-colors hover:bg-cos-brand-deep disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <ArrowUp className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );

  return (
    <>
      {/* La mascota. En /cierre la conversación ES la pantalla: sobra. */}
      {!enCierre && companyId && (
        <CopilotoMascota
          companyId={companyId}
          abierto={isOpen}
          necesito={necesito}
          onToggle={toggle}
          onPreguntarMas={preguntarMas}
          onTurno={turnoDesdeMascota}
          onCaja={setCajaMascota}
          onArrastre={cerrarAlArrastrar}
          saltos={saltos}
          aCasa={aCasa}
        />
      )}

      {panel}

      {/* Backdrop on mobile */}
      {isOpen && !flotante && <div className="fixed inset-0 z-[61] bg-black/20 print:hidden" onClick={() => setIsOpen(false)} />}
    </>
  );
}
