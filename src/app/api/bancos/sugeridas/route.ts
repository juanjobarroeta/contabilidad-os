import { NextResponse } from "next/server";
import { AuthzError, requireMembership } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { sugerirCuentasBancarias } from "@/lib/bancos/cuentas-del-catalogo";

// GET /api/bancos/sugeridas?companyId= — las cuentas bancarias que la empresa
// declaró en su catálogo de cuentas (CE del SAT, agrupador 102.01/102.02) y que
// todavía no están registradas en Bancos. Las usa el alta y la pantalla Bancos.
export async function GET(req: Request) {
  try {
    const companyId = new URL(req.url).searchParams.get("companyId") ?? "";
    if (!companyId) return NextResponse.json({ error: "Falta companyId" }, { status: 400 });
    await requireMembership(companyId, undefined, req);
    const [catalogo, existentes, ct] = await Promise.all([
      prisma.chartAccount.findMany({
        where: { companyId, OR: [{ codAgrup: { startsWith: "102" } }, { cuentaSAT: "102" }] },
        select: { id: true, cuentaSAT: true, subcuenta: true, nombre: true, codAgrup: true, padreCodigo: true, isActive: true },
      }),
      prisma.bankAccount.findMany({ where: { companyId }, select: { chartAccountId: true, numeroCuenta: true, clabe: true } }),
      prisma.ceArchivo.findFirst({
        where: { companyId, tipo: "CT", importadoEn: { not: null } },
        orderBy: [{ anio: "desc" }, { mes: "desc" }],
        select: { anio: true, mes: true },
      }),
    ]);
    return NextResponse.json({
      sugeridas: sugerirCuentasBancarias(catalogo, existentes),
      // De qué catálogo salen (null = todavía no llega el del SAT).
      catalogo: ct,
    });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
