import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getPacProvider } from "@/lib/pac";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { gateEscritura } from "@/lib/subscription";
import { registrarBitacora } from "@/lib/audit";
import { variantesUuid } from "@/lib/fiscal/uuid";

const VALID_MOTIVOS = ["01", "02", "03", "04"] as const;

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/nomina/recibos/cancelar — cancela ante el SAT el CFDI de nómina de
// un PayrollItem y deja al empleado LISTO PARA RETIMBRAR:
//
//   1. Cancela vía PAC (mismo contrato que facturas: sólo marcamos CANCELLED
//      si el SAT confirma — receptor empleado, sin paso de aceptación).
//   2. Limpia cfdiUuid/facturapiId del PayrollItem (el timbrado filtra por
//      !cfdiUuid, así que el empleado vuelve a ser timbrable).
//   3. Regresa la corrida STAMPED → CALCULATED para que "Timbrar" se rehabilite
//      (sólo emite los items sin cfdiUuid; no duplica a los demás).
//
// Body: { companyId, payrollItemId, motivo: "01"|"02"|"03"|"04", sustituyeUuid? }
// Sólo recibos EMITIDOS POR LA APP (facturapiId). Los importados del SAT se
// cancelan donde se emitieron.
// ─────────────────────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { companyId, payrollItemId } = body ?? {};
  const motivo = String(body?.motivo ?? "");
  const sustituyeUuid = body?.sustituyeUuid ? String(body.sustituyeUuid).trim() : null;

  if (!companyId || !payrollItemId) {
    return NextResponse.json({ error: "companyId y payrollItemId requeridos" }, { status: 400 });
  }
  if (!VALID_MOTIVOS.includes(motivo as (typeof VALID_MOTIVOS)[number])) {
    return NextResponse.json({ error: "Falta el motivo de cancelación (01, 02, 03 o 04)." }, { status: 400 });
  }
  if (motivo === "01" && !sustituyeUuid) {
    return NextResponse.json(
      { error: "El motivo 01 requiere el UUID del recibo que lo sustituye." },
      { status: 400 }
    );
  }

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member || member.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }
  const gate = await gateEscritura(session.user.id);
  if (gate) return gate;

  const item = await prisma.payrollItem.findUnique({
    where: { id: payrollItemId },
    select: {
      id: true,
      cfdiUuid: true,
      payrollRunId: true,
      employee: { select: { nombre: true, apellidoPaterno: true } },
      payrollRun: { select: { id: true, companyId: true, status: true, extraData: true } },
    },
  });
  if (!item || item.payrollRun.companyId !== companyId) {
    return NextResponse.json({ error: "Recibo no encontrado" }, { status: 404 });
  }
  if (!item.cfdiUuid) {
    return NextResponse.json({ error: "El recibo no está timbrado" }, { status: 409 });
  }

  const [invoice, company] = await Promise.all([
    prisma.invoice.findFirst({
      where: { companyId, tipo: "NOMINA", uuid: { in: variantesUuid([item.cfdiUuid]) } },
      select: { id: true, uuid: true, facturapiId: true, status: true },
    }),
    prisma.company.findUnique({ where: { id: companyId }, select: { facturapiApiKey: true } }),
  ]);
  if (invoice?.status === "CANCELLED") {
    return NextResponse.json({ error: "El recibo ya está cancelado" }, { status: 409 });
  }
  if (!invoice?.facturapiId || !company?.facturapiApiKey) {
    return NextResponse.json(
      {
        error:
          "Este recibo no se emitió desde la app (es historial importado del SAT); cancélalo en el sistema donde se timbró o desde el portal del SAT.",
      },
      { status: 422 }
    );
  }

  // Cancelación real ante el SAT. Igual que facturas: si el PAC no confirma,
  // NO tocamos nada local — el CFDI sigue vigente.
  const out = await getPacProvider().cancelCfdi(
    { apiKey: company.facturapiApiKey, companyId, actor: "nomina-cancelar" },
    invoice.facturapiId,
    motivo,
    sustituyeUuid ?? undefined
  );
  if (!out.ok) {
    return NextResponse.json(
      { error: `No se pudo cancelar ante el SAT: ${out.message}`, kind: out.kind },
      { status: out.status }
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.invoice.update({
      where: { id: invoice.id },
      data: {
        status: "CANCELLED",
        canceladaAt: new Date(),
        cancelMotivo: motivo,
        cancelSustituyeUuid: sustituyeUuid,
      },
    });
    await tx.payrollItem.update({
      where: { id: item.id },
      data: { cfdiUuid: null, facturapiId: null },
    });
    // La corrida vuelve a CALCULATED para que el candado permita retimbrar al
    // empleado (el filtro !cfdiUuid protege a los demás de duplicarse). PAID
    // también se regresa: dejarlo bloquearía el retimbrado sin salida (el
    // candado exige CALCULATED); al terminar el retimbrado queda STAMPED y la
    // dispersión se re-registra si aplica.
    const timbradosRestantes = await tx.payrollItem.count({
      where: { payrollRunId: item.payrollRunId, cfdiUuid: { not: null } },
    });
    await tx.payrollRun.update({
      where: { id: item.payrollRunId },
      data: {
        ...(item.payrollRun.status === "STAMPED" || item.payrollRun.status === "PAID"
          ? { status: "CALCULATED" }
          : {}),
        extraData: {
          ...((item.payrollRun.extraData as Record<string, unknown>) ?? {}),
          stampedCount: timbradosRestantes,
        },
      },
    });
  });

  registrarBitacora({
    accion: "nomina.cancelar-timbre",
    userId: session.user.id,
    companyId,
    entidad: "Invoice",
    entidadId: invoice.id,
    detalle: {
      uuid: invoice.uuid,
      motivo,
      ...(sustituyeUuid ? { sustituyeUuid } : {}),
      empleado: `${item.employee.nombre} ${item.employee.apellidoPaterno}`,
      payrollItemId: item.id,
    },
  });

  return NextResponse.json({
    ok: true,
    uuid: invoice.uuid,
    empleado: `${item.employee.nombre} ${item.employee.apellidoPaterno}`,
  });
}
