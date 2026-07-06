import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Raíz del dominio: antes no existía página y "/" respondía 404 — la puerta
// principal del producto era un callejón sin salida. Con sesión → /dashboard;
// sin sesión → /login. Cuando exista dominio propio, "/" será la landing de
// marketing y la app vivirá en su subdominio.
export default async function RootPage() {
  const session = await auth();
  redirect(session?.user ? "/dashboard" : "/login");
}
