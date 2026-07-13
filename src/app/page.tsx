import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { Landing } from "./landing";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "ContabilidadOS — La contabilidad de tu despacho, en automático",
  description:
    "CFDIs que se descargan solos con tu e.firma, bancos por WhatsApp, nómina verificada contra el DOF y toda tu cartera multi-RFC en un tablero. Para despachos contables y sus clientes.",
};

// Raíz del dominio: con sesión → /dashboard; sin sesión → landing pública de
// marketing (el pitch para despachos, con CTA a prueba gratis y demo). Antes
// redirigía a /login — la puerta principal no vendía nada.
export default async function RootPage() {
  const session = await auth();
  if (session?.user) redirect("/dashboard");
  return <Landing />;
}
