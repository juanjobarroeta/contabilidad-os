import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import type { FamiliaConcepto, SignoMovimiento } from "@/lib/bancos/categorizar-concepto";
import { FAMILIA_META } from "@/lib/bancos/categorizar-concepto";
import {
  aprobarSugerenciasEnLote,
  aplicarReglaRetroactiva,
  upsertReglaCategorizacion,
  contarSimilaresSinConciliar,
} from "@/lib/bancos/reglas-categorizacion";

const FAMILIAS_VALIDAS = Object.keys(FAMILIA_META) as FamiliaConcepto[];

/**
 * GET /api/bancos/sugerencias/lote?companyId=&patron=&signo=
 * Cuenta cuántos movimientos UNMATCHED SIN CFDI empatarían con el patrón — lo
 * usa la UI para confirmar "categorizar N similares" antes de ejecutar.
 */
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const companyId = url.searchParams.get("companyId");
  const patron = url.searchParams.get("patron") ?? "";
  const signo = url.searchParams.get("signo");

  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  if (signo && signo !== "CREDITO" && signo !== "DEBITO") {
    return NextResponse.json({ error: "signo inválido" }, { status: 400 });
  }

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  const count = await contarSimilaresSinConciliar(
    companyId,
    patron,
    (signo as SignoMovimiento | null) ?? null,
  );
  return NextResponse.json({ count });
}

/**
 * POST /api/bancos/sugerencias/lote
 * Body: {
 *   txIds: string[];            // movimientos a categorizar con la MISMA familia
 *   familia: FamiliaConcepto;
 *   crearRegla?: boolean;       // si true, persiste (upsert) una regla del patrón
 *   patron?: string;            // token/patrón de la regla (requerido si crearRegla)
 *   signo?: "CREDITO"|"DEBITO"; // acota la regla/retro-scan a un signo (opcional)
 *   retroactivo?: boolean;      // re-escanea los UNMATCHED existentes con el patrón
 * }
 *
 * Categoriza en lote reusando el `aprobarSugerencia` idempotente (mismo asiento y
 * etiqueta de notes que el cierre mensual lee). Opcionalmente recuerda la regla y
 * la aplica de forma retroactiva a los demás movimientos similares sin conciliar.
 */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const txIds: unknown = body?.txIds;
  const familia: unknown = body?.familia;
  const crearRegla = body?.crearRegla === true;
  const retroactivo = body?.retroactivo === true;
  const patron: unknown = body?.patron;
  const signo: unknown = body?.signo;

  if (!Array.isArray(txIds) || txIds.some((t) => typeof t !== "string")) {
    return NextResponse.json({ error: "txIds requerido (arreglo de ids)" }, { status: 400 });
  }
  if (typeof familia !== "string" || !FAMILIAS_VALIDAS.includes(familia as FamiliaConcepto)) {
    return NextResponse.json({ error: "familia inválida" }, { status: 400 });
  }
  if (signo !== undefined && signo !== "CREDITO" && signo !== "DEBITO") {
    return NextResponse.json({ error: "signo inválido" }, { status: 400 });
  }
  if (crearRegla && (typeof patron !== "string" || !patron.trim())) {
    return NextResponse.json({ error: "patron requerido para crear la regla" }, { status: 400 });
  }
  if ((txIds as string[]).length === 0 && !retroactivo) {
    return NextResponse.json({ error: "No hay movimientos que categorizar" }, { status: 400 });
  }

  // Authz: todos los movimientos deben pertenecer a UNA sola empresa a la que el
  // usuario tiene acceso de escritura. Si no vienen txIds (sólo retro-scan), la
  // empresa se toma del body.companyId.
  const ids = txIds as string[];
  let companyId: string | null = typeof body?.companyId === "string" ? body.companyId : null;
  if (ids.length > 0) {
    const rows = await prisma.bankTransaction.findMany({
      where: { id: { in: ids } },
      select: { companyId: true },
    });
    const empresas = new Set(rows.map((r) => r.companyId));
    if (empresas.size === 0) {
      return NextResponse.json({ error: "Movimientos no encontrados" }, { status: 404 });
    }
    if (empresas.size > 1) {
      return NextResponse.json({ error: "Los movimientos son de más de una empresa" }, { status: 400 });
    }
    companyId = [...empresas][0];
  }
  if (!companyId) {
    return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  }

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member || member.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }

  const familiaV = familia as FamiliaConcepto;
  const signoV = (signo as SignoMovimiento | undefined) ?? undefined;

  // 1) Categoriza los movimientos seleccionados.
  const lote = await aprobarSugerenciasEnLote(ids, familiaV);

  // 2) Recuerda la regla (upsert) si se pidió.
  let regla: { id: string; created: boolean } | null = null;
  if (crearRegla && typeof patron === "string") {
    regla = await upsertReglaCategorizacion({
      companyId,
      pattern: patron.trim(),
      familia: familiaV,
      signo: signoV ?? null,
      createdBy: session.user.email ?? session.user.id,
    });
  }

  // 3) Escaneo retroactivo opcional: aplica el patrón a los DEMÁS movimientos
  //    UNMATCHED sin CFDI (los que no venían en txIds). Idempotente.
  let retro: Awaited<ReturnType<typeof aplicarReglaRetroactiva>> | null = null;
  if (retroactivo && typeof patron === "string" && patron.trim()) {
    retro = await aplicarReglaRetroactiva(companyId, patron.trim(), familiaV, signoV ?? null);
  }

  return NextResponse.json({ ok: true, lote, regla, retro });
}
