import { NextResponse } from "next/server";
import { AuthzError, requireMembership, requireWriter } from "@/lib/authz";
import { registrarBitacora } from "@/lib/audit";
import {
  ConciliacionSinDatosError,
  ConfirmacionSinActividadConDatosError,
  ConfirmacionSinActividadNotaError,
  conciliacionDelMes,
  confirmarSinActividadBancaria,
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
//      { companyId, bankAccountId?, year, month, accion: "saldo"|"firmar"|"sin_actividad",
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
    // `req` para que el bearer de los satélites (HospitalOS lee la conciliación
    // del mes en su pestaña Bancos) también resuelva; sin él sólo entra la cookie
    // y el satélite recibe 401 — que su apiFetch interpreta como sesión vencida.
    await requireMembership(companyId, undefined, req);
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
    const accion =
      body?.accion === "firmar"
        ? "firmar"
        : body?.accion === "saldo"
          ? "saldo"
          : body?.accion === "sin_actividad"
            ? "sin_actividad"
            : null;

    if (
      !companyId ||
      !Number.isInteger(year) ||
      !Number.isInteger(month) ||
      month < 1 ||
      month > 12 ||
      !accion ||
      (accion !== "sin_actividad" && !bankAccountId)
    ) {
      return NextResponse.json(
        { error: "companyId, year, month y accion válidos son requeridos; bankAccountId aplica a saldo/firma" },
        { status: 400 }
      );
    }

    const { user } = await requireWriter(companyId, req);

    if (accion !== "sin_actividad") {
      // La cuenta bancaria debe ser de esta empresa: sin esto, un miembro de una
      // empresa podría escribir la conciliación de otra pasando su bankAccountId.
      const { prisma } = await import("@/lib/prisma");
      const cuenta = await prisma.bankAccount.findFirst({
        where: { id: bankAccountId!, companyId },
        select: { id: true },
      });
      if (!cuenta) return NextResponse.json({ error: "Cuenta bancaria no encontrada" }, { status: 404 });
    }

    if (accion === "saldo") {
      const num = (v: unknown): number | null => {
        if (v === null || v === undefined || v === "") return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      };
      await guardarSaldoEstado({
        companyId,
        bankAccountId: bankAccountId!,
        year,
        month,
        saldoFinalEstado: num(body?.saldoFinalEstado),
        saldoInicialEstado: num(body?.saldoInicialEstado),
        notas: typeof body?.notas === "string" ? body.notas.trim() || null : undefined,
      });
    } else if (accion === "firmar") {
      await firmarConciliacion({
        companyId,
        bankAccountId: bankAccountId!,
        year,
        month,
        userId: user.id,
        conciliado: body?.conciliado !== false,
      });
    } else {
      const confirmada = body?.confirmada !== false;
      const nota = typeof body?.nota === "string" ? body.nota.trim() : "";
      if (confirmada && nota.length < 10) {
        return NextResponse.json(
          { error: "Explica en al menos 10 caracteres por qué el periodo no tuvo actividad bancaria" },
          { status: 400 },
        );
      }
      await confirmarSinActividadBancaria({
        companyId,
        year,
        month,
        userId: user.id,
        confirmada,
        nota,
      });
    }

    const esSinActividad = accion === "sin_actividad";
    registrarBitacora({
      companyId,
      userId: user.id,
      accion: esSinActividad
        ? body?.confirmada === false
          ? "bancos.sin_actividad.revocar"
          : "bancos.sin_actividad.confirmar"
        : accion === "saldo"
          ? "bancos.conciliacion.saldo"
          : "bancos.conciliacion.firmar",
      entidad: esSinActividad ? "CierrePeriodo" : "ConciliacionBancaria",
      entidadId: esSinActividad
        ? `${companyId}:${year}-${String(month).padStart(2, "0")}`
        : `${bankAccountId}:${year}-${String(month).padStart(2, "0")}`,
      detalle: {
        year,
        month,
        ...(esSinActividad
          ? { confirmada: body?.confirmada !== false, nota: typeof body?.nota === "string" ? body.nota.trim() : "" }
          : { bankAccountId, ...(accion === "firmar" ? { conciliado: body?.conciliado !== false } : {}) }),
      },
      req,
    });

    return NextResponse.json(await conciliacionDelMes(companyId, year, month));
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    if (e instanceof ConciliacionSinDatosError) {
      return NextResponse.json({ error: e.message, code: "BANK_NO_DATA" }, { status: 409 });
    }
    if (e instanceof ConfirmacionSinActividadConDatosError) {
      return NextResponse.json({ error: e.message, code: "BANK_HAS_DATA" }, { status: 409 });
    }
    if (e instanceof ConfirmacionSinActividadNotaError) {
      return NextResponse.json({ error: e.message, code: "BANK_NO_ACTIVITY_NOTE_REQUIRED" }, { status: 400 });
    }
    throw e;
  }
}
