import Link from "next/link";
import { Building2, Users, CreditCard, UserCircle, Briefcase, Bell, MessageCircle, TicketPercent } from "lucide-react";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { esAdminPlataforma } from "@/lib/billing/admin-plataforma";

const SECTIONS = [
  {
    href: "/configuracion/despacho",
    title: "Despacho",
    description: "Tu organización, miembros del equipo y roles.",
    icon: Briefcase,
  },
  {
    href: "/configuracion/empresas",
    title: "Empresas",
    description: "Administra los RFCs, datos fiscales y certificados.",
    icon: Building2,
  },
  {
    href: "/configuracion/usuarios",
    title: "Usuarios",
    description: "Lista completa de personas con acceso.",
    icon: Users,
  },
  {
    href: "/configuracion/facturacion",
    title: "Facturación",
    description: "Tu plan, prueba y método de pago.",
    icon: CreditCard,
  },
  {
    href: "/configuracion/cuenta",
    title: "Mi cuenta",
    description: "Nombre, correo y contraseña.",
    icon: UserCircle,
  },
  {
    href: "/configuracion/notificaciones",
    title: "Notificaciones",
    description: "Activa el push y elige qué avisos recibir.",
    icon: Bell,
  },
  {
    href: "/configuracion/whatsapp",
    title: "WhatsApp",
    description: "Vincula tu número y consulta tu contabilidad por chat.",
    icon: MessageCircle,
  },
];

// Sección extra SOLO para el admin de plataforma (PLATFORM_ADMIN_EMAILS):
// generador de códigos de descuento por negociación. Para el resto de los
// usuarios ni siquiera aparece la tarjeta (y la página responde 404).
const SECCION_CODIGOS = {
  href: "/configuracion/codigos",
  title: "Códigos de descuento",
  description: "Genera códigos por cliente según el precio negociado.",
  icon: TicketPercent,
};

export default async function ConfiguracionPage() {
  const session = await auth();
  let sections = SECTIONS;
  if (session?.user?.id) {
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { email: true },
    });
    if (user?.email && esAdminPlataforma(user.email)) sections = [...SECTIONS, SECCION_CODIGOS];
  }

  return (
    <div className="p-6 max-w-5xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Configuración</h1>
        <p className="text-sm text-cos-ink-soft mt-1">
          Administra tu cuenta, empresas y colaboradores.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {sections.map((s) => (
          <Link
            key={s.href}
            href={s.href}
            className="group bg-cos-card border border-cos-line rounded-xl p-5 hover:border-cos-brand/40 hover:shadow-sm transition-all"
          >
            <div className="flex items-start gap-4">
              <div className="h-10 w-10 rounded-lg bg-cos-brand-tint text-cos-brand-ink flex items-center justify-center shrink-0">
                <s.icon className="h-5 w-5" />
              </div>
              <div className="flex-1">
                <h2 className="font-semibold text-cos-ink group-hover:text-cos-brand-ink">
                  {s.title}
                </h2>
                <p className="text-sm text-cos-ink-soft mt-0.5">{s.description}</p>
              </div>
            </div>
          </Link>
        ))}
      </div>

      <p className="text-xs text-cos-ink-faint mt-8">
        <Link href="/legal/aviso-de-privacidad" className="hover:text-cos-brand-ink hover:underline">
          Aviso de Privacidad
        </Link>
        {" · "}
        <Link href="/legal/terminos" className="hover:text-cos-brand-ink hover:underline">
          Términos y Condiciones
        </Link>
      </p>
    </div>
  );
}
