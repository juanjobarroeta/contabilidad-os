import type Stripe from "stripe";
import { getStripe } from "@/lib/billing/stripe";

// ─────────────────────────────────────────────────────────────────────────────
// Códigos de descuento por negociación (sustituyen al plan "Despacho" como
// mecanismo de precio a la medida): el admin de plataforma genera un código
// por cliente según lo negociado y el cliente lo escribe en la pantalla de
// pago de Stripe (el checkout ya envía allow_promotion_codes: true).
//
// En Stripe son DOS objetos: un Coupon (define el descuento: porcentaje o
// monto, y por cuánto tiempo aplica) y un Promotion Code (el texto canjeable,
// con tope de canjes y vencimiento). Aquí creamos ambos de un tiro, con el
// nombre del cliente en metadata para rastrear a qué negociación corresponde.
// Los montos fijos son MXN (la moneda de los Price); Stripe los pide en
// centavos.
// ─────────────────────────────────────────────────────────────────────────────

export interface NuevoCodigoInput {
  /** Texto del código (p.ej. DESPACHOGARCIA20). Si falta, Stripe genera uno. */
  codigo?: string;
  /** "porcentaje" (1–100) o "monto" (MXN fijos por cobro). */
  tipo: "porcentaje" | "monto";
  valor: number;
  /**
   * Vigencia del DESCUENTO sobre la suscripción una vez canjeado:
   *   "siempre"  → todos los cobros (precio negociado permanente)
   *   "una_vez"  → sólo el primer cobro
   *   "meses"    → los primeros N cobros mensuales (requiere `meses`)
   */
  duracion: "siempre" | "una_vez" | "meses";
  meses?: number;
  /** Cuántas cuentas pueden canjear el código (default 1: un código por cliente). */
  maxCanjes?: number;
  /** Días para canjearlo antes de que venza (default 30; 0 = sin vencimiento). */
  expiraDias?: number;
  /** Nombre del cliente / nota de la negociación (va a metadata en Stripe). */
  cliente?: string;
}

export interface CodigoParams {
  coupon: Stripe.CouponCreateParams;
  /** Parámetros del promotion code SIN la referencia al coupon (se inyecta al crear). */
  promo: Omit<Stripe.PromotionCodeCreateParams, "promotion">;
}

// Stripe sólo admite letras, dígitos y guiones en el texto del código.
const CODIGO_RE = /^[A-Z0-9-]{4,40}$/;

/**
 * Valida el input y lo traduce a parámetros de Stripe. Pura (el reloj entra
 * por parámetro) para poder probarla sin Stripe. Devuelve un mensaje de error
 * en español si el input no es válido.
 */
export function construirCodigoParams(
  input: NuevoCodigoInput,
  ahoraMs: number,
): { ok: true; params: CodigoParams } | { ok: false; error: string } {
  const cliente = input.cliente?.trim() ?? "";

  // ── Descuento ──
  if (input.tipo !== "porcentaje" && input.tipo !== "monto")
    return { ok: false, error: "Tipo de descuento inválido: usa porcentaje o monto." };
  if (typeof input.valor !== "number" || !isFinite(input.valor) || input.valor <= 0)
    return { ok: false, error: "El valor del descuento debe ser mayor a cero." };
  if (input.tipo === "porcentaje" && input.valor > 100)
    return { ok: false, error: "El porcentaje no puede exceder 100." };

  // ── Duración ──
  let duration: Stripe.CouponCreateParams.Duration;
  let durationInMonths: number | undefined;
  if (input.duracion === "siempre") duration = "forever";
  else if (input.duracion === "una_vez") duration = "once";
  else if (input.duracion === "meses") {
    const m = input.meses ?? 0;
    if (!Number.isInteger(m) || m < 1 || m > 36)
      return { ok: false, error: "Indica cuántos meses aplica el descuento (1 a 36)." };
    duration = "repeating";
    durationInMonths = m;
  } else return { ok: false, error: "Duración inválida: usa siempre, una_vez o meses." };

  // ── Código y canjes ──
  let code: string | undefined;
  if (input.codigo !== undefined && input.codigo.trim() !== "") {
    code = input.codigo.trim().toUpperCase();
    if (!CODIGO_RE.test(code))
      return { ok: false, error: "El código debe tener 4–40 caracteres: letras, números o guiones." };
  }
  const maxCanjes = input.maxCanjes ?? 1;
  if (!Number.isInteger(maxCanjes) || maxCanjes < 1 || maxCanjes > 1000)
    return { ok: false, error: "El máximo de canjes debe ser un entero entre 1 y 1000." };
  const expiraDias = input.expiraDias ?? 30;
  if (!Number.isInteger(expiraDias) || expiraDias < 0 || expiraDias > 365)
    return { ok: false, error: "El vencimiento debe ser de 0 (sin vencer) a 365 días." };

  // Nombre legible en el dashboard de Stripe: "Cliente — 20% siempre".
  const descuentoTxt =
    input.tipo === "porcentaje"
      ? `${input.valor}%`
      : `$${input.valor.toLocaleString("es-MX")} MXN`;
  const duracionTxt =
    duration === "forever" ? "siempre" : duration === "once" ? "1er cobro" : `${durationInMonths} meses`;
  const name = `${cliente || "Negociado"} — ${descuentoTxt} ${duracionTxt}`.slice(0, 40);

  const coupon: Stripe.CouponCreateParams = {
    name,
    duration,
    ...(durationInMonths !== undefined ? { duration_in_months: durationInMonths } : {}),
    ...(input.tipo === "porcentaje"
      ? { percent_off: input.valor }
      : { amount_off: Math.round(input.valor * 100), currency: "mxn" }),
    metadata: { cliente },
  };

  const promo: Omit<Stripe.PromotionCodeCreateParams, "promotion"> = {
    ...(code !== undefined ? { code } : {}),
    max_redemptions: maxCanjes,
    ...(expiraDias > 0
      ? { expires_at: Math.floor(ahoraMs / 1000) + expiraDias * 86400 }
      : {}),
    metadata: { cliente },
  };

  return { ok: true, params: { coupon, promo } };
}

