import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership, requireUser, AuthzError } from "@/lib/authz";
import { historiaDeMovimiento } from "@/lib/bancos/historia-movimiento";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/bancos/transactions/[txId]/historia
//
// Lo que le pasó a este movimiento y por qué: las decisiones de los motores
// (con sus reglas en palabras) mezcladas con lo que hicieron las personas.
//
// Es la respuesta a la pregunta que la mesa no sabía contestar: «¿por qué quedó
// casado con ESA factura?». En agosto esa pregunta costó reconstruir un mes a
// mano para encontrar un traspaso de $30,000 casado contra la factura de un
// paciente sólo porque el importe coincidía.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ txId: string }> };

export async function GET(req: Request, { params }: Params) {
  let user;
  try {
    user = await requireUser(req);
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const { txId } = await params;
  const tx = await prisma.bankTransaction.findUnique({
    where: { id: txId },
    select: { companyId: true },
  });
  if (!tx) return NextResponse.json({ error: "Movimiento no encontrado" }, { status: 404 });

  const member = await getEffectiveCompanyMembership(user.id, tx.companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  const eventos = await historiaDeMovimiento(tx.companyId, txId);
  return NextResponse.json({ eventos });
}
