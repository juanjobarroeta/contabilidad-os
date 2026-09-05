import { NextResponse } from "next/server";
import { withAuthz } from "@/lib/authz";
import { requireCierreGuiado } from "@/lib/cierre/gate";
import { confirmarPaso, omitirPaso, reabrirPaso } from "@/lib/cierre/evaluar";
import { esClavePaso } from "@/lib/cierre/workflow";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/cierre/paso
//   { companyId, year, month, clave, accion: "confirmar"|"omitir"|"reabrir",
//     hashEsperado?, nota? }
//
// LA decisión humana sobre un paso del cierre. Es la única vía por la que un
// paso se cierra: el copiloto sólo la propone (fase 2, pending-action) y el
// humano toca. Rechaza VIEWER (como /api/ai/confirm) y devuelve 409 cuando la
// evidencia cambió desde que el humano la vio.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";

const ACCIONES = ["confirmar", "omitir", "reabrir"] as const;
type Accion = (typeof ACCIONES)[number];

export const POST = withAuthz(async (req: Request) => {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const companyId = typeof body?.companyId === "string" ? body.companyId : "";
  const year = Number(body?.year);
  const month = Number(body?.month);
  const clave = body?.clave;
  const accion = body?.accion as Accion;
  if (
    !companyId ||
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    month < 1 ||
    month > 12 ||
    !esClavePaso(clave) ||
    !ACCIONES.includes(accion)
  ) {
    return NextResponse.json({ error: "companyId, year, month, clave y accion son requeridos" }, { status: 400 });
  }
  const { user } = await requireCierreGuiado(companyId, ["OWNER", "ADMIN", "ACCOUNTANT"], req);

  const args = {
    companyId,
    year,
    month,
    clave,
    userId: user.id,
    hashEsperado: typeof body?.hashEsperado === "string" ? body.hashEsperado : null,
    nota: typeof body?.nota === "string" ? body.nota.slice(0, 2000) : null,
    req,
  };
  const r =
    accion === "confirmar" ? await confirmarPaso(args) : accion === "omitir" ? await omitirPaso(args) : await reabrirPaso(args);

  if (!r.ok) {
    const status = r.motivo === "hash_cambio" ? 409 : r.motivo === "no_existe" ? 404 : 400;
    return NextResponse.json({ error: r.error, motivo: r.motivo, cierre: r.cierre ?? null }, { status });
  }
  return NextResponse.json({ ok: true, cierre: r.cierre });
});
