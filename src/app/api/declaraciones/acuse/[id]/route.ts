import { NextResponse } from "next/server";
import { AuthzError, requireMembership } from "@/lib/authz";
import { prisma } from "@/lib/prisma";

// GET /api/declaraciones/acuse/[id]
// Stream del acuse PDF guardado de una declaración (capturado a mano o traído por
// el backfill de Syntage). 404 si esa declaración no conserva el PDF.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const decl = await prisma.taxDeclaration.findUnique({
      where: { id },
      select: { companyId: true, tipo: true, periodo: true, acusePdf: true, acusePdfNombre: true },
    });
    if (!decl) return NextResponse.json({ error: "Declaración no encontrada" }, { status: 404 });

    await requireMembership(decl.companyId);

    if (!decl.acusePdf) {
      return NextResponse.json({ error: "Esta declaración no tiene acuse PDF guardado" }, { status: 404 });
    }

    const nombre = decl.acusePdfNombre || `acuse-${decl.tipo.toLowerCase()}-${decl.periodo}.pdf`;
    return new NextResponse(new Uint8Array(decl.acusePdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${nombre}"`,
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