// Forma que consume la UI (lista y resultado de creación).
export interface CodigoResumen {
  id: string;
  codigo: string;
  activo: boolean;
  cliente: string;
  descuento: string;
  duracion: string;
  canjes: number;
  maxCanjes: number | null;
  expiraEl: string | null; // ISO
  creadoEl: string; // ISO
}

function describeCoupon(c: Stripe.Coupon): { descuento: string; duracion: string } {
  const descuento =
    c.percent_off != null
      ? `${c.percent_off}%`
      : c.amount_off != null
        ? `$${(c.amount_off / 100).toLocaleString("es-MX")} ${(c.currency ?? "mxn").toUpperCase()}`
        : "—";
  const duracion =
    c.duration === "forever"
      ? "siempre"
      : c.duration === "once"
        ? "1er cobro"
        : `${c.duration_in_months ?? "?"} meses`;
  return { descuento, duracion };
}

export function resumenDePromotionCode(pc: Stripe.PromotionCode): CodigoResumen {
  // El coupon vive en pc.promotion.coupon y sólo es objeto si se pidió con
  // expand ("promotion.coupon"); como string (sin expand) no hay detalle.
  const raw = pc.promotion?.coupon;
  const coupon = raw && typeof raw !== "string" ? raw : null;
  const { descuento, duracion } = coupon ? describeCoupon(coupon) : { descuento: "—", duracion: "—" };
  return {
    id: pc.id,
    codigo: pc.code,
    activo: pc.active,
    cliente: (pc.metadata?.cliente || coupon?.metadata?.cliente || coupon?.name || "").toString(),
    descuento,
    duracion,
    canjes: pc.times_redeemed,
    maxCanjes: pc.max_redemptions ?? null,
    expiraEl: pc.expires_at ? new Date(pc.expires_at * 1000).toISOString() : null,
    creadoEl: new Date(pc.created * 1000).toISOString(),
  };
}

export type CrearCodigoResult =
  | { ok: true; codigo: CodigoResumen }
  | { ok: false; status: number; error: string };

/** Crea coupon + promotion code en Stripe según lo negociado. */
export async function crearCodigoDescuento(
  input: NuevoCodigoInput,
  creadoPor: string,
): Promise<CrearCodigoResult> {
  const stripe = getStripe();
  if (!stripe)
    return { ok: false, status: 503, error: "Stripe no está configurado (STRIPE_SECRET_KEY)." };

  const built = construirCodigoParams(input, Date.now());
  if (!built.ok) return { ok: false, status: 400, error: built.error };

  try {
    const coupon = await stripe.coupons.create({
      ...built.params.coupon,
      metadata: { ...built.params.coupon.metadata, creadoPor },
    });
    const promo = await stripe.promotionCodes.create({
      ...built.params.promo,
      promotion: { type: "coupon", coupon: coupon.id },
      metadata: { ...built.params.promo.metadata, creadoPor },
      expand: ["promotion.coupon"],
    });
    return { ok: true, codigo: resumenDePromotionCode(promo) };
  } catch (e) {
    // El caso común: el código ya existe en Stripe (deben ser únicos entre activos).
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[codigos-descuento] error creando código:", e);
    return {
      ok: false,
      status: 502,
      error: /already exists|existing/i.test(msg)
        ? "Ya existe un código activo con ese texto. Usa otro o desactiva el anterior."
        : "Stripe rechazó la creación del código. Revisa los datos e intenta de nuevo.",
    };
  }
}

/** Últimos códigos (activos e inactivos), más recientes primero. */
export async function listarCodigosDescuento(): Promise<
  { ok: true; codigos: CodigoResumen[] } | { ok: false; status: number; error: string }
> {
  const stripe = getStripe();
  if (!stripe)
    return { ok: false, status: 503, error: "Stripe no está configurado (STRIPE_SECRET_KEY)." };
  try {
    const page = await stripe.promotionCodes.list({
      limit: 50,
      expand: ["data.promotion.coupon"],
    });
    return { ok: true, codigos: page.data.map(resumenDePromotionCode) };
  } catch (e) {
    console.error("[codigos-descuento] error listando códigos:", e);
    return { ok: false, status: 502, error: "No se pudieron leer los códigos de Stripe." };
  }
}

/** Desactiva (o reactiva) un código. Desactivar NO afecta suscripciones ya canjeadas. */
export async function activarCodigoDescuento(
  id: string,
  activo: boolean,
): Promise<{ ok: true; codigo: CodigoResumen } | { ok: false; status: number; error: string }> {
  const stripe = getStripe();
  if (!stripe)
    return { ok: false, status: 503, error: "Stripe no está configurado (STRIPE_SECRET_KEY)." };
  try {
    const promo = await stripe.promotionCodes.update(id, {
      active: activo,
      expand: ["promotion.coupon"],
    });
    return { ok: true, codigo: resumenDePromotionCode(promo) };
  } catch (e) {
    console.error("[codigos-descuento] error actualizando código:", e);
    return { ok: false, status: 502, error: "No se pudo actualizar el código en Stripe." };
  }
}
