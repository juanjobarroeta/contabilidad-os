import { NextResponse } from "next/server";
import { withAuthz, requireMembership } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { declaracionesFaltantesEmpresa } from "@/lib/fiscal/cobertura-declaraciones";
import { filasExpediente, type FilaExpediente } from "@/lib/fiscal/expediente";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/declaraciones/expediente?companyId=
//
// EL EXPEDIENTE DE UNA EMPRESA: lo que ya se presentó al SAT y lo que falta, en
// una sola lista y para UNA empresa.
//
// Antes esto vivía en dos pantallas distintas y mezcladas: «por capturar»
// juntaba todas las empresas del despacho, y lo presentado estaba detrás de un
// botón. Quien quiere ver el expediente de un RFC quiere las dos cosas juntas
// y sólo de ese RFC.
//
// Reúne TODO lo que sabemos que se presentó, venga de donde venga:
//   · TaxDeclaration  — anual, IVA, ISR provisional, IEPS, retenciones, DIOT.
//   · CeBalanzaMes    — las balanzas de Contabilidad Electrónica que el SAT
//                       nos devuelve (una fila por cuenta; el periodo cuenta
//                       como presentado si tiene renglones).
//   · CoeEnvio        — los envíos de CE hechos desde aquí.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";

export const GET = withAuthz(async (req: Request) => {
  const companyId = new URL(req.url).searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId es requerido" }, { status: 400 });
  await requireMembership(companyId, undefined, req);

  const [empresa, declaraciones, balanzas, envios, faltantes] = await Promise.all([
    prisma.company.findUnique({ where: { id: companyId }, select: { rfc: true, razonSocial: true } }),
    prisma.taxDeclaration.findMany({
      where: { companyId },
      select: {
        id: true,
        tipo: true,
        periodo: true,
        status: true,
        fechaPresentacion: true,
        isHistorical: true,
        acusePdfNombre: true,
        acuseUrl: true,
        lineaCaptura: true,
      },
      orderBy: [{ periodo: "desc" }],
    }),
    // Una fila por cuenta: sólo interesa QUÉ periodos tienen balanza.
    prisma.ceBalanzaMes.groupBy({ by: ["anio", "mes"], where: { companyId }, _count: { _all: true } }),
    prisma.coeEnvio.findMany({
      where: { companyId },
      select: { tipoDoc: true, periodo: true, tipoEnvio: true, updatedAt: true },
    }),
    declaracionesFaltantesEmpresa(companyId),
  ]);
  if (!empresa) return NextResponse.json({ error: "Empresa no encontrada" }, { status: 404 });

  const presentadas: FilaExpediente[] = filasExpediente({
    declaraciones: declaraciones.map((d) => ({
      id: d.id,
      tipo: d.tipo,
      periodo: d.periodo,
      status: d.status,
      fechaPresentacion: d.fechaPresentacion?.toISOString() ?? null,
      isHistorical: d.isHistorical,
      tienePdf: d.acusePdfNombre != null,
      acuseUrl: d.acuseUrl,
      lineaCaptura: d.lineaCaptura,
    })),
    balanzas: balanzas.map((b) => ({ anio: b.anio, mes: b.mes, cuentas: b._count._all })),
    envios: envios.map((e) => ({
      tipoDoc: e.tipoDoc,
      periodo: e.periodo,
      tipoEnvio: e.tipoEnvio,
      fecha: e.updatedAt.toISOString(),
    })),
  });

  return NextResponse.json({
    empresa: { companyId, rfc: empresa.rfc, razonSocial: empresa.razonSocial },
    presentadas,
    faltantes,
  });
});
