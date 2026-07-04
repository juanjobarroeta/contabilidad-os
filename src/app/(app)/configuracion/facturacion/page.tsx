import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { computeState } from "@/lib/subscription";
import { stripeConfigured } from "@/lib/billing/stripe";
import { contarEmpresasFacturables } from "@/lib/billing/sync-cantidad-despacho";
import { PLAN_LABEL } from "@/lib/planes";
import { ArrowLeft, CreditCard } from "lucide-react";
import { SuscripcionAcciones } from "./suscripcion-acciones";

export const dynamic = "force-dynamic";

const STATUS_LABELS: Record<string, string> = {
  TRIALING: "Prueba",
  ACTIVE: "Activa",
  PAST_DUE: "Pago vencido",
  CANCELED: "Cancelada",
  EXPIRED: "Vencida",
};

function fechaLarga(d: Date): string {
  return d.toLocaleDateString("es-MX", { day: "numeric", month: "long", year: "numeric" });
}

export default async function FacturacionPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      subscriptionStatus: true,
      trialEndsAt: true,
      currentPeriodEnd: true,
      stripeCustomerId: true,
    },
  });
  if (!user) redirect("/login");

  const state = computeState(user);

  // Plan mostrado: el tier de las empresas del usuario (OWNER o de su
  // despacho) — es donde src/lib/planes.ts lee las capacidades.
  const empresas = await prisma.company.findMany({
    where: {
      OR: [
        { members: { some: { userId: session.user.id, role: "OWNER" } } },
        { despacho: { members: { some: { userId: session.user.id } } } },
      ],
    },
    select: { tier: true },
  });
  const planesActuales = [...new Set(empresas.map((e) => PLAN_LABEL[e.tier]))];

  // Empresas ACTIVAS facturables: mismo conteo que usa el checkout DESPACHO
  // (cantidad = max(10, N)) y la sincronización en altas/bajas.
  const empresasActivas = await contarEmpresasFacturables(session.user.id);

  const configurado = stripeConfigured();

  return (
    <div className="p-6 max-w-3xl">
      <Link
        href="/configuracion"
        className="inline-flex items-center gap-1.5 text-sm text-cos-ink-soft hover:text-cos-ink mb-4"
      >
        <ArrowLeft className="h-4 w-4" /> Configuración
      </Link>

      <div className="mb-6">
        <h1 className="text-2xl font-bold">Facturación</h1>
        <p className="text-sm text-cos-ink-soft mt-1">Tu plan y estado de suscripción.</p>
      </div>

      <div className="bg-cos-card border border-cos-line rounded-xl p-6">
        <div className="flex items-start gap-4">
          <div className="h-10 w-10 rounded-lg bg-cos-brand-tint text-cos-brand-ink flex items-center justify-center shrink-0">
            <CreditCard className="h-5 w-5" />
          </div>
          <div className="flex-1">
            <p className="text-xs uppercase text-cos-ink-soft tracking-wide">Suscripción</p>
            <p className="text-xl font-bold mt-1">{STATUS_LABELS[state.status] ?? state.status}</p>

            {planesActuales.length > 0 && (
              <p className="text-sm text-cos-ink-soft mt-1">
                Plan actual: <span className="font-medium text-cos-ink">{planesActuales.join(", ")}</span>
              </p>
            )}

            {state.isTrialing && state.daysLeft !== null && (
              <p className="text-sm text-cos-ink-soft mt-1">
                Te {state.daysLeft === 1 ? "queda" : "quedan"} {state.daysLeft}{" "}
                {state.daysLeft === 1 ? "día" : "días"} de prueba
              </p>
            )}

            {!state.isTrialing && user.currentPeriodEnd && (
              <p className="text-sm text-cos-ink-soft mt-1">
                {state.status === "ACTIVE"
                  ? `Tu periodo actual termina el ${fechaLarga(user.currentPeriodEnd)}.`
                  : `Último periodo pagado hasta el ${fechaLarga(user.currentPeriodEnd)}.`}
              </p>
            )}

            {state.isExpired && (
              <p className="text-sm text-cos-ink-soft mt-1">
                Tu acceso está limitado. Contrata un plan para continuar.
              </p>
            )}
          </div>
        </div>

        <div className="border-t border-cos-line pt-5 mt-6">
          <SuscripcionAcciones
            configurado={configurado}
            tieneCliente={!!user.stripeCustomerId}
            empresasActivas={empresasActivas}
          />
        </div>
      </div>
    </div>
  );
}
