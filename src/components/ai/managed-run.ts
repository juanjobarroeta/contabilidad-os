import type { Message, PendingAction } from "./useChat";

export interface ManagedSnapshot {
  done: boolean;
  activeTool: string | null;
  message: Message | null;
  pendingAction: PendingAction | null;
  pendingActions?: PendingAction[];
}

export async function watchManagedRun(id: string, requestId: string, signal: AbortSignal,
  receive: (snapshot: ManagedSnapshot) => void) {
  const deadline = Date.now() + 13 * 60_000;
  let failures = 0;
  while (!signal.aborted && Date.now() < deadline) {
    try {
      const response = await fetch(`/api/ai/contabot/${encodeURIComponent(id)}?requestId=${encodeURIComponent(requestId)}`, { signal, cache: "no-store" });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        // Revoked access and a newer request are terminal for this observer.
        if (response.status < 500) throw new ManagedReadError(body.error ?? "Sin acceso al avance de ContaBot.");
        throw new Error("El avance no está disponible todavía.");
      }
      const snapshot: ManagedSnapshot = await response.json();
      if (signal.aborted) return;
      receive(snapshot);
      if (snapshot.done) return;
      failures = 0;
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof ManagedReadError || ++failures >= 5) throw error;
    }
    await new Promise<void>((resolve) => {
      const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
      const timer = setTimeout(finish, 2500);
      signal.addEventListener("abort", finish, { once: true });
    });
  }
  if (!signal.aborted) throw new Error("El trabajo quedó guardado. Abre la conversación para consultar su avance.");
}
class ManagedReadError extends Error {}
