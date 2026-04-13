import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { getLink, listAccounts, isBelvoConfigured } from "@/lib/belvo";

// POST /api/bancos/belvo/connect
// Called after the Belvo Connect Widget successfully creates a link.
// Creates or updates a BankAccount with the Belvo link ID.
//
// Body: { companyId, linkId, institution }

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!isBelvoConfigured()) {
    return NextResponse.json({ error: "Belvo no configurado" }, { status: 503 });
  }

  const body = await req.json();
  const { companyId, linkId, institution } = body;

  if (!companyId || !linkId) {
    return NextResponse.json({ error: "companyId y linkId requeridos" }, { status: 400 });
  }

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member || member.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }

  try {
    // Fetch link details from Belvo
    const link = await getLink(linkId);

    // Fetch accounts for this link
    const accounts = await listAccounts(linkId);
    const created: string[] = [];

    for (const acc of accounts) {
      // Only import checking/savings accounts (skip credit cards for now)
      if (!["checking", "savings", "loan"].includes(acc.type)) continue;

      // Upsert bank account — match by Belvo account ID or create new
      const existing = await prisma.bankAccount.findFirst({
        where: { companyId, belvoAccountId: acc.id },
      });

      if (existing) {
        await prisma.bankAccount.update({
          where: { id: existing.id },
          data: { belvoLinkId: linkId },
        });
        created.push(`${existing.nombre} (actualizada)`);
      } else {
        const nombre = `${institution ?? link.institution} — ${acc.name || acc.type}`;
        await prisma.bankAccount.create({
          data: {
            companyId,
            banco: institution ?? link.institution,
            nombre,
            numeroCuenta: acc.number || acc.id.slice(-8),
            moneda: acc.currency ?? "MXN",
            belvoLinkId: linkId,
            belvoAccountId: acc.id,
          },
        });
        created.push(nombre);
      }
    }

    return NextResponse.json({
      ok: true,
      linkId,
      institution: institution ?? link.institution,
      accountsConnected: created.length,
      accounts: created,
    });
  } catch (e) {
    console.error("[belvo/connect] Error:", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Error al conectar con Belvo" },
      { status: 502 }
    );
  }
}
