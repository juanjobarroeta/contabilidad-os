import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isOperador } from "@/lib/authz";

// PATCH /api/rentabilidad/precio
// body: { tipo: "company" | "despacho", id: string, precioMensualCentavos: number | null }
// Fija el precio mensual de análisis (centavos MXN). Sólo operador. null = limpiar.

export async function PATCH(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!(await isOperador(session.user.id))) {
    return NextResponse.json({ error: "Sólo disponible para operador de plataforma" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const { tipo, id } = body ?? {};
  const raw = body?.precioMensualCentavos;

  if (tipo !== "company" && tipo !== "despacho") {
    return NextResponse.json({ error: "tipo inválido" }, { status: 400 });
  }
  if (typeof id !== "string" || !id) {
    return NextResponse.json({ error: "id requerido" }, { status: 400 });
  }
  let precio: number | null;
  if (raw === null || raw === undefined || raw === "") {
    precio = null;
  } else {
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n) || n < 0) {
      return NextResponse.json({ error: "precioMensualCentavos debe ser un entero ≥ 0 o null" }, { status: 400 });
    }
    precio = n;
  }

  if (tipo === "company") {
    await prisma.company.update({ where: { id }, data: { precioMensualCentavos: precio } });
  } else {
    await prisma.despacho.update({ where: { id }, data: { precioMensualCentavos: precio } });
  }

  return NextResponse.json({ ok: true, tipo, id, precioMensualCentavos: precio });
}
