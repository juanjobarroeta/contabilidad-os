"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Superficie de PRUEBA del copiloto jurídico (docs/MOTOR-JURIDICO.md §6): el
// perfil abogado sobre todo el corpus + jurisprudencia, con las conversaciones
// guardadas y la traza de cada respuesta a la vista (qué herramientas llamó,
// qué fundamentos devolvió la base, qué hizo la verificación). Sólo operador.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Loader2, Lock, Plus, Scale, Send, ThumbsDown, ThumbsUp, Trash2 } from "lucide-react";
import { Markdown } from "@/components/ai/Markdown";

interface Conv {
  id: string;
  titulo: string;
  updatedAt: string;
  mensajes: number;
}

interface Traza {
  modelo?: string;
  rondas?: number;
  tools?: { name: string; ms: number; resumen?: string }[];
  fundamentos?: { cita: string; similitud: number; fuente?: string }[];
  verificacion?: { verificada: boolean; corregida: boolean; problemas: number; citasNoVerificables: string[]; ms: number };
}

interface Msg {
  role: "user" | "assistant";
  content: string;
  id?: string;
  meta?: Traza | null;
  feedback?: "up" | "down" | null;
}

const EJEMPLOS = [
  "¿Qué plazo tengo para contestar una demanda en el juicio oral civil del CNPCF?",
  "¿Cómo han resuelto los tribunales la deducción de pagos a partes relacionadas en el extranjero?",
  "¿Procede el amparo indirecto contra la negativa de devolución de IVA? ¿Qué dice la jurisprudencia?",
  "¿Cuándo prescribe la acción para reclamar el pago de un pagaré?",
];

