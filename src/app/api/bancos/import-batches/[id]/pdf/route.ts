/**
 * Descarga del estado de cuenta original de un lote de importación.
 *
 * GET /api/bancos/import-batches/[id]/pdf
 *   Sesión web O token de servicio. Devuelve el documento (PDF/imagen) que
 *   respaldó la importación por visión — evidencia de underwriting. 404 si el
 *   lote no guardó archivo (importaciones CSV o previas a esta función).
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, getEffectiveCompanyMembership, requireUser } from "@/lib/authz";

type Params = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Params) {
  let user;
  try {
    user = await requireUser(req);
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: "Unauthorized" }, { status: e.status });
    throw e;
  }

  const { id } = await params;
  const batch = await prisma.importBatch.findUnique({
    where: { id },
    select: { companyId: true, archivoPdf: true, archivoNombre: true, archivoMime: true },
  });
  if (!batch) return NextResponse.json({ error: "Lote no encontrado" }, { status: 404 });

  const member = await getEffectiveCompanyMembership(user.id, batch.companyId);
  if (!member) return NextResponse.json({ error: "Sin permisos" }, { status: 403 });

  if (!batch.archivoPdf) {
    return NextResponse.json({ error: "Este lote no guardó el documento original" }, { status: 404 });
  }

  // Nombre saneado para el header (sin saltos/comillas que lo rompan).
  const nombre = (batch.archivoNombre ?? "estado-de-cuenta.pdf").replace(/[\r\n"\\]/g, "_");
  return new NextResponse(new Uint8Array(batch.archivoPdf), {
    status: 200,
    headers: {
      "Content-Type": batch.archivoMime ?? "application/pdf",
      "Content-Disposition": `inline; filename="${nombre}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
