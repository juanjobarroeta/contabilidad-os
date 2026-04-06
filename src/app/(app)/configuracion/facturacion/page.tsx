import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getUserSubscriptionState } from "@/lib/subscription";
import { ArrowLeft, CreditCard } from "lucide-react";

const STATUS_LABELS: Record<string, string> = {
  TRIALING: "Prueba",
  ACTIVE: "Activa",
  PAST_DUE: "Pago vencido",
  CANCELED: "Cancelada",
  EXPIRED: "Vencida",
};

export default async function FacturacionPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const state = await getUserSubscriptionState(session.user.id);

  return (
    <div className="p-6 max-w-3xl">
      <Link
        href="/configuracion"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-4"
      >
        <ArrowLeft className="h-4 w-4" /> Configuración
      </Link>

      <div className="mb-6">
        <h1 className="text-2xl font-bold">Facturación</h1>
        <p className="text-sm text-muted-foreground mt-1">Tu plan y estado de suscripción.</p>
      </div>

      <div className="bg-white border border-border rounded-xl p-6">
        <div className="flex items-start gap-4 mb-6">
          <div className="h-10 w-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <CreditCard className="h-5 w-5" />
          </div>
          <div className="flex-1">
            <p className="text-xs uppercase text-muted-foreground tracking-wide">Estado actual</p>
            <p className="text-xl font-bold mt-1">{STATUS_LABELS[state.status] ?? state.status}</p>
            {state.isTrialing && state.daysLeft !== null && (
              <p className="text-sm text-muted-foreground mt-1">
                Te {state.daysLeft === 1 ? "queda" : "quedan"} {state.daysLeft}{" "}
                {state.daysLeft === 1 ? "día" : "días"} de prueba
              </p>
            )}
          </div>
        </div>

        <div className="border-t border-border pt-5">
          <p className="text-sm text-muted-foreground mb-3">
            La integración con Stripe llega pronto. Por ahora, durante la prueba tienes acceso
            completo a todas las funciones.
          </p>
          <div className="bg-blue-50 border border-blue-200 rounded-md p-4 text-sm">
            <p className="font-semibold text-blue-900 mb-1">Precios planeados</p>
            <ul className="text-blue-800 space-y-1 text-xs">
              <li>• <strong>Solo</strong> $499/mes — 1 RFC, persona física</li>
              <li>• <strong>Negocio</strong> $1,499/mes — 1 RFC PM, nómina, multi-usuario</li>
              <li>• <strong>+ RFC adicional</strong> $999/mes c/u</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
