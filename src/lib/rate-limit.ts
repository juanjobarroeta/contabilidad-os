/**
 * Límite de intentos (rate limiting) en memoria para los endpoints de
 * autenticación: registro, inicio de sesión y emisión de tokens.
 *
 * Implementación: ventana deslizante por clave arbitraria (p. ej.
 * "signup:ip:1.2.3.4" o "token:email:usuario@dominio.com"). Se guardan las
 * marcas de tiempo de cada intento dentro de la ventana; al exceder el límite
 * se rechaza e indica en cuántos segundos puede reintentarse.
 *
 * LIMITACIÓN IMPORTANTE — instancia única:
 * El estado vive en la memoria del proceso de Node. Esto funciona porque la
 * aplicación se despliega como UN solo servidor de larga duración (Railway).
 * Si algún día se escala horizontalmente (varias réplicas) o se migra a un
 * entorno serverless, cada proceso tendría su propio contador y el límite
 * efectivo se multiplicaría; en ese caso este módulo debe migrarse a un
 * almacén compartido (Redis o Postgres). Un reinicio del proceso también
 * reinicia los contadores, lo cual es aceptable para este caso de uso.
 *
 * La limpieza de entradas viejas es perezosa: cada cierto tiempo, al procesar
 * una verificación, se barren las claves cuyos intentos ya expiraron para que
 * el Map no crezca sin límite.
 */

type Entry = {
  /** Marcas de tiempo (ms epoch) de los intentos dentro de la ventana. */
  timestamps: number[];
  /** Ventana usada en la última verificación; sirve para la limpieza. */
  windowMs: number;
};

const buckets = new Map<string, Entry>();

/** Cada cuánto (como máximo) se barre el Map de entradas expiradas. */
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
let lastCleanupAt = Date.now();

function maybeCleanup(now: number): void {
  if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) return;
  lastCleanupAt = now;
  for (const [key, entry] of buckets) {
    const newest = entry.timestamps[entry.timestamps.length - 1];
    if (newest === undefined || now - newest >= entry.windowMs) {
      buckets.delete(key);
    }
  }
}

export type RateLimitResult = {
  ok: boolean;
  /** Solo presente cuando ok === false: segundos hasta poder reintentar. */
  retryAfterSeconds?: number;
};

/**
 * Registra un intento bajo `key` y verifica si excede `limit` intentos por
 * ventana de `windowMs`. Cuando se rechaza, el intento NO se cuenta (los
 * intentos rechazados no extienden el castigo).
 */
export function checkRateLimit(
  key: string,
  opts: { limit: number; windowMs: number }
): RateLimitResult {
  const now = Date.now();
  maybeCleanup(now);

  let entry = buckets.get(key);
  if (!entry) {
    entry = { timestamps: [], windowMs: opts.windowMs };
    buckets.set(key, entry);
  }
  entry.windowMs = opts.windowMs;
  entry.timestamps = entry.timestamps.filter((t) => now - t < opts.windowMs);

  if (entry.timestamps.length >= opts.limit) {
    const oldest = entry.timestamps[0];
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((oldest + opts.windowMs - now) / 1000)
    );
    return { ok: false, retryAfterSeconds };
  }

  entry.timestamps.push(now);
  return { ok: true };
}

/**
 * Extrae la IP del cliente desde los encabezados del proxy (Railway pone la
 * IP real en `x-forwarded-for`; se toma el primer salto). Si no hay
 * encabezados se regresa una constante para que el límite por IP aplique de
 * todos modos como un solo bucket.
 */
export function getClientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = req.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  return "ip-desconocida";
}

/** Solo para pruebas: vacía todos los contadores. */
export function resetRateLimiter(): void {
  buckets.clear();
  lastCleanupAt = Date.now();
}

/** Solo para pruebas: número de claves vivas en el Map. */
export function rateLimiterSize(): number {
  return buckets.size;
}
