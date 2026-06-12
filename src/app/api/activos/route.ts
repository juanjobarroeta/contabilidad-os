import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { tipoActivoDesdeSubtipo, TASA_DEPRECIACION, type TipoActivo } from "@/lib/fiscal/depreciacion";
import { INPC_VERIFICADO } from "@/lib/fiscal/inpc";
import { calcularDepreciacionRegistro } from "@/lib/fiscal/activos-registro";
import { clasificarCfdi } from "@/lib/fiscal/clasificar-cfdi";

const TIPOS = Object.keys(TASA_DEPRECIACION) as TipoActivo[];

// GET /api/activos?companyId=x&ejercicio=2026
// Registro de activo fijo + la depreciación calculada de cada uno para el
// ejercicio (con su acumulada de ejercicios previos para topar al MOI).
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  const ejercicio = parseInt(searchParams.get("ejercicio") ?? String(new Date().getFullYear()));
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  const { activos, totalDepreciacionEjercicio } = await calcularDepreciacionRegistro(companyId, ejercicio);

  return NextResponse.json({
    ejercicio,
    activos,
    totalDepreciacionEjercicio,
    // El INPC aún no está cotejado contra la fuente oficial (ver inpc.ts).
    inpcVerificado: INPC_VERIFICADO,
  });
}

// POST /api/activos — alta de un activo (desde un CFDI INVERSION o manual).
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  if (!body?.companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  const member = await getEffectiveCompanyMembership(session.user.id, body.companyId);
  if (!member || member.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }

  // Desde un CFDI: hereda MOI (subtotal), fecha y sugiere tipo/tope desde el
  // clasificador (usoCfdi + claves de producto).
  let defaults: {
    descripcion: string; tipo: TipoActivo; moi: number;
    fechaAdquisicion: Date; esAutomovil: boolean;
  } | null = null;
  if (body.invoiceId) {
    const inv = await prisma.invoice.findFirst({
      where: { id: body.invoiceId, companyId: body.companyId },
      include: { items: { select: { claveProdServ: true, importe: true, descripcion: true } } },
    });
    if (!inv) return NextResponse.json({ error: "CFDI no encontrado" }, { status: 404 });
    const clasif = clasificarCfdi({
      tipo: inv.tipo,
      usoCfdi: inv.usoCfdi ?? null,
      items: inv.items.map((it) => ({ claveProdServ: it.claveProdServ, importe: it.importe })),
    });
    defaults = {
      descripcion: inv.items[0]?.descripcion ?? `CFDI ${inv.serie ?? ""}${inv.folio ?? ""}`.trim(),
      tipo: tipoActivoDesdeSubtipo(clasif.subtipoInversion),
      moi: inv.subtotal,
      fechaAdquisicion: inv.fecha,
      esAutomovil: clasif.posibleTopeAutomovil === true,
    };
  }

  const tipo = (TIPOS.includes(body.tipo) ? body.tipo : defaults?.tipo ?? "otro") as TipoActivo;
  const moi = typeof body.moi === "number" ? body.moi : defaults?.moi;
  const fechaAdquisicion = body.fechaAdquisicion ? new Date(body.fechaAdquisicion) : defaults?.fechaAdquisicion;
  const descripcion = (body.descripcion ?? defaults?.descripcion ?? "").trim();
  if (!moi || moi <= 0 || !fechaAdquisicion || isNaN(fechaAdquisicion.getTime()) || !descripcion) {
    return NextResponse.json({ error: "Faltan datos: descripción, MOI y fecha de adquisición" }, { status: 400 });
  }

  const activo = await prisma.activoFijo.create({
    data: {
      companyId: body.companyId,
      invoiceId: body.invoiceId ?? null,
      descripcion,
      tipo,
      moi,
      fechaAdquisicion,
      tasaAnual: TASA_DEPRECIACION[tipo].tasa,
      esAutomovil: body.esAutomovil ?? defaults?.esAutomovil ?? false,
      esElectricoHibrido: body.esElectricoHibrido ?? false,
    },
  });
  return NextResponse.json(activo, { status: 201 });
}
