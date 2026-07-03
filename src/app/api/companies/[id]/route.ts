import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { provisionFacturapiOrg } from "@/lib/facturapi";
import { provisionCompany } from "@/lib/fiscal/cumplimiento/syntage/provision";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { encryptSecret } from "@/lib/crypto";
import { fielStatus, parseCertExpiry } from "@/lib/fiel";
import { borrarCredencialesEmpresa, borrarEmpresaDefinitivo } from "@/lib/empresas/baja";
import { registrarBitacora } from "@/lib/audit";

type Params = { params: Promise<{ id: string }> };

// CSD upload triggers Facturapi provisioning (create org → upload certificate →
// renew live key), several sequential external calls. Give it room so it doesn't
// time out into an empty response. The DELETE (baja definitiva) runs a single
// transaction with a 120 s budget over years of CFDIs — give it the same room
// where the platform allows it.
export const maxDuration = 150;

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

  // Vigencia efectiva de la e.firma: usa fielVigencia guardada o parsea el .cer
  // en vivo (empresas cargadas antes de que existiera el campo — sin backfill).
  const fiel = fielStatus({ fielCer: company.fielCer, fielVigencia: company.fielVigencia });

  // Mask the actual cert content for security — just signal presence
  return NextResponse.json({
    ...company,
    csdCer: company.csdCer ? "[stored]" : null,
    csdKey: company.csdKey ? "[stored]" : null,
    fielCer: company.fielCer ? "[stored]" : null,
    fielKey: company.fielKey ? "[stored]" : null,
    fielVigencia: fiel.vigencia, // ISO o null
    fielEstado: fiel.estado, // "ok" | "por_vencer" | "vencida" | "sin_fiel"
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

  // Bitácora de seguridad: cambio de credenciales fiscales. Se registra QUÉ
  // tipo cambió (fiel/csd), NUNCA los valores ni contraseñas.
  const credencialesCambiadas: string[] = [];
  if (data.fielCer || data.fielKey || data.fielPassword) credencialesCambiadas.push("fiel");
  if (data.csdCer || data.csdKey || data.csdPassword) credencialesCambiadas.push("csd");
  if (credencialesCambiadas.length > 0) {
    registrarBitacora({
      companyId,
      userId: session.user.id,
      actorEmail: session.user.email ?? null,
      accion: "credenciales.actualizar",
      entidad: "Company",
      entidadId: companyId,
      detalle: { tipos: credencialesCambiadas },
      req,
    });
  }

  // If the CSD just changed, re-run Facturapi provisioning so the org gets
  // the certificate uploaded and a live key issued.
  let facturapi = null;
  if (data.csdCer || data.csdKey || data.csdPassword) {
    facturapi = await provisionFacturapiOrg(companyId);
  }

  // If the e.firma just changed, kick a Syntage provision (force → full
  // historic pull) right away instead of waiting for the next cron. Mirrors the
  // CSD→Facturapi flow above. Best-effort: provisionOne only TRIGGERS extractions
  // (no waiting for results), so it's a few quick calls; the compliance-sync cron
  // persists the results later. Never fails the save.
  let syntage = null;
  if (data.fielCer || data.fielKey || data.fielPassword) {
    try {
      syntage = await provisionCompany(companyId);
    } catch (e) {
      syntage = { error: e instanceof Error ? e.message : String(e) };
    }
  }

  return NextResponse.json({ ok: true, facturapi, syntage });
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

// DELETE /api/companies/[id] — baja definitiva de la empresa (LFPDPPP,
// derecho de cancelación). Borra la empresa y TODOS sus datos dependientes.
//
// Regla de autorización (deliberadamente MÁS estricta que requireOwner):
// sólo un usuario con fila CompanyMember DIRECTA y role = OWNER en ESTA
// empresa puede darla de baja. NO basta:
//   - el acceso implícito por despacho (getEffectiveCompanyMembership lo
//     topa en ADMIN de todos modos — un despacho nunca es dueño de los
//     datos de su cliente), ni
//   - el flag esOperador (soporte de plataforma): un operador no es el
//     titular de los datos y no puede ejercer la cancelación por él.
//
// Confirmación: el body debe traer el RFC exacto de la empresa (confirmRfc).
export async function DELETE(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id: companyId } = await params;

  // Membresía DIRECTA con role OWNER — sin acceso implícito por despacho ni operador.
  const direct = await prisma.companyMember.findUnique({
    where: { userId_companyId: { userId: session.user.id, companyId } },
    select: { role: true },
  });
  if (!direct || direct.role !== "OWNER") {
    return NextResponse.json(
      {
        error:
          "Solo el propietario (OWNER directo) de la empresa puede darla de baja definitivamente.",
      },
      { status: 403 }
    );
  }

  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { rfc: true, razonSocial: true },
  });
  if (!company) {
    return NextResponse.json({ error: "Empresa no encontrada" }, { status: 404 });
  }

  const body = await req.json().catch(() => ({}));
  const confirmRfc =
    typeof body?.confirmRfc === "string" ? body.confirmRfc.trim().toUpperCase() : "";
  if (!confirmRfc || confirmRfc !== company.rfc.trim().toUpperCase()) {
    return NextResponse.json(
      {
        error:
          "El RFC de confirmación no coincide con el RFC de la empresa. Escríbelo exactamente para confirmar la baja.",
      },
      { status: 400 }
    );
  }

  // Registro estructurado de auditoría (aún no existe tabla de auditoría).
  const auditoria = {
    userId: session.user.id,
    email: session.user.email ?? null,
    companyId,
    rfc: company.rfc,
    razonSocial: company.razonSocial,
    timestamp: new Date().toISOString(),
  };
  console.warn(`[baja-empresa] solicitada ${JSON.stringify(auditoria)}`);

  try {
    // Fase 1 — PRIMERA acción del flujo: matar credenciales (FIEL/CSD/llaves
    // de Facturapi y Playtomic). Aunque la fase 2 falle, los secretos ya no existen.
    await borrarCredencialesEmpresa(companyId);
    console.warn(`[baja-empresa] credenciales eliminadas ${JSON.stringify(auditoria)}`);

    // Fase 2 — borrado total en una transacción (todo-o-nada).
    await borrarEmpresaDefinitivo(companyId);
    console.warn(`[baja-empresa] completada ${JSON.stringify(auditoria)}`);

    // Bitácora de seguridad: la fila SOBREVIVE al borrado porque AuditLog no
    // tiene FK a Company (companyId es columna plana a propósito).
    registrarBitacora({
      companyId,
      userId: session.user.id,
      actorEmail: session.user.email ?? null,
      accion: "empresa.baja",
      entidad: "Company",
      entidadId: companyId,
      detalle: { rfc: company.rfc, razonSocial: company.razonSocial },
      req,
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(
      `[baja-empresa] fallo ${JSON.stringify({ ...auditoria, error: msg })}`
    );
    return NextResponse.json(
      {
        error:
          "No se pudo completar la baja. Las credenciales (e.firma/CSD) ya fueron eliminadas y la empresa quedó desactivada; intenta la baja de nuevo en unos minutos.",
      },
      { status: 500 }
    );
  }
}
