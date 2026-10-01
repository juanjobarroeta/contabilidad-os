"use client";

// ─────────────────────────────────────────────────────────────────────────────
// EL MOTOR DEL CHAT, fuera del cajón. Estado de la conversación, el turno con
// SSE, la acción propuesta y el feedback — sin nada de presentación, para que
// el drawer (ChatPanel) y la pantalla del cierre usen EL MISMO chat en vez de
// dos implementaciones que se desincronizan.
//
// Protocolo: conversation, text, replace, tool_start, pending_action, done,
// error y `card` (tarjetas y botones bajo la respuesta, ver
// lib/copiloto/tarjetas.ts). El contrato de confirmación por tap no cambia:
// nada se ejecuta hasta /api/ai/confirm, y un botón sólo manda un turno.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from "react";
import type { Card, RefCopiloto } from "@/lib/copiloto/tarjetas";
import { watchManagedRun } from "./managed-run";

export interface Message {
  role: "user" | "assistant";
  content: string;
  /** Id persistido (sólo respuestas del asistente): cuelga el feedback. */
  id?: string;
  feedback?: "up" | "down" | null;
  /** Cierre guiado: paso al que pertenece el mensaje (aperturas de paso). */
  paso?: string | null;
  /** Tarjetas, botones y marca de memoria bajo la respuesta (sólo assistant). */
  cards?: Card[];
  /** El elemento adjunto a la pregunta («Explícame esto»; sólo user). */
  ref?: RefCopiloto;
  /**
   * Avance en vivo de la tarjeta «pasos»: cuántas herramientas arrancaron
   * desde que se pintó. null/undefined = turno terminado (todo hecho).
   */
  pasosInicios?: number | null;
}

/** Cuántos pasos ya se marcan hechos, dado el avance en vivo. */
export function pasosHechos(total: number, inicios: number | null | undefined): number {
  if (inicios == null) return total;
  // La primera herramienta es el paso 1 corriendo; cada una que arranca
  // después da por hecho el anterior. El último sólo se cierra con `done`.
  return Math.max(0, Math.min(total - 1, inicios - 1));
}

export interface PendingAction {
  type: string;
  summary: string;
  token: string;
  expiresAt: number;
}

/** Dónde está el usuario cuando manda el turno. */
export interface ChatContexto {
  ruta?: string;
  /** Cierre guiado: periodo y paso abiertos. Habilita las tools y el bloque del cierre. */
  cierre?: { year: number; month: number; paso?: string };
  /** El elemento adjunto al turno (se manda sólo con el turno que lo lleva). */
  ref?: RefCopiloto;
}

/** Cómo viaja al modelo una pregunta vieja que llevaba referencia. */
function contenidoParaModelo(m: Message): string {
  if (!m.ref) return m.content;
  return `${m.content}\n\n[Sobre: ${m.ref.tipo} «${m.ref.titulo}» (id ${m.ref.id})]`;
}

interface Opciones {
  companyId: string | null;
  /** Se lee en el momento de enviar (la ruta y el paso cambian). */
  contexto: () => ChatContexto;
  /** Tras cerrar un turno (para refrescar historial). */
  onTurnoTerminado?: (nuevaConversacion: boolean) => void;
  /** Tras ejecutar una acción confirmada (p. ej. recargar el cierre). */
  onAccionConfirmada?: () => void;
}


// ── Conexión cortada a media respuesta ──────────────────────────────────────
// En el celular, salir de la app (o perder señal) corta el stream: Safari lo
// reporta como «TypeError: Load failed». El servidor NO se entera de que el
// cliente se fue: termina el turno y lo guarda en la conversación. Así que un
// corte no es un error: se avisa y se recupera la respuesta guardada.

export const AVISO_CORTE = "Se cortó la conexión (¿saliste de la app?). Sigo trabajando; en cuanto termine te traigo la respuesta…";
const AVISO_SIN_RECUPERAR =
  "Se cortó la conexión y no pude traer la respuesta todavía. Ábrela en el historial en un momento, o vuelve a preguntar.";
const AVISO_CORTE_INICIO = "Se cortó la conexión antes de empezar. Vuelve a preguntar.";

