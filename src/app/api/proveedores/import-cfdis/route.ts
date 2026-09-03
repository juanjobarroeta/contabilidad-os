import { NextResponse } from "next/server";
import { AuthzError, getEffectiveCompanyMembership, requireUser } from "@/lib/authz";
import { gateEscritura } from "@/lib/subscription";
import { sembrarProveedoresDesdeCfdis } from "@/lib/proveedores/seed-desde-cfdis";

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

  const r = await sembrarProveedoresDesdeCfdis(companyId);

  return NextResponse.json(r);
}
