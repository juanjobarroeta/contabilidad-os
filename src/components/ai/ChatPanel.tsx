"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { X, Send, Loader2, Sparkles, Wrench, Plus, MessagesSquare, Lock, Users, Trash2, ArrowLeft, CheckCircle2, ShieldCheck } from "lucide-react";
import { Markdown } from "./Markdown";

interface Message {
  role: "user" | "assistant";
  content: string;
}
// Acción reversible PROPUESTA por el asistente, a la espera del tap de Confirmar.
interface PendingAction {
  type: string;
  summary: string;
  token: string;
  expiresAt: number;
}
type Visibility = "PRIVATE" | "COMPANY";
interface ConvSummary {
  id: string;
  title: string;
  visibility: Visibility;
  updatedAt: string;
  mine: boolean;
  autor: string | null;
}

const fmtFecha = (iso: string) => {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("es-MX", { day: "2-digit", month: "short" });
};

export function ChatPanel() {
  const { activeCompany } = useCompany();
  const [isOpen, setIsOpen] = useState(false);
  const [view, setView] = useState<"chat" | "history">("chat");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  // Acción reversible propuesta + estado del tap de confirmación.
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [confirming, setConfirming] = useState(false);
  // Conversación actual + historial.
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<Visibility>("PRIVATE");
  const [isMine, setIsMine] = useState(true);
  const [conversations, setConversations] = useState<ConvSummary[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const prevCompanyRef = useRef<string | null>(null);

  const loadConversations = useCallback(async () => {
    if (!activeCompany) return;
    try {
      const res = await fetch(`/api/ai/conversations?companyId=${activeCompany.id}`);
      if (res.ok) setConversations(await res.json());
    } catch { /* offline — el historial puede esperar */ }
  }, [activeCompany]);

  const newChat = useCallback(() => {
    setMessages([]);
    setConversationId(null);
    setVisibility("PRIVATE");
    setIsMine(true);
    setPendingAction(null);
    setView("chat");
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

  async function openConversation(id: string) {
    setView("chat");
    setIsLoading(true);
    try {
      const res = await fetch(`/api/ai/conversations/${id}`);
      if (!res.ok) return;
      const data = await res.json();
      setMessages((data.messages ?? []).map((m: Message) => ({ role: m.role, content: m.content })));
      setConversationId(data.id);
      setVisibility(data.visibility);
      setIsMine(!!data.mine);
      setPendingAction(null);
    } finally {
      setIsLoading(false);
    }
  }

  async function deleteConversation(id: string) {
    if (!window.confirm("¿Borrar esta conversación?")) return;
    await fetch(`/api/ai/conversations/${id}`, { method: "DELETE" });
    if (id === conversationId) newChat();
    await loadConversations();
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

  // Reset al cambiar de empresa; recarga el historial.
  useEffect(() => {
    if (activeCompany?.id && prevCompanyRef.current !== activeCompany.id) {
      if (prevCompanyRef.current !== null) {
        setMessages([]);
        setConversationId(null);
        setView("chat");
      }
      prevCompanyRef.current = activeCompany.id;
      loadConversations();
    }
  }, [activeCompany?.id, loadConversations]);

  // Cargar historial al abrir.
  useEffect(() => {
    if (isOpen) loadConversations();
  }, [isOpen, loadConversations]);

  // Auto-scroll
  useEffect(() => {
    if (view === "chat") messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeTool, view]);

  // Focus input al abrir
  useEffect(() => {
    if (isOpen && view === "chat") inputRef.current?.focus();
  }, [isOpen, view]);

  // ── Mobile (PWA) keyboard fix ──────────────────────────────────────────────
  const [vvBox, setVvBox] = useState<{ height: number; top: number } | null>(null);
  useEffect(() => {
    if (!isOpen) return;
    const vv = window.visualViewport;
    const narrow = () => window.innerWidth < 1024;
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

  // Abrir desde cualquier parte vía `cos:ask-ai`. Si el evento trae `detail.seed`,
  // arrancamos una conversación nueva con ese texto pre-cargado en el input (p.ej.
  // "Resolver con el asistente" desde un pendiente), para que el asistente ya
  // conozca la tarea. `detail.send` lo envía automáticamente.
  useEffect(() => {
    const open = (e: Event) => {
      setIsOpen(true);
      const detail = (e as CustomEvent<{ seed?: string; send?: boolean }>).detail;
      if (detail?.seed) {
        newChat();
        setInput(detail.seed);
        setTimeout(() => inputRef.current?.focus(), 60);
      }
    };
    window.addEventListener("cos:ask-ai", open);
    return () => window.removeEventListener("cos:ask-ai", open);
  }, [newChat]);

  const sendMessage = useCallback(async () => {
    if (!input.trim() || isLoading || !activeCompany) return;

    const userMessage: Message = { role: "user", content: input.trim() };
    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setInput("");
    setIsLoading(true);
    setActiveTool(null);
    // Un nuevo turno invalida cualquier propuesta anterior aún en pantalla.
    setPendingAction(null);

    try {
      const apiMessages = newMessages.map((m) => ({ role: m.role, content: m.content }));
      const response = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: apiMessages, companyId: activeCompany.id, conversationId }),
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || "Error del servidor");
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No se pudo leer la respuesta");

      const decoder = new TextDecoder();
      let assistantText = "";
      let buffer = "";
      let nuevaConv = false;

      const handle = (data: { type: string; text?: string; tool?: string; error?: string; id?: string; nueva?: boolean; action?: PendingAction }) => {
        if (data.type === "conversation") {
          if (data.id) setConversationId(data.id);
          if (data.nueva) nuevaConv = true;
        } else if (data.type === "pending_action") {
          if (data.action) setPendingAction(data.action);
        } else if (data.type === "text") {
          assistantText += data.text ?? "";
          setMessages((prev) => {
            const updated = [...prev];
            const lastMsg = updated[updated.length - 1];
            if (lastMsg?.role === "assistant") lastMsg.content = assistantText;
            else updated.push({ role: "assistant", content: assistantText });
            return [...updated];
          });
        } else if (data.type === "tool_start") {
          setActiveTool(data.tool ?? null);
        } else if (data.type === "done") {
          setActiveTool(null);
        } else if (data.type === "error") {
          setMessages((prev) => [...prev, { role: "assistant", content: `Error: ${data.error}` }]);
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        for (const evt of events) {
          for (const line of evt.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            try { handle(JSON.parse(line.slice(6))); } catch { /* partial */ }
          }
        }
      }
      // Refresca el historial (título nuevo / orden) tras el turno.
      if (nuevaConv || conversationId) loadConversations();
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `Error: ${error instanceof Error ? error.message : "Error desconocido"}` },
      ]);
    } finally {
      setIsLoading(false);
      setActiveTool(null);
    }
  }, [input, isLoading, activeCompany, messages, conversationId, loadConversations]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  // El TAP de Confirmar: ejecuta la acción reversible staged (POST /api/ai/confirm).
  // El backend re-valida sesión, membresía (rechaza VIEWER), TTL, token e
  // idempotencia. El asistente NUNCA llega aquí: el tap es la confirmación.
  const confirmAction = useCallback(async () => {
    if (!pendingAction || !conversationId || confirming) return;
    setConfirming(true);
    try {
      const res = await fetch("/api/ai/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId, token: pendingAction.token }),
      });
      const data = await res.json().catch(() => ({}));
      const ok = res.ok && data.ok;
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: ok
            ? `Listo. ${data.message ?? "Acción realizada."}`
            : `No se pudo completar: ${data.error ?? "Inténtalo de nuevo."}`,
        },
      ]);
    } catch {
      setMessages((prev) => [...prev, { role: "assistant", content: "No se pudo completar la acción. Inténtalo de nuevo." }]);
    } finally {
      setPendingAction(null);
      setConfirming(false);
    }
  }, [pendingAction, conversationId, confirming]);

  const cancelAction = useCallback(() => {
    // Sólo descartamos la tarjeta en el cliente; el staged caduca solo por TTL y
    // un nuevo turno lo invalida. No ejecuta nada.
    setPendingAction(null);
  }, []);

  const TOOL_LABELS: Record<string, string> = {
    query_invoices: "Consultando facturas",
    query_bank_transactions: "Revisando transacciones",
    query_tax_declarations: "Consultando declaraciones",
    query_dashboard_kpis: "Obteniendo KPIs",
    query_customers: "Buscando clientes",
    query_employees: "Buscando empleados",
    query_obligations: "Revisando obligaciones",
    categorize_transaction: "Clasificando transacción",
    suggest_reconciliation_match: "Buscando coincidencias",
    analyze_anomalies: "Analizando anomalías",
    proponer_conciliacion: "Preparando conciliación",
    proponer_categorizacion: "Preparando categorización",
    proponer_resolver_hallazgo: "Preparando resolución",
    proponer_posponer_hallazgo: "Preparando posposición",
    proponer_marcar_pendiente: "Preparando cambio",
  };

  if (!activeCompany) return null;

  return (
    <>
      {/* Floating toggle button */}
      {!isOpen && (
        <button
          onClick={() => setIsOpen(true)}
          className="fixed bottom-6 right-6 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-cos-brand text-white shadow-lg transition-transform hover:scale-105 hover:bg-cos-brand-deep active:scale-95"
          title="Asistente IA"
        >
          <Sparkles className="h-6 w-6" />
        </button>
      )}

      <div
        className={`fixed right-0 top-0 z-50 flex h-dvh w-full flex-col border-l border-cos-line bg-cos-card shadow-2xl transition-transform duration-300 sm:w-[440px] ${
          isOpen ? "translate-x-0" : "translate-x-full"
        }`}
        style={vvBox ? { height: `${vvBox.height}px`, top: `${vvBox.top}px` } : undefined}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-cos-line bg-cos-card px-3 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            {view === "history" ? (
              <button onClick={() => setView("chat")} className="rounded-control p-1.5 text-cos-ink-soft hover:bg-cos-paper" title="Volver">
                <ArrowLeft className="h-5 w-5" />
              </button>
            ) : (
              <div className="grid h-9 w-9 flex-none place-items-center rounded-control bg-cos-brand-tint text-cos-brand-ink">
                <Sparkles className="h-[18px] w-[18px]" />
              </div>
            )}
            <div className="min-w-0">
              <h3 className="truncate text-[14px] font-semibold text-cos-ink">
                {view === "history" ? "Conversaciones" : "Asistente Contable"}
              </h3>
              <p className="truncate text-[12px] text-cos-ink-soft">{activeCompany.razonSocial}</p>
            </div>
          </div>
          <div className="flex flex-none items-center gap-0.5">
            {view === "chat" && conversationId && isMine && (
              <button
                onClick={toggleVisibility}
                title={visibility === "COMPANY" ? "Compartida con el equipo — clic para hacerla privada" : "Privada — clic para compartir con el equipo"}
                className={`flex items-center gap-1 rounded-control px-2 py-1.5 text-[12px] font-medium ${
                  visibility === "COMPANY" ? "bg-cos-brand-tint text-cos-brand-ink" : "text-cos-ink-soft hover:bg-cos-paper"
                }`}
              >
                {visibility === "COMPANY" ? <Users className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
              </button>
            )}
            {view === "chat" && (
              <>
                <button onClick={() => setView("history")} className="rounded-control p-1.5 text-cos-ink-soft hover:bg-cos-paper" title="Historial">
                  <MessagesSquare className="h-5 w-5" />
                </button>
                <button onClick={newChat} className="rounded-control p-1.5 text-cos-ink-soft hover:bg-cos-paper" title="Nueva conversación">
                  <Plus className="h-5 w-5" />
                </button>
              </>
            )}
            <button onClick={() => setIsOpen(false)} className="rounded-control p-1.5 text-cos-ink-faint hover:bg-cos-paper hover:text-cos-ink">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {view === "history" ? (
          /* ── Historial de conversaciones ── */
          <div className="flex-1 overflow-y-auto overscroll-contain p-3">
            <button
              onClick={newChat}
              className="mb-3 flex w-full items-center gap-2 rounded-control border border-cos-line px-3 py-2.5 text-[13.5px] font-semibold text-cos-brand-ink hover:bg-cos-brand-tint"
            >
              <Plus className="h-4 w-4" /> Nueva conversación
            </button>
            {conversations.length === 0 ? (
              <p className="py-10 text-center text-[13px] text-cos-ink-faint">Aún no hay conversaciones.</p>
            ) : (
              conversations.map((c) => (
                <div
                  key={c.id}
                  className={`group mb-1 flex items-center gap-2 rounded-control px-3 py-2.5 ${c.id === conversationId ? "bg-cos-brand-tint" : "hover:bg-cos-paper"}`}
                >
                  <button onClick={() => openConversation(c.id)} className="min-w-0 flex-1 text-left">
                    <div className="flex items-center gap-1.5">
                      {c.visibility === "COMPANY" ? <Users className="h-3.5 w-3.5 flex-none text-cos-brand-ink" /> : <Lock className="h-3.5 w-3.5 flex-none text-cos-ink-faint" />}
                      <p className="truncate text-[13.5px] font-medium text-cos-ink">{c.title}</p>
                    </div>
                    <p className="mt-0.5 text-[11.5px] text-cos-ink-faint">
                      {fmtFecha(c.updatedAt)}{!c.mine && c.autor ? ` · ${c.autor}` : ""}
                    </p>
                  </button>
                  {c.mine && (
                    <button
                      onClick={() => deleteConversation(c.id)}
                      className="flex-none rounded-control p-1.5 text-cos-ink-faint opacity-0 hover:bg-cos-red-tint hover:text-cos-red-ink group-hover:opacity-100"
                      title="Borrar"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
        ) : (
          <>
            {/* Messages */}
            <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-4">
              {messages.length === 0 && (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <div className="mb-3 grid h-12 w-12 place-items-center rounded-card bg-cos-brand-tint text-cos-brand-ink">
                    <Sparkles className="h-6 w-6" />
                  </div>
                  <p className="text-[14px] font-semibold text-cos-ink">Asistente Contable</p>
                  <p className="mt-1 max-w-[34ch] text-[13px] text-cos-ink-soft">
                    Pregúntame sobre tus impuestos, facturas o conciliaciones — en lenguaje simple.
                  </p>
                  <div className="mt-4 flex flex-wrap justify-center gap-2">
                    {["¿Por qué debo este IVA?", "¿Qué pasa si no presento la DIOT?", "¿Tengo transacciones sin conciliar?"].map((q) => (
                      <button
                        key={q}
                        onClick={() => { setInput(q); inputRef.current?.focus(); }}
                        className="rounded-full border border-cos-line px-3 py-1.5 text-[12.5px] text-cos-ink-soft transition-colors hover:border-cos-brand hover:bg-cos-brand-tint hover:text-cos-brand-ink"
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {messages.map((msg, i) => (
                <div key={i} className={`mb-3 flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                  <div
                    className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                      msg.role === "user" ? "bg-cos-brand text-white" : "border border-cos-line bg-cos-paper text-cos-ink"
                    }`}
                  >
                    {msg.role === "user" ? <div className="whitespace-pre-wrap">{msg.content}</div> : <Markdown>{msg.content}</Markdown>}
                  </div>
                </div>
              ))}

              {activeTool && (
                <div className="mb-3 flex justify-start">
                  <div className="flex items-center gap-2 rounded-2xl bg-cos-amber-tint px-4 py-2.5 text-sm text-cos-amber-ink">
                    <Wrench className="h-4 w-4 animate-spin" />
                    <span>{TOOL_LABELS[activeTool] || activeTool}...</span>
                  </div>
                </div>
              )}

              {/* Tarjeta de confirmación: el asistente PROPUSO una acción reversible.
                  El tap de "Confirmar" es lo único que la ejecuta. */}
              {pendingAction && !isLoading && (
                <div className="mb-3">
                  <div className="rounded-card border border-cos-brand/40 bg-cos-brand-tint/60 p-3.5">
                    <div className="flex items-center gap-1.5 text-[12px] font-semibold text-cos-brand-ink">
                      <ShieldCheck className="h-4 w-4" /> Confirmación requerida
                    </div>
                    <p className="mt-1.5 text-[13.5px] leading-relaxed text-cos-ink">{pendingAction.summary}</p>
                    <p className="mt-1 text-[11.5px] text-cos-ink-faint">
                      Nada se ejecuta hasta que toques Confirmar. Esta acción es reversible.
                    </p>
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
                </div>
              )}

              {isLoading && !activeTool && messages[messages.length - 1]?.role === "user" && (
                <div className="mb-3 flex justify-start">
                  <div className="flex items-center gap-2 rounded-2xl border border-cos-line bg-cos-paper px-4 py-2.5 text-sm text-cos-ink-soft">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>Pensando...</span>
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            <div className="border-t border-cos-line bg-cos-card p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:p-4">
              <div className="flex items-end gap-2">
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Pregunta algo…"
                  rows={1}
                  enterKeyHint="send"
                  className="flex-1 resize-none rounded-control border border-cos-line px-4 py-2.5 text-base focus:border-cos-brand focus:outline-none focus:ring-1 focus:ring-cos-brand sm:text-sm"
                  style={{ maxHeight: "120px" }}
                  onInput={(e) => {
                    const target = e.target as HTMLTextAreaElement;
                    target.style.height = "auto";
                    target.style.height = Math.min(target.scrollHeight, 120) + "px";
                  }}
                />
                <button
                  onClick={sendMessage}
                  disabled={!input.trim() || isLoading}
                  className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-control bg-cos-brand text-white transition-colors hover:bg-cos-brand-deep disabled:cursor-not-allowed disabled:bg-cos-line"
                >
                  <Send className="h-4 w-4" />
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Backdrop on mobile */}
      {isOpen && <div className="fixed inset-0 z-40 bg-black/20 lg:hidden" onClick={() => setIsOpen(false)} />}
    </>
  );
}
