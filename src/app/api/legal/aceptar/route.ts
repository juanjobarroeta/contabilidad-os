import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { pendientesDeUsuario, registrarAceptaciones } from "@/lib/legal/aceptaciones";

// POST /api/legal/aceptar   { "acepta": true }
//
// Registra la aceptación de TODOS los documentos de cuenta que el usuario
// tenga pendientes (Términos y/o Aviso en su versión vigente). Lo llama el
// AceptacionLegalGate cuando un usuario existente entra a la app después de
// un cambio de versión, o cuando su cuenta fue creada por un tercero (alta
// desde un satélite o por un administrador) sin pasar por el signup.
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  if (body?.acepta !== true) {
    return NextResponse.json({ error: "Debes aceptar los documentos para continuar" }, { status: 400 });
  }

  const pendientes = await pendientesDeUsuario(session.user.id);
  await registrarAceptaciones({
    userId: session.user.id,
    email: session.user.email ?? null,
    documentos: pendientes.map((d) => d.documento),
    contexto: "gate",
    req,
  });

  return NextResponse.json({ ok: true, aceptados: pendientes.map((d) => d.documento) });
}
