// ─── Playtomic Integration ───────────────────────────────────────────────────
// Two-way court-booking sync with Playtomic for clubs running the PADEL module.
//
// Auth model: each club generates External API credentials in Playtomic Manager
// (Settings → Developer Tools) and stores them on its PadelClubConfig row
// (playtomicTenantId + playtomicApiKey, the key encrypted at rest via
// lib/crypto). A global PLAYTOMIC_BASE_URL env var selects the API host so we
// can point at sandbox vs production without code changes.
//
// Flow:
//   1. Club links its Playtomic tenant + API key in the satellite settings UI.
//   2. Cron /api/padel/cron/playtomic-sync pulls recent bookings → upserts
//      Reservation rows (matched to Court by playtomicResourceId), idempotent
//      on (companyId, playtomicBookingId).
//   3. Native (APP/STAFF) bookings are pushed out to Playtomic where the club's
//      API tier allows writes; otherwise they remain native-only and the push
//      is a no-op (see pushBooking).
//
// NOTE: Playtomic's third-party API surface varies by partner tier. The exact
// paths below are centralized as constants so they can be confirmed against the
// club's Manager API docs without touching call sites. Rate limit is ~1 req/min
// per the public docs — the cron batches a single window per club per run.
// ─────────────────────────────────────────────────────────────────────────────

import { decryptSecret } from "./crypto";

const DEFAULT_BASE_URL = "https://api.playtomic.io";

function getBaseUrl(): string {
  return (process.env.PLAYTOMIC_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
}

// Centralized endpoint paths — confirm against the club's Playtomic Manager API
// tier. Kept here so call sites never hardcode a path.
const ENDPOINTS = {
  bookings: "/v1/bookings",
};

export type PlaytomicCreds = {
  tenantId: string;
  apiKey: string; // already-decrypted
};

/** A booking as we consume it from Playtomic, normalized to our shape. */
export type PlaytomicBooking = {
  id: string; // Playtomic booking id → Reservation.playtomicBookingId
  resourceId: string; // Playtomic court/resource id → Court.playtomicResourceId
  start: string; // ISO 8601 start
  end: string; // ISO 8601 end
  price?: number;
  status?: string;
  playerName?: string;
  cancelled?: boolean;
};

/**
 * Resolves per-club Playtomic credentials from a PadelClubConfig row, decrypting
 * the API key. Returns null when the club hasn't enabled/configured Playtomic
 * (callers treat null as "skip, not configured").
 */
export function resolveCreds(config: {
  playtomicEnabled: boolean;
  playtomicTenantId: string | null;
  playtomicApiKey: string | null;
}): PlaytomicCreds | null {
  if (!config.playtomicEnabled) return null;
  if (!config.playtomicTenantId || !config.playtomicApiKey) return null;
  return {
    tenantId: config.playtomicTenantId,
    apiKey: decryptSecret(config.playtomicApiKey),
  };
}

async function playtomicFetch<T>(
  creds: PlaytomicCreds,
  path: string,
  options?: RequestInit
): Promise<T> {
  const url = `${getBaseUrl()}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${creds.apiKey}`,
      "X-Tenant-Id": creds.tenantId,
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Playtomic ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

/** Raw booking row shape returned by Playtomic (loosely typed; mapped below). */
type RawPlaytomicBooking = Record<string, unknown>;

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/** Maps a raw Playtomic booking to our normalized shape; null if unusable. */
export function mapBooking(raw: RawPlaytomicBooking): PlaytomicBooking | null {
  const id = str(raw.booking_id) ?? str(raw.id);
  const resourceId = str(raw.resource_id) ?? str(raw.court_id);
  const start = str(raw.start) ?? str(raw.start_date) ?? str(raw.started_at);
  const end = str(raw.end) ?? str(raw.end_date) ?? str(raw.ended_at);
  if (!id || !resourceId || !start || !end) return null;
  const status = str(raw.status);
  return {
    id,
    resourceId,
    start,
    end,
    price: num(raw.price) ?? num(raw.total_price),
    status,
    playerName: str(raw.player_name) ?? str(raw.owner_name),
    cancelled: status ? /cancel/i.test(status) : false,
  };
}

/**
 * Lists bookings in a [from, to] window for a club. Returns normalized,
 * usable bookings only.
 */
export async function listBookings(
  creds: PlaytomicCreds,
  from: Date,
  to: Date
): Promise<PlaytomicBooking[]> {
  const qs = new URLSearchParams({
    tenant_id: creds.tenantId,
    from: from.toISOString(),
    to: to.toISOString(),
  });
  const data = await playtomicFetch<RawPlaytomicBooking[] | { bookings?: RawPlaytomicBooking[] }>(
    creds,
    `${ENDPOINTS.bookings}?${qs.toString()}`
  );
  const rows = Array.isArray(data) ? data : data.bookings ?? [];
  return rows.map(mapBooking).filter((b): b is PlaytomicBooking => b !== null);
}

/**
 * Pushes a native booking out to Playtomic. Best-effort: returns the external
 * booking id on success, or null when the club's API tier doesn't permit
 * writes (caller leaves the reservation native-only). Never throws on a 403/405
 * write-not-allowed — only on unexpected errors.
 */
export async function pushBooking(
  creds: PlaytomicCreds,
  booking: { resourceId: string; start: Date; end: Date; price?: number }
): Promise<string | null> {
  try {
    const res = await playtomicFetch<{ booking_id?: string; id?: string }>(
      creds,
      ENDPOINTS.bookings,
      {
        method: "POST",
        body: JSON.stringify({
          tenant_id: creds.tenantId,
          resource_id: booking.resourceId,
          start: booking.start.toISOString(),
          end: booking.end.toISOString(),
          price: booking.price,
        }),
      }
    );
    return res.booking_id ?? res.id ?? null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Write not permitted on this tier → degrade gracefully to native-only.
    if (/\b40[35]\b/.test(msg)) return null;
    throw e;
  }
}
