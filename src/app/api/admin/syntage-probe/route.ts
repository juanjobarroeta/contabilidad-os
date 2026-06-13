import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { decryptSecret } from "@/lib/crypto";
import {
  SyntageClient,
  mapTaxCompliance,
  mapTaxStatus,
  type Extractor,
} from "@/lib/fiscal/cumplimiento/syntage";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/syntage-probe   { "companyId": "..." }   (o { "rfc", "ciec" })
//
// Prueba en vivo de un extremo a otro contra Syntage para UNA empresa:
//   1) crea/reutiliza la entidad por RFC,
//   2) registra la credencial (e.firma guardada de la empresa, o CIEC del body),
//   3) espera a que valide,
//   4) corre extracciones tax_compliance (opinión) y tax_status (CSF),
//   5) devuelve el RAW + el mapeado, para cotejar map.ts contra la respuesta real.
//
// NO persiste nada (solo lectura de nuestro lado). Consume cuota de extracción
// del trial. Auth: CRON_SECRET. No registra secretos en la respuesta.
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

type CredInput =
  | { type: "ciec"; password: string }
  | { type: "efirma"; certificate: string; privateKey: string; password: string };

export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    companyId?: string;
    buscar?: string; // por razón social (contiene, sin distinguir mayúsculas)
    rfc?: string;
    ciec?: string;
  };
  const pasos: unknown[] = [];

  try {
    const client = new SyntageClient();

    // Resolver RFC + credencial.
    let rfc = body.rfc ?? "";
    let cred: CredInput | null = null;

    if (body.companyId || body.buscar) {
      const c = body.companyId
        ? await prisma.company.findUnique({
            where: { id: body.companyId },
            select: { rfc: true, razonSocial: true, fielCer: true, fielKey: true, fielPassword: true },
          })
        : await prisma.company.findFirst({
            where: { razonSocial: { contains: body.buscar!, mode: "insensitive" } },
            select: { rfc: true, razonSocial: true, fielCer: true, fielKey: true, fielPassword: true },
          });
      if (!c) return NextResponse.json({ error: "Empresa no encontrada" }, { status: 404 });
      rfc = c.rfc;
      pasos.push({ paso: "empresa", razonSocial: c.razonSocial, rfc });
      if (body.ciec) {
        cred = { type: "ciec", password: body.ciec };
      } else if (c.fielCer && c.fielKey && c.fielPassword) {
        cred = {
          type: "efirma",
          certificate: decryptSecret(c.fielCer),
          privateKey: decryptSecret(c.fielKey),
          password: decryptSecret(c.fielPassword),
        };
        pasos.push({ paso: "credencial_fuente", tipo: "efirma (guardada)" });
      } else {
        return NextResponse.json(
          { error: "La empresa no tiene e.firma guardada; pasa { ciec } en el body." },
          { status: 400 },
        );
      }
    } else if (body.rfc && body.ciec) {
      cred = { type: "ciec", password: body.ciec };
    } else {
      return NextResponse.json({ error: "Pasa { companyId } o { rfc, ciec }" }, { status: 400 });
    }

    // 1) Entidad.
    const entity = await client.ensureEntity(rfc);
    pasos.push({ paso: "entidad", entityId: entity.id });

    // 2) Credencial.
    const created =
      cred.type === "ciec"
        ? await client.createCiecCredential(rfc, cred.password)
        : await client.createEfirmaCredential(cred);
    pasos.push({ paso: "credencial", credentialId: created.id, status: created.status });

    // 3) Validación.
    await client.waitForCredentialValid(created.id);
    pasos.push({ paso: "credencial_valida" });

    // 4) Extracciones.
    const run = async (extractor: Extractor) => {
      const { id } = await client.createExtraction({ extractor, entity: entity.id });
      pasos.push({ paso: "extraccion", extractor, extractionId: id });
      return client.waitForExtraction(id, { timeoutMs: 180_000 });
    };
    const opinionRaw = await run("tax_compliance");
    const csfRaw = await run("tax_status");

    // 5) Crudo + mapeado (para cotejar map.ts).
    return NextResponse.json({
      ok: true,
      rfc,
      entityId: entity.id,
      pasos,
      opinion: { raw: opinionRaw, mapped: mapTaxCompliance(opinionRaw) },
      csf: { raw: csfRaw, mapped: mapTaxStatus(csfRaw) },
    });
  } catch (e) {
    const err = e as { message?: string; status?: number; body?: unknown };
    return NextResponse.json(
      { ok: false, pasos, error: err.message ?? String(e), status: err.status, detail: err.body },
      { status: 502 },
    );
  }
}
