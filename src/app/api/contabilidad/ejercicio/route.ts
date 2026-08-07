import { NextResponse } from "next/server";
import { AuthzError, requireMembership, requireWriter } from "@/lib/authz";
import {
  EjercicioError,
  cerrarEjercicio,
  estadoEjercicio,
  reabrirEjercicio,
} from "@/lib/contabilidad/candado";

// Candado de ejercicio (Fase 3.2).
//
// GET  /api/contabilidad/ejercicio?companyId=&year=   → estado + por qué se puede
//      o no cerrar (el UI no duplica las reglas, las consulta).
// POST /api/contabilidad/ejercicio  { companyId, year, accion: "cerrar"|"reabrir" }
//
// Cerrar marca CLOSED los 13 periodos del año: a partir de ahí ninguna ruta de
// escritura (postMonth, cierre, apertura, pólizas manuales, conciliación,
// módulos satélite) puede tocar ese ejercicio. Reabrir es reversible y queda
// registrado en bitácora.

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const companyId = url.searchParams.get("companyId");
    const year = parseInt(url.searchParams.get("year") ?? "");
    if (!companyId || !Number.isInteger(year)) {
      return NextResponse.json({ error: "companyId y year requeridos" }, { status: 400 });
    }
    await requireMembership(companyId);
    return NextResponse.json(await estadoEjercicio(companyId, year));
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const companyId = body?.companyId as string | undefined;
    const year = parseInt(String(body?.year ?? ""));
    const accion = body?.accion === "reabrir" ? "reabrir" : body?.accion === "cerrar" ? "cerrar" : null;
    if (!companyId || !Number.isInteger(year) || !accion) {
      return NextResponse.json(
        { error: "companyId, year y accion (cerrar|reabrir) requeridos" },
        { status: 400 }
      );
    }

    const { user } = await requireWriter(companyId, req);
    const userId = user.id;

    if (accion === "cerrar") {
      const r = await cerrarEjercicio(companyId, year, { userId, req });
      return NextResponse.json({ ok: true, accion, year, ...r });
    }
    const motivo = typeof body?.motivo === "string" ? body.motivo.trim() || undefined : undefined;
    const r = await reabrirEjercicio(companyId, year, { motivo, userId, req });
    return NextResponse.json({ ok: true, accion, year, ...r });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    if (e instanceof EjercicioError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
