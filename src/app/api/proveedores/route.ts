/**
 * Proveedores (Suppliers) — espejo de /api/clientes para satélites.
 *
 * GET  /api/proveedores?companyId=xxx&search=abc
 *   Sesión web O token de servicio (Bearer). Lista los proveedores de la
 *   empresa (JCPT los muestra en su admin: a quién le hemos recibido
 *   facturas / a quién se le paga).
 *
 * POST /api/proveedores
 *   Body: { companyId, rfc, razonSocial, regimenFiscal?, email?, clabe?,
 *           banco?, cuentaBancaria?, titularCuenta? }
 *   409 si ya existe (companyId, rfc) — igual que clientes.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, getEffectiveCompanyMembership, requireUser } from "@/lib/authz";
import { gateEscritura } from "@/lib/subscription";

export async function GET(req: Request) {
  let user;
  try {
    user = await requireUser(req);
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json([], { status: e.status });
    throw e;
  }

  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  const search = searchParams.get("search") ?? "";
  if (!companyId) return NextResponse.json([], { status: 400 });

  const member = await getEffectiveCompanyMembership(user.id, companyId);
  if (!member) return NextResponse.json([], { status: 403 });

  const proveedores = await prisma.supplier.findMany({
    where: {
      companyId,
      ...(search
        ? {
            OR: [
              { rfc: { contains: search.toUpperCase() } },
              { razonSocial: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    include: {
      _count: { select: { bankTransactions: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(proveedores);
}

export async function POST(req: Request) {
  let user;
  try {
    user = await requireUser(req);
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const body = await req.json();
  const { companyId, rfc, razonSocial, regimenFiscal, email, clabe, banco, cuentaBancaria, titularCuenta } = body;

  if (!companyId || !rfc || !razonSocial) {
    return NextResponse.json({ error: "Faltan campos requeridos" }, { status: 400 });
  }

  const member = await getEffectiveCompanyMembership(user.id, companyId);
  if (!member || member.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }

  // Gating de suscripción (bandera SUBSCRIPTION_ENFORCEMENT_ENABLED).
  const gate = await gateEscritura(user.id);
  if (gate) return gate;

  const existing = await prisma.supplier.findUnique({
    where: { companyId_rfc: { companyId, rfc: rfc.toUpperCase() } },
  });
  if (existing) {
    return NextResponse.json({ error: "Ya existe un proveedor con ese RFC" }, { status: 409 });
  }

  const proveedor = await prisma.supplier.create({
    data: {
      companyId,
      rfc: rfc.toUpperCase(),
      razonSocial,
      regimenFiscal,
      email,
      clabe,
      banco,
      cuentaBancaria,
      titularCuenta,
    },
  });

  return NextResponse.json(proveedor, { status: 201 });
}
