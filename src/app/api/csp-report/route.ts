import { NextResponse } from "next/server";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

// POST /api/csp-report — receptor de violaciones del CSP en Report-Only
// (ver src/lib/security-headers.ts). Los navegadores postean SIN sesión, así
// que la ruta es pública a propósito (allowlist de api-guardias). Sólo
// registra un resumen en logs: con el inventario real de violaciones se
// escribe la política de enforcement (con nonces) sin romper a ciegas.
//
// Defensa del endpoint público: rate limit por IP y tope de tamaño; el body
// jamás se persiste ni se reenvía a terceros.

export const dynamic = "force-dynamic";

const MAX_BYTES = 16 * 1024;

export async function POST(req: Request) {
  const ip = getClientIp(req) ?? "sin-ip";
  const rl = checkRateLimit(`csp-report:${ip}`, { limit: 30, windowMs: 10 * 60_000 });
  if (!rl.ok) return new NextResponse(null, { status: 204 });

  try {
    const texto = await req.text();
    if (texto.length > MAX_BYTES) return new NextResponse(null, { status: 204 });
    const body = JSON.parse(texto) as {
      "csp-report"?: Record<string, unknown>;
    };
    const r = body["csp-report"] ?? {};
    // Sólo campos de diagnóstico — nunca el body completo (puede traer URLs
    // con datos) ni hacia Sentry ni hacia la BD.
    console.warn(
      "[csp-report]",
      JSON.stringify({
        directiva: r["violated-directive"] ?? r["effective-directive"] ?? null,
        bloqueado: r["blocked-uri"] ?? null,
        documento: r["document-uri"] ?? null,
      })
    );
  } catch {
    // Reporte malformado: ignorar en silencio (endpoint público).
  }
  return new NextResponse(null, { status: 204 });
}
