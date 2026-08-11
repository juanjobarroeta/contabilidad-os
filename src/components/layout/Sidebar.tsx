"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { signOut } from "next-auth/react";
import { useCompany } from "./CompanyProvider";
import { cn } from "@/lib/utils";
import { BrandMark, ThemeToggle } from "@/components/ui";
import {
  LayoutDashboard,
  FileText,
  Users,
  Landmark,
  Users2,
  Calculator,
  BookOpen,
  ChevronDown,
  LogOut,
  Building2,
  Briefcase,
  Plus,
  Settings,
  ShieldCheck,
  ScanSearch,
  Menu,
  X,
  TrendingUp,
  Wrench,
  Inbox,
  Banknote,
  UserRound,
  ClipboardCheck,
  LayoutGrid,
  Truck,
  type LucideIcon,
} from "lucide-react";
import { useState, useEffect } from "react";

type NavItem = { href: string; label: string; icon: LucideIcon; badge?: string };
type NavSection = { label: string | null; items: NavItem[] };

// Menú agrupado en secciones (rediseño de navegación). Las rutas no cambian:
// cada destino sigue apuntando a su página actual; sólo se reorganizan bajo
// encabezados ("Operación" / "Fiscal") para que se encuentren donde se esperan.
const SECTIONS: NavSection[] = [
  {
    label: null,
    items: [{ href: "/dashboard", label: "Inicio", icon: LayoutDashboard }],
  },
  {
    label: "Operación",
    items: [
      { href: "/facturas", label: "Facturas", icon: FileText },
      { href: "/clientes", label: "Clientes", icon: Users },
      { href: "/proveedores", label: "Proveedores", icon: Truck },
      { href: "/bancos", label: "Bancos", icon: Landmark },
    ],
  },
  {
    label: "Fiscal",
    items: [
      { href: "/impuestos", label: "Impuestos", icon: Calculator, badge: "3 tabs" },
      { href: "/contabilidad", label: "Contabilidad", icon: BookOpen, badge: "9 tabs" },
      { href: "/cumplimiento", label: "Cumplimiento", icon: ShieldCheck, badge: "3 tabs" },
      // Herramienta transversal (no depende de la empresa activa): valida
      // RFC/CURP/NSS y cruza la lista 69-B — el "check.id" incluido en el plan.
      { href: "/verificador", label: "Verificador", icon: ScanSearch },
    ],
  },
];

// Nómina: pilar propio en la navegación (deja de ser un renglón dentro de
// Operación). Las entradas enlazan a las pestañas del hub /nomina (deep-link
// ?tab=) y a las páginas hermanas — las RUTAS no cambian, sólo se hacen
// visibles. El resaltado sigue la pestaña activa (y las páginas hijas
// /nomina/empleado/* y /nomina/ajuste-anual encienden a su padre).
type NominaItem = { href: string; label: string; icon: LucideIcon; tab: string | null };

const NOMINA_ITEMS: NominaItem[] = [
  { href: "/nomina", label: "Resumen", icon: Users2, tab: "resumen" },
  { href: "/nomina?tab=corridas", label: "Corridas", icon: Banknote, tab: "corridas" },
  { href: "/nomina?tab=empleados", label: "Empleados", icon: UserRound, tab: "empleados" },
  { href: "/nomina?tab=cumplimiento", label: "IMSS y cumplimiento", icon: ClipboardCheck, tab: "cumplimiento" },
];

/**
 * Cuál entrada de Nómina está activa. PURA para poder probarla a ojo:
 *   - /nomina → la pestaña de la URL (?tab=), o "resumen" sin ella.
 *   - /nomina/empleado/* → "empleados"; /nomina/ajuste-anual → "cumplimiento"
 *     (de ahí se llega); /nomina/cockpit → "cockpit" (item del despacho).
 */
function nominaTabActiva(pathname: string, tabParam: string | null): string | null {
  if (pathname === "/nomina") return tabParam ?? "resumen";
  if (pathname.startsWith("/nomina/empleado")) return "empleados";
  if (pathname.startsWith("/nomina/ajuste-anual")) return "cumplimiento";
  if (pathname.startsWith("/nomina/cockpit")) return "cockpit";
  if (pathname.startsWith("/nomina")) return "resumen";
  return null;
}