/** ¿El error es un corte de red (no una respuesta de error del servidor)? */
export function esCorteDeRed(e: unknown): boolean {
  if (e instanceof TypeError) return true;
  const msg = e instanceof Error ? e.message : String(e ?? "");
  return /load failed|failed to fetch|networkerror|network connection was lost|terminated|network error/i.test(msg);
}

/**
 * ¿La conversación guardada ya tiene la respuesta al turno `pregunta`? Busca,
 * desde el final, el último mensaje del usuario con ese texto y exige que le
 * siga una respuesta del asistente.
 */
export function respuestaGuardada(
  guardados: Array<{ role: string; content: string }>,
  pregunta: string,
  /** Cuántas veces se hizo esa misma pregunta en el hilo (contando la nueva). */
  veces = 1,
): boolean {
  const iguales = guardados.filter((m) => m.role === "user" && m.content.trim() === pregunta.trim()).length;
  if (iguales < veces) return false;
  for (let i = guardados.length - 1; i >= 0; i--) {
    if (guardados[i].role === "user" && guardados[i].content.trim() === pregunta.trim()) {
      return guardados.slice(i + 1).some((m) => m.role === "assistant");
    }
  }
  return false;
}

/** Espera `ms` o a que la app vuelva al frente (lo que pase primero). */
function esperarOVolver(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((res) => {
    const fin = () => {
      clearTimeout(t);
      document.removeEventListener("visibilitychange", alVolver);
      signal.removeEventListener("abort", fin);
      res();
    };
    const alVolver = () => {
      if (document.visibilityState === "visible") fin();
    };
    const t = setTimeout(fin, ms);
    document.addEventListener("visibilitychange", alVolver);
    signal.addEventListener("abort", fin);
  });
}

const MS_ENTRE_INTENTOS = 4000;
const MAX_ESPERA_MS = 4 * 60_000;

