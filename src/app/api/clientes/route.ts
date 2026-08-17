import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getFacturapiClient } from "@/lib/facturapi";
import { getEffectiveCompanyMembership, requireScope, requireUser, AuthzError } from "@/lib/authz";
import { gateEscritura } from "@/lib/subscription";

// GET /api/clientes?companyId=xxx&search=xxx
// Autz: sesión web O token de servicio (Authorization: Bearer <jwt>), para que
// apps satélite (p.ej. theclubpadel) puedan sincronizar clientes sin la UI.
export async function GET(req: Request) {
  let user;
  try {
    user = await requireUser(req);
    requireScope(user, "clientes"); // sólo aplica a tokens emitidos con scope
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json([], { status: e.status });
    throw e;
  }

  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  const search = searchParams.get("search") ?? "";

  if (!companyId) return NextResponse.json([], { status: 400 });

  // Verify membership
  const member = await getEffectiveCompanyMembership(user.id, companyId);
  if (!member) return NextResponse.json([], { status: 403 });

  const clientes = await prisma.customer.findMany({
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
      _count: { select: { invoices: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(clientes);
}

// POST /api/clientes
// Autz: sesión web O token de servicio (Bearer). Crea el Customer y lo sincroniza
// con Facturapi (si la empresa tiene API key). Idempotente por (companyId, rfc).
export async function POST(req: Request) {
  let user;
  try {
    user = await requireUser(req);
    requireScope(user, "clientes"); // sólo aplica a tokens emitidos con scope
  } catch (e) {
    const status = e instanceof AuthzError ? e.status : 401;
    const error = e instanceof AuthzError ? e.message : "Unauthorized";
    return NextResponse.json({ error }, { status });
  }

  const body = await req.json();
  const { companyId, rfc, razonSocial, regimenFiscal, email, phone, domicilio, codigoPostal } = body;

  if (!companyId || !rfc || !razonSocial || !regimenFiscal) {
    return NextResponse.json({ error: "Faltan campos requeridos" }, { status: 400 });
  }

  // Verify membership
  const member = await getEffectiveCompanyMembership(user.id, companyId);
  if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // Gating de suscripción (bandera SUBSCRIPTION_ENFORCEMENT_ENABLED).
  const gate = await gateEscritura(user.id);
  if (gate) return gate;

  // Check duplicate RFC
  const existing = await prisma.customer.findUnique({
    where: { companyId_rfc: { companyId, rfc: rfc.toUpperCase() } },
  });
  if (existing) {
    return NextResponse.json({ error: "Ya existe un cliente con ese RFC" }, { status: 409 });
  }

  // Try to sync with Facturapi if company has an API key
  let facturapiId: string | undefined;
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { facturapiApiKey: true, codigoPostal: true },
  });

  // Sin CP del cliente NO se sincroniza. Antes caía a `company.codigoPostal`:
  // se registraba NUESTRO domicilio como el fiscal del cliente, y el SAT
  // rechaza el timbre porque valida la tripleta RFC + Nombre + CP contra el
  // padrón. Un cliente sin CP no es facturable de todas formas; se guarda
  // local y se sincroniza al capturarlo (o cuando el backfill lo saque de un
  // CFDI). Mejor faltar que mentir.
  if (company?.facturapiApiKey && codigoPostal) {
    try {
      const fp = getFacturapiClient(company.facturapiApiKey, {
        companyId,
        actor: "clientes-sync",
      });
      const fpCustomer = await fp.customers.create({
        legal_name: razonSocial,
        tax_id: rfc.toUpperCase(),
        tax_system: regimenFiscal,
        email: email || undefined,
        phone: phone || undefined,
        address: {
          zip: codigoPostal,
          street: domicilio || undefined,
        },
      });
      facturapiId = fpCustomer.id;
    } catch (e) {
      // Facturapi sync failed — continue without it, but log the reason
      // so we can debug (common: 401 with dead key after org re-link).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const err = e as any;
      console.error("[clientes/create] Facturapi sync failed:", {
        status: err?.response?.status ?? err?.status,
        message: err?.response?.data?.message ?? err?.message,
      });
    }
  }

  const cliente = await prisma.customer.create({
    data: {
      companyId,
      rfc: rfc.toUpperCase(),
      razonSocial,
      regimenFiscal,
      email,
      phone,
      domicilio,
      codigoPostal,
      facturapiId,
    },
  });

  return NextResponse.json(cliente, { status: 201 });
}
