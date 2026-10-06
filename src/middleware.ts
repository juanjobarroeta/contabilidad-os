/**
 * Narrow API CORS plus the explicit legacy workspace redirects.
 *
 * Scoped narrowly: only the endpoints those clients actually need. The rest
 * of the app — NextAuth callbacks and any route not listed in the matcher —
 * is unaffected and stays same-origin only. UI redirects never receive CORS.
 *
 * Allowed origins come from the `API_ALLOWED_ORIGINS` env var, comma-
 * separated (e.g. `https://construccion-admin.vercel.app,http://localhost:5173`).
 * If the env var is unset we allow nothing cross-origin, which is a safer
 * default than `*` for a multi-tenant SaaS.
 *
 * The routes gated here use bearer-token auth (see src/lib/authz.ts), so we
 * do NOT set `Access-Control-Allow-Credentials: true` — cookies are not
 * needed, and omitting credentials keeps the surface area smaller.
 */

import { NextRequest, NextResponse } from "next/server";
import { legacyWorkspaceRedirect } from "@/lib/security/legacy-redirects";

const ALLOWED = (process.env.API_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Previews de Vercel de Bartiz (una URL por rama: bartiz-git-<rama>-<equipo>
// y bartiz-<hash>-<equipo>). Sin esto cada preview falla el login con
// «Load failed». Patrón anclado al proyecto Y al equipo: un tercero no puede
// crear un subdominio bajo ese scope. Las rutas usan bearer token y no se
// envían credenciales, así que el riesgo es el mismo que el de producción.
const PREVIEW_ORIGIN = /^https:\/\/bartiz-[a-z0-9-]+-juans-projects-92ecaef1\.vercel\.app$/;

function isAllowed(origin: string | null): boolean {
  if (!origin) return false;
  return ALLOWED.includes(origin) || PREVIEW_ORIGIN.test(origin);
}

function withCors(res: NextResponse, origin: string | null): NextResponse {
  if (isAllowed(origin)) {
    res.headers.set("Access-Control-Allow-Origin", origin!);
    res.headers.set("Vary", "Origin");
    res.headers.set(
      "Access-Control-Allow-Methods",
      "GET,POST,PUT,PATCH,DELETE,OPTIONS"
    );
    // `sentry-trace` y `baggage` son los headers con los que el navegador del
    // satélite (Automotriz) pasa el ID de traza al hub. Sin permitirlos aquí,
    // el preflight los rechaza y el SDK los descarta EN SILENCIO: los errores
    // siguen llegando a Sentry, pero desconectados —el click en el satélite y
    // la excepción del hub quedan como dos incidentes sin relación—. Es
    // exactamente la correlación entre proyectos que queremos, así que van.
    res.headers.set(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type, sentry-trace, baggage"
    );
    // Permite que el satélite LEA el header de traza de la respuesta.
    res.headers.set("Access-Control-Expose-Headers", "sentry-trace, baggage");
    res.headers.set("Access-Control-Max-Age", "86400");
  }
  return res;
}

export function middleware(req: NextRequest) {
  // Unlike Next 15's next.config redirects, middleware redirects retain the
  // headers() baseline. Keep the existing 307 destinations and period params.
  const redirect = legacyWorkspaceRedirect(req);
  if (redirect) return redirect;

  const origin = req.headers.get("origin");

  // Preflight: respond 204 with CORS headers, never hit the route handler.
  if (req.method === "OPTIONS") {
    if (!isAllowed(origin)) {
      return new NextResponse(null, { status: 403 });
    }
    return withCors(new NextResponse(null, { status: 204 }), origin);
  }

  // Non-preflight: let the route run, then decorate the response with
  // CORS headers so the browser can read it.
  const res = NextResponse.next();
  return withCors(res, origin);
}

/**
 * Only the eight exact legacy UI paths and existing satellite API surface.
 * Other UI pages and NextAuth callbacks stay outside middleware.
 */
export const config = {
  matcher: [
    "/declaracion",
    "/declaraciones",
    "/declaracion-anual",
    "/impuestos/detalle",
    "/impuestos/cierre",
    "/bancos/detalle",
    "/activos",
    "/nomina/detalle",
    // :path* para cubrir también /api/auth/token/refresh — ver AUTOMOTRIZ-4 en
    // Sentry: sin la subruta, el preflight de la renovación de sesión no lleva
    // Access-Control-Allow-Origin y Safari tira el fetch con «Load failed» sin
    // status, el mismo modo de falla que AUTOMOTRIZ-2 más abajo.
    "/api/auth/token",
    "/api/auth/token/:path*",
    // El satélite refresca su lista de empresas (rol y páginas) sin volver a
    // iniciar sesión: GET con bearer, cross-origin, igual que la renovación.
    "/api/auth/sesion",
    // El abogado cambia su contraseña desde el satélite jurídico (la primera se
    // la damos nosotros al darlo de alta). Sin este renglón el preflight no
    // lleva Access-Control-Allow-Origin y Safari tira el fetch sin status.
    "/api/auth/change-password",
    // Onboarding desde satélites (wizard Automotriz): alta de cuenta, parseo
    // de la CSF y checkout de Stripe se llaman cross-origin con bearer token.
    "/api/auth/signup",
    "/api/onboarding/:path*",
    "/api/billing/checkout",
    "/api/billing/portal",
    // PurificadoraOS muestra y contrata la suscripción desde su propia app.
    "/api/billing/suscripcion",
    "/api/companies/:path*",
    // La CE presentada (balanzas declaradas al SAT). El satélite Automotriz la
    // lee desde su pestaña Contabilidad — ver AUTOMOTRIZ-2 en Sentry: sin este
    // renglón el preflight no lleva Access-Control-Allow-Origin, Safari tira la
    // respuesta y el fetch truena con «Load failed» sin status. La ruta ya
    // resuelve bearer + requireMembership como el resto de superficies de
    // satélite, así que lo único que faltaba era dejar correr el CORS.
    "/api/contabilidad/:path*",
    "/api/construccion/:path*",
    "/api/padel/:path*",
    "/api/purificadora/:path*",
    "/api/restaurante/:path*",
    "/api/automotriz/:path*",
    // Hospital (satélite): expediente, cuenta del paciente, censo, agenda,
    // farmacia y el directorio derivado de CFDIs. Ver docs/HOSPITAL.md.
    "/api/hospital/:path*",
    // Salamería (satélite): el ERP del importador Y la tienda pública. Las
    // rutas /api/salameria/tienda/* las llama el NAVEGADOR de un comprador
    // cualquiera desde el dominio de la tienda, así que ese origen también
    // tiene que estar en API_ALLOWED_ORIGINS. Ver docs/SALAMERIA.md.
    "/api/salameria/:path*",
    // PurificadoraOS (satélite) administra clientes y concilia contra el
    // estado de cuenta desde su propio origen, así que las superficies
    // canónicas de clientes y bancos también necesitan CORS.
    "/api/clientes",
    "/api/clientes/:path*",
    "/api/bancos/:path*",
    // RestauranteOS stamps CFDIs for charged orders directly against the
    // hub's bearer-aware invoicing endpoint (POST /api/facturas), so the
    // facturas surface needs CORS for allowlisted satellite origins too.
    "/api/facturas",
    "/api/facturas/:path*",
    // AutomotrizPro surfacea la nómina desde su propio origen — ver
    // AUTOMOTRIZ-6 y AUTOMOTRIZ-7 en Sentry: `/api/nomina/empleado` y
    // `/api/nomina/run` truenan «sin respuesta», o sea sin status, que es la
    // firma de un fetch que el navegador tiró por falta de
    // Access-Control-Allow-Origin — el MISMO modo de falla que AUTOMOTRIZ-2 y
    // AUTOMOTRIZ-4 documentados arriba.
    //
    // Las rutas ya resuelven bearer + requireMembership como el resto de las
    // superficies de satélite, así que lo único que faltaba era dejar correr
    // el CORS. La nómina es además la base del costo de mano de obra que ya
    // usa la absorción de servicio, así que el satélite tiene por qué leerla.
    "/api/nomina/:path*",
    // Papeles de trabajo (IVA, ISR, retenciones): el detalle POR CFDI que
    // sostiene cada cifra declarada. AutomotrizPro los lee desde su pestaña
    // de Impuestos — sin esto la pantalla sólo puede enseñar totales, y un
    // total sin los comprobantes que lo forman no se defiende ante nadie.
    "/api/papeles/:path*",
    // Copiloto jurídico (satélite, docs/MOTOR-JURIDICO.md §6): chat en
    // streaming y conversaciones, con bearer del hub.
    "/api/juridico/:path*",
  ],
};
