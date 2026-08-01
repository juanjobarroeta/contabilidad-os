/**
 * PATCH /api/proveedores/[id] — sesión web O token de servicio (Bearer).
 * Actualiza los datos del proveedor (razón social, email, datos de pago
 * SPEI). El RFC no se edita: es la identidad del proveedor por empresa —
 * un RFC nuevo es un alta nueva.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, getEffectiveCompanyMembership, requireUser } from "@/lib/authz";
import { gateEscritura } from "@/lib/subscription";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, { params }: Params) {
  let userId: string;
  try {
    userId = (await requireUser(req)).id;
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const { id } = await params;
  const proveedor = await prisma.supplier.findUnique({ where: { id } });
  if (!proveedor) return NextResponse.json({ error: "Proveedor no encontrado" }, { status: 404 });

  const member = await getEffectiveCompanyMembership(userId, proveedor.companyId);
  if (!member || member.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }

  const gate = await gateEscritura(userId);
  if (gate) return gate;

  const body = await req.json();
  const { razonSocial, regimenFiscal, email, clabe, banco, cuentaBancaria, titularCuenta } = body;

  const updated = await prisma.supplier.update({
    where: { id },
    data: {
      ...(razonSocial !== undefined ? { razonSocial } : {}),
      ...(regimenFiscal !== undefined ? { regimenFiscal } : {}),
      ...(email !== undefined ? { email } : {}),
      ...(clabe !== undefined ? { clabe } : {}),
      ...(banco !== undefined ? { banco } : {}),
      ...(cuentaBancaria !== undefined ? { cuentaBancaria } : {}),
      ...(titularCuenta !== undefined ? { titularCuenta } : {}),
    },
  });

  return NextResponse.json(updated);
}