export default function JuridicoPage() {
  const [convs, setConvs] = useState<Conv[]>([]);
  const [convId, setConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [toolsTurno, setToolsTurno] = useState<{ name: string; ms?: number; resumen?: string }[]>([]);
  const [error, setError] = useState("");
  const [denied, setDenied] = useState(false);
  const [trazaAbierta, setTrazaAbierta] = useState<Record<string, boolean>>({});
  const convRef = useRef<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const cargarConvs = useCallback(async () => {
    const res = await fetch("/api/juridico/conversaciones");
    if (res.status === 403) {
      setDenied(true);
      return;
    }
    if (res.ok) setConvs(await res.json());
  }, []);

  useEffect(() => {
    cargarConvs();
  }, [cargarConvs]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeTool]);

  async function abrir(id: string) {
    setError("");
    const res = await fetch(`/api/juridico/conversaciones/${id}`);
    if (!res.ok) {
      setError("No se pudo abrir la conversación");
      return;
    }
    const j = (await res.json()) as { id: string; mensajes: { id: string; rol: string; contenido: string; meta: Traza | null; feedback: "up" | "down" | null }[] };
    convRef.current = j.id;
    setConvId(j.id);
    setMessages(j.mensajes.map((m) => ({ role: m.rol === "user" ? "user" : "assistant", content: m.contenido, id: m.id, meta: m.meta, feedback: m.feedback })));
  }

  function nueva() {
    convRef.current = null;
    setConvId(null);
    setMessages([]);
    setError("");
    setToolsTurno([]);
  }

  async function archivar(id: string) {
    await fetch(`/api/juridico/conversaciones/${id}`, { method: "DELETE" });
    if (convRef.current === id) nueva();
    cargarConvs();
  }

  async function feedback(mensajeId: string, valor: "up" | "down") {
    if (!convRef.current) return;
    setMessages((prev) => prev.map((m) => (m.id === mensajeId ? { ...m, feedback: m.feedback === valor ? null : valor } : m)));
    await fetch(`/api/juridico/conversaciones/${convRef.current}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mensajeId, feedback: valor }),
    }).catch(() => {});
  }

  async function enviar(texto: string) {
    const contenido = texto.trim();
    if (!contenido || loading) return;
    setInput("");
    setError("");
    const historial: Msg[] = [...messages, { role: "user", content: contenido }];
    setMessages(historial);
    setLoading(true);
    setActiveTool(null);
    setToolsTurno([]);

    let nuevaConv = false;
    try {
      const res = await fetch("/api/juridico/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: historial.map((m) => ({ role: m.role, content: m.content })), conversacionId: convRef.current }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Error del servidor");
      }
      const reader = res.body?.getReader();
      if (!reader) throw new Error("No se pudo leer la respuesta");
      const decoder = new TextDecoder();
      let assistantText = "";
      let buffer = "";
      const handle = (d: { type: string; text?: string; tool?: string; ms?: number; resumen?: string; error?: string; id?: string; nueva?: boolean; messageId?: string | null; traza?: Traza }) => {
        if (d.type === "conversation") {
          if (d.id) {
            convRef.current = d.id;
            setConvId(d.id);
          }
          if (d.nueva) nuevaConv = true;
        } else if (d.type === "text" || d.type === "replace") {
          assistantText = d.type === "text" ? assistantText + (d.text ?? "") : (d.text ?? assistantText);
          setMessages((prev) => {
            const upd = [...prev];
            const last = upd[upd.length - 1];
            if (last?.role === "assistant") upd[upd.length - 1] = { ...last, content: assistantText };
            else upd.push({ role: "assistant", content: assistantText });
            return upd;
          });
        } else if (d.type === "tool_start") {
          setActiveTool(d.tool ?? null);
          setToolsTurno((prev) => [...prev, { name: d.tool ?? "?" }]);
        } else if (d.type === "tool_done") {
          setActiveTool(null);
          setToolsTurno((prev) => {
            const upd = [...prev];
            const i = upd.map((t) => t.name).lastIndexOf(d.tool ?? "?");
            if (i >= 0) upd[i] = { ...upd[i], ms: d.ms, resumen: d.resumen };
            return upd;
          });
        } else if (d.type === "done") {
          setActiveTool(null);
          setMessages((prev) => {
            const upd = [...prev];
            const last = upd[upd.length - 1];
            if (last?.role === "assistant") upd[upd.length - 1] = { ...last, id: d.messageId ?? undefined, meta: d.traza ?? null };
            return upd;
          });
        } else if (d.type === "error") {
          throw new Error(d.error || "Error");
        }
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            handle(JSON.parse(line.slice(6)));
          } catch (e) {
            if (e instanceof Error && e.message !== "Unexpected end of JSON input") throw e;
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setLoading(false);
      setActiveTool(null);
      if (nuevaConv || convRef.current) cargarConvs();
    }
  }

  if (denied) {
    return (
      <div className="mx-auto max-w-2xl p-8 text-center">
        <Lock className="mx-auto mb-3 h-8 w-8 text-cos-ink-faint" />
        <p className="text-cos-ink-soft">El copiloto jurídico es una superficie de prueba del operador.</p>
        <Link href="/operador" className="mt-4 inline-block text-cos-brand-ink underline">Volver</Link>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-4rem)] gap-4 p-4">
      {/* Conversaciones */}
      <aside className="flex w-64 flex-none flex-col rounded-card border border-cos-line bg-cos-card">
        <div className="flex items-center justify-between border-b border-cos-line px-3 py-2.5">
          <span className="text-[12px] font-semibold uppercase tracking-wide text-cos-ink-soft">Conversaciones</span>
          <button onClick={nueva} className="rounded-control p-1.5 text-cos-brand-ink hover:bg-cos-brand-tint" title="Nueva conversación">
            <Plus className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {convs.length === 0 && <p className="px-2 py-3 text-[12.5px] text-cos-ink-faint">Sin conversaciones todavía.</p>}
          {convs.map((c) => (
            <div key={c.id} className={`group mb-1 flex items-start gap-1 rounded-control px-2 py-1.5 ${c.id === convId ? "bg-cos-brand-tint" : "hover:bg-cos-paper"}`}>
              <button onClick={() => abrir(c.id)} className="min-w-0 flex-1 text-left">
                <div className="truncate text-[13px] text-cos-ink">{c.titulo}</div>
                <div className="text-[11px] text-cos-ink-faint">
                  {new Date(c.updatedAt).toLocaleString("es-MX", { dateStyle: "short", timeStyle: "short" })} · {c.mensajes} msgs
                </div>
              </button>
              <button onClick={() => archivar(c.id)} className="flex-none rounded-control p-1 text-cos-ink-faint opacity-0 hover:bg-cos-red-tint hover:text-cos-red-ink group-hover:opacity-100" title="Archivar">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      </aside>

      {/* Chat */}
      <section className="flex min-w-0 flex-1 flex-col rounded-card border border-cos-line bg-cos-card">
        <header className="flex items-center gap-3 border-b border-cos-line px-4 py-3">
          <div className="grid h-9 w-9 flex-none place-items-center rounded-control bg-cos-brand-tint text-cos-brand-ink">
            <Scale className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <h1 className="text-[15px] font-semibold text-cos-ink">Copiloto jurídico · prueba</h1>
            <p className="truncate text-[12px] text-cos-ink-soft">Perfil abogado: todo el orden jurídico cargado + jurisprudencia 9a.–12a. Época. Verificación de citas encendida. Cada respuesta guarda su traza.</p>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {messages.length === 0 && (
            <div className="mx-auto max-w-2xl py-8">
              <p className="mb-3 text-[13.5px] text-cos-ink-soft">Prueba con una de éstas o escribe la tuya:</p>
              <div className="flex flex-wrap gap-2">
                {EJEMPLOS.map((e) => (
                  <button key={e} onClick={() => enviar(e)} className="rounded-full border border-cos-line px-3 py-1.5 text-left text-[12.5px] text-cos-ink-soft hover:border-cos-brand hover:bg-cos-brand-tint hover:text-cos-brand-ink">
                    {e}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={m.id ?? i} className={`mb-4 flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[85%] rounded-card px-4 py-3 text-[13.5px] ${m.role === "user" ? "bg-cos-brand text-white" : "border border-cos-line bg-cos-paper text-cos-ink"}`}>
                {m.role === "user" ? <div className="whitespace-pre-wrap">{m.content}</div> : <Markdown>{m.content}</Markdown>}
                {m.role === "assistant" && m.meta && (
                  <div className="mt-3 border-t border-cos-line pt-2 text-[12px] text-cos-ink-soft">
                    <div className="flex flex-wrap items-center gap-2">
                      <button onClick={() => setTrazaAbierta((p) => ({ ...p, [m.id ?? String(i)]: !p[m.id ?? String(i)] }))} className="underline underline-offset-2 hover:text-cos-ink">
                        Traza · {m.meta.rondas ?? 0} rondas · {m.meta.tools?.length ?? 0} herramientas · {m.meta.fundamentos?.length ?? 0} fundamentos
                      </button>
                      {m.meta.verificacion && (
                        <span className={`rounded-full border px-2 py-0.5 ${m.meta.verificacion.corregida ? "border-cos-amber-ink text-cos-amber-ink" : m.meta.verificacion.verificada ? "border-cos-brand text-cos-brand-ink" : "border-cos-line"}`}>
                          {m.meta.verificacion.corregida ? `corregida (${m.meta.verificacion.problemas} problemas)` : m.meta.verificacion.verificada ? "verificada" : "sin verificar"}
                          {m.meta.verificacion.citasNoVerificables.length > 0 && ` · ${m.meta.verificacion.citasNoVerificables.length} citas fuera de la base`}
                        </span>
                      )}
                      {m.id && (
                        <span className="ml-auto flex gap-1">
                          <button onClick={() => feedback(m.id!, "up")} className={`rounded-control p-1 hover:bg-cos-brand-tint ${m.feedback === "up" ? "text-cos-brand-ink" : "text-cos-ink-faint"}`} title="Buena respuesta"><ThumbsUp className="h-3.5 w-3.5" /></button>
                          <button onClick={() => feedback(m.id!, "down")} className={`rounded-control p-1 hover:bg-cos-red-tint ${m.feedback === "down" ? "text-cos-red-ink" : "text-cos-ink-faint"}`} title="Mala respuesta"><ThumbsDown className="h-3.5 w-3.5" /></button>
                        </span>
                      )}
                    </div>
                    {trazaAbierta[m.id ?? String(i)] && (
                      <div className="mt-2 space-y-1.5">
                        <div className="text-cos-ink-faint">Modelo {m.meta.modelo}</div>
                        {(m.meta.tools ?? []).map((t, k) => (
                          <div key={k} className="font-mono text-[11.5px]"><span className="text-cos-ink">{t.name}</span> · {t.ms} ms{t.resumen ? ` · ${t.resumen}` : ""}</div>
                        ))}
                        {(m.meta.fundamentos ?? []).length > 0 && (
                          <div>
                            <div className="mt-1 text-cos-ink-faint">Fundamentos devueltos por la base:</div>
                            {(m.meta.fundamentos ?? []).map((f, k) => (
                              <div key={k} className="font-mono text-[11.5px]">{f.cita} <span className="text-cos-ink-faint">({f.fuente ?? "?"} · {f.similitud})</span></div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
          {loading && (
            <div className="mb-4 flex items-center gap-2 text-[12.5px] text-cos-ink-soft">
              <Loader2 className="h-4 w-4 animate-spin" />
              {activeTool ? `Consultando ${activeTool}…` : toolsTurno.length > 0 ? "Redactando con lo recuperado…" : "Pensando…"}
              {toolsTurno.length > 0 && <span className="text-cos-ink-faint">· {toolsTurno.map((t) => t.name).join(", ")}</span>}
            </div>
          )}
          {error && <div className="mb-3 rounded-control border border-cos-red-ink bg-cos-red-tint px-3 py-2 text-[12.5px] text-cos-red-ink">{error}</div>}
          <div ref={bottomRef} />
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            enviar(input);
          }}
          className="flex items-end gap-2 border-t border-cos-line p-3"
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                enviar(input);
              }
            }}
            rows={2}
            placeholder="Pregunta de derecho mexicano… (Enter envía, Shift+Enter salto de línea)"
            className="min-w-0 flex-1 resize-none rounded-control border border-cos-line bg-cos-card px-3 py-2 text-[13.5px] focus:border-cos-brand focus:outline-none"
          />
          <button type="submit" disabled={loading || !input.trim()} className="grid h-10 w-10 flex-none place-items-center rounded-control bg-cos-brand text-white hover:bg-cos-brand-deep disabled:opacity-50" title="Enviar">
            <Send className="h-4 w-4" />
          </button>
        </form>
      </section>
    </div>
  );
}
