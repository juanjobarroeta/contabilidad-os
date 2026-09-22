import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { empresasAccesiblesIds } from "@/lib/authz";
import { bytesDeDataUrl } from "@/lib/fiscal/cumplimiento/persist";
import { SyntageClient, SyntageError } from "@/lib/fiscal/cumplimiento/syntage";

// GET /api/cumplimiento/acuse/[snapshotId]
// Stream del acuse PDF (opinión SAT 32-D / opinión IMSS / CSF) de un snapshot.
// Orden de fuentes: (1) los bytes guardados en la base (acusePdf — lo normal
// desde que SatGo y el gap-fill los guardan), (2) la data URL legado que el
// proveedor IMSS dejaba en acuseUrl, (3) proxy server-side a Syntage para las
// referencias viejas que aún no se han bajado. Nunca expone SYNTAGE_API_KEY.

function pdf(bytes: Uint8Array<ArrayBuffer>, nombre: string, contentType = "application/pdf") {
  return new NextResponse(bytes, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `inline; filename="${nombre}"`,
      "Cache-Control": "private, max-age=300",
    },
  });
}

export async function GET(_req: Request, { params }: { params: Promise<{ snapshotId: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { snapshotId } = await params;
  const snapshot = await prisma.complianceSnapshot.findUnique({
    where: { id: snapshotId },
    select: { id: true, companyId: true, tipo: true, acuseUrl: true, acusePdf: true, acusePdfNombre: true },
  });
  if (!snapshot) return NextResponse.json({ error: "Acuse no encontrado" }, { status: 404 });

  // Autorización: el usuario debe tener acceso a la empresa del snapshot.
  const ids = await empresasAccesiblesIds(session.user.id);
  if (!ids.includes(snapshot.companyId)) {
    return NextResponse.json({ error: "Sin acceso" }, { status: 403 });
  }

  const nombreDefault = `acuse-${snapshot.tipo.toLowerCase()}-${snapshot.id}.pdf`;
  if (snapshot.acusePdf && snapshot.acusePdf.byteLength > 0) {
    return pdf(new Uint8Array(snapshot.acusePdf), snapshot.acusePdfNombre || nombreDefault);
  }
  if (!snapshot.acuseUrl) {
    return NextResponse.json({ error: "Este snapshot no tiene acuse de respaldo" }, { status: 404 });
  }

  const enBase = bytesDeDataUrl(snapshot.acuseUrl);
  if (enBase) {
    const ct = snapshot.acuseUrl.match(/^data:([^;,]+);/)?.[1] ?? "application/pdf";
    return pdf(new Uint8Array(enBase), nombreDefault, ct);
  }

  let client: SyntageClient;
  try {
    client = new SyntageClient();
  } catch {
    return NextResponse.json({ error: "Integración de cumplimiento no configurada" }, { status: 503 });
  }

  try {
    const { data, contentType, filename } = await client.downloadAcuse(snapshot.acuseUrl);
    const ext = contentType.includes("pdf") ? "pdf" : "bin";
    const nombre = filename || `acuse-${snapshot.tipo.toLowerCase()}-${snapshot.id}.${ext}`;
    return pdf(new Uint8Array(data), nombre, contentType);
  } catch (e) {
    console.error("[cumplimiento/acuse] error:", e instanceof SyntageError ? `${e.message} (${e.status})` : e);
    return NextResponse.json({ error: "No se pudo descargar el acuse desde el proveedor" }, { status: 502 });
  }
}
