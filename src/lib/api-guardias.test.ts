/**
 * P0-2a — Guardia estática sobre TODA la superficie de la API.
 *
 * El multi-tenant de este repo es 100% aplicación (sin RLS): cada ruta filtra
 * por companyId a mano. Este test convierte "ojalá nadie olvide el guard" en
 * una invariante que CI verifica en cada PR:
 *
 *   Rule 1 — toda route.ts bajo src/app/api referencia al menos un
 *            AUTENTICADOR conocido, o está en RUTAS_PUBLICAS con razón.
 *   Rule 2 — toda route.ts que menciona companyId referencia al menos un
 *            ESCOPADOR de tenant (autenticación que sabe DE QUÉ empresa es
 *            la petición), o está en RUTAS_CON_AUTH_PROPIA con razón.
 *   Rule 3 — las allowlists no acumulan entradas rancias: archivo borrado o
 *            que ya adoptó una guardia = la entrada sobra y el test falla.
 *
 * Detección por contenido (regex sobre el fuente), no por ejecución: es un
 * PISO estructural — "toda ruta tiene guardia" — no prueba que la guardia
 * esté bien puesta (eso es la capa b/c de P0-2, tests contra Postgres real).
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { RUTAS_PUBLICAS, RUTAS_CON_AUTH_PROPIA } from "./api-guardias.allowlist";

const APP_DIR = path.join(process.cwd(), "src", "app");
const API_DIR = path.join(APP_DIR, "api");

/** Autenticación de cualquier tipo: sesión, bearer, secreto, firma, token. */
const AUTENTICADORES: RegExp[] = [
  // Membresía / tenant (src/lib/authz.ts)
  /\brequireMembership\b/,
  /\brequireWriter\b/,
  /\brequireOwner\b/,
  /\brequireModule\b/,
  /\bgetEffectiveCompanyMembership\b/,
  /\bempresasAccesiblesIds\b/,
  /\bisOperador\b/,
  // Capa despacho (src/lib/despacho.ts, src/lib/invitations-server.ts)
  /\brequireDespachoRole\b/,
  /\brequireOwnDespacho\b/,
  /\brequireDespachoAdminForCompany\b/,
  // Sesión web / bearer de satélite
  /\brequireUser\b/,
  /\bauth\(\)/,
  // Portales y club (token con companyId embebido)
  /\brequireClubMember\b/,
  /\brequireClubModule\b/,
  /\bverifyClubMemberToken\b/,
  /\brequirePortalAccount\b/,
  /\brequireAutoPortalAccount\b/,
  /\bverifyPurifPortalToken\b/,
  /\bverifyAutoPortalToken\b/,
  // Tokens firmados de recurso único
  /\bverifyFileToken\b/,
  /\bverifyDraftToken\b/,
  // Webhooks con firma verificada
  /\bverifyTwilioSignature/,
  /\bconstructEventAsync\b/,
  // Secretos de máquina
  /\bCRON_SECRET\b/,
  /\bMCP_OPERADOR_KEYS\b/,
  /\bPLATFORM_ADMIN_EMAILS\b/,
];

/**
 * Subconjunto que además ESCOPA el tenant: la identidad autenticada trae o
 * valida la empresa. `requireUser`/`auth()` a secas autentican al usuario
 * pero NO amarran companyId — una ruta de datos de empresa con solo eso es
 * exactamente el bug que buscamos.
 */
const ESCOPADORES: RegExp[] = [
  /\brequireMembership\b/,
  /\brequireWriter\b/,
  /\brequireOwner\b/,
  /\brequireModule\b/,
  /\bgetEffectiveCompanyMembership\b/,
  /\bempresasAccesiblesIds\b/,
  /\bisOperador\b/,
  /\brequireDespachoRole\b/,
  /\brequireOwnDespacho\b/,
  /\brequireDespachoAdminForCompany\b/,
  /\brequireClubMember\b/,
  /\brequireClubModule\b/,
  /\bverifyClubMemberToken\b/,
  /\brequirePortalAccount\b/,
  /\brequireAutoPortalAccount\b/,
  /\bverifyPurifPortalToken\b/,
  /\bverifyAutoPortalToken\b/,
  /\bverifyFileToken\b/,
  /\bverifyDraftToken\b/,
  /\bverifyTwilioSignature/,
  /\bconstructEventAsync\b/,
  /\bCRON_SECRET\b/,
  /\bMCP_OPERADOR_KEYS\b/,
  /\bPLATFORM_ADMIN_EMAILS\b/,
];

