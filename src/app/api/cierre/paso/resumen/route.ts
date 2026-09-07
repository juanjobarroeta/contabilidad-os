import { NextResponse } from "next/server";
import { withAuthz } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { parsePeriodoQuery, requireCierreGuiado } from "@/lib/cierre/gate";
import { aperturaDelPaso } from "@/lib/cierre/resumen-paso";
import { esClavePaso } from "@/lib/cierre/claves";
import { quedoStaged, TIPO_DE_TOOL, toolsAProbar } from "@/lib/cierre/acciones";
import { evaluarCierre } from "@/lib/cierre/evaluar";
import { executeToolCall } from "@/lib/ai/tool-executor";
import { getChatPendingAction } from "@/lib/ai/pending-action";
import { conversacionDelPeriodo } from "@/lib/cierre/pase-diario";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/cierre/paso/resumen?companyId=&year=&month=&clave=
//
// La apertura del paso escrita por el copiloto, cacheada por el hash de la
// evidencia: sólo se paga cuando los datos del paso cambiaron. Plan PRO.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const GET = withAuthz(async (req: Request) => {
  const sp = new URL(req.url).searchParams;
  const p = parsePeriodoQuery(sp);
  const clave = sp.get("clave");
  if (!p || !esClavePaso(clave)) {
    return NextResponse.json({ error: "companyId, year, month y clave son requeridos" }, { status: 400 });
  }
  const { user, membership } = await requireCierreGuiado(p.companyId, undefined, req);
  const rol = membership.role;
  const empresa = await prisma.company.findUnique({ where: { id: p.companyId }, select: { razonSocial: true } });
  const r = await aperturaDelPaso({
    companyId: p.companyId,
    year: p.year,
    month: p.month,
    clave,
    userId: user.id,
    empresa: empresa?.razonSocial ?? "la empresa",
  });

  // La tarjeta del paso, puesta sin que nadie la pida (ver acciones.ts). Sólo
  // para quien puede escribir, y nunca encima de una propuesta ya en pantalla.
  const pendingAction = await tarjetaDelPaso({
    companyId: p.companyId,
    year: p.year,
    month: p.month,
    clave,
    userId: user.id,
    puedeEscribir: rol !== "VIEWER",
  });

  return NextResponse.json({ ...r, pendingAction });
});

/**
 * Prueba las propuestas candidatas del paso y devuelve la que quedó puesta.
 * Cada herramienta se valida a sí misma; la primera que sobrevive es la
 * tarjeta. Best-effort: si algo falla, la pantalla sigue sirviendo sin tarjeta.
 */
async function tarjetaDelPaso(args: {
  companyId: string;
  year: number;
  month: number;
  clave: Parameters<typeof aperturaDelPaso>[0]["clave"];
  userId: string;
  puedeEscribir: boolean;
}) {
  const { companyId, year, month, clave, userId, puedeEscribir } = args;
  if (!puedeEscribir) return null;
  try {
    const conversationId = await conversacionDelPeriodo(companyId, year, month, null);
    if (!conversationId) return null;

    const cierre = await evaluarCierre(companyId, year, month);
    const paso = cierre.pasos.find((x) => x.clave === clave);
    if (!paso) return null;
    const candidatas = toolsAProbar(paso);

    // Si ya hay una propuesta Y es de este paso, se respeta tal cual (puede ser
    // la que el contador está a punto de tocar). Si es de otro paso, la del
    // paso abierto la sustituye: una propuesta a la vez, la del contexto.
    const yaHay = await getChatPendingAction(conversationId);
    if (yaHay && candidatas.some((t) => TIPO_DE_TOOL[t] === yaHay.type)) {
      return { type: yaHay.type, summary: yaHay.summary, token: yaHay.token, expiresAt: yaHay.expiresAt };
    }

    for (const tool of candidatas) {
      const salida = await executeToolCall(tool, { year, month }, companyId, {
        conversationId,
        inApp: true,
        userId,
        cierre: { year, month, paso: clave },
      });
      if (!quedoStaged(salida)) continue;
      const pa = await getChatPendingAction(conversationId);
      if (pa) return { type: pa.type, summary: pa.summary, token: pa.token, expiresAt: pa.expiresAt };
    }
    return null;
  } catch (e) {
    console.error("[cierre/resumen] tarjeta del paso falló:", companyId, clave, e instanceof Error ? e.message : e);
    return null;
  }
}
