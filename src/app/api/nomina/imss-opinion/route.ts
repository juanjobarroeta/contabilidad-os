import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, requireWriter, getEffectiveCompanyMembership, AuthzError } from "@/lib/authz";
import { registrarBitacora } from "@/lib/audit";
import { persistComplianceResult } from "@/lib/fiscal/cumplimiento";
import { SatGoComplianceProvider, SatGoError, satGoConfigurado } from "@/lib/fiscal/cumplimiento/satgo";

// ─────────────────────────────────────────────────────────────────────────────
// Opinión de cumplimiento IMSS (OCOFSS).
//   GET  ?companyId=  → la última guardada (ComplianceSnapshot IMSS_OPINION) y si
//                        SatGo está configurado para pedir otra.
//   POST {companyId}  → la pide al IMSS vía SatGo (sólo RFC), la lee y la guarda
//                        con persistComplianceResult (hallazgos si es negativa).
// El IMSS tarda ~1–2 min: maxDuration alto. Si el IMSS está caído no se guarda
// nada: se devuelve 502 con el mensaje y se reintenta después.
// ─────────────────────────────────────────────────────────────────────────────

export const maxDuration = 300;

function fila(s: { id: string; resultado: string; motivos: string[]; vigencia: Date | null; fetchedAt: Date; acuseUrl: string | null }) {
  return { snapshotId: s.id, resultado: s.resultado, motivos: s.motivos, vigencia: s.vigencia?.toISOString().slice(0, 10) ?? null, fetchedAt: s.fetchedAt.toISOString(), tieneAcuse: !!s.acuseUrl };
}
const SELECT = { id: true, resultado: true, motivos: true, vigencia: true, fetchedAt: true, acuseUrl: true } as const;

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    const companyId = new URL(req.url).searchParams.get("companyId");
    if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
    if (!(await getEffectiveCompanyMembership(user.id, companyId))) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });
    const s = await prisma.complianceSnapshot.findFirst({ where: { companyId, tipo: "IMSS_OPINION" }, orderBy: { fetchedAt: "desc" }, select: SELECT });
    return NextResponse.json({ opinion: s ? fila(s) : null, configurado: satGoConfigurado() });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { companyId?: string };
    if (!body.companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
    const { user } = await requireWriter(body.companyId, req);
    if (!satGoConfigurado()) return NextResponse.json({ error: "Integración SatGo no configurada (SATGO_API_KEY)" }, { status: 503 });

    const provider = new SatGoComplianceProvider(async (id) => {
      const c = await prisma.company.findUnique({ where: { id }, select: { rfc: true } });
      if (!c?.rfc) throw new Error("La empresa no tiene RFC");
      return c.rfc;
    });
    const t0 = Date.now();
    const result = await provider.fetchImssOpinion(body.companyId);
    const persist = await persistComplianceResult(body.companyId, result);
    const s = await prisma.complianceSnapshot.findFirst({ where: { companyId: body.companyId, tipo: "IMSS_OPINION" }, orderBy: { fetchedAt: "desc" }, select: SELECT });

    registrarBitacora({
      companyId: body.companyId, userId: user.id, actorEmail: user.email,
      accion: "cumplimiento.imss-opinion", entidad: "ComplianceSnapshot", entidadId: s?.id ?? null,
      detalle: { resultado: result.resultado, vigencia: result.vigencia ?? null, cambio: persist.changed, hallazgos: persist.hallazgos, ms: Date.now() - t0 },
      req,
    });
    return NextResponse.json({ ok: true, opinion: s ? fila(s) : null, cambio: persist.changed, hallazgos: persist.hallazgos });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    if (e instanceof SatGoError) return NextResponse.json({ error: e.message, transitorio: e.transitorio }, { status: e.transitorio ? 502 : e.status >= 400 && e.status < 600 ? e.status : 502 });
    return NextResponse.json({ error: e instanceof Error ? e.message : "No se pudo consultar al IMSS" }, { status: 500 });
  }
}
