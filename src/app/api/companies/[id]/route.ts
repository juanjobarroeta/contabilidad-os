import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { provisionFacturapiOrg } from "@/lib/facturapi";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { encryptSecret } from "@/lib/crypto";
import { parseCertExpiry } from "@/lib/fiel";

type Params = { params: Promise<{ id: string }> };

// CSD upload triggers Facturapi provisioning (create org → upload certificate →
// renew live key), several sequential external calls. Give it room so it doesn't
// time out into an empty response.
export const maxDuration = 60;

// GET /api/companies/[id]
export async function GET(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: companyId } = await params;

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: {
      id: true,
      rfc: true,
      razonSocial: true,
      regimenFiscal: true,
      codigoPostal: true,
      domicilioFiscal: true,
      nombreComercial: true,
      email: true,
      telefono: true,
      actividadEconomica: true,
      facturapiOrgId: true,
      facturapiApiKey: true,
      csdCer: true,
      csdKey: true,
      csdVigencia: true,
      fielCer: true,
      fielKey: true,
      fielVigencia: true,
      registroPatronal: true,
      plataformaActividad: true,
      isActive: true,
      createdAt: true,
    },
  });

  if (!company) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Mask the actual cert content for security — just signal presence
  return NextResponse.json({
    ...company,
    csdCer: company.csdCer ? "[stored]" : null,
    csdKey: company.csdKey ? "[stored]" : null,
    fielCer: company.fielCer ? "[stored]" : null,
    fielKey: company.fielKey ? "[stored]" : null,
  });
}

// PATCH /api/companies/[id] — update FIEL or CSD credentials
export async function PATCH(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: companyId } = await params;

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member || member.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }

  const body = await req.json();
  const {
    fielCer, fielKey, fielPassword, csdCer, csdKey, csdPassword,
    registroPatronal,
    plataformaActividad,
    grupoId,
    // Editable fiscal/contact fields
    razonSocial, regimenFiscal, codigoPostal, domicilioFiscal,
    nombreComercial, email, telefono, actividadEconomica,
  } = body;

  try {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: Record<string, any> = {};
  // Encrypt credential material at rest (AES-256-GCM via lib/crypto).
  if (fielCer) data.fielCer = encryptSecret(fielCer);
  if (fielKey) data.fielKey = encryptSecret(fielKey);
  if (fielPassword) data.fielPassword = encryptSecret(fielPassword);
  if (fielCer) data.fielVigencia = parseCertExpiry(fielCer); // capture e.firma expiry
  if (csdCer) data.csdCer = encryptSecret(csdCer);
  if (csdKey) data.csdKey = encryptSecret(csdKey);
  if (csdPassword) data.csdPassword = encryptSecret(csdPassword);
  if (registroPatronal !== undefined) {
    // Accept empty string as "clear it"
    data.registroPatronal = registroPatronal?.trim() || null;
  }
  // General fields — only accept non-empty truthy values
  if (razonSocial?.trim()) data.razonSocial = razonSocial.trim();
  if (regimenFiscal?.trim()) data.regimenFiscal = regimenFiscal.trim();
  if (codigoPostal?.trim()) data.codigoPostal = codigoPostal.trim();
  if (domicilioFiscal !== undefined) data.domicilioFiscal = domicilioFiscal?.trim() || null;
  if (nombreComercial !== undefined) data.nombreComercial = nombreComercial?.trim() || null;
  if (email !== undefined) data.email = email?.trim() || null;
  if (telefono !== undefined) data.telefono = telefono?.trim() || null;
  if (actividadEconomica !== undefined) data.actividadEconomica = actividadEconomica?.trim() || null;
  if (grupoId !== undefined) {
    // Asignar/quitar grupo — solo si el grupo es del mismo despacho que la empresa.
    if (!grupoId) {
      data.grupoId = null;
    } else {
      const company = await prisma.company.findUnique({ where: { id: companyId }, select: { despachoId: true } });
      const g = company?.despachoId
        ? await prisma.grupo.findFirst({ where: { id: grupoId, despachoId: company.despachoId }, select: { id: true } })
        : null;
      if (!g) return NextResponse.json({ error: "Grupo inválido para esta empresa" }, { status: 400 });
      data.grupoId = g.id;
    }
  }
  if (plataformaActividad !== undefined) {
    // Tipo de actividad de plataforma (625) que define la tasa Art. 113-A.
    const v = plataformaActividad?.trim();
    data.plataformaActividad = v === "transporte" || v === "hospedaje" || v === "servicios" ? v : null;
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "No hay datos para actualizar" }, { status: 400 });
  }

  await prisma.company.update({ where: { id: companyId }, data });

  // If the CSD just changed, re-run Facturapi provisioning so the org gets
  // the certificate uploaded and a live key issued.
  let facturapi = null;
  if (data.csdCer || data.csdKey || data.csdPassword) {
    facturapi = await provisionFacturapiOrg(companyId);
  }

  return NextResponse.json({ ok: true, facturapi });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error inesperado";
    // The most common production cause: CREDENTIALS_ENCRYPTION_KEY missing or
    // not a valid 32-byte base64 value, so encrypting the CSD/FIEL throws. Give
    // an actionable message instead of an empty 500 (which the client showed as
    // "Unexpected end of JSON input").
    const esClave = /clave debe ser 32 bytes|CREDENTIALS_ENCRYPTION_KEY/i.test(msg);
    console.error("[companies/PATCH] failed:", msg);
    return NextResponse.json(
      {
        error: esClave
          ? "La clave de cifrado del servidor (CREDENTIALS_ENCRYPTION_KEY) no es válida. Configúrala con un valor de 32 bytes en base64 y vuelve a intentar."
          : `No se pudo guardar: ${msg}`,
      },
      { status: esClave ? 500 : 422 }
    );
  }
}
