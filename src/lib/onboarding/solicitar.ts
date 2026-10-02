/** Bounded requests: an interrupted connection must leave a retryable form. */
export async function solicitar(url: string, init?: RequestInit, timeoutMs = 30_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch {
    throw new Error("Se interrumpió la conexión. Revisa tu conexión e intenta de nuevo.");
  } finally {
    clearTimeout(timer);
  }
}
