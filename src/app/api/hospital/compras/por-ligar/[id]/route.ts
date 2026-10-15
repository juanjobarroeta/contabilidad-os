import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora } from "@/lib/hospital/http";
import { cambiarEstadoLinea, LigadoError, ligarLineaManual } from "@/lib/hospital/cfdi-ligado";
import { puedeLigarCfdi } from "@/lib/hospital/ligado-permisos";

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/hospital/compras/por-ligar/[id]
//   { companyId, accion: "ligar", insumoId }  → liga el renglón y APRENDE la
//       clave del proveedor; los demás pendientes con la misma clave se ligan
//       solos (`propagadas`).
//   { companyId, accion: "ignorar" }          → no es inventario (no vuelve a la cola).
//   { companyId, accion: "reabrir" }          → regresa a la cola.
// Escritor + dueño/admin o permiso COMPRAS_AUTORIZAR / FINANZAS_ESCRIBIR.
// No mueve inventario: la existencia la pone la recepción.
// ─────────────────────────────────────────────────────────────────────────────

type Ctx = { params: Promise<{ id: string }> };

const schema = z.discriminatedUnion("accion", [
  z.object({ companyId: z.string().min(1), accion: z.literal("ligar"), insumoId: z.string().min(1) }),
  z.object({ companyId: z.string().min(1), accion: z.literal("ignorar") }),
  z.object({ companyId: z.string().min(1), accion: z.literal("reabrir") }),
]);

export const PATCH = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Datos inválidos" }, { status: 400 });
  const body = parsed.data;
  const { user, membership } = await requireWriter(body.companyId, req);
  await requireModule(body.companyId, "HOSPITAL", req);
  if (!(await puedeLigarCfdi(body.companyId, user.id, membership.role))) {
    throw new AuthzError(403, "Ligar facturas al catálogo es de compras o finanzas. Pide a un administrador el permiso en Usuarios.");
  }

  try {
    const r =
      body.accion === "ligar"
        ? await prisma.$transaction((tx) => ligarLineaManual(tx, { companyId: body.companyId, lineaId: id, insumoId: body.insumoId, userId: user.id }))
        : await cambiarEstadoLinea(prisma, { companyId: body.companyId, lineaId: id, estado: body.accion === "ignorar" ? "IGNORADA" : "POR_LIGAR", userId: user.id });
    bitacora(user, req, { companyId: body.companyId, accion: `hospital.cfdi-linea.${body.accion}`, entidad: "HospCfdiLinea", entidadId: id, detalle: r });
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    if (e instanceof LigadoError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
});
