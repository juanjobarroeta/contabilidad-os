import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireUser } from "@/lib/authz";
import { consultarReporte, construirXlsx, construirZip, filtrosSchema, resumir } from "@/lib/facturas/reporte-facturas";
import { puedeVerFacturas, verificarDescarga, type FormatoReporte } from "@/lib/facturas/reporte-servicio";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/facturas/reporte/[id]?formato=xlsx|zip[&token=…]
//
// El reporte que pidió alguien a Mochi. Los archivos se arman AHORA con los
// filtros guardados (no una foto vieja). Con `token` (enlace firmado que
// entrega HospitalOS, 24 h) no hace falta sesión; sin él, sesión o Bearer y
// permiso de ver facturas en esa empresa.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const limpio = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w.-]+/g, "_").slice(0, 90);

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const sp = new URL(req.url).searchParams;
  const formato = sp.get("formato") === "zip" ? "zip" : ("xlsx" as FormatoReporte);
  const reporte = await prisma.reporteFacturas.findUnique({ where: { id } });
  if (!reporte) return NextResponse.json({ error: "Reporte no encontrado" }, { status: 404 });

  const token = sp.get("token");
  let userId: string | null = null;
  if (token) {
    if (!verificarDescarga(id, formato, token)) return NextResponse.json({ error: "El enlace caducó; pide el reporte otra vez." }, { status: 403 });
    userId = reporte.userId;
  } else {
    try {
      userId = (await requireUser(req)).id;
    } catch (e) {
      if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
      throw e;
    }
  }
  // Aun con enlace firmado, quien lo pidió debe seguir pudiendo ver facturas.
  if (!userId) return NextResponse.json({ error: "Sin sesión" }, { status: 401 });
  const acceso = await puedeVerFacturas(prisma, userId, reporte.companyId);
  if (!acceso.ok) return NextResponse.json({ error: acceso.motivo }, { status: 403 });

  const filtros = filtrosSchema.parse(reporte.filtros);
  const { rows } = await consultarReporte(prisma, reporte.companyId, filtros, reporte.customerIds.length ? reporte.customerIds : null);
  await prisma.auditLog.create({
    data: { companyId: reporte.companyId, userId, accion: "facturas.reporte.descarga", entidad: "ReporteFacturas", entidadId: id, detalle: { formato, facturas: rows.length, firmado: !!token } },
  });
  const nombre = limpio(reporte.titulo);
  if (formato === "xlsx") {
    const buf = construirXlsx(rows, resumir(rows), reporte.titulo);
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${nombre}.xlsx"`,
        "Cache-Control": "private, no-store",
      },
    });
  }
  try {
    const { buffer } = await construirZip(prisma, reporte.companyId, rows);
    return new NextResponse(new Uint8Array(buffer), {
      headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${nombre}.zip"`, "Cache-Control": "private, no-store" },
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "No se pudo armar el ZIP" }, { status: 413 });
  }
}
