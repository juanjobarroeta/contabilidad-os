import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import {
  createSandboxLink, listAccounts, listTransactions, listInstitutions, isBelvoConfigured,
} from "@/lib/belvo";

export const runtime = "nodejs";
export const maxDuration = 120;

// POST /api/bancos/belvo/sandbox-test  { companyId, institution?, username?, password? }
//
// SANDBOX ONLY. End-to-end test of the Belvo flow in one call (no Connect
// Widget): creates a test link, imports its accounts as BankAccounts, and pulls
// the last 90 days of transactions into BankTransaction (source=BELVO) so they
// show in Bancos and feed reconciliation. Dedups by belvoId.
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!isBelvoConfigured()) {
    return NextResponse.json(
      { error: "Belvo no está configurado. Define BELVO_SECRET_ID, BELVO_SECRET_PASSWORD y BELVO_ENV=sandbox." },
      { status: 503 }
    );
  }
  if ((process.env.BELVO_ENV ?? "sandbox") !== "sandbox") {
    return NextResponse.json({ error: "Esta prueba sólo corre en BELVO_ENV=sandbox." }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  const { companyId, institution, username, password } = body ?? {};
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member || member.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }

  try {
    // 0. Resolver una institución BANCARIA de prueba de este sandbox.
    //    IMPORTANTE: Belvo NO ofrece agregación bancaria en México (sólo datos
    //    fiscales/laborales y pagos); la agregación de cuentas/movimientos sólo
    //    existe en Brasil. Por eso un sandbox MX típicamente sólo expone
    //    instituciones tipo "fiscal" (SAT) y "employment" (IMSS), no bancos.
    //    Detectamos el banco por type === "bank" (canónico) y, si no hay
    //    ninguno, devolvemos un mensaje honesto en vez de intentar un conector
    //    no-bancario con credenciales de banco.
    const instituciones = await listInstitutions("MX");
    const esBanco = (i: { type: string; name: string }) =>
      i.type === "bank" && !/(fiscal|employment|gig)/i.test(i.name);
    const bancos = instituciones.filter(esBanco);
    const elegida =
      institution ||
      bancos.find((i) => /retail/i.test(i.name))?.name ||
      bancos[0]?.name;
    if (!elegida) {
      return NextResponse.json(
        {
          error:
            "Belvo no ofrece agregación bancaria en México (sólo datos fiscales del SAT, datos laborales del IMSS y pagos). Para importar movimientos usa “Cargar estado de cuenta” o un agregador con cobertura MX (Finerio, Syncfy, Prometeo).",
          institucionProbada: null,
          bancosDisponibles: instituciones.map((i) => i.name),
        },
        { status: 502 }
      );
    }

    // 1. Crear link de prueba (sandbox).
    let link;
    try {
      link = await createSandboxLink({ institution: elegida, username, password });
    } catch (e) {
      // El nombre o las credenciales no aplican → devolvemos las opciones para elegir.
      return NextResponse.json(
        {
          error: e instanceof Error ? e.message : "No se pudo crear el link de prueba",
          institucionProbada: elegida,
          bancosDisponibles: instituciones.map((i) => i.name),
        },
        { status: 502 }
      );
    }

    // 2. Importar cuentas como BankAccount.
    const accounts = await listAccounts(link.id);
    const cuentas: { id: string; nombre: string; belvoAccountId: string }[] = [];
    for (const acc of accounts) {
      if (!["checking", "savings", "loan"].includes(acc.type)) continue;
      const existing = await prisma.bankAccount.findFirst({ where: { companyId, belvoAccountId: acc.id } });
      const nombre = `${link.institution} — ${acc.name || acc.type}`;
      if (existing) {
        await prisma.bankAccount.update({ where: { id: existing.id }, data: { belvoLinkId: link.id } });
        cuentas.push({ id: existing.id, nombre: existing.nombre, belvoAccountId: acc.id });
      } else {
        const created = await prisma.bankAccount.create({
          data: {
            companyId, banco: link.institution, nombre,
            numeroCuenta: acc.number || acc.id.slice(-8), moneda: acc.currency ?? "MXN",
            belvoLinkId: link.id, belvoAccountId: acc.id,
          },
          select: { id: true, nombre: true },
        });
        cuentas.push({ id: created.id, nombre: created.nombre, belvoAccountId: acc.id });
      }
    }

    // 3. Traer transacciones (últimos 90 días de datos de prueba).
    const now = new Date();
    const to = now.toISOString().slice(0, 10);
    const from = new Date(now.getTime() - 90 * 86400000).toISOString().slice(0, 10);
    let txCreated = 0;
    for (const c of cuentas) {
      const txs = await listTransactions(link.id, from, to, c.belvoAccountId);
      for (const tx of txs) {
        const existing = await prisma.bankTransaction.findFirst({
          where: { bankAccountId: c.id, belvoId: tx.id },
          select: { id: true },
        });
        if (existing) continue;
        await prisma.bankTransaction.create({
          data: {
            bankAccountId: c.id,
            companyId,
            fecha: new Date(tx.value_date || tx.accounting_date),
            descripcion: tx.description.replace(/\s+/g, " ").trim(),
            monto: tx.amount,
            saldo: tx.balance,
            referencia: tx.reference ?? undefined,
            belvoId: tx.id,
            belvoCategory: tx.category ?? undefined,
            source: "BELVO",
            tipo: tx.amount >= 0 ? "CREDITO" : "DEBITO",
          },
        });
        txCreated++;
      }
    }

    return NextResponse.json({
      ok: true,
      linkId: link.id,
      institution: link.institution,
      cuentas: cuentas.map((c) => c.nombre),
      txCreated,
      periodo: `${from} → ${to}`,
    });
  } catch (e) {
    console.error("[belvo/sandbox-test] Error:", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Error en la prueba de Belvo" },
      { status: 502 }
    );
  }
}
