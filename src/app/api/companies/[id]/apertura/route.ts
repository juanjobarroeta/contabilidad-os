import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { registrarBitacora } from "@/lib/audit";
import { estadoApertura, guardarSaldoFavorInicial } from "@/lib/fiscal/apertura";

// ─────────────────────────────────────────────────────────────────────────────
// Apertura fiscal de la empresa.
//
// GET   → snapshot del punto de partida con procedencia por dato (cualquier
//         miembro puede LEERLO — revisar no exige permisos de escritura).
// PATCH → correcciones del punto de partida (rol con escritura):
//         · ivaSaldoFavorInicial  — se persiste en la fila IVA_MENSUAL del mes
//           anterior al primer mes computado (la MISMA que lee el arrastre del
//           Art. 6 LIVA), espejo del import de acuses; nunca una fuente nueva.
//         · coeficiente           — Company.coeficienteUtilidad/coeficienteAnio
//           (el override manual que ya consume computeTaxPosition).
//         · perdidaPendiente      — Company.perdidaFiscalPendiente/perdidaFiscalAnio
//           (remanente PM, Art. 14).
//         · perdidas / perdidasEliminar — ledger PerdidaFiscal (Art. 57),
//           upsert por ejercicio con origen IMPORTADA (igual que el import).
//         · obligaciones          — toggles de CompanyObligation.activa.
//         Cada corrección se registra en la bitácora (sin secretos).
// ─────────────────────────────────────────────────────────────────────────────

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: companyId } = await params;
  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member) return NextResponse.json({ error: "Sin permisos" }, { status: 403 });

  try {
    const apertura = await estadoApertura(companyId);
    return NextResponse.json(apertura);
  } catch (e) {
    console.error("[apertura] GET error:", e);
    return NextResponse.json({ error: "No se pudo armar la apertura fiscal" }, { status: 500 });
  }
}

interface PatchBody {
  /** Saldo a favor de IVA inicial (>= 0). null = borrar el dato capturado. */
  ivaSaldoFavorInicial?: number | null;
  /** Coeficiente de utilidad manual (0–1, 4 decimales). null = quitar el manual. */
  coeficiente?: { valor: number | null; anio?: number | null };
  /** Remanente de pérdidas PM (Art. 14). null = quitar el manual. */
  perdidaPendiente?: { valor: number | null; anio?: number | null };
  /** Pérdidas por ejercicio (Art. 57): upsert en el ledger. */
  perdidas?: { ejercicio: number; montoOriginal?: number | null; saldoActualizado: number }[];
  /** Ejercicios a eliminar del ledger. */
  perdidasEliminar?: number[];
  /** Toggles de obligaciones. */
  obligaciones?: { tipo: string; activa: boolean }[];
}

const esMonto = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

