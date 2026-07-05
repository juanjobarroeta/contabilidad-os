import { auth } from "@/lib/auth";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { signDraftToken, publicBaseUrl } from "@/lib/facturas/file-token";
import { checkStagedActionUsable, stagedActionErrorMessage } from "@/lib/staged-action";
import {
  getStagedActionByRawToken,
  type StagedTimbrarPayload,
  type StagedComplementoPayload,
} from "@/lib/staged-action-server";
import { AutorizarAcciones } from "@/components/staged/AutorizarAcciones";
import { AlertCircle, FileText, ShieldCheck } from "lucide-react";

export const dynamic = "force-dynamic";

const MXN = (n: number) => n.toLocaleString("es-MX", { style: "currency", currency: "MXN" });

function EstadoError({ titulo, mensaje }: { titulo: string; mensaje: string }) {
  return (
    <div className="mx-auto mt-16 max-w-md px-5">
      <div className="flex flex-col items-center gap-3 rounded-card border border-cos-line bg-cos-card px-6 py-8 text-center">
        <div className="grid h-12 w-12 place-items-center rounded-full bg-cos-amber-tint text-cos-amber-ink">
          <AlertCircle className="h-6 w-6" />
        </div>
        <h1 className="text-[18px] font-semibold text-cos-ink">{titulo}</h1>
        <p className="text-[14px] leading-snug text-cos-ink-soft">{mensaje}</p>
      </div>
    </div>
  );
}

