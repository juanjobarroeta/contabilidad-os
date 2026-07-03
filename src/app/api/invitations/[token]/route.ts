import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { checkInviteAcceptable, hashInviteToken } from "@/lib/invitations";
import { registrarBitacora } from "@/lib/audit";

type Params = { params: Promise<{ token: string }> };

const ACCEPT_ERROR_STATUS: Record<string, number> = {
  not_found: 404,
  revoked: 410,
  expired: 410,
  email_mismatch: 403,
};
const ACCEPT_ERROR_MSG: Record<string, string> = {
  not_found: "La invitación no existe",
  revoked: "La invitación fue revocada",
  expired: "La invitación expiró",
  email_mismatch:
    "Esta invitación es para otro correo. Inicia sesión con el correo invitado.",
};

// GET /api/invitations/[token] — preview an invite (public-by-token). Returns
// the invited email + company name so the accept page can render before login.
// Never exposes other companies or despacho data.
export async function GET(_req: Request, { params }: Params) {
  const { token } = await params;
  const invite = await prisma.companyInvitation.findUnique({
    where: { tokenHash: hashInviteToken(token) },
    select: {
      email: true,
      status: true,
      expiresAt: true,
      company: { select: { razonSocial: true } },
    },
  });

  if (!invite) {
    return NextResponse.json({ error: ACCEPT_ERROR_MSG.not_found }, { status: 404 });
  }

  const now = new Date();
  const usable =
    invite.status === "PENDING" && invite.expiresAt.getTime() > now.getTime();

  return NextResponse.json({
    email: invite.email,
    company: invite.company.razonSocial,
    status: invite.status,
    usable,
  });
}

// POST /api/invitations/[token] — consume the invite. The caller MUST be logged
// in as the invited email. Creates a CompanyMember scoped to EXACTLY ONE company
// with the invite's client role, and NEVER a DespachoMember (so the client can
// never see sibling companies). Idempotent: a second accept is a no-op success.
export async function POST(req: Request, { params }: Params) {
  const { token } = await params;

  const session = await auth();
  if (!session?.user?.id || !session.user.email) {
    return NextResponse.json(
      { error: "Inicia sesión con el correo invitado para aceptar" },
      { status: 401 }
    );
  }
  const userId = session.user.id;
  const userEmail = session.user.email.toLowerCase();

  const invite = await prisma.companyInvitation.findUnique({
    where: { tokenHash: hashInviteToken(token) },
  });

  // Idempotency: if already accepted by this same user, re-confirm and return OK
  // without trying to recreate anything.
  if (
    invite &&
    invite.status === "ACCEPTED" &&
    invite.acceptedUserId === userId
  ) {
    return NextResponse.json({ ok: true, companyId: invite.companyId });
  }

  const gate = checkInviteAcceptable(
    invite
      ? { status: invite.status, expiresAt: invite.expiresAt, email: invite.email }
      : null,
    userEmail
  );
  if (gate) {
    return NextResponse.json(
      { error: ACCEPT_ERROR_MSG[gate] },
      { status: ACCEPT_ERROR_STATUS[gate] }
    );
  }
  // gate === null guarantees invite is non-null and PENDING for this email.
  const live = invite!;

  // Consume atomically. We re-check status inside the transaction's update
  // (status: "PENDING") so two concurrent accepts can't both create a member.
  const consumida = await prisma.$transaction(async (tx) => {
    const consumed = await tx.companyInvitation.updateMany({
      where: { id: live.id, status: "PENDING" },
      data: {
        status: "ACCEPTED",
        acceptedAt: new Date(),
        acceptedUserId: userId,
      },
    });
    // Lost the race — another request already accepted. Nothing more to do;
    // the membership was created by the winner.
    if (consumed.count === 0) return false;

    // Create the single-company membership if it doesn't already exist.
    // IMPORTANT: only a CompanyMember — never a DespachoMember.
    await tx.companyMember.upsert({
      where: { userId_companyId: { userId, companyId: live.companyId } },
      create: { userId, companyId: live.companyId, role: live.role },
      update: {}, // keep an existing (possibly higher) role untouched
    });
    return true;
  });

  // Bitácora de seguridad: invitación aceptada (fire-and-forget). Sólo la
  // petición que GANÓ la carrera registra; nunca se guarda el token.
  if (consumida) registrarBitacora({
    companyId: live.companyId,
    userId,
    actorEmail: userEmail,
    accion: "invitacion.aceptar",
    entidad: "CompanyInvitation",
    entidadId: live.id,
    detalle: { rol: live.role },
    req,
  });

  return NextResponse.json({ ok: true, companyId: live.companyId });
}
