"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import { useCompany } from "./CompanyProvider";
import { cn } from "@/lib/utils";
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
  Plus,
  Settings,
  ShieldCheck,
  ClipboardList,
  Menu,
  X,
} from "lucide-react";
import { useState, useEffect } from "react";

const NAV_ITEMS = [
  { href: "/dashboard",    label: "Dashboard",       icon: LayoutDashboard },
  { href: "/facturas",     label: "Facturas (CFDI)", icon: FileText },
  { href: "/clientes",     label: "Clientes",        icon: Users },
  { href: "/bancos",       label: "Bancos",          icon: Landmark },
  { href: "/nomina",       label: "Nómina",          icon: Users2 },
  { href: "/impuestos",    label: "Impuestos",       icon: Calculator },
  { href: "/cumplimiento", label: "Cumplimiento",    icon: ShieldCheck },
  { href: "/declaracion-anual", label: "Dec. Anual",  icon: ClipboardList },
  { href: "/contabilidad", label: "Contabilidad",    icon: BookOpen },
];

const BOTTOM_NAV_ITEMS = [
  { href: "/empresa", label: "Mi Empresa", icon: Building2 },
  { href: "/configuracion", label: "Configuración", icon: Settings },
];

interface SidebarProps {
  user: { name?: string | null; email?: string | null };
}

export function Sidebar({ user }: SidebarProps) {
  const pathname = usePathname();
  const { companies, activeCompany, setActiveCompany } = useCompany();
  const [companyOpen, setCompanyOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  // Close the mobile drawer on navigation.
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  return (
    <>
      {/* Mobile top bar with hamburger (hidden on md+) */}
      <div className="md:hidden fixed top-0 inset-x-0 z-30 h-14 bg-white border-b border-border flex items-center gap-3 px-4">
        <button
          onClick={() => setMobileOpen(true)}
          aria-label="Abrir menú"
          className="p-2 -ml-2 rounded-md hover:bg-accent"
        >
          <Menu className="h-5 w-5" />
        </button>
        <span className="font-bold text-primary">ContabilidadOS</span>
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
          "bg-white border-r border-border flex flex-col h-full w-60 shrink-0",
          // Desktop: static in the flex row. Mobile: off-canvas drawer.
          "max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-50 max-md:transition-transform",
          mobileOpen ? "max-md:translate-x-0" : "max-md:-translate-x-full"
        )}
      >
      {/* Logo (with close button on mobile) */}
      <div className="px-4 py-4 border-b border-border flex items-center justify-between">
        <span className="font-bold text-primary text-lg">ContabilidadOS</span>
        <button
          onClick={() => setMobileOpen(false)}
          aria-label="Cerrar menú"
          className="md:hidden p-1 rounded-md hover:bg-accent"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Company switcher */}
      <div className="px-3 py-3 border-b border-border">
        <button
          onClick={() => setCompanyOpen((o) => !o)}
          className="w-full flex items-center gap-2 px-2 py-2 rounded-md hover:bg-accent text-sm"
        >
          <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="flex-1 text-left truncate font-medium">
            {activeCompany?.razonSocial ?? "Sin empresa"}
          </span>
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        </button>

        {companyOpen && (
          <div className="mt-1 bg-white border border-border rounded-md shadow-sm overflow-hidden">
            {companies.map((c) => (
              <button
                key={c.id}
                onClick={() => {
                  setActiveCompany(c);
                  setCompanyOpen(false);
                }}
                className={cn(
                  "w-full text-left px-3 py-2 text-xs hover:bg-accent truncate",
                  activeCompany?.id === c.id && "bg-accent font-medium"
                )}
              >
                <span className="block truncate">{c.razonSocial}</span>
                <span className="block text-muted-foreground">{c.rfc}</span>
              </button>
            ))}
            <Link
              href="/onboarding"
              onClick={() => setCompanyOpen(false)}
              className="flex items-center gap-2 w-full px-3 py-2 text-xs text-primary hover:bg-accent border-t border-border"
            >
              <Plus className="h-3 w-3" />
              Agregar empresa
            </Link>
          </div>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className={cn(
              "flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors",
              pathname === href || pathname.startsWith(href + "/")
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground"
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
            {label}
          </Link>
        ))}

        {/* Divider */}
        <div className="pt-3 mt-3 border-t border-border space-y-1">
          {BOTTOM_NAV_ITEMS.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors",
                pathname === href || pathname.startsWith(href + "/")
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {label}
            </Link>
          ))}
        </div>
      </nav>

      {/* User */}
      <div className="px-3 py-3 border-t border-border">
        <div className="flex items-center gap-2 px-2 py-1 mb-1">
          <div className="h-7 w-7 rounded-full bg-primary/10 flex items-center justify-center text-xs font-bold text-primary">
            {user.name?.[0] ?? user.email?.[0] ?? "U"}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium truncate">{user.name ?? user.email}</p>
            {user.name && (
              <p className="text-xs text-muted-foreground truncate">{user.email}</p>
            )}
          </div>
        </div>
        <button
          onClick={() => signOut({ callbackUrl: "/login" })}
          className="flex items-center gap-2 w-full px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground rounded-md hover:bg-accent transition-colors"
        >
          <LogOut className="h-3.5 w-3.5" />
          Cerrar sesión
        </button>
      </div>
      </aside>
    </>
  );
}
