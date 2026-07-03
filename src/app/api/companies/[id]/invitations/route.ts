import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError } from "@/lib/authz";
import {
  buildAcceptUrl,
  CLIENT_INVITE_ROLES,
  inviteExpiry,
  mintInviteToken,
} from "@/lib/invitations";
import { requireDespachoAdminForCompany } from "@/lib/invitations-server";
import { registrarBitacora } from "@/lib/audit";

type Params = { params: Promise<{ id: string }> };

// GET /api/companies/[id]/invitations — list pending/recent client invites.
// Despacho OWNER/ADMIN of the owning despacho only.
export async function GET(req: Request, { params }: Params) {
  try {
    const { id: companyId } = await params;
    await requireDespachoAdminForCompany(companyId, req);

    const invites = await prisma.companyInvitation.findMany({
      where: { companyId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        expiresAt: true,
        acceptedAt: true,
        createdAt: true,
      },
    });
    return NextResponse.json(invites);
  } catch (e) {
    if (e instanceof AuthzError)
      return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

const createSchema = z.object({
  email: z
    .string()
    .email("Correo inválido")
    .transform((s) => s.toLowerCase().trim()),
  role: z.enum(CLIENT_INVITE_ROLES).default("VIEWER"),
});

// POST /api/companies/[id]/invitations — create a single-company client invite.
// Despacho OWNER/ADMIN of the owning despacho only. Returns the accept URL so
// the admin can share the link out-of-band.
export async function POST(req: Request, { params }: Params) {
  try {
    const { id: companyId } = await params;
    const { userId, despachoId } = await requireDespachoAdminForCompany(
      companyId,
      req
    );

    const parsed = createSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Datos inválidos" },
        { status: 400 }
      );
    }
    const { email, role } = parsed.data;

    // If the email already has access to this company, don't bother inviting.
    const existingUser = await prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (existingUser) {
      const member = await prisma.companyMember.findUnique({
        where: { userId_companyId: { userId: existingUser.id, companyId } },
        select: { id: true },
      });
      if (member) {
        return NextResponse.json(
          { error: "Este correo ya tiene acceso a la empresa" },
          { status: 409 }
        );
      }
    }

    // Revoke any prior pending invite for the same email+company so a re-invite
    // is unambiguous (one live link per client per company).
    await prisma.companyInvitation.updateMany({
      where: { companyId, email, status: "PENDING" },
      data: { status: "REVOKED" },
    });

    const { rawToken, tokenHash } = mintInviteToken();
    const invite = await prisma.companyInvitation.create({
      data: {
        companyId,
        despachoId,
        invitedByUserId: userId,
        email,
        role,
        tokenHash,
        expiresAt: inviteExpiry(),
      },
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        expiresAt: true,
        createdAt: true,
      },
    });

    // Bitácora de seguridad: invitación creada (fire-and-forget). Nunca se
    // registra el token del enlace, sólo metadatos.
    registrarBitacora({
      companyId,
      userId,
      accion: "invitacion.crear",
      entidad: "CompanyInvitation",
      entidadId: invite.id,
      detalle: { email, rol: role },
      req,
    });

    return NextResponse.json(
      { ...invite, acceptUrl: buildAcceptUrl(rawToken) },
      { status: 201 }
    );
  } catch (e) {
    if (e instanceof AuthzError)
      return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
