import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { registrarBitacora } from "@/lib/audit";
import { estadoApertura } from "@/lib/fiscal/apertura";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/companies/[id]/apertura/confirmar
//
// Estampa la confirmación del punto de partida fiscal (quién y cuándo) y
// registra en la bitácora un RESUMEN del snapshot confirmado — los valores que
// el contador dio por buenos quedan asentados (nunca secretos). Re-confirmar
// tras una corrección actualiza la marca.
// ─────────────────────────────────────────────────────────────────────────────

type Params = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: companyId } = await params;
  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member || member.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }

  try {
    // Snapshot ANTES de estampar — lo que el contador está confirmando.
    const apertura = await estadoApertura(companyId);

    const confirmadaPor = session.user.email ?? session.user.id;
    const company = await prisma.company.update({
      where: { id: companyId },
      data: { aperturaConfirmadaAt: new Date(), aperturaConfirmadaPor: confirmadaPor },
      select: { aperturaConfirmadaAt: true, aperturaConfirmadaPor: true },
    });

    registrarBitacora({
      companyId,
      userId: session.user.id,
      actorEmail: session.user.email ?? null,
      accion: "apertura.confirmar",
      entidad: "Company",
      entidadId: companyId,
      detalle: {
        primerPeriodo: apertura.primerPeriodo,
        periodoAnterior: apertura.periodoAnterior,
        ivaSaldoFavor: apertura.ivaSaldoFavor.valor,
        ivaSaldoFavorFuente: apertura.ivaSaldoFavor.fuente.tipo,
        coeficiente: apertura.coeficiente.valor,
        coeficienteFuente: apertura.coeficiente.fuente.tipo,
        perdidaPendiente: apertura.perdidaPendiente.valor,
        perdidasPorAmortizar: apertura.perdidasPorAmortizar.map((p) => ({
          ejercicio: p.ejercicio,
          saldoActualizado: p.saldoActualizado,
        })),
        pagosProvisionales: apertura.pagosProvisionalesEjercicio.length,
        obligacionesActivas: apertura.obligaciones.filter((o) => o.activa).map((o) => o.tipo),
        empleadosActivos: apertura.nomina.empleadosActivos,
        periodosSincronizados: apertura.sincronizacion.periodosCubiertos,
        periodosFaltantes: apertura.sincronizacion.faltantes.length,
      },
      req,
    });

    return NextResponse.json({
      ok: true,
      confirmadaAt: company.aperturaConfirmadaAt?.toISOString() ?? null,
      confirmadaPor: company.aperturaConfirmadaPor,
    });
  } catch (e) {
    console.error("[apertura] confirmar error:", e);
    return NextResponse.json({ error: "No se pudo confirmar la apertura" }, { status: 500 });
  }
}
