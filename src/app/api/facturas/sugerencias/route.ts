import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership, requireUser, AuthzError } from "@/lib/authz";
import { aggregateConceptos, type RawItem } from "@/lib/facturas/sugerencias";

// GET /api/facturas/sugerencias?companyId=xxx&customerId=yyy
//
// Powers the "invoicing suggestions" UX in facturas/nueva. Returns:
//   - conceptos: distinct recent line items (customer-first, then company-wide),
//     ranked by recency/frequency, ~top 15.
//   - facturasPrevias: recent STAMPED invoices to that customer (~top 5) so the
//     user can prefill the whole line-item list from a past invoice.
//
// Same auth/scoping shape as the rest of /api/facturas (requireUser +
// getEffectiveCompanyMembership). customerId is optional — without it we still
// return company-wide conceptos but no facturasPrevias.
export async function GET(req: Request) {
  let user;
  try {
    user = await requireUser(req);
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  const membership = await getEffectiveCompanyMembership(user.id, companyId);
  if (!membership) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  const customerId = searchParams.get("customerId");

  // Pull recent INGRESO line items for this company (stamped or not — drafts are
  // still useful conceptos). Cap the row scan so a high-volume company stays
  // fast; the most recent invoices carry the most relevant conceptos anyway.
  const recentInvoices = await prisma.invoice.findMany({
    where: { companyId, tipo: "INGRESO" },
    orderBy: { fecha: "desc" },
    take: 200,
    select: {
      fecha: true,
      customerId: true,
      items: {
        select: {
          claveProdServ: true,
          descripcion: true,
          valorUnitario: true,
          claveUnidad: true,
        },
      },
    },
  });

  const rawItems: RawItem[] = recentInvoices.flatMap((inv) =>
    inv.items.map((it) => ({
      claveProdServ: it.claveProdServ,
      descripcion: it.descripcion,
      valorUnitario: it.valorUnitario,
      claveUnidad: it.claveUnidad,
      fecha: inv.fecha,
      customerId: inv.customerId,
    }))
  );

  const conceptos = aggregateConceptos(rawItems, customerId, 15);

  // Recent STAMPED invoices to this customer, with their items, for one-click
  // prefill. Only meaningful when a customer is selected.
  const facturasPrevias = customerId
    ? (
        await prisma.invoice.findMany({
          where: { companyId, customerId, tipo: "INGRESO", status: "STAMPED" },
          orderBy: { fecha: "desc" },
          take: 5,
          select: {
            id: true,
            folio: true,
            fecha: true,
            total: true,
            items: {
              select: {
                claveProdServ: true,
                descripcion: true,
                cantidad: true,
                valorUnitario: true,
                claveUnidad: true,
              },
            },
          },
        })
      ).map((inv) => ({
        id: inv.id,
        folio: inv.folio,
        fecha: inv.fecha,
        total: inv.total,
        items: inv.items,
      }))
    : [];

  return NextResponse.json({ conceptos, facturasPrevias });
}