export function useChat({ companyId, contexto, onTurnoTerminado, onAccionConfirmada }: Opciones) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  // El id vive también en un ref: `enviar` no debe recrearse (ni perder el hilo)
  // cada vez que cambia la conversación.
  const convRef = useRef<string | null>(null);
  const observerRef = useRef<AbortController | null>(null);
  useEffect(() => () => observerRef.current?.abort(), [companyId]);
  const fijarConversacion = useCallback((id: string | null) => {
    convRef.current = id;
    setConversationId(id);
  }, []);

  // El historial se lee por ref dentro de `enviar`: así el callback no se
  // recrea en cada tecla ni manda una captura vieja de los mensajes.
  const messagesRef = useRef<Message[]>([]);
  messagesRef.current = messages;

  const reset = useCallback(() => {
    observerRef.current?.abort();
    setIsLoading(false);
    // El ref también: quien hace reset() y enviar() en el mismo tick (abrir
    // el chat con una pregunta lista) no debe mandar el hilo anterior.
    messagesRef.current = [];
    setMessages([]);
    setPendingAction(null);
    setActiveTool(null);
    fijarConversacion(null);
  }, [fijarConversacion]);

  const observarAgente = useCallback(async (id: string, requestId: string, signal: AbortSignal) => {
    await watchManagedRun(id, requestId, signal, (snapshot) => {
      setActiveTool(snapshot.activeTool);
      setPendingAction(snapshot.pendingAction);
      if (snapshot.message?.content || snapshot.message?.cards?.length) {
        const message = snapshot.message!;
        setMessages((prev) => {
          const index = prev.findIndex((m) => m.id === message.id);
          if (index >= 0) return prev.map((m, i) => i === index ? message : m);
          return [...prev, message];
        });
      }
    });
  }, []);

  const retomarAgente = useCallback(async (id: string, requestId: string) => {
    observerRef.current?.abort();
    const observer = new AbortController();
    observerRef.current = observer;
    setIsLoading(true);
    try { await observarAgente(id, requestId, observer.signal); }
    catch (error) {
      if (!observer.signal.aborted) setMessages((prev) => [...prev, { role: "assistant", content: error instanceof Error ? error.message : "No se pudo consultar el avance." }]);
    } finally {
      if (!observer.signal.aborted) {
        setIsLoading(false);
        setActiveTool(null);
        onTurnoTerminado?.(false);
      }
    }
  }, [observarAgente, onTurnoTerminado]);

  /**
   * Tras un corte: lee la conversación guardada hasta que aparezca la respuesta
   * al turno (o se agote la espera) y la pinta tal como quedó en el servidor.
   */
  const recuperarTurno = useCallback(
    async (conv: string, pregunta: string, veces: number, signal: AbortSignal): Promise<boolean> => {
      const limite = Date.now() + MAX_ESPERA_MS;
      while (!signal.aborted && Date.now() < limite) {
        await esperarOVolver(MS_ENTRE_INTENTOS, signal);
        if (signal.aborted) return false;
        // Con la app en segundo plano el fetch también se cae: se espera a que vuelva.
        if (document.visibilityState !== "visible") continue;
        try {
          const res = await fetch(`/api/ai/conversations/${conv}`, { signal });
          if (!res.ok) continue;
          const data = (await res.json()) as { messages?: Message[] };
          const guardados = data.messages ?? [];
          if (!respuestaGuardada(guardados, pregunta, veces)) continue;
          if (signal.aborted || convRef.current !== conv) return false;
          setMessages(
            guardados.map((m) => ({
              id: m.id,
              role: m.role,
              content: m.content,
              feedback: m.feedback ?? null,
              ...(m.cards ? { cards: m.cards } : {}),
              ...(m.ref ? { ref: m.ref } : {}),
            })),
          );
          return true;
        } catch {
          /* sigue sin red: otro intento */
        }
      }
      return false;
    },
    [],
  );

  /** Manda un turno. `texto` ya viene limpio; la UI decide de dónde sale. */
  const enviar = useCallback(
    async (texto: string, opciones?: { ref?: RefCopiloto }) => {
      const contenido = texto.trim();
      if (!contenido || !companyId) return;
      observerRef.current?.abort();
      const observer = new AbortController();
      observerRef.current = observer;
      const ref = opciones?.ref;

      const nuevo: Message = { role: "user", content: contenido, ...(ref ? { ref } : {}) };
      const historial = [...messagesRef.current, nuevo];
      setMessages(historial);
      setIsLoading(true);
      setActiveTool(null);
      // A proposal remains pending until confirmed/cancelled on the server.
      // Sending another question must not hide its only confirmation card.

      let nuevaConv = false;
      try {
        const res = await fetch("/api/ai/chat", {
          method: "POST",
          signal: observer.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            // La referencia del turno nuevo va en `contexto.ref`; la de los
            // turnos viejos viaja dentro del texto para que «esto» no se pierda.
            // Los mensajes sólo-tarjeta (texto vacío) no se mandan.
            messages: historial
              .filter((m) => m.content.trim())
              .map((m, i, arr) => ({ role: m.role, content: i === arr.length - 1 ? m.content : contenidoParaModelo(m) })),
            companyId,
            requestId: crypto.randomUUID(),
            conversationId: convRef.current,
            contexto: { ...contexto(), ...(ref ? { ref } : {}) },
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || "Error del servidor");
        }
        if (res.status === 202) {
          const managed = await res.json();
          if (observer.signal.aborted) return;
          fijarConversacion(managed.conversationId);
          nuevaConv = !!managed.nueva;
          await observarAgente(managed.managedRunId, managed.requestId, observer.signal);
          if (!observer.signal.aborted) onTurnoTerminado?.(nuevaConv);
          return;
        }
        const reader = res.body?.getReader();
        if (!reader) throw new Error("No se pudo leer la respuesta");

        const decoder = new TextDecoder();
        let assistantText = "";
        let buffer = "";

        const handle = (data: {
          type: string;
          text?: string;
          tool?: string;
          error?: string;
          id?: string;
          nueva?: boolean;
          action?: PendingAction;
          messageId?: string | null;
          card?: Card;
        }) => {
          if (observer.signal.aborted) return;
          if (data.type === "conversation") {
            if (data.id) fijarConversacion(data.id);
            if (data.nueva) nuevaConv = true;
          } else if (data.type === "pending_action") {
            if (data.action) setPendingAction(data.action);
          } else if (data.type === "text") {
            assistantText += data.text ?? "";
            setMessages((prev) => {
              const upd = [...prev];
              const last = upd[upd.length - 1];
              if (last?.role === "assistant") last.content = assistantText;
              else upd.push({ role: "assistant", content: assistantText });
              return [...upd];
            });
          } else if (data.type === "replace") {
            // Pase de verificación: la corregida sustituye a la que se pintó.
            assistantText = data.text ?? assistantText;
            setMessages((prev) => {
              const upd = [...prev];
              const last = upd[upd.length - 1];
              if (last?.role === "assistant") last.content = assistantText;
              return [...upd];
            });
          } else if (data.type === "card") {
            const card = data.card;
            if (!card) return;
            setMessages((prev) => {
              const upd = [...prev];
              const last = upd[upd.length - 1];
              const msg: Message = last?.role === "assistant" ? { ...last } : { role: "assistant", content: assistantText };
              msg.cards = [...(msg.cards ?? []), card];
              if (card.type === "pasos") msg.pasosInicios = 0;
              if (last?.role === "assistant") upd[upd.length - 1] = msg;
              else upd.push(msg);
              return upd;
            });
          } else if (data.type === "tool_start") {
            setActiveTool(data.tool ?? null);
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role !== "assistant" || last.pasosInicios == null) return prev;
              return [...prev.slice(0, -1), { ...last, pasosInicios: last.pasosInicios + 1 }];
            });
          } else if (data.type === "done") {
            setActiveTool(null);
            const mid = data.messageId;
            setMessages((prev) => {
              const upd = [...prev];
              const last = upd[upd.length - 1];
              if (last?.role === "assistant") {
                upd[upd.length - 1] = { ...last, ...(mid ? { id: mid } : {}), pasosInicios: null };
              }
              return upd;
            });
          } else if (data.type === "error") {
            setMessages((prev) => [...prev, { role: "assistant", content: `Error: ${data.error}` }]);
          }
        };

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const eventos = buffer.split("\n\n");
          buffer = eventos.pop() ?? "";
          for (const evt of eventos) {
            for (const linea of evt.split("\n")) {
              if (!linea.startsWith("data: ")) continue;
              try {
                handle(JSON.parse(linea.slice(6)));
              } catch {
                /* fragmento parcial */
              }
            }
          }
        }
        onTurnoTerminado?.(nuevaConv);
      } catch (e) {
        if (observer.signal.aborted) return;
        if (esCorteDeRed(e)) {
          const conv = convRef.current;
          if (!conv) {
            setMessages((prev) => [...prev, { role: "assistant", content: AVISO_CORTE_INICIO }]);
            return;
          }
          setActiveTool(null);
          setMessages((prev) => [...prev, { role: "assistant", content: AVISO_CORTE }]);
          const veces = historial.filter((m) => m.role === "user" && m.content.trim() === contenido).length;
          const ok = await recuperarTurno(conv, contenido, veces, observer.signal);
          if (observer.signal.aborted) return;
          if (ok) onTurnoTerminado?.(nuevaConv);
          else
            setMessages((prev) =>
              prev.map((m, i) => (i === prev.length - 1 && m.content === AVISO_CORTE ? { ...m, content: AVISO_SIN_RECUPERAR } : m)),
            );
          return;
        }
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: `Error: ${e instanceof Error ? e.message : "Error desconocido"}` },
        ]);
      } finally {
        if (observer.signal.aborted) return;
        setIsLoading(false);
        setActiveTool(null);
        // Si el turno se cortó, los pasos no se quedan girando para siempre.
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role !== "assistant" || last.pasosInicios == null) return prev;
          return [...prev.slice(0, -1), { ...last, pasosInicios: null }];
        });
      }
    },
    [companyId, contexto, fijarConversacion, onTurnoTerminado, observarAgente, recuperarTurno]
  );

  const confirmar = useCallback(async () => {
    if (!pendingAction || !convRef.current || confirming) return;
    setConfirming(true);
    try {
      const res = await fetch("/api/ai/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: convRef.current, token: pendingAction.token }),
      });
      const data = await res.json().catch(() => ({}));
      const ok = res.ok && data.ok;
      if (ok || res.status === 409) setPendingAction(null);
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: ok ? `Listo. ${data.message ?? "Acción realizada."}` : `No se pudo completar: ${data.error ?? "Inténtalo de nuevo."}`,
        },
      ]);
      if (ok) onAccionConfirmada?.();
    } catch {
      setMessages((prev) => [...prev, { role: "assistant", content: "No se pudo completar la acción. Inténtalo de nuevo." }]);
    } finally {
      setConfirming(false);
    }
  }, [pendingAction, confirming, onAccionConfirmada]);

  /** Cancel the durable proposal, not only its visible card. */
  const cancelar = useCallback(async () => {
    if (!pendingAction || !convRef.current || confirming) return;
    setConfirming(true);
    try {
      const response = await fetch("/api/ai/confirm", { method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: convRef.current, token: pendingAction.token }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? "No se pudo cancelar la propuesta.");
      setPendingAction(null);
    } catch (error) { setMessages((prev) => [...prev, { role: "assistant", content: error instanceof Error ? error.message : "No se pudo cancelar la propuesta." }]); }
    finally { setConfirming(false); }
  }, [pendingAction, confirming]);

  const enviarFeedback = useCallback(async (id: string, feedback: "up" | "down" | null, correccion?: string) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, feedback } : m)));
    try {
      await fetch(`/api/ai/messages/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback, ...(correccion !== undefined ? { correccion } : {}) }),
      });
    } catch {
      /* best-effort: el pulgar no debe romper el chat */
    }
  }, []);

  return {
    messages,
    setMessages,
    isLoading,
    activeTool,
    pendingAction,
    confirming,
    conversationId,
    fijarConversacion,
    retomarAgente,
    /** La pantalla del cierre pinta la tarjeta que el paso deja puesta al abrirse. */
    setPendingAction,
    enviar,
    confirmar,
    cancelar,
    enviarFeedback,
    reset,
  };
}

/** Etiquetas legibles de las tools (spinner «Consultando facturas…»). */
export const TOOL_LABELS: Record<string, string> = {
  query_invoices: "Consultando facturas",
  get_invoice_detail: "Abriendo la factura",
  query_cancelaciones: "Revisando cancelaciones",
  query_ppd_cartera: "Revisando cartera PPD",
  query_bank_transactions: "Consultando movimientos bancarios",
  list_unmatched_transactions: "Buscando movimientos sin conciliar",
  categorize_transaction: "Clasificando el movimiento",
  suggest_reconciliation_match: "Buscando la factura que empata",
  analyze_anomalies: "Buscando anomalías",
  query_tax_declarations: "Consultando declaraciones",
  query_tax_position: "Calculando impuestos del periodo",
  query_declaracion_checklist: "Revisando el checklist del mes",
  query_complementos_pendientes: "Revisando complementos por emitir",
  query_complementos_recibidos_pendientes: "Revisando complementos de proveedores",
  query_obligations: "Consultando obligaciones",
  query_dashboard_kpis: "Consultando indicadores del mes",
  query_customers: "Consultando clientes",
  query_employees: "Consultando empleados",
  query_despacho_panorama: "Revisando la cartera",
  query_sat_sync_status: "Revisando la descarga del SAT",
  get_invoice_files: "Preparando los archivos",
  search_fiscal_knowledge: "Buscando el fundamento legal",
  get_articulo: "Leyendo el artículo",
  get_valor_fiscal: "Consultando valores oficiales",
  query_cierre_estado: "Revisando el cierre",
  query_cierre_paso: "Revisando el paso",
  proponer_confirmar_paso: "Preparando la confirmación",
  proponer_fijar_coeficiente: "Preparando el coeficiente",
  proponer_fijar_perdida: "Preparando las pérdidas por amortizar",
  proponer_firmar_conciliacion: "Preparando la firma de la conciliación",
  query_cuentas_sin_agrupador: "Revisando el catálogo de cuentas",
  proponer_fijar_agrupador: "Preparando el código agrupador",
  proponer_marcar_diot_presentada: "Preparando el registro de la DIOT",
  proponer_fijar_saldo_favor_iva: "Preparando el saldo a favor inicial",
  proponer_confirmar_apertura: "Preparando la confirmación del punto de partida",
  proponer_omitir_paso: "Preparando la omisión",
  proponer_conciliacion: "Preparando la conciliación",
  proponer_categorizacion: "Preparando la categorización",
  proponer_categorizacion_lote: "Preparando la categorización en lote",
  proponer_resolver_hallazgo: "Preparando la resolución",
  proponer_posponer_hallazgo: "Preparando el aplazamiento",
  proponer_marcar_pendiente: "Actualizando el pendiente",
};
