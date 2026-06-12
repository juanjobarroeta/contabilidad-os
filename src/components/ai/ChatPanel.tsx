"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { X, Send, Loader2, Sparkles, Wrench } from "lucide-react";

interface Message {
  role: "user" | "assistant";
  content: string;
}

export function ChatPanel() {
  const { activeCompany } = useCompany();
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const prevCompanyRef = useRef<string | null>(null);

  // Reset messages when company changes
  useEffect(() => {
    if (activeCompany?.id && prevCompanyRef.current !== activeCompany.id) {
      if (prevCompanyRef.current !== null) {
        setMessages([]);
      }
      prevCompanyRef.current = activeCompany.id;
    }
  }, [activeCompany?.id]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeTool]);

  // Focus input when panel opens
  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen]);

  // ── Mobile (PWA) keyboard fix ──────────────────────────────────────────────
  // En iOS el teclado NO redimensiona el layout viewport (100vh/dvh ni los
  // elementos fixed se encogen): sólo cambia window.visualViewport. Un panel
  // `h-full` deja el input escondido detrás del teclado. Mientras el panel está
  // abierto en pantallas angostas, lo dimensionamos al visual viewport y lo
  // anclamos a su offsetTop, y bloqueamos el scroll del body para que iOS no
  // "empuje" la página al enfocar el textarea.
  const [vvBox, setVvBox] = useState<{ height: number; top: number } | null>(null);
  useEffect(() => {
    if (!isOpen) return;
    const vv = window.visualViewport;
    const narrow = () => window.innerWidth < 1024;
    const update = () => {
      if (vv && narrow()) {
        setVvBox({ height: Math.round(vv.height), top: Math.round(vv.offsetTop) });
        // Mantén la conversación pegada al fondo cuando el teclado abre/cierra.
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

  // Open from anywhere via the `cos:ask-ai` event (e.g. the Inicio ask-row).
  useEffect(() => {
    const open = () => setIsOpen(true);
    window.addEventListener("cos:ask-ai", open);
    return () => window.removeEventListener("cos:ask-ai", open);
  }, []);

  const sendMessage = useCallback(async () => {
    if (!input.trim() || isLoading || !activeCompany) return;

    const userMessage: Message = { role: "user", content: input.trim() };
    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setInput("");
    setIsLoading(true);
    setActiveTool(null);

    try {
      // Build API messages (only role + content as strings)
      const apiMessages = newMessages.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const response = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: apiMessages,
          companyId: activeCompany.id,
        }),
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || "Error del servidor");
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No se pudo leer la respuesta");

      const decoder = new TextDecoder();
      let assistantText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n");

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = JSON.parse(line.slice(6));

          if (data.type === "text") {
            assistantText += data.text;
            setMessages((prev) => {
              const updated = [...prev];
              const lastMsg = updated[updated.length - 1];
              if (lastMsg?.role === "assistant") {
                lastMsg.content = assistantText;
              } else {
                updated.push({ role: "assistant", content: assistantText });
              }
              return [...updated];
            });
          } else if (data.type === "tool_start") {
            setActiveTool(data.tool);
          } else if (data.type === "done") {
            setActiveTool(null);
          } else if (data.type === "error") {
            setMessages((prev) => [
              ...prev,
              { role: "assistant", content: `Error: ${data.error}` },
            ]);
          }
        }
      }
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `Error: ${error instanceof Error ? error.message : "Error desconocido"}`,
        },
      ]);
    } finally {
      setIsLoading(false);
      setActiveTool(null);
    }
  }, [input, isLoading, activeCompany, messages]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

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

      {/* Chat panel — full-width sheet en móvil (alto = visual viewport para
          que el input quede arriba del teclado), side panel de 420px en desktop. */}
      <div
        className={`fixed right-0 top-0 z-50 flex h-dvh w-full flex-col border-l border-cos-line bg-white shadow-2xl transition-transform duration-300 sm:w-[420px] ${
          isOpen ? "translate-x-0" : "translate-x-full"
        }`}
        style={vvBox ? { height: `${vvBox.height}px`, top: `${vvBox.top}px` } : undefined}
      >
        {/* Header — white con tile de sparkle (spec Contia), no header sólido */}
        <div className="flex items-center justify-between border-b border-cos-line bg-white px-4 py-3">
          <div className="flex items-center gap-2.5">
            <div className="grid h-9 w-9 place-items-center rounded-control bg-cos-brand-tint text-cos-brand-ink">
              <Sparkles className="h-[18px] w-[18px]" />
            </div>
            <div>
              <h3 className="text-[14px] font-semibold text-cos-ink">Asistente Contable</h3>
              <p className="text-[12px] text-cos-ink-soft">{activeCompany.razonSocial}</p>
            </div>
          </div>
          <button
            onClick={() => setIsOpen(false)}
            className="rounded-control p-1.5 text-cos-ink-faint hover:bg-cos-paper hover:text-cos-ink"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

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
                {[
                  "¿Por qué debo este IVA?",
                  "¿Qué pasa si no presento la DIOT?",
                  "¿Tengo transacciones sin conciliar?",
                ].map((q) => (
                  <button
                    key={q}
                    onClick={() => {
                      setInput(q);
                      inputRef.current?.focus();
                    }}
                    className="rounded-full border border-cos-line px-3 py-1.5 text-[12.5px] text-cos-ink-soft transition-colors hover:border-cos-brand hover:bg-cos-brand-tint hover:text-cos-brand-ink"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg, i) => (
            <div
              key={i}
              className={`mb-3 flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                  msg.role === "user"
                    ? "bg-cos-brand text-white"
                    : "border border-cos-line bg-cos-paper text-cos-ink"
                }`}
              >
                <div className="whitespace-pre-wrap">{msg.content}</div>
              </div>
            </div>
          ))}

          {/* Tool use indicator */}
          {activeTool && (
            <div className="mb-3 flex justify-start">
              <div className="flex items-center gap-2 rounded-2xl bg-cos-amber-tint px-4 py-2.5 text-sm text-cos-amber-ink">
                <Wrench className="h-4 w-4 animate-spin" />
                <span>{TOOL_LABELS[activeTool] || activeTool}...</span>
              </div>
            </div>
          )}

          {/* General loading indicator */}
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

        {/* Input — pb con safe-area para el home indicator (PWA standalone);
            text-base en móvil: iOS hace auto-zoom de la página con inputs <16px. */}
        <div className="border-t border-cos-line bg-white p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:p-4">
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
      </div>

      {/* Backdrop when open on mobile */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/20 lg:hidden"
          onClick={() => setIsOpen(false)}
        />
      )}
    </>
  );
}