// Cartera (vista despacho) reutiliza la ruta /despacho; sólo aparece cuando el
// usuario opera más de una empresa.
const CARTERA: NavItem = { href: "/despacho", label: "Cartera", icon: Briefcase };

const BOTTOM_NAV_ITEMS: NavItem[] = [
  { href: "/empresa", label: "Mi Empresa", icon: Building2 },
  { href: "/configuracion", label: "Configuración", icon: Settings },
];

const GRP_LBL =
  "px-3 pt-4 pb-1 font-mono text-[10px] font-semibold uppercase tracking-[0.13em] text-cos-ink-faint";

function navLinkClass(active: boolean): string {
  return cn(
    "flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors",
    active ? "bg-cos-brand text-white" : "text-cos-ink-soft hover:bg-cos-paper hover:text-cos-ink"
  );
}

interface SidebarProps {
  user: { name?: string | null; email?: string | null };
  /** Herramientas internas (p.ej. Rentabilidad) sólo para operador de plataforma. */
  esOperador?: boolean;
}

export function Sidebar({ user, esOperador }: SidebarProps) {
  const pathname = usePathname();
  // Para resaltar la pestaña activa de Nómina (?tab=). Todas las rutas bajo
  // (app) son dinámicas (el layout lee la sesión), así que no requiere Suspense.
  const searchParams = useSearchParams();
  const { companies, activeCompany, setActiveCompany } = useCompany();
  const [companyOpen, setCompanyOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [pendientesNuevos, setPendientesNuevos] = useState(0);

  // Cartera sólo para despachos (más de una empresa).
  const showCartera = companies.length > 1;

  // Close the mobile drawer on navigation.
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  // Conteo de pendientes NUEVO para el badge del menú. Se refresca al navegar
  // (p.ej. al volver de /pendientes tras atender alguno).
  useEffect(() => {
    let activo = true;
    fetch("/api/notificaciones?estado=NUEVO")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (activo && d) setPendientesNuevos(d.noLeidos ?? 0);
      })
      .catch(() => {});
    return () => {
      activo = false;
    };
  }, [pathname]);

  // Highlight only the most specific matching item, so a nested route (e.g.
  // /impuestos/papeles) doesn't also light up a shorter-prefix sibling.
  const allHrefs = [
    ...SECTIONS.flatMap((s) => s.items.map((i) => i.href)),
    CARTERA.href,
    "/pendientes",
    "/rentabilidad",
    "/operador",
    ...BOTTOM_NAV_ITEMS.map((i) => i.href),
  ];
  const activeNavHref = allHrefs
    .filter((href) => pathname === href || pathname.startsWith(href + "/"))
    .sort((a, b) => b.length - a.length)[0] ?? null;

  // Entrada activa de la sección Nómina (por pestaña, no sólo por ruta).
  const nominaActiva = nominaTabActiva(pathname, searchParams.get("tab"));

  return (
    <>
      {/* Mobile top bar with hamburger (hidden on md+) */}
      <div className="md:hidden fixed top-0 inset-x-0 z-30 h-14 bg-cos-card border-b border-cos-line flex items-center gap-3 px-4">
        <button
          onClick={() => setMobileOpen(true)}
          aria-label="Abrir menú"
          className="p-2 -ml-2 rounded-md hover:bg-cos-paper"
        >
          <Menu className="h-5 w-5" />
        </button>
        <span className="flex items-center gap-2 text-[16px] font-semibold tracking-[-0.02em] text-cos-ink">
          <BrandMark size={20} className="text-cos-brand" />
          Contabilidad<span className="text-cos-brand">OS</span>
        </span>
        <div className="ml-auto">
          <ThemeToggle />
        </div>
      </div>

      {/* Backdrop (mobile only, when open) */}
      {mobileOpen && (
        <div
          className="md:hidden fixed inset-0 z-40 bg-black/40"
          onClick={() => setMobileOpen(false)}
          aria-hidden
        />
      )}

      <aside
        className={cn(
          "bg-cos-card border-r border-cos-line flex flex-col h-full w-60 shrink-0",
          // Desktop: static in the flex row. Mobile: off-canvas drawer.
          "max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-50 max-md:transition-transform",
          mobileOpen ? "max-md:translate-x-0" : "max-md:-translate-x-full"
        )}
      >
      {/* Logo (with close button on mobile) */}
      <div className="px-4 py-4 border-b border-cos-line flex items-center justify-between">
        <span className="flex items-center gap-2 text-[19px] font-semibold tracking-[-0.03em] text-cos-ink">
          <BrandMark size={24} className="text-cos-brand" />
          Contabilidad<span className="text-cos-brand">OS</span>
        </span>
        <div className="flex items-center gap-1">
          {/* Toggle de tema: en escritorio vive aquí; en móvil está en la barra superior. */}
          <div className="max-md:hidden">
            <ThemeToggle />
          </div>
          <button
            onClick={() => setMobileOpen(false)}
            aria-label="Cerrar menú"
            className="md:hidden p-1 rounded-md hover:bg-cos-paper"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Company switcher */}
      <div className="px-3 py-3 border-b border-cos-line">
        <button
          onClick={() => setCompanyOpen((o) => !o)}
          className="w-full flex items-center gap-2 px-2 py-2 rounded-md hover:bg-cos-paper text-sm"
        >
          <Building2 className="h-4 w-4 text-cos-ink-soft shrink-0" />
          <span className="flex-1 text-left truncate font-medium">
            {activeCompany?.razonSocial ?? "Sin empresa"}
          </span>
          <ChevronDown className="h-3 w-3 text-cos-ink-soft" />
        </button>

        {companyOpen && (
          <div className="mt-1 bg-cos-card border border-cos-line rounded-md shadow-sm overflow-hidden">
            <div className="max-h-72 overflow-y-auto">
              {(() => {
                const renderCompany = (c: typeof companies[number]) => (
                  <button
                    key={c.id}
                    onClick={() => {
                      setActiveCompany(c);
                      setCompanyOpen(false);
                    }}
                    className={cn(
                      "w-full text-left px-3 py-2 text-xs hover:bg-cos-paper truncate",
                      activeCompany?.id === c.id && "bg-cos-paper font-medium"
                    )}
                  >
                    <span className="block truncate">{c.razonSocial}</span>
                    <span className="block text-cos-ink-soft">{c.rfc}</span>
                  </button>
                );

                // Agrupa por despacho sólo cuando hay más de uno (operador de
                // plataforma). Para un usuario normal —un solo despacho— se
                // mantiene la lista plana de siempre.
                const despachos = Array.from(
                  new Set(companies.map((c) => c.despachoNombre ?? null))
                ).filter(Boolean);
                if (despachos.length <= 1) return companies.map(renderCompany);

                const groups = new Map<string, typeof companies>();
                for (const c of companies) {
                  const k = c.despachoNombre ?? "Sin despacho";
                  const arr = groups.get(k) ?? [];
                  arr.push(c);
                  groups.set(k, arr);
                }
                return Array.from(groups.entries()).map(([nombre, list]) => (
                  <div key={nombre}>
                    <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-cos-ink-soft bg-cos-paper sticky top-0">
                      {nombre}
                    </div>
                    {list.map(renderCompany)}
                  </div>
                ));
              })()}
            </div>
            <Link
              href="/onboarding"
              onClick={() => setCompanyOpen(false)}
              className="flex items-center gap-2 w-full px-3 py-2 text-xs text-cos-brand-ink hover:bg-cos-paper border-t border-cos-line"
            >
              <Plus className="h-3 w-3" />
              Agregar empresa
            </Link>
          </div>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-3 overflow-y-auto">
        {/* Inicio + Cartera (sin encabezado) */}
        <div className="space-y-1">
          <Link href="/dashboard" className={navLinkClass("/dashboard" === activeNavHref)}>
            <LayoutDashboard className="h-4 w-4 shrink-0" />
            Inicio
          </Link>
          <Link href="/pendientes" className={navLinkClass("/pendientes" === activeNavHref)}>
            <Inbox className="h-4 w-4 shrink-0" />
            <span className="flex-1">Pendientes</span>
            {pendientesNuevos > 0 && (
              <span className="rounded-full bg-cos-brand px-2 py-0.5 font-mono text-[10px] font-semibold text-white">
                {pendientesNuevos}
              </span>
            )}
          </Link>
          {showCartera && (
            <Link href={CARTERA.href} className={navLinkClass(CARTERA.href === activeNavHref)}>
              <CARTERA.icon className="h-4 w-4 shrink-0" />
              <span className="flex-1">{CARTERA.label}</span>
              <span className="rounded-full bg-cos-brand-tint px-2 py-0.5 font-mono text-[10px] font-semibold text-cos-brand-ink">
                {companies.length} RFC
              </span>
            </Link>
          )}
        </div>

        {/* Secciones con encabezado (Operación / Nómina / Fiscal) */}
        {SECTIONS.filter((s) => s.label).map((section) => (
          <div key={section.label}>
            <p className={GRP_LBL}>{section.label}</p>
            <div className="space-y-1">
              {section.items.map(({ href, label, icon: Icon, badge }) => (
                <Link key={href} href={href} className={navLinkClass(href === activeNavHref)}>
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="flex-1">{label}</span>
                  {badge && (
                    <span className="rounded-full bg-cos-brand-tint px-2 py-0.5 font-mono text-[10px] font-semibold text-cos-brand-ink">
                      {badge}
                    </span>
                  )}
                </Link>
              ))}
            </div>
            {/* Nómina: sección propia, entre Operación y Fiscal. */}
            {section.label === "Operación" && (
              <div>
                <p className={GRP_LBL}>Nómina</p>
                <div className="space-y-1">
                  {/* Despachos: el tablero multi-RFC encabeza la sección (antes
                      era un redirect silencioso del único renglón "Nómina"). */}
                  {showCartera && (
                    <Link
                      href="/nomina/cockpit"
                      className={navLinkClass(nominaActiva === "cockpit")}
                    >
                      <LayoutGrid className="h-4 w-4 shrink-0" />
                      <span className="flex-1">Tablero multi-RFC</span>
                    </Link>
                  )}
                  {NOMINA_ITEMS.map(({ href, label, icon: Icon, tab }) => (
                    <Link key={href} href={href} className={navLinkClass(nominaActiva === tab)}>
                      <Icon className="h-4 w-4 shrink-0" />
                      <span className="flex-1">{label}</span>
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}

        {/* Operador de plataforma: herramientas internas (ocultas para los demás). */}
        {esOperador && (
          <div>
            <p className={GRP_LBL}>Operador</p>
            <div className="space-y-1">
              <Link href="/rentabilidad" className={navLinkClass(pathname === "/rentabilidad")}>
                <TrendingUp className="h-4 w-4 shrink-0" />
                Rentabilidad
              </Link>
              <Link href="/creditos" className={navLinkClass(pathname === "/creditos")}>
                <Banknote className="h-4 w-4 shrink-0" />
                Créditos
              </Link>
              <Link href="/operador" className={navLinkClass(pathname === "/operador")}>
                <Wrench className="h-4 w-4 shrink-0" />
                Herramientas
              </Link>
            </div>
          </div>
        )}

        {/* Footer nav (separado) */}
        <div className="pt-3 mt-3 border-t border-cos-line space-y-1">
          {BOTTOM_NAV_ITEMS.map(({ href, label, icon: Icon }) => (
            <Link key={href} href={href} className={navLinkClass(href === activeNavHref)}>
              <Icon className="h-4 w-4 shrink-0" />
              {label}
            </Link>
          ))}
        </div>
      </nav>

      {/* User */}
      <div className="px-3 py-3 border-t border-cos-line">
        <div className="flex items-center gap-2 px-2 py-1 mb-1">
          <div className="h-7 w-7 rounded-full bg-cos-brand-tint flex items-center justify-center text-xs font-bold text-cos-brand-ink">
            {user.name?.[0] ?? user.email?.[0] ?? "U"}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium truncate text-cos-ink">{user.name ?? user.email}</p>
            {user.name && (
              <p className="text-xs text-cos-ink-soft truncate">{user.email}</p>
            )}
          </div>
        </div>
        <button
          onClick={() => signOut({ callbackUrl: "/login" })}
          className="flex items-center gap-2 w-full px-2 py-1.5 text-xs text-cos-ink-soft hover:text-cos-ink rounded-md hover:bg-cos-paper transition-colors"
        >
          <LogOut className="h-3.5 w-3.5" />
          Cerrar sesión
        </button>
      </div>
      </aside>
    </>
  );
}
