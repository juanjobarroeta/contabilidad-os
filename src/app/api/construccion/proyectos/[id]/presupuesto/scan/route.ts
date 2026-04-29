/**
 * POST /api/construccion/proyectos/[id]/presupuesto/scan
 *
 * Multipart upload of Gerardo's PRESUPUESTO Excel. Parses + cross-checks +
 * returns preview WITHOUT writing anything to the DB. The client uses the
 * preview to render the confirmation screen, then POSTs the same parsed
 * structure back to /import to commit.
 *
 * Body: multipart/form-data with field "file" (.xls or .xlsx).
 *
 * Response: full PresupuestoParseResult plus {alreadyHasPresupuesto: boolean}
 * so the UI can warn before confirmation.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  AuthzError,
  requireModule,
  requireWriter,
  withAuthz,
} from "@/lib/authz";
import { parsePresupuestoXls } from "@/lib/construccion/presupuesto-parser";

export const POST = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;

    const proyecto = await prisma.proyecto.findUnique({
      where: { id },
      select: { id: true, companyId: true },
    });
    if (!proyecto) throw new AuthzError(404, "Proyecto no encontrado");
    await requireWriter(proyecto.companyId, req);
    await requireModule(proyecto.companyId, "CONSTRUCCION");

    const form = await req.formData().catch(() => null);
    if (!form) {
      return NextResponse.json({ error: "Archivo no recibido" }, { status: 400 });
    }
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Archivo no recibido" }, { status: 400 });
    }
    if (file.size > 10 * 1024 * 1024) {
      return NextResponse.json({ error: "Archivo > 10 MB no permitido" }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    let parsed;
    try {
      parsed = parsePresupuestoXls(buffer);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Error al leer el archivo";
      return NextResponse.json({ error: msg }, { status: 422 });
    }

    // Reject reimport up-front so the UI can warn before showing the preview.
    // (We re-check at /import time; this is just for a better UX.)
    const existing = await prisma.presupuesto.count({
      where: { proyectoId: id },
    });

    return NextResponse.json({
      ...parsed,
      filename: file.name,
      fileSize: file.size,
      alreadyHasPresupuesto: existing > 0,
    });
  }
);
