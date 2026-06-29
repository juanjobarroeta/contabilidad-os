import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError } from "@/lib/authz";
import { requireDespachoAdminForCompany } from "@/lib/invitations-server";

type Params = { params: Promise<{ id: string; inviteId: string }> };

// DELETE /api/companies/[id]/invitations/[inviteId] — revoke a pending invite.
// Despacho OWNER/ADMIN of the owning despacho only. Revoking an already
// accepted invite does NOT remove the resulting CompanyMember (use the member
// management UI for that); it only kills the link.
export async function DELETE(req: Request, { params }: Params) {
  try {
    const { id: companyId, inviteId } = await params;
    await requireDespachoAdminForCompany(companyId, req);

    const invite = await prisma.companyInvitation.findUnique({
      where: { id: inviteId },
      select: { id: true, companyId: true, status: true },
    });
    // Scope the invite to THIS company — never let an id from another company
    // be revoked through this company's route.
    if (!invite || invite.companyId !== companyId) {
      return NextResponse.json(
        { error: "Invitación no encontrada" },
        { status: 404 }
      );
    }
    if (invite.status === "PENDING") {
      await prisma.companyInvitation.update({
        where: { id: inviteId },
        data: { status: "REVOKED" },
      });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof AuthzError)
      return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
