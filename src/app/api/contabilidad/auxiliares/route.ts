/**
 * GET  /api/contabilidad/auxiliares?companyId=[&codigoMotor=]
 *      → { codigos: [{ codigoMotor, nombreAgrupador, padron, pares, sinPareja, yaLigados }] }
 * POST /api/contabilidad/auxiliares { companyId, codigoMotor, modo: "exactas" }
 *      { companyId, parejas: [{ chartAccountId, customerId }] }
 *      → { aplicadas }
 *
 * El enlace contraparte → auxiliar del catálogo propio (Fase 2i del plan).
 * NO cambia dónde postea nada todavía: escribe `Customer.chartAccountId`, que
 * el motor aún no consulta. Primero se puebla y se revisa; conectarlo al
 * posteo es el paso siguiente, y va con re-posteo de la historia.
 *
 * `modo: "exactas"` aplica sólo los nombres idénticos. Lo PARECIDO se manda
 * explícito en `parejas`, una vez que una persona lo miró: un enlace malo no
 * se nota —la balanza cuadra igual, con el saldo en el renglón de otro— y ése
 * es el error más caro que hay.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireWriter, withAuthz } from "@/lib/authz";
import { registrarBitacora } from "@/lib/audit";
import { aplicarParejas, emparejarAuxiliares, type Pareja } from "@/lib/contabilidad/auxiliar-contraparte";
import { DIMENSION_POR_CODIGO, dimensionDe } from "@/lib/contabilidad/dimension-codigo";
import { CODIGO_AGRUPADOR_OFICIAL } from "@/lib/contabilidad/codigo-agrupador";

const PORCONTRAPARTE = Object.entries(DIMENSION_POR_CODIGO)
  .filter(([, d]) => d.dimension === "CONTRAPARTE")
  .map(([c]) => c);

export const GET = withAuthz(async (req: Request) => {
  const url = new URL(req.url);
  const companyId = url.searchParams.get("companyId") ?? "";
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  await requireMembership(companyId, undefined, req);

  const uno = url.searchParams.get("codigoMotor");
  const codigos = uno ? [uno] : PORCONTRAPARTE;

  const out = [];
  for (const codigoMotor of codigos) {
    const r = await emparejarAuxiliares(prisma, companyId, codigoMotor);
    // Un código sin auxiliares no tiene nada que enseñar.
    if (r.pares.length === 0 && r.sinPareja.length === 0 && r.yaLigados === 0) continue;
    out.push({
      ...r,
      nombreAgrupador: CODIGO_AGRUPADOR_OFICIAL[codigoMotor] ?? null,
      padron: dimensionDe(codigoMotor).padron ?? null,
      porque: dimensionDe(codigoMotor).porque,
    });
  }
  return NextResponse.json({ codigos: out });
});

const postSchema = z.union([
  z.object({ companyId: z.string().min(1), codigoMotor: z.string().min(1), modo: z.literal("exactas") }),
  z.object({
    companyId: z.string().min(1),
    parejas: z.array(z.object({ chartAccountId: z.string().min(1), customerId: z.string().min(1) })).min(1).max(500),
  }),
]);

export const POST = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => null);
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "cuerpo inválido" }, { status: 400 });
  const d = parsed.data;

  const { user } = await requireWriter(d.companyId, req);

  let aplicadas = 0;
  let detalle: Record<string, string | number>;

  if ("modo" in d) {
    const r = await emparejarAuxiliares(prisma, d.companyId, d.codigoMotor);
    aplicadas = await aplicarParejas(prisma, d.companyId, r.pares);
    detalle = { codigoMotor: d.codigoMotor, modo: "exactas", propuestas: r.pares.length, aplicadas };
  } else {
    // Confirmadas a mano: se escriben aunque sean PARECIDA, porque alguien las vio.
    const pares = d.parejas.map((p) => ({ ...p, confianza: "EXACTA" }) as Pareja);
    aplicadas = await aplicarParejas(prisma, d.companyId, pares, { soloExactas: false });
    detalle = { modo: "confirmadas", propuestas: d.parejas.length, aplicadas };
  }

  await registrarBitacora({
    companyId: d.companyId,
    userId: user.id,
    accion: "contabilidad.auxiliar.ligar",
    entidad: "Customer",
    detalle,
  });
  return NextResponse.json({ aplicadas });
});
