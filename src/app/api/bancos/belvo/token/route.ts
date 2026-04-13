import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { createWidgetToken, isBelvoConfigured } from "@/lib/belvo";

// POST /api/bancos/belvo/token
// Returns a temporary access token for the Belvo Connect Widget.
export async function POST() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!isBelvoConfigured()) {
    return NextResponse.json(
      { error: "Belvo no está configurado. Configura BELVO_SECRET_ID y BELVO_SECRET_PASSWORD." },
      { status: 503 }
    );
  }

  try {
    const token = await createWidgetToken();
    return NextResponse.json({ access: token.access });
  } catch (e) {
    console.error("[belvo/token] Error:", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Error al obtener token de Belvo" },
      { status: 502 }
    );
  }
}
