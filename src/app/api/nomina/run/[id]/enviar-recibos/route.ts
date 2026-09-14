import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireWriter, AuthzError } from "@/lib/authz";
import { getFacturapiClient } from "@/lib/facturapi";
import { registrarBitacora } from "@/lib/audit";
import { variantesUuid, normalizarUuid } from "@/lib/fiscal/uuid";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/nomina/run/[id]/enviar-recibos — cada recibo timbrado a su empleado.
//
// Va por Facturapi (sendByEmail, PDF + XML), igual que facturas/[id]/email:
// no hay SMTP propio. Por eso sólo salen los recibos EMITIDOS desde la app
// (facturapiId); los importados del SAT se cuentan y se reportan, no se
// inventa un envío. Sin correo en el padrón se reporta por nombre: es lo que
// el contador tiene que capturar, no un error del sistema.
// ─────────────────────────────────────────────────────────────────────────────

const CONCURRENCIA = 4;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const run = await prisma.payrollRun.findUnique({
      where: { id },
      include: {
        company: { select: { facturapiApiKey: true } },
        items: { select: { cfdiUuid: true, employee: { select: { id: true, nombre: true, apellidoPaterno: true, email: true } } } },
      },
    });
    if (!run) return NextResponse.json({ error: "Corrida no encontrada" }, { status: 404 });
    const { user } = await requireWriter(run.companyId, req);
    if (run.status !== "STAMPED" && run.status !== "PAID") {
      return NextResponse.json({ error: "Sólo se envían corridas timbradas" }, { status: 409 });
    }
    if (!run.company.facturapiApiKey) return NextResponse.json({ error: "Facturapi no configurado" }, { status: 422 });

    const uuids = run.items.map((i) => i.cfdiUuid).filter((u): u is string => !!u);
    const invoices = uuids.length
      ? await prisma.invoice.findMany({ where: { companyId: run.companyId, uuid: { in: variantesUuid(uuids) } }, select: { uuid: true, facturapiId: true } })
      : [];
    const facturapiPorUuid = new Map(invoices.map((i) => [normalizarUuid(i.uuid ?? ""), i.facturapiId]));

    const nombreDe = (e: { nombre: string; apellidoPaterno: string }) => `${e.nombre} ${e.apellidoPaterno}`.trim();
    const sinCorreo: string[] = [];
    const errores: { nombre: string; error: string }[] = [];
    let importados = 0, sinTimbrar = 0, enviados = 0;
    const pendientes: { facturapiId: string; email: string; nombre: string }[] = [];
    for (const it of run.items) {
      if (!it.cfdiUuid) { sinTimbrar++; continue; }
      const facturapiId = facturapiPorUuid.get(normalizarUuid(it.cfdiUuid));
      if (!facturapiId) { importados++; continue; }
      const email = (it.employee.email ?? "").trim();
      if (!email) { sinCorreo.push(nombreDe(it.employee)); continue; }
      pendientes.push({ facturapiId, email, nombre: nombreDe(it.employee) });
    }

    const fp = getFacturapiClient(run.company.facturapiApiKey);
    for (let i = 0; i < pendientes.length; i += CONCURRENCIA) {
      const lote = pendientes.slice(i, i + CONCURRENCIA);
      const res = await Promise.allSettled(lote.map((p) => fp.invoices.sendByEmail(p.facturapiId, { email: p.email })));
      res.forEach((r, k) => {
        if (r.status === "fulfilled") enviados++;
        else errores.push({ nombre: lote[k].nombre, error: r.reason instanceof Error ? r.reason.message : "error de Facturapi" });
      });
    }

    registrarBitacora({
      companyId: run.companyId, userId: user.id, actorEmail: user.email,
      accion: "nomina.enviar-recibos", entidad: "PayrollRun", entidadId: run.id,
      detalle: { periodo: run.periodo, recibos: enviados, sinCorreo: sinCorreo.length, importados, errores: errores.length },
      req,
    });
    return NextResponse.json({ ok: true, enviados, sinCorreo, importados, sinTimbrar, errores });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: e instanceof Error ? e.message : "Error al enviar" }, { status: 500 });
  }
}
