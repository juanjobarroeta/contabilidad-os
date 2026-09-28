import { NextRequest, NextResponse } from "next/server";

// Same temporary redirects formerly in next.config.ts. Keep the explicit
// middleware matcher in sync; never redirect nested acuse or workpaper routes.
const destinations: Record<string, string> = {
  "/declaracion": "/impuestos?tab=del-mes",
  "/declaraciones": "/impuestos?tab=historial",
  "/declaracion-anual": "/impuestos?tab=anual",
  "/impuestos/detalle": "/impuestos?tab=del-mes",
  "/impuestos/cierre": "/impuestos?tab=del-mes",
  "/bancos/detalle": "/bancos",
  "/activos": "/contabilidad?tab=activo-fijo",
  "/nomina/detalle": "/nomina?tab=corridas",
};

export function legacyWorkspaceRedirect(req: NextRequest): NextResponse | null {
  const destination = destinations[req.nextUrl.pathname];
  if (typeof destination !== "string") return null;
  const url = req.nextUrl.clone();
  const target = new URL(destination, url.origin);
  url.pathname = target.pathname;
  // Retain the requested month/year and other deep-link context; the canonical
  // destination's tab wins over a conflicting incoming tab, as in Next config.
  for (const [key, value] of target.searchParams) url.searchParams.set(key, value);
  return NextResponse.redirect(url, 307);
}