function listarRutas(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listarRutas(full));
    else if (entry.name === "route.ts") out.push(full);
  }
  return out;
}

/** Ruta relativa estilo "api/facturas/[id]/route.ts" (separador posix). */
function rel(abs: string): string {
  return path.relative(APP_DIR, abs).split(path.sep).join("/");
}

const archivos = listarRutas(API_DIR).map((abs) => ({
  ruta: rel(abs),
  contenido: fs.readFileSync(abs, "utf8"),
}));

const publicas = new Set(RUTAS_PUBLICAS.map((e) => e.ruta));
const authPropia = new Set(RUTAS_CON_AUTH_PROPIA.map((e) => e.ruta));

const tieneAutenticador = (c: string) => AUTENTICADORES.some((r) => r.test(c));
const tieneEscopador = (c: string) => ESCOPADORES.some((r) => r.test(c));
const mencionaCompany = (c: string) => /\bcompanyId\b/.test(c);

describe("guardias de la superficie API (P0-2a)", () => {
  it("encuentra una superficie del tamaño esperado (el walker no está roto)", () => {
    // Si un refactor mueve src/app/api, este test debe romper en vez de
    // pasar en verde sobre una lista vacía.
    expect(archivos.length).toBeGreaterThan(400);
  });

  it("Rule 1 — toda ruta tiene un autenticador conocido o es pública declarada", () => {
    const sinAuth = archivos
      .filter((a) => !tieneAutenticador(a.contenido) && !publicas.has(a.ruta))
      .map((a) => a.ruta);
    expect(
      sinAuth,
      `Rutas SIN autenticador reconocido y fuera de RUTAS_PUBLICAS.\n` +
        `O le falta guardia (bug), o usa un mecanismo nuevo (agrégalo a ` +
        `AUTENTICADORES), o es pública a propósito (allowlist CON razón):\n  ` +
        sinAuth.join("\n  ")
    ).toEqual([]);
  });

  it("Rule 2 — toda ruta que toca companyId escopa el tenant", () => {
    const sinScope = archivos
      .filter(
        (a) =>
          mencionaCompany(a.contenido) &&
          !tieneEscopador(a.contenido) &&
          !authPropia.has(a.ruta) &&
          // Una ruta declarada pública ya pasó revisión consciente en Rule 1;
          // su manejo de companyId (p. ej. alta de empresa en signup) es parte
          // de esa decisión.
          !publicas.has(a.ruta)
      )
      .map((a) => a.ruta);
    expect(
      sinScope,
      `Rutas que MENCIONAN companyId sin mecanismo de scoping de tenant.\n` +
        `requireUser/auth() a secas NO basta para datos de empresa. O se le ` +
        `agrega requireMembership/... (lo normal), o se documenta en ` +
        `RUTAS_CON_AUTH_PROPIA con la razón:\n  ` +
        sinScope.join("\n  ")
    ).toEqual([]);
  });

  it("Rule 3 — las allowlists no tienen entradas rancias", () => {
    const porRuta = new Map(archivos.map((a) => [a.ruta, a.contenido]));
    const rancias: string[] = [];
    for (const e of RUTAS_PUBLICAS) {
      const c = porRuta.get(e.ruta);
      if (c === undefined) rancias.push(`${e.ruta} (ya no existe)`);
      else if (tieneAutenticador(c)) rancias.push(`${e.ruta} (ya tiene autenticador — podar de RUTAS_PUBLICAS)`);
    }
    for (const e of RUTAS_CON_AUTH_PROPIA) {
      const c = porRuta.get(e.ruta);
      if (c === undefined) rancias.push(`${e.ruta} (ya no existe)`);
      else if (!mencionaCompany(c)) rancias.push(`${e.ruta} (ya no menciona companyId — podar)`);
      else if (tieneEscopador(c)) rancias.push(`${e.ruta} (ya tiene escopador — podar de RUTAS_CON_AUTH_PROPIA)`);
    }
    expect(rancias, `Entradas rancias en la allowlist:\n  ${rancias.join("\n  ")}`).toEqual([]);
  });

  it("las razones de la allowlist no están vacías", () => {
    const sinRazon = [...RUTAS_PUBLICAS, ...RUTAS_CON_AUTH_PROPIA]
      .filter((e) => !e.razon || e.razon.trim().length < 10)
      .map((e) => e.ruta);
    expect(sinRazon).toEqual([]);
  });
});