export async function PATCH(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: companyId } = await params;
  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member || member.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Cuerpo inválido" }, { status: 400 });
  }

  const bitacora = (detalle: Prisma.InputJsonObject) =>
    registrarBitacora({
      companyId,
      userId: session.user!.id,
      actorEmail: session.user!.email ?? null,
      accion: "apertura.corregir",
      entidad: "Company",
      entidadId: companyId,
      detalle,
      req,
    });

  const aplicado: string[] = [];

  try {
    // ── Saldo a favor de IVA inicial ─────────────────────────────────────────
    if ("ivaSaldoFavorInicial" in body) {
      const v = body.ivaSaldoFavorInicial;
      if (v !== null && !esMonto(v)) {
        return NextResponse.json({ error: "El saldo a favor inicial debe ser un monto positivo" }, { status: 400 });
      }
      const r = await guardarSaldoFavorInicial(companyId, v ?? null);
      bitacora({ campo: "ivaSaldoFavorInicial", periodo: r.periodo, antes: r.anterior, despues: v ?? null });
      aplicado.push("ivaSaldoFavorInicial");
    }

    // ── Coeficiente de utilidad manual ───────────────────────────────────────
    if (body.coeficiente !== undefined) {
      const { valor, anio } = body.coeficiente;
      if (valor !== null && (!esMonto(valor) || valor > 1)) {
        return NextResponse.json({ error: "El coeficiente debe estar entre 0 y 1" }, { status: 400 });
      }
      const antes = await prisma.company.findUnique({
        where: { id: companyId },
        select: { coeficienteUtilidad: true, coeficienteAnio: true },
      });
      await prisma.company.update({
        where: { id: companyId },
        data: {
          coeficienteUtilidad: valor,
          coeficienteAnio: valor == null ? null : (anio ?? new Date().getFullYear()),
        },
      });
      bitacora({ campo: "coeficiente", antes: antes?.coeficienteUtilidad ?? null, despues: valor, anio: anio ?? null });
      aplicado.push("coeficiente");
    }

    // ── Remanente de pérdidas PM (Art. 14) ───────────────────────────────────
    if (body.perdidaPendiente !== undefined) {
      const { valor, anio } = body.perdidaPendiente;
      if (valor !== null && !esMonto(valor)) {
        return NextResponse.json({ error: "El remanente de pérdidas debe ser un monto positivo" }, { status: 400 });
      }
      const antes = await prisma.company.findUnique({
        where: { id: companyId },
        select: { perdidaFiscalPendiente: true },
      });
      await prisma.company.update({
        where: { id: companyId },
        data: {
          perdidaFiscalPendiente: valor,
          perdidaFiscalAnio: valor == null ? null : (anio ?? null),
        },
      });
      bitacora({ campo: "perdidaPendiente", antes: antes?.perdidaFiscalPendiente ?? null, despues: valor, anio: anio ?? null });
      aplicado.push("perdidaPendiente");
    }

    // ── Ledger de pérdidas (Art. 57) ─────────────────────────────────────────
    if (body.perdidas?.length) {
      for (const p of body.perdidas) {
        if (!Number.isInteger(p.ejercicio) || p.ejercicio < 1990 || p.ejercicio > 2100 || !esMonto(p.saldoActualizado)) {
          return NextResponse.json({ error: "Pérdida inválida: ejercicio y saldo positivos requeridos" }, { status: 400 });
        }
        const montoOriginal = esMonto(p.montoOriginal) ? p.montoOriginal : p.saldoActualizado;
        // Mismo modelado que el import de acuses: un registro por ejercicio, ya
        // actualizado a su diciembre, origen IMPORTADA.
        await prisma.perdidaFiscal.upsert({
          where: { companyId_ejercicioOrigen: { companyId, ejercicioOrigen: p.ejercicio } },
          create: {
            companyId,
            ejercicioOrigen: p.ejercicio,
            montoOriginal,
            saldoActualizado: p.saldoActualizado,
            mesUltimaActualizacion: `${p.ejercicio}-12`,
            agotada: p.saldoActualizado <= 0,
            origen: "IMPORTADA",
          },
          update: {
            montoOriginal,
            saldoActualizado: p.saldoActualizado,
            agotada: p.saldoActualizado <= 0,
            origen: "IMPORTADA",
          },
        });
        bitacora({ campo: "perdidaFiscal", ejercicio: p.ejercicio, montoOriginal, saldoActualizado: p.saldoActualizado });
      }
      aplicado.push("perdidas");
    }

    if (body.perdidasEliminar?.length) {
      const ejercicios = body.perdidasEliminar.filter((e) => Number.isInteger(e));
      if (ejercicios.length > 0) {
        await prisma.perdidaFiscal.deleteMany({ where: { companyId, ejercicioOrigen: { in: ejercicios } } });
        bitacora({ campo: "perdidaFiscal.eliminar", ejercicios });
        aplicado.push("perdidasEliminar");
      }
    }

    // ── Obligaciones (toggles) ───────────────────────────────────────────────
    if (body.obligaciones?.length) {
      for (const o of body.obligaciones) {
        if (typeof o.tipo !== "string" || !o.tipo.trim() || typeof o.activa !== "boolean") {
          return NextResponse.json({ error: "Obligación inválida" }, { status: 400 });
        }
        await prisma.companyObligation.updateMany({
          where: { companyId, tipo: o.tipo.trim() },
          data: { activa: o.activa },
        });
        bitacora({ campo: "obligacion", tipo: o.tipo.trim(), activa: o.activa });
      }
      aplicado.push("obligaciones");
    }
  } catch (e) {
    console.error("[apertura] PATCH error:", e);
    return NextResponse.json({ error: "No se pudo guardar la corrección" }, { status: 500 });
  }

  if (aplicado.length === 0) {
    return NextResponse.json({ error: "No hay datos para actualizar" }, { status: 400 });
  }

  const apertura = await estadoApertura(companyId);
  return NextResponse.json({ ok: true, aplicado, apertura });
}
