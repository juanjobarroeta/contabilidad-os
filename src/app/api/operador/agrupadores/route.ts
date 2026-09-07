import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isOperador } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { registrarBitacora } from "@/lib/audit";
import { SyntageClient } from "@/lib/fiscal/cumplimiento/syntage/client";
import { rellenarNombresDeCuentas } from "@/lib/contabilidad/ce-import-syntage";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/operador/agrupadores { companyId }
//
// Rellena nombres y códigos agrupadores desde los catálogos que la empresa YA
// presentó al SAT. Es exactamente lo que hace el cron ce-nombrar-cuentas; lo
// que cambia es quién puede dispararlo: aquí la sesión del operador, no el
// CRON_SECRET.
//
// POR QUÉ EXISTE. La alternativa era pegar el secreto de máquina en la consola
// del navegador para correr el cron a mano — y ahí queda, en el historial de
// la consola. Un secreto de máquina no debería pasar por las manos de nadie
// para hacer una tarea de mantenimiento rutinaria.
//
// Idempotente: en la segunda corrida no baja un solo XML.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id || !(await isOperador(session.user.id))) {
    return NextResponse.json({ error: "Sólo disponible para operador de plataforma" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as { companyId?: string } | null;
  const companyId = body?.companyId;
  if (!companyId) return NextResponse.json({ error: "companyId es requerido" }, { status: 400 });

  const empresa = await prisma.company.findUnique({
    where: { id: companyId },
    select: { rfc: true, razonSocial: true },
  });
  if (!empresa) return NextResponse.json({ error: "Empresa no encontrada" }, { status: 404 });

  const t0 = Date.now();
  const r = await rellenarNombresDeCuentas(companyId, new SyntageClient());
  if (r.error) return NextResponse.json({ error: r.error }, { status: 502 });

  if (r.nombradas > 0 || r.agrupadas > 0) {
    registrarBitacora({
      companyId,
      userId: session.user.id,
      actorEmail: session.user.email ?? null,
      accion: "contabilidad.catalogo.rellenar",
      entidad: "Company",
      entidadId: companyId,
      detalle: {
        nombradas: r.nombradas,
        agrupadas: r.agrupadas,
        agrupadasValidas: r.agrupadasValidas,
        catalogosLeidos: r.catalogosLeidos.length,
      },
      req,
    });
  }

  return NextResponse.json({
    empresa: { razonSocial: empresa.razonSocial, rfc: empresa.rfc },
    sinNombreAntes: r.sinNombreAntes,
    nombradas: r.nombradas,
    siguenSinNombre: r.siguenSinNombre.length,
    sinAgrupadorAntes: r.sinAgrupadorAntes,
    agrupadas: r.agrupadas,
    agrupadasValidas: r.agrupadasValidas,
    siguenSinAgrupador: r.siguenSinAgrupador.length,
    siguenSinAgrupadorCuentas: r.siguenSinAgrupadorCuentas,
    catalogosLeidos: r.catalogosLeidos.length,
    elapsedMs: Date.now() - t0,
  });
}
