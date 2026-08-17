import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { abrirCredencial } from "@/lib/vault";
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
    soloLeer?: boolean; // solo lee los últimos resultados ya extraídos (rápido)
    declaraciones?: boolean; // con soloLeer: incluye tax-returns (anuales raw + resumen mensuales)
  };
  const pasos: unknown[] = [];

  try {
    const client = new SyntageClient();

    // Resolver RFC + credencial.
    let rfc = body.rfc ?? "";
    let nombre = body.rfc ?? "";
    let cred: CredInput | null = null;

    if (body.companyId || body.buscar) {
      const c = body.companyId
        ? await prisma.company.findUnique({
            where: { id: body.companyId },
            select: { id: true, rfc: true, razonSocial: true, fielCer: true, fielKey: true, fielPassword: true },
          })
        : await prisma.company.findFirst({
            where: { razonSocial: { contains: body.buscar!, mode: "insensitive" } },
            select: { id: true, rfc: true, razonSocial: true, fielCer: true, fielKey: true, fielPassword: true },
          });
      if (!c) return NextResponse.json({ error: "Empresa no encontrada" }, { status: 404 });
      rfc = c.rfc;
      nombre = c.razonSocial;
      pasos.push({ paso: "empresa", razonSocial: c.razonSocial, rfc });
      if (body.ciec) {
        cred = { type: "ciec", password: body.ciec };
      } else if (c.fielCer && c.fielKey && c.fielPassword) {
        const fiel = abrirCredencial({
          companyId: c.id,
          tipo: "fiel",
          proposito: "syntage-provision",
          actor: "operador:syntage-probe",
          valores: { cer: c.fielCer, key: c.fielKey, password: c.fielPassword },
        });
        cred = {
          type: "efirma",
          certificate: fiel.cer,
          privateKey: fiel.key,
          password: fiel.password,
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

    // Modo solo-lectura: trae los últimos resultados ya extraídos (sin correr
    // extracción nueva) — rápido, evita el timeout del proxy.
    if (body.soloLeer) {
      const ent = await client.findEntityByRfc(rfc);
      if (!ent) {
        return NextResponse.json(
          { ok: false, pasos, error: "No hay entidad en Syntage para ese RFC; corre primero una extracción." },
          { status: 404 },
        );
      }
      const [opinionRes, csfRes] = await Promise.all([
        client.getLatestTaxComplianceCheck(ent.id),
        client.getLatestTaxStatus(ent.id),
      ]);
      // Con { declaraciones: true } también trae las tax-returns ya extraídas:
      // las ANUALES completas (raw — para cotejar qué campos manda Syntage,
      // p.ej. si el remanente de pérdidas viene y bajo qué llave) y un resumen
      // de las mensuales. Sin costo: es lectura de lo ya extraído.
      let declaraciones: unknown = null;
      if (body.declaraciones) {
        const returns = (await client.getEntityTaxReturns(ent.id)) as Record<string, unknown>[];
        const esMensual = (tr: Record<string, unknown>) => String(tr.intervalUnit) === "Mensual";
        declaraciones = {
          total: returns.length,
          anualesRaw: returns.filter((tr) => !esMensual(tr)).slice(0, 3),
          mensualesResumen: returns
            .filter(esMensual)
            .slice(0, 6)
            .map((tr) => ({
              fiscalYear: tr.fiscalYear,
              period: tr.period,
              intervalUnit: tr.intervalUnit,
              llaves: Object.keys(tr),
            })),
        };
      }
      return NextResponse.json({
        ok: true,
        modo: "soloLeer",
        rfc,
        entityId: ent.id,
        opinion: { raw: opinionRes, mapped: opinionRes ? mapTaxCompliance(opinionRes) : null },
        csf: { raw: csfRes, mapped: csfRes ? mapTaxStatus(csfRes) : null },
        declaraciones,
      });
    }

    // 1) Entidad.
    const entity = await client.ensureEntity({ rfc, name: nombre || rfc });
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

    // 4) Extracción (job) + 5) recurso de resultado (el dato vive aparte).
    const run = async (extractor: Extractor) => {
      const { id } = await client.createExtraction({ extractor, entity: entity.id });
      pasos.push({ paso: "extraccion", extractor, extractionId: id });
      await client.waitForExtraction(id, { timeoutMs: 180_000 });
    };
    await run("tax_compliance");
    const opinionRes = await client.getLatestTaxComplianceCheck(entity.id);
    await run("tax_status");
    const csfRes = await client.getLatestTaxStatus(entity.id);

    return NextResponse.json({
      ok: true,
      rfc,
      entityId: entity.id,
      pasos,
      opinion: { raw: opinionRes, mapped: opinionRes ? mapTaxCompliance(opinionRes) : null },
      csf: { raw: csfRes, mapped: csfRes ? mapTaxStatus(csfRes) : null },
    });
  } catch (e) {
    const err = e as { message?: string; status?: number; body?: unknown };
    return NextResponse.json(
      { ok: false, pasos, error: err.message ?? String(e), status: err.status, detail: err.body },
      { status: 502 },
    );
  }
}
