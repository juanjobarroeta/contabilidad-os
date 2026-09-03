import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isOperador } from "@/lib/authz";

// GET /api/admin/legal-aceptaciones?email=...  |  ?userId=...  |  ?companyId=...
//
// Evidencia de aceptación de documentos legales para atender una reclamación
// o una solicitud ARCO: quién aceptó qué, en qué versión, cuándo, desde qué IP
// y en qué flujo. Sólo el operador de plataforma. Sin filtro devuelve las
// últimas 200 filas.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!(await isOperador(session.user.id))) {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }

  const url = new URL(req.url);
  const email = url.searchParams.get("email")?.trim().toLowerCase() || null;
  const userId = url.searchParams.get("userId")?.trim() || null;
  const companyId = url.searchParams.get("companyId")?.trim() || null;

  // Por correo: resolver el userId actual Y buscar por la copia del correo en
  // la propia aceptación (sobrevive a la baja de la cuenta).
  let userIds: string[] | null = null;
  if (email) {
    const u = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    userIds = u ? [u.id] : [];
  }
  if (userId) userIds = [...(userIds ?? []), userId];

  const filas = await prisma.legalAcceptance.findMany({
    where: {
      ...(companyId ? { companyId } : {}),
      ...(userIds || email
        ? {
            OR: [
              ...(userIds && userIds.length > 0 ? [{ userId: { in: userIds } }] : []),
              ...(email ? [{ email }] : []),
            ],
          }
        : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  return NextResponse.json({ total: filas.length, aceptaciones: filas });
}
