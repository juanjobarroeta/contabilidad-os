import { Prisma, type MemberRole } from "@prisma/client";
import { NextResponse } from "next/server";
import { ipDeRequest } from "@/lib/audit";
import {
  AuthzError,
  requireMembership,
  withAuthz,
} from "@/lib/authz";
import { registrarAceptaciones } from "@/lib/legal/aceptaciones";
import { MANDATO_EFIRMA } from "@/lib/legal/documentos";
import { estadoCredencialParaMandato } from "@/lib/legal/mandato-efirma";
import { prisma } from "@/lib/prisma";

type Params = { params: Promise<{ id: string }> };

function esOperadorSintetico(membershipId: string): boolean {
  return membershipId.startsWith("operador:");
}

type MembresiaMandato = {
  id: string;
  role: MemberRole;
  allowedModules?: readonly string[];
  accessViaDespacho?: boolean;
};

function puedeAceptar(membership: MembresiaMandato): boolean {
  if (membership.role === "VIEWER" || esOperadorSintetico(membership.id)) {
    return false;
  }
  if (membership.accessViaDespacho) return true;
  const restricted =
    Array.isArray(membership.allowedModules) &&
    membership.allowedModules.length > 0;
  return !restricted || membership.allowedModules!.includes("CONTABILIDAD");
}

export const GET = withAuthz(async (req: Request, { params }: Params) => {
  const { id: companyId } = await params;
  const { user, membership } = await requireMembership(
    companyId,
    undefined,
    req,
    { platformOperatorMode: "fallback" },
  );
  const [company, acceptances] = await Promise.all([
    prisma.company.findUnique({
      where: { id: companyId },
      select: {
        isActive: true,
        fielCer: true,
        fielKey: true,
        fielPassword: true,
      },
    }),
    prisma.legalAcceptance.findMany({
      where: {
        companyId,
        documento: "MANDATO_EFIRMA",
        version: MANDATO_EFIRMA.version,
      },
      select: { userId: true },
    }),
  ]);
  if (!company?.isActive) {
    throw new AuthzError(404, "Empresa no encontrada");
  }

  const estadoCredencial = estadoCredencialParaMandato(company);
  const vigente = acceptances.length > 0;
  return NextResponse.json(
    {
      documento: MANDATO_EFIRMA.documento,
      version: MANDATO_EFIRMA.version,
      url: MANDATO_EFIRMA.url,
      vigente,
      aceptadaPorUsuario: acceptances.some((row) => row.userId === user.id),
      estadoCredencial,
      puedeAceptar:
        !vigente &&
        estadoCredencial === "LISTA" &&
        puedeAceptar(membership),
      role: membership.role,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
});

export const POST = withAuthz(async (req: Request, { params }: Params) => {
  const { id: companyId } = await params;
  // Esta aceptación es clickwrap humano: sólo sesión web interactiva. No se
  // admite un bearer de satélite aunque apunte al mismo usuario.
  const { user, membership } = await requireMembership(
    companyId,
    ["OWNER", "ADMIN", "ACCOUNTANT"],
    undefined,
    { platformOperatorMode: "deny" },
  );
  if (esOperadorSintetico(membership.id)) {
    throw new AuthzError(
      403,
      "Soporte de plataforma no puede aceptar la autorización por el cliente.",
    );
  }
  if (!puedeAceptar(membership)) {
    throw new AuthzError(
      403,
      "Tu acceso no incluye facultades fiscales para aceptar esta autorización.",
    );
  }

  const contentType = req.headers.get("content-type")?.split(";", 1)[0]
    .trim()
    .toLowerCase();
  const declaredLength = Number(req.headers.get("content-length"));
  if (contentType !== "application/json") {
    return NextResponse.json({ error: "Content-Type inválido" }, { status: 415 });
  }
  if (Number.isFinite(declaredLength) && declaredLength > 1_024) {
    return NextResponse.json({ error: "Solicitud demasiado grande" }, { status: 413 });
  }

  const rawBody = await req.text();
  if (new TextEncoder().encode(rawBody).byteLength > 1_024) {
    return NextResponse.json({ error: "Solicitud demasiado grande" }, { status: 413 });
  }
  let body: unknown = null;
  try {
    body = JSON.parse(rawBody);
  } catch {
    // The exact acknowledgement contract below returns the safe 400 response.
  }
  const record = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : null;
  const keys = record ? Object.keys(record).sort() : [];
  if (
    !record ||
    keys.length !== 2 ||
    keys[0] !== "acepta" ||
    keys[1] !== "version" ||
    record.acepta !== true ||
    record.version !== MANDATO_EFIRMA.version
  ) {
    return NextResponse.json(
      {
        error:
          "Debes aceptar expresamente la versión vigente de la Autorización de uso de la e.firma.",
        codigo: "MANDATO_EFIRMA_REQUERIDO",
      },
      { status: 400 },
    );
  }

  const result = await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "Company"
      WHERE "id" = ${companyId}
      FOR UPDATE
    `);
    if (locked.length !== 1) {
      return {
        ok: false as const,
        status: 404,
        error: "Empresa no encontrada",
        codigo: "COMPANY_NOT_FOUND",
      };
    }

    const company = await tx.company.findUnique({
      where: { id: companyId },
      select: {
        isActive: true,
        fielCer: true,
        fielKey: true,
        fielPassword: true,
      },
    });
    if (!company?.isActive) {
      return {
        ok: false as const,
        status: 404,
        error: "Empresa no encontrada",
        codigo: "COMPANY_NOT_FOUND",
      };
    }
    const estadoCredencial = estadoCredencialParaMandato(company);
    if (estadoCredencial !== "LISTA") {
      return {
        ok: false as const,
        status: 409,
        error:
          "La empresa no tiene una e.firma completa y cifrada que pueda autorizarse sin volver a cargarla.",
        codigo: estadoCredencial,
      };
    }

    const existing = await tx.legalAcceptance.findFirst({
      where: {
        userId: user.id,
        companyId,
        documento: "MANDATO_EFIRMA",
        version: MANDATO_EFIRMA.version,
      },
      select: { id: true },
    });
    if (existing) {
      return { ok: true as const, alreadyAccepted: true };
    }

    await registrarAceptaciones(
      {
        userId: user.id,
        email: user.email,
        companyId,
        documentos: ["MANDATO_EFIRMA"],
        contexto: "credencial_existente",
        req,
      },
      tx,
    );
    await tx.auditLog.create({
      data: {
        companyId,
        userId: user.id,
        actorEmail: user.email,
        accion: "legal.mandato-efirma-aceptar-existente",
        entidad: "Company",
        entidadId: companyId,
        detalle: {
          documento: MANDATO_EFIRMA.documento,
          version: MANDATO_EFIRMA.version,
          credentialState: "ENCRYPTED_COMPLETE",
          authMethod: "SESSION_COOKIE",
        },
        ip: ipDeRequest(req),
      },
    });
    return { ok: true as const, alreadyAccepted: false };
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, codigo: result.codigo },
      { status: result.status },
    );
  }
  return NextResponse.json({
    ok: true,
    documento: MANDATO_EFIRMA.documento,
    version: MANDATO_EFIRMA.version,
    alreadyAccepted: result.alreadyAccepted,
  });
});
