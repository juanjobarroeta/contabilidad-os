import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { SyntageClient } from "@/lib/fiscal/cumplimiento/syntage/client";
import {
  clasificarSlot,
  liberarSlotSyntage,
  type AccionSlot,
} from "@/lib/fiscal/cumplimiento/syntage/deprovision";
import { planIncluyeSyntage } from "@/lib/planes";
import { empresasConPagoVigente } from "@/lib/billing/pagadores";

// ─────────────────────────────────────────────────────────────────────────────
// GET/POST /api/cron/syntage-liberar-slots   [?ejecutar=1]
//
// Reconciliación de los RFC VINCULADOS en Syntage contra la realidad del
// negocio: cada credencial en Syntage ocupa un lugar del plan (y cuesta),
// exista o no el cliente. Barre todas las credenciales y clasifica cada RFC
// (clasificarSlot, puro):
//   huerfana         → la empresa ya no existe (baja) → borrar credenciales + entidad
//   sin_fiel         → empresa sin e.firma guardada   → borrar credenciales
//   plan_sin_syntage → tier ASISTENTE                 → borrar credenciales
//   sin_pago         → ningún pagador vigente         → borrar credenciales
//   activa           → conservar
//
// SIN ?ejecutar=1 es SIMULACIÓN: reporta qué liberaría, no borra nada. Es
// reversible: la e.firma vive en nuestra DB y compliance-provision recrea
// credencial y extracciones solo, en cuanto el cliente vuelve a estar al
// corriente. Auth: CRON_SECRET (mismo patrón que compliance-provision).
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization");
  if (auth && auth === `Bearer ${secret}`) return true;
  return req.headers.get("x-cron-secret") === secret;
}

type Detalle = {
  rfc: string;
  credenciales: number;
  companyId: string | null;
  razonSocial: string | null;
} & AccionSlot & {
    liberacion?: { credencialesBorradas: number; entidadBorrada: boolean; errores: string[] };
  };

async function handle(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ejecutar = new URL(req.url).searchParams.get("ejecutar") === "1";

  try {
    const client = new SyntageClient();
    const creds = await client.listCredentials();

    // Credenciales agrupadas por RFC (un RFC puede tener varias, p.ej. una
    // inválida vieja y la vigente — todas ocupan el slot).
    const porRfc = new Map<string, number>();
    for (const c of creds) {
      const rfc = String(c.rfc ?? "").trim().toUpperCase();
      if (!rfc) continue;
      porRfc.set(rfc, (porRfc.get(rfc) ?? 0) + 1);
    }

    // Estado local de cada RFC vinculado, en dos consultas (empresas + pagos).
    const companies = await prisma.company.findMany({
      where: { rfc: { in: Array.from(porRfc.keys()) } },
      select: { id: true, rfc: true, razonSocial: true, tier: true, fielCer: true, fielKey: true, fielPassword: true },
    });
    const porRfcLocal = new Map(companies.map((c) => [c.rfc.trim().toUpperCase(), c]));
    const conPago = await empresasConPagoVigente(companies.map((c) => c.id));

    const detalles: Detalle[] = [];
    for (const [rfc, numCreds] of porRfc) {
      const local = porRfcLocal.get(rfc);
      const decision = clasificarSlot({
        existe: !!local,
        tieneFiel: !!(local?.fielCer && local?.fielKey && local?.fielPassword),
        incluyeSyntage: local ? planIncluyeSyntage(local.tier) : undefined,
        pagoVigente: local ? conPago.has(local.id) : undefined,
      });
      const d: Detalle = {
        rfc,
        credenciales: numCreds,
        companyId: local?.id ?? null,
        razonSocial: local?.razonSocial ?? null,
        ...decision,
      };
      if (ejecutar && decision.accion === "liberar") {
        const lib = await liberarSlotSyntage(rfc, { borrarEntidad: decision.borrarEntidad, client });
        d.liberacion = {
          credencialesBorradas: lib.credencialesBorradas,
          entidadBorrada: lib.entidadBorrada,
          errores: lib.errores,
        };
      }
      detalles.push(d);
    }

    const porMotivo: Record<string, number> = {};
    for (const d of detalles) porMotivo[d.motivo] = (porMotivo[d.motivo] ?? 0) + 1;
    const aLiberar = detalles.filter((d) => d.accion === "liberar");

    return NextResponse.json({
      ok: true,
      modo: ejecutar ? "ejecutado" : "simulacion",
      rfcsVinculados: porRfc.size,
      slotsALiberar: aLiberar.length,
      porMotivo,
      // En simulación se listan sólo los liberables (lo accionable); en
      // ejecución, todo con su resultado.
      detalles: ejecutar ? detalles : aLiberar,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}

export async function POST(req: Request) {
  return handle(req);
}
export async function GET(req: Request) {
  return handle(req);
}
