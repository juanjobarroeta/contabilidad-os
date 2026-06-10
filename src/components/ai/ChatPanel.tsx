"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { Bot, X, Send, Loader2, Sparkles, Wrench } from "lucide-react";

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

      {/* Chat panel */}
      <div
        className={`fixed right-0 top-0 z-50 flex h-full w-[420px] flex-col border-l border-gray-200 bg-white shadow-2xl transition-transform duration-300 ${
          isOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200 bg-cos-brand px-4 py-3">
          <div className="flex items-center gap-2 text-white">
            <Bot className="h-5 w-5" />
            <div>
              <h3 className="text-sm font-semibold">Asistente Contable</h3>
              <p className="text-xs text-white/75">{activeCompany.razonSocial}</p>
            </div>
          </div>
          <button
            onClick={() => setIsOpen(false)}
            className="rounded-lg p-1 text-white/75 hover:bg-cos-brand-deep hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-center text-gray-400">
              <Sparkles className="mb-3 h-10 w-10 text-cos-brand" />
              <p className="text-sm font-medium text-gray-500">Asistente Contable IA</p>
              <p className="mt-1 text-xs text-gray-400">
                Pregunta sobre tus facturas, impuestos, transacciones bancarias, o pide ayuda con
                conciliaciones.
              </p>
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                {[
                  "Cuántas facturas emití este mes?",
                  "Cuál es mi IVA estimado?",
                  "Tengo transacciones sin conciliar?",
                ].map((q) => (
                  <button
                    key={q}
                    onClick={() => {
                      setInput(q);
                      inputRef.current?.focus();
                    }}
                    className="rounded-full border border-gray-200 px-3 py-1.5 text-xs text-gray-600 transition-colors hover:border-cos-brand hover:bg-cos-brand-tint hover:text-cos-brand-ink"
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
                    : "bg-gray-100 text-gray-800"
                }`}
              >
                <div className="whitespace-pre-wrap">{msg.content}</div>
              </div>
            </div>
          ))}

          {/* Tool use indicator */}
          {activeTool && (
            <div className="mb-3 flex justify-start">
              <div className="flex items-center gap-2 rounded-2xl bg-amber-50 px-4 py-2.5 text-sm text-amber-700">
                <Wrench className="h-4 w-4 animate-spin" />
                <span>{TOOL_LABELS[activeTool] || activeTool}...</span>
              </div>
            </div>
          )}

          {/* General loading indicator */}
          {isLoading && !activeTool && messages[messages.length - 1]?.role === "user" && (
            <div className="mb-3 flex justify-start">
              <div className="flex items-center gap-2 rounded-2xl bg-gray-100 px-4 py-2.5 text-sm text-gray-500">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Pensando...</span>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className="border-t border-gray-200 bg-white p-4">
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Pregunta algo..."
              rows={1}
              className="flex-1 resize-none rounded-xl border border-gray-300 px-4 py-2.5 text-sm focus:border-cos-brand focus:outline-none focus:ring-1 focus:ring-cos-brand"
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
              className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-cos-brand text-white transition-colors hover:bg-cos-brand-deep disabled:bg-gray-300 disabled:cursor-not-allowed"
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
