import { NextResponse } from "next/server";
import { requireMembership, requireWriter, withAuthz } from "@/lib/authz";
import { esTipoSolicitud } from "@/lib/solicitudes/claves";
import { abrirSolicitud, solicitudesAbiertas, solicitudesDeEntidad } from "@/lib/solicitudes/registro";

// ─────────────────────────────────────────────────────────────────────────────
// GET  /api/solicitudes?companyId=[&entidadId=]  → lo que se está esperando
// POST /api/solicitudes                           → pedir algo a mano
//
// `entidadId` es la consulta de la mesa: al seleccionar un movimiento, qué se
// está esperando POR ÉL. Es lo que convierte «no se puede conciliar esto» en
// «falta el estado de cuenta de la terminal de julio, y ya se pidió».
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";

export const GET = withAuthz(async (req: Request) => {
  const sp = new URL(req.url).searchParams;
  const companyId = sp.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId es requerido" }, { status: 400 });
  await requireMembership(companyId, undefined, req);

  const entidadId = sp.get("entidadId");
  const solicitudes = entidadId
    ? await solicitudesDeEntidad(companyId, entidadId)
    : await solicitudesAbiertas(companyId);
  return NextResponse.json({ solicitudes });
});

export const POST = withAuthz(async (req: Request) => {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const companyId = typeof body?.companyId === "string" ? body.companyId : null;
  if (!companyId) return NextResponse.json({ error: "companyId es requerido" }, { status: 400 });
  await requireWriter(companyId, req);

  if (!esTipoSolicitud(body?.tipo)) return NextResponse.json({ error: "tipo inválido" }, { status: 400 });
  const refs = Array.isArray(body?.refs)
    ? (body.refs as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  const periodo = typeof body?.periodo === "string" ? body.periodo : null;
  const detalle = typeof body?.detalle === "string" ? body.detalle : null;

  // Un pedido hecho a mano necesita su propia llave para que el motor no lo
  // duplique después: se arma con lo que lo identifica, no con la hora.
  const dedupeKey =
    typeof body?.dedupeKey === "string" && body.dedupeKey
      ? body.dedupeKey
      : `manual:${body.tipo}:${periodo ?? "sin-periodo"}:${refs[0] ?? "sin-ref"}`;

  const r = await abrirSolicitud({
    companyId,
    tipo: body.tipo,
    dedupeKey,
    refs,
    periodo,
    detalle,
    origen: "usuario",
  });
  return NextResponse.json(r);
});
