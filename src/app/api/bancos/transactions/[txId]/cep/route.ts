import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership, requireUser, AuthzError } from "@/lib/authz";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/bancos/transactions/[txId]/cep        → datos del comprobante
// GET /api/bancos/transactions/[txId]/cep?xml=1  → el XML firmado, para guardar
//
// El CEP es la prueba de que un importe llegó a la cuenta de un beneficiario en
// una fecha: la evidencia de materialidad que se le enseña al SAT cuando
// pregunta si un pago fue real. Se consultaba para sacarle el RFC y se tiraba;
// ahora se guarda y se puede ver y descargar desde el movimiento.
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
    select: { companyId: true, fecha: true, claveRastreo: true },
  });
  if (!tx) return NextResponse.json({ error: "Movimiento no encontrado" }, { status: 404 });

  const member = await getEffectiveCompanyMembership(user.id, tx.companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  const cep = await prisma.cepMovimiento.findUnique({ where: { bankTransactionId: txId } });
  if (!cep) return NextResponse.json({ error: "Sin comprobante para este movimiento" }, { status: 404 });

  if (new URL(req.url).searchParams.get("xml") === "1") {
    const nombre = `CEP-${tx.claveRastreo ?? txId}.xml`;
    return new NextResponse(cep.xml, {
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        "Content-Disposition": `attachment; filename="${nombre}"`,
      },
    });
  }

  // El XML no viaja en la respuesta de datos: pesa y sólo hace falta al bajarlo.
  const { xml: _xml, ...datos } = cep;
  void _xml;
  return NextResponse.json({ ...datos, monto: datos.monto ? Number(datos.monto) : null });
}
