/**
 * POST /api/ingest/external-income
 *
 * Idempotent ingest of an income movement pushed by a satellite app (e.g. the
 * padel club app or the JCPT coaching platform). Records a BankTransaction
 * (CREDITO, UNMATCHED) the contador then reconciles + posts to the ledger via
 * the normal flow. Idempotent by `externalRef` so re-pushes never double-count.
 *
 * Auth: bearer token (or session) + membership + the satellite's module.
 *
 * The target account must be a dedicated cuenta puente (e.g. tipo CAJA):
 * accounts fed by statement uploads or Belvo are rejected with 409 so the
 * same charge can never enter twice (see src/lib/bancos/fuentes.ts).
 *
 * Body: {
 *   companyId, bankAccountId, externalRef,
 *   fecha (ISO), descripcion, monto (number, pesos),
 *   tipo? "CREDITO" | "DEBITO" (default CREDITO), referencia?,
 *   modulo? "PADEL" | "JCPT" (default PADEL — the module gate + `source` tag)
 * }
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";
import { cuentaTieneEstadosDeCuenta, ERROR_CUENTA_CON_ESTADOS } from "@/lib/bancos/fuentes";

const schema = z.object({
  companyId: z.string().min(1),
  bankAccountId: z.string().min(1),
  externalRef: z.string().min(1),
  fecha: z.string(),
  descripcion: z.string().min(1),
  monto: z.number().positive(),
  tipo: z.enum(["CREDITO", "DEBITO"]).default("CREDITO"),
  referencia: z.string().optional(),
  modulo: z.enum(["PADEL", "JCPT"]).default("PADEL"),
});

export const POST = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;

  await requireMembership(d.companyId, undefined, req);
  await requireModule(d.companyId, d.modulo, req);

  // Idempotency: return the existing row if this ref was already ingested.
  const existing = await prisma.bankTransaction.findUnique({ where: { externalRef: d.externalRef } });
  if (existing) {
    return NextResponse.json({ id: existing.id, externalRef: d.externalRef, duplicate: true });
  }

  // The bank account must belong to this company.
  const account = await prisma.bankAccount.findFirst({
    where: { id: d.bankAccountId, companyId: d.companyId },
    select: { id: true, belvoLinkId: true, belvoAccountId: true },
  });
  if (!account) {
    return NextResponse.json({ error: "Cuenta bancaria no encontrada" }, { status: 404 });
  }

  // Guardia anti-duplicado: sólo cuentas puente dedicadas — una cuenta que se
  // alimenta de estados de cuenta (upload/Belvo) registraría el mismo cobro
  // dos veces. Ver src/lib/bancos/fuentes.ts.
  if (
    account.belvoLinkId ||
    account.belvoAccountId ||
    (await cuentaTieneEstadosDeCuenta(d.bankAccountId))
  ) {
    return NextResponse.json({ error: ERROR_CUENTA_CON_ESTADOS }, { status: 409 });
  }

  const fecha = new Date(d.fecha);
  if (Number.isNaN(fecha.getTime())) {
    return NextResponse.json({ error: "fecha inválida" }, { status: 400 });
  }

  try {
    const tx = await prisma.bankTransaction.create({
      data: {
        companyId: d.companyId,
        bankAccountId: d.bankAccountId,
        fecha,
        descripcion: d.descripcion,
        referencia: d.referencia,
        monto: d.tipo === "DEBITO" ? -Math.abs(d.monto) : Math.abs(d.monto),
        tipo: d.tipo,
        source: d.modulo,
        externalRef: d.externalRef,
      },
    });
    return NextResponse.json({ id: tx.id, externalRef: d.externalRef }, { status: 201 });
  } catch (e) {
    // Unique race on externalRef → treat as duplicate.
    const again = await prisma.bankTransaction.findUnique({ where: { externalRef: d.externalRef } });
    if (again) return NextResponse.json({ id: again.id, externalRef: d.externalRef, duplicate: true });
    throw e;
  }
});
