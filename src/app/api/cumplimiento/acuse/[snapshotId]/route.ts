import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { empresasAccesiblesIds } from "@/lib/authz";
import { SyntageClient, SyntageError } from "@/lib/fiscal/cumplimiento/syntage";

// GET /api/cumplimiento/acuse/[snapshotId]
// Proxy server-side del acuse PDF (opinión SAT / CSF) que vive en Syntage. Nunca
// expone SYNTAGE_API_KEY al browser: descarga con la API key y hace stream del PDF.
// La resolución del archivo (ref directa al file vs. recurso padre) la maneja
// SyntageClient.downloadAcuse().

export async function GET(_req: Request, { params }: { params: Promise<{ snapshotId: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { snapshotId } = await params;
  const snapshot = await prisma.complianceSnapshot.findUnique({
    where: { id: snapshotId },
    select: { id: true, companyId: true, tipo: true, acuseUrl: true },
  });
  if (!snapshot) return NextResponse.json({ error: "Acuse no encontrado" }, { status: 404 });

  // Autorización: el usuario debe tener acceso a la empresa del snapshot.
  const ids = await empresasAccesiblesIds(session.user.id);
  if (!ids.includes(snapshot.companyId)) {
    return NextResponse.json({ error: "Sin acceso" }, { status: 403 });
  }
  if (!snapshot.acuseUrl) {
    return NextResponse.json({ error: "Este snapshot no tiene acuse de respaldo" }, { status: 404 });
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
    return new NextResponse(data, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `inline; filename="${nombre}"`,
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch (e) {
    console.error("[cumplimiento/acuse] error:", e instanceof SyntageError ? `${e.message} (${e.status})` : e);
    return NextResponse.json({ error: "No se pudo descargar el acuse desde el proveedor" }, { status: 502 });
  }
}
