// ─────────────────────────────────────────────────────────────────────────────
// Intake & prioritization — configuración y feature gates.
//
// TODO el subsistema es opt-in por variables de entorno: sin INTAKE_ENABLED=1
// la captura no escribe nada y los crons son no-ops baratos, así el deploy es
// inerte hasta que se configure. Diseño completo: docs/INTAKE.md
// ─────────────────────────────────────────────────────────────────────────────

export type IntakeProduct = {
  key: string;
  label: string;
  /** One-liner para el catálogo del prompt de extracción. */
  description: string;
  /** Trabajo que cae en el motor compartido multiplica ×3 en el scoring. */
  core: boolean;
};

/**
 * Catálogo de productos. La atribución es un campo de primera clase: el
 * extractor SOLO puede emitir estas claves (cualquier otra se descarta).
 */
export const INTAKE_PRODUCTS: IntakeProduct[] = [
  {
    key: "contabilidados",
    label: "ContabilidadOS",
    description:
      "Plataforma de contabilidad fiscal MX (CFDI, declaraciones, conciliación bancaria, nómina). Motor compartido de todos los verticales.",
    core: true,
  },
  {
    key: "automotriz",
    label: "AutomotrizPro",
    description: "Vertical para agencias/talleres automotrices: inventario de unidades, refacciones, órdenes de servicio.",
    core: false,
  },
  {
    key: "restaurante",
    label: "Restaurante",
    description: "Vertical restaurantero: ventas por canal, insumos, costos de platillo.",
    core: false,
  },
  {
    key: "purificadora",
    label: "Purificadora",
    description: "Vertical de purificadoras de agua: rutas, garrafones, cobranza.",
    core: false,
  },
  {
    key: "construccion",
    label: "Construcción",
    description: "Vertical de constructoras: obras, estimaciones, costos por proyecto.",
    core: false,
  },
  {
    key: "padel",
    label: "Padel",
    description: "Vertical de clubes de pádel: reservas, membresías, ingresos por cancha.",
    core: false,
  },
];

export function productByKey(key: string | null | undefined): IntakeProduct | null {
  if (!key) return null;
  const k = key.trim().toLowerCase();
  return INTAKE_PRODUCTS.find((p) => p.key === k) ?? null;
}

/** Master switch de la captura (webhook tap + crons). */
export function intakeEnabled(): boolean {
  return process.env.INTAKE_ENABLED === "1";
}

export function zoomConfigured(): boolean {
  return Boolean(process.env.ZOOM_WEBHOOK_SECRET_TOKEN);
}

export function deepgramConfigured(): boolean {
  return Boolean(process.env.DEEPGRAM_API_KEY);
}

export function telegramConfigured(): boolean {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

export function intakeGithubConfigured(): boolean {
  return Boolean(process.env.INTAKE_GITHUB_TOKEN && process.env.INTAKE_GITHUB_REPO);
}

/**
 * Repo destino ("owner/repo") para los issues de un producto. Por omisión todo
 * va a INTAKE_GITHUB_REPO; un satélite con repo propio se mapea con
 * INTAKE_GITHUB_REPO_<PRODUCT> (p. ej. INTAKE_GITHUB_REPO_AUTOMOTRIZ).
 */
export function githubRepoForProduct(product: string | null | undefined): string | null {
  if (product) {
    const override = process.env[`INTAKE_GITHUB_REPO_${product.toUpperCase()}`];
    if (override) return override;
  }
  return process.env.INTAKE_GITHUB_REPO ?? null;
}

export const INTAKE_TZ = "America/Mexico_City";

/** Hora local (0–23) en America/Mexico_City. */
export function horaLocal(now: Date = new Date()): number {
  return parseInt(
    new Intl.DateTimeFormat("en-US", { timeZone: INTAKE_TZ, hour: "numeric", hour12: false }).format(now),
    10
  ) % 24;
}

/** Día de la semana local: 0=domingo … 6=sábado. */
export function diaSemanaLocal(now: Date = new Date()): number {
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: INTAKE_TZ, weekday: "short" }).format(now);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd);
}

/**
 * Lunes 00:00 (hora local MX) de la semana de `now`, como Date UTC estable —
 * la clave `weekOf` de los snapshots de scoring.
 */
export function lunesDeLaSemana(now: Date = new Date()): Date {
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: INTAKE_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const local = new Date(`${ymd}T00:00:00Z`); // fecha local como ancla UTC estable
  const dow = diaSemanaLocal(now);
  const diasDesdeLunes = (dow + 6) % 7;
  local.setUTCDate(local.getUTCDate() - diasDesdeLunes);
  return local;
}