// Pantalla de REVISIÓN y AUTORIZACIÓN (Tier 3). Se llega por el deep link que
// mandó el asistente de WhatsApp. Vive bajo /(app), así que el layout ya exigió
// iniciar sesión — esa reautenticación real es el corazón del riel: nadie timbra
// desde un teléfono secuestrado con un "sí". Aquí se muestra el documento COMPLETO
// y el timbrado ocurre solo cuando el usuario toca "Confirmar y timbrar".
export default async function AutorizarPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return <EstadoError titulo="Inicia sesión" mensaje="Necesitas iniciar sesión para revisar y autorizar esta acción." />;
  }

  const action = await getStagedActionByRawToken(token);
  const gate = checkStagedActionUsable(action);
  if (gate) {
    return <EstadoError titulo="No se puede autorizar" mensaje={stagedActionErrorMessage(gate)} />;
  }
  const staged = action!;

  const membership = await getEffectiveCompanyMembership(userId, staged.companyId);
  if (!membership || membership.role === "VIEWER") {
    return (
      <EstadoError
        titulo="Sin permiso"
        mensaje="No tienes permiso para autorizar acciones en esta empresa. Pide acceso al administrador."
      />
    );
  }

  const company = await prisma.company.findUnique({
    where: { id: staged.companyId },
    select: { razonSocial: true },
  });

  const empresa = company?.razonSocial ?? "Empresa";

  // ── Complemento de pago (REP) ─────────────────────────────────────────────
  if (staged.type === "complemento_pago") {
    const c = (staged.payload as unknown as StagedComplementoPayload).resumen;
    return (
      <div className="mx-auto mt-10 max-w-lg px-5 pb-24">
        <div className="mb-4 flex items-center gap-2 text-cos-jade">
          <ShieldCheck className="h-5 w-5" />
          <span className="text-[13px] font-medium uppercase tracking-wide">Autorización de complemento de pago</span>
        </div>
        <div className="rounded-card border border-cos-line bg-cos-card px-6 py-6">
          <p className="text-[13px] text-cos-ink-faint">{empresa}</p>
          <h1 className="mt-0.5 text-[20px] font-semibold text-cos-ink">Revisa antes de emitir el REP</h1>
          <p className="mt-1 text-[14px] leading-snug text-cos-ink-soft">
            Este complemento de pago aún <span className="font-semibold">NO</span> está timbrado. El timbrado es definitivo.
          </p>
          <dl className="mt-5 space-y-2.5 text-[14px]">
            <div className="flex justify-between gap-4">
              <dt className="text-cos-ink-soft">Cliente</dt>
              <dd className="text-right font-medium text-cos-ink">
                {c.cliente} <span className="text-cos-ink-faint">({c.rfc})</span>
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-cos-ink-soft">Pago</dt>
              <dd className="font-medium text-cos-ink">{MXN(c.monto)} · {c.fechaPago}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-cos-ink-soft">Parcialidad</dt>
              <dd className="font-medium text-cos-ink">{c.numParcialidad}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-cos-ink-soft">Saldo anterior</dt>
              <dd className="font-medium text-cos-ink">{MXN(c.impSaldoAnterior)}</dd>
            </div>
            <div className="flex justify-between gap-4 border-t border-cos-line-soft pt-2.5">
              <dt className="font-semibold text-cos-ink">Saldo insoluto</dt>
              <dd className="text-[16px] font-semibold text-cos-ink">{MXN(c.impSaldoInsoluto)}</dd>
            </div>
            {c.ivaTrasladado > 0 && (
              <div className="flex justify-between gap-4">
                <dt className="text-cos-ink-soft">IVA del pago</dt>
                <dd className="font-medium text-cos-ink">{MXN(c.ivaTrasladado)}</dd>
              </div>
            )}
          </dl>
          <div className="mt-6">
            <AutorizarAcciones token={token} accion="emitir" />
          </div>
          <p className="mt-4 text-[12px] leading-snug text-cos-ink-faint">
            Al confirmar, el complemento de pago (REP) se timbra de forma definitiva ante el SAT. Enlace de un solo uso; vence a los 30 minutos.
          </p>
        </div>
      </div>
    );
  }

  if (staged.type !== "timbrar") {
    return <EstadoError titulo="Acción no reconocida" mensaje="Este tipo de autorización no está disponible." />;
  }

  const payload = staged.payload as unknown as StagedTimbrarPayload;
  const r = payload.resumen;
  const base = publicBaseUrl();
  const pdfUrl = base
    ? `${base}/api/facturas/draft/${payload.draftId}/pdf?companyId=${staged.companyId}&token=${signDraftToken(
        staged.companyId,
        payload.draftId
      )}`
    : null;

  return (
    <div className="mx-auto mt-10 max-w-lg px-5 pb-24">
      <div className="mb-4 flex items-center gap-2 text-cos-jade">
        <ShieldCheck className="h-5 w-5" />
        <span className="text-[13px] font-medium uppercase tracking-wide">Autorización de timbrado</span>
      </div>

      <div className="rounded-card border border-cos-line bg-cos-card px-6 py-6">
        <p className="text-[13px] text-cos-ink-faint">{company?.razonSocial ?? "Empresa"}</p>
        <h1 className="mt-0.5 text-[20px] font-semibold text-cos-ink">Revisa antes de timbrar</h1>
        <p className="mt-1 text-[14px] leading-snug text-cos-ink-soft">
          Esta factura aún <span className="font-semibold">NO</span> está timbrada. Revisa los datos —sobre todo la
          clasificación SAT— y confirma. El timbrado es definitivo.
        </p>

        <dl className="mt-5 space-y-2.5 text-[14px]">
          <div className="flex justify-between gap-4">
            <dt className="text-cos-ink-soft">Cliente</dt>
            <dd className="text-right font-medium text-cos-ink">
              {r.cliente} <span className="text-cos-ink-faint">({r.rfc})</span>
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-cos-ink-soft">Subtotal</dt>
            <dd className="font-medium text-cos-ink">{MXN(r.subtotal)}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-cos-ink-soft">IVA</dt>
            <dd className="font-medium text-cos-ink">{MXN(r.iva)}</dd>
          </div>
          <div className="flex justify-between gap-4 border-t border-cos-line-soft pt-2.5">
            <dt className="font-semibold text-cos-ink">Total</dt>
            <dd className="text-[16px] font-semibold text-cos-ink">{MXN(r.total)}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-cos-ink-soft">Método / Uso</dt>
            <dd className="font-medium text-cos-ink">
              {r.metodoPago} · {r.usoCfdi}
            </dd>
          </div>
        </dl>

        {pdfUrl && (
          <a
            href={pdfUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-5 inline-flex items-center gap-2 rounded-control border border-cos-line px-3.5 py-2 text-[13.5px] font-medium text-cos-brand-ink hover:bg-cos-brand-tint"
          >
            <FileText className="h-4 w-4" /> Ver el borrador (PDF)
          </a>
        )}

        <div className="mt-6">
          <AutorizarAcciones token={token} />
        </div>

        <p className="mt-4 text-[12px] leading-snug text-cos-ink-faint">
          Al confirmar, la factura se timbra de forma definitiva ante el SAT. Este enlace es de un solo uso y vence a los
          30 minutos.
        </p>
      </div>
    </div>
  );
}
