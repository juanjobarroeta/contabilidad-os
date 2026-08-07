import { NextResponse } from "next/server";
import { AuthzError, requireMembership, requireWriter } from "@/lib/authz";
import { registrarBitacora } from "@/lib/audit";
import {
  conciliacionDelMes,
  firmarConciliacion,
  guardarSaldoEstado,
} from "@/lib/bancos/conciliacion-repo";

// Conciliación bancaria mensual — el papel de trabajo del contador.
//
// GET  /api/bancos/conciliacion?companyId=&year=&month=
//      Devuelve el papel completo: saldo del estado de cuenta, partidas en
//      conciliación (movimientos sin registrar y asientos sin movimiento),
//      saldo en libros y la diferencia. Todo se recalcula del ledger salvo el
//      saldo capturado y la firma.
//
// POST /api/bancos/conciliacion
//      { companyId, bankAccountId, year, month, accion: "saldo"|"firmar",
//        saldoFinalEstado?, saldoInicialEstado?, notas?, conciliado? }

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const companyId = url.searchParams.get("companyId");
    const year = parseInt(url.searchParams.get("year") ?? "");
    const month = parseInt(url.searchParams.get("month") ?? "");
    if (!companyId || !Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
      return NextResponse.json({ error: "companyId, year y month (1-12) requeridos" }, { status: 400 });
    }
    await requireMembership(companyId);
    return NextResponse.json(await conciliacionDelMes(companyId, year, month));
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const companyId = body?.companyId as string | undefined;
    const bankAccountId = body?.bankAccountId as string | undefined;
    const year = parseInt(String(body?.year ?? ""));
    const month = parseInt(String(body?.month ?? ""));
    const accion = body?.accion === "firmar" ? "firmar" : body?.accion === "saldo" ? "saldo" : null;

    if (!companyId || !bankAccountId || !Number.isInteger(year) || !Number.isInteger(month) || !accion) {
      return NextResponse.json(
        { error: "companyId, bankAccountId, year, month y accion (saldo|firmar) requeridos" },
        { status: 400 }
      );
    }

    const { user } = await requireWriter(companyId, req);

    // La cuenta bancaria debe ser de esta empresa: sin esto, un miembro de una
    // empresa podría escribir la conciliación de otra pasando su bankAccountId.
    const { prisma } = await import("@/lib/prisma");
    const cuenta = await prisma.bankAccount.findFirst({
      where: { id: bankAccountId, companyId },
      select: { id: true },
    });
    if (!cuenta) return NextResponse.json({ error: "Cuenta bancaria no encontrada" }, { status: 404 });

    if (accion === "saldo") {
      const num = (v: unknown): number | null => {
        if (v === null || v === undefined || v === "") return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      };
      await guardarSaldoEstado({
        companyId,
        bankAccountId,
        year,
        month,
        saldoFinalEstado: num(body?.saldoFinalEstado),
        saldoInicialEstado: num(body?.saldoInicialEstado),
        notas: typeof body?.notas === "string" ? body.notas.trim() || null : undefined,
      });
    } else {
      await firmarConciliacion({
        companyId,
        bankAccountId,
        year,
        month,
        userId: user.id,
        conciliado: body?.conciliado !== false,
      });
    }

    registrarBitacora({
      companyId,
      userId: user.id,
      accion: accion === "saldo" ? "bancos.conciliacion.saldo" : "bancos.conciliacion.firmar",
      entidad: "ConciliacionBancaria",
      entidadId: `${bankAccountId}:${year}-${String(month).padStart(2, "0")}`,
      detalle: { year, month, bankAccountId, ...(accion === "firmar" ? { conciliado: body?.conciliado !== false } : {}) },
      req,
    });

    return NextResponse.json(await conciliacionDelMes(companyId, year, month));
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
