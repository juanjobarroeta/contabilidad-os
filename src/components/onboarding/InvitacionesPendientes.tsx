export interface InvitacionPendiente { empresa: string; despacho: string | null }

export function InvitacionesPendientes({ invitaciones }: { invitaciones: InvitacionPendiente[] }) {
  if (!invitaciones.length) return null;
  const primera = invitaciones[0];
  return (
    <div role="status" className="mx-auto mb-4 w-full max-w-3xl rounded-xl border border-cos-jade-ink/25 bg-cos-jade-tint px-4 py-3">
      <p className="text-[13.5px] font-semibold text-cos-jade-ink">
        Te invitaron a {primera.empresa}{invitaciones.length > 1 ? ` (y ${invitaciones.length - 1} más)` : ""}
      </p>
      <p className="mt-1 text-[12.5px] leading-relaxed text-cos-jade-ink/90">
        No necesitas crear una empresa ni contratar un plan: esa empresa ya está configurada y pagada
        {primera.despacho ? ` por ${primera.despacho}` : " por tu despacho"}.
        {" "}Abre el enlace de invitación que te compartieron y acepta ahí — si ya no lo tienes, pide que te lo reenvíen.
      </p>
    </div>
  );
}
