import { redirect } from "next/navigation";

// «Pendientes» se retiró (revisión página por página): la superficie vive en
// /avisos como historial de notificaciones. El redirect honra los enlaces
// viejos (correos y WhatsApp ya enviados apuntan aquí).
export default function PendientesRedirect() {
  redirect("/avisos");
}
