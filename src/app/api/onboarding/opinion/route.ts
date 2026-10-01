import { NextResponse } from "next/server";
import { AuthzError, requireWriter } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { SatGoComplianceProvider } from "@/lib/fiscal/cumplimiento/satgo/provider";
import { satGoConfigurado } from "@/lib/fiscal/cumplimiento/satgo/client";
import { persistComplianceResult } from "@/lib/fiscal/cumplimiento/persist";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/onboarding/opinion { companyId } — la opinión de cumplimiento 32-D
// al final de la pantalla 04, con la e.firma recién guardada. Es la misma
// consulta que corre la agenda (CUMPLIMIENTO): SatGo → PDF → interpretación →
// ComplianceSnapshot (+ hallazgos si es negativa). Si el SAT no responde, el
// alta sigue: la agenda la vuelve a pedir.
// ─────────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as { companyId?: string } | null;
    const companyId = typeof body?.companyId === "string" ? body.companyId : "";
    if (!companyId) return NextResponse.json({ error: "Falta companyId" }, { status: 400 });
    await requireWriter(companyId, req);

    if (!satGoConfigurado()) {
      return NextResponse.json({ error: "La consulta al SAT no está disponible en este momento." }, { status: 503 });
    }
    const company = await prisma.company.findUnique({ where: { id: companyId }, select: { rfc: true } });
    if (!company) return NextResponse.json({ error: "Empresa no encontrada" }, { status: 404 });

    try {
      const provider = new SatGoComplianceProvider(async () => company.rfc);
      const r = await provider.fetchSatOpinion(companyId);
      await persistComplianceResult(companyId, r);
      return NextResponse.json({ resultado: r.resultado, motivos: r.motivos, vigencia: r.vigencia ?? null, fetchedAt: r.fetchedAt });
    } catch (e) {
      console.warn("[onboarding/opinion] 32-D falló:", e instanceof Error ? e.message : e);
      return NextResponse.json({ error: "El SAT no respondió con tu opinión de cumplimiento." }, { status: 502 });
    }
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
