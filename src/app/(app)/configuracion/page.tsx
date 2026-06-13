import Link from "next/link";
import { Building2, Users, CreditCard, UserCircle, Briefcase, Bell } from "lucide-react";

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
];

export default function ConfiguracionPage() {
  return (
    <div className="p-6 max-w-5xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Configuración</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Administra tu cuenta, empresas y colaboradores.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {SECTIONS.map((s) => (
          <Link
            key={s.href}
            href={s.href}
            className="group bg-white border border-border rounded-xl p-5 hover:border-primary/40 hover:shadow-sm transition-all"
          >
            <div className="flex items-start gap-4">
              <div className="h-10 w-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
                <s.icon className="h-5 w-5" />
              </div>
              <div className="flex-1">
                <h2 className="font-semibold text-foreground group-hover:text-primary">
                  {s.title}
                </h2>
                <p className="text-sm text-muted-foreground mt-0.5">{s.description}</p>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
