import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, getEffectiveCompanyMembership, requireUser } from "@/lib/authz";
import { gateEscritura } from "@/lib/subscription";

/**
 * POST /api/proveedores/import-cfdis   { companyId }
 *
 * Siembra el catálogo de proveedores desde los CFDIs RECIBIDOS: todo emisor
 * que alguna vez nos facturó (Invoice tipo EGRESO; el emisor vive como fila
 * de Customer, así los importa el sync del SAT) se da de alta como Supplier
 * si su RFC aún no existe. Idempotente — repetirlo sólo agrega los nuevos.
 *
 * Versión GENERAL de la de construcción (aquélla exige el módulo
 * CONSTRUCCION): cualquier empresa arma su catálogo con un clic desde la
 * pestaña Proveedores. Se excluyen el RFC propio y el genérico de público en
 * general.
 */
export async function POST(req: Request) {
  let userId: string;
  try {
    userId = (await requireUser(req)).id;
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const body = await req.json().catch(() => ({}));
  const companyId = String(body?.companyId ?? "").trim();
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  const member = await getEffectiveCompanyMembership(userId, companyId);
  if (!member || member.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }
  const gate = await gateEscritura(userId);
  if (gate) return gate;

  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { rfc: true },
  });

  // Emisores de CFDIs recibidos (agrupados vía su fila de Customer).
  const emisores = await prisma.customer.findMany({
    where: {
      companyId,
      invoices: { some: { companyId, tipo: "EGRESO", status: { not: "CANCELLED" } } },
    },
    select: {
      rfc: true,
      razonSocial: true,
      regimenFiscal: true,
      email: true,
      _count: {
        select: { invoices: { where: { tipo: "EGRESO", status: { not: "CANCELLED" } } } },
      },
    },
  });

  const EXCLUIR = new Set(
    [company?.rfc?.toUpperCase(), "XAXX010101000", "XEXX010101000"].filter(Boolean) as string[],
  );

  const existentes = await prisma.supplier.findMany({
    where: { companyId },
    select: { rfc: true },
  });
  const yaExiste = new Set(existentes.map((s) => s.rfc.toUpperCase()));

  let creados = 0;
  let omitidos = 0;
  for (const e of emisores) {
    const rfc = e.rfc.toUpperCase().trim();
    if (!rfc || EXCLUIR.has(rfc) || yaExiste.has(rfc)) {
      omitidos++;
      continue;
    }
    await prisma.supplier.create({
      data: {
        companyId,
        rfc,
        razonSocial: e.razonSocial,
        regimenFiscal: e.regimenFiscal || null,
        email: e.email || null,
      },
    });
    yaExiste.add(rfc);
    creados++;
  }

  return NextResponse.json({ creados, omitidos, emisoresDetectados: emisores.length });
}
