import { NextResponse } from "next/server";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { requireModule, requireWriter } from "@/lib/authz";
import { meteredCreate } from "@/lib/costos/anthropic";
import { asegurarUsoIA, respuestaTopeIA } from "@/lib/ai/guardia";
import { withHospital } from "@/lib/hospital/with-hospital";
import { error, errorZod } from "@/lib/hospital/http";
import { caducidadImpresa, normalizarGtin } from "@/lib/hospital/codigos-barras";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/hospital/farmacia/etiqueta   { companyId, archivoBase64, mime }
//
// Lee de la FOTO de la caja lo que el código de barras no trae: lote,
// caducidad y precio máximo al público (van impresos con tinta al lado del
// EAN). Mismo patrón que el lector de vouchers de Caja: el modelo propone,
// la persona confirma — nada se guarda desde aquí. La imagen no se guarda.
// ─────────────────────────────────────────────────────────────────────────────

export const maxDuration = 120;

const MAX_BYTES = 10 * 1024 * 1024;
const MIMES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;

const schema = z.object({
  companyId: z.string().min(1),
  archivoBase64: z.string().min(1),
  mime: z.enum(MIMES),
});

const SYSTEM_PROMPT = `Eres el asistente de farmacia de un hospital en México. Lees la ETIQUETA de una caja de medicamento o material de curación para registrar su recepción o su conteo.

REGLAS:
1. Devuelve SOLO un objeto JSON válido, sin markdown ni explicaciones.
2. Si un campo no aparece con claridad, devuelve null. NO inventes ni completes valores.
3. lote: el número de LOTE (aparece como Lote, LOT, L.) tal cual, en mayúsculas, sin espacios.
4. caducidadTexto: la CADUCIDAD tal como está impresa (aparece como Cad., CAD, EXP, Caducidad, Vence), por ejemplo «JUL 28», «07/2028», «2028-07». No la conviertas.
5. precioMaximoPublico: el PRECIO MÁXIMO AL PÚBLICO como número sin signo ni comas (ej. 2727.5). Si no aparece, null.
6. codigoImpreso: los dígitos impresos bajo el código de barras, sin espacios (ej. 7502245840289).
7. producto: el nombre del producto si se ve en la foto; si no, null.
8. confianza: número entre 0 y 1 según la legibilidad.
9. Ojo: a veces la impresora de tinta desfasa los renglones (el valor de «Lote» puede venir en el renglón de arriba y el de «Cad.» en el de en medio). Asigna cada valor por lo que ES (un lote es alfanumérico; una caducidad es mes y año; un precio lleva signo de pesos), no sólo por el renglón.

SCHEMA:
{
  "lote": string | null,
  "caducidadTexto": string | null,
  "precioMaximoPublico": number | null,
  "codigoImpreso": string | null,
  "producto": string | null,
  "confianza": number,
  "notas": string | null
}`;

const texto = (v: unknown, max = 120): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

function importe(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null;
  const s = texto(v, 30);
  if (!s) return null;
  const n = Number(s.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

export const POST = withHospital(async (req: Request) => {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorZod(parsed.error);
  const { companyId, mime } = parsed.data;
  const { user } = await requireWriter(companyId, req);
  await requireModule(companyId, "HOSPITAL", req);

  const guardia = await asegurarUsoIA({ userId: user.id, companyId });
  if (!guardia.ok) return respuestaTopeIA(guardia);
  if (!process.env.ANTHROPIC_API_KEY) return error("La lectura de etiquetas con IA no está configurada en este servidor", 503);

  const base64 = parsed.data.archivoBase64.replace(/^data:[^;]+;base64,/, "").replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/=]+$/.test(base64)) return error("archivoBase64 no es base64 válido");
  if (Math.floor((base64.length * 3) / 4) > MAX_BYTES) return error("La foto pesa más de 10 MB", 413);

  let respuesta = "";
  try {
    const msg = await meteredCreate(new Anthropic(), { subtipo: "hospital.etiqueta.leer", userId: user.id, companyId }, {
      model: "claude-opus-5",
      max_tokens: 800,
      output_config: { effort: "low" },
      system: SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mime, data: base64 } },
          { type: "text", text: "Lee la etiqueta siguiendo el schema exacto. Sólo JSON." },
        ],
      }],
    });
    if (msg.stop_reason === "refusal") return error("El modelo no procesó la foto; captura los datos a mano", 422);
    respuesta = msg.content.find((b) => b.type === "text")?.text ?? "";
  } catch (e) {
    console.error("[hospital.etiqueta.leer] error del modelo:", e instanceof Error ? e.message : e);
    return error("No se pudo leer la etiqueta; captura los datos a mano", 502);
  }

  let x: Record<string, unknown>;
  try {
    x = JSON.parse(respuesta.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim());
  } catch {
    return error("La lectura no devolvió datos legibles; captura los datos a mano", 502);
  }

  const advertencias: string[] = [];
  const nota = texto(x.notas, 300);
  if (nota) advertencias.push(nota);
  const caducidadTexto = texto(x.caducidadTexto, 30);
  const caducidad = caducidadImpresa(caducidadTexto);
  if (caducidadTexto && !caducidad) advertencias.push(`No entendí la caducidad «${caducidadTexto}»: captúrala.`);
  const codigoImpreso = texto(x.codigoImpreso, 20)?.replace(/\D/g, "") || null;
  const gtinImpreso = codigoImpreso ? normalizarGtin(codigoImpreso) : null;
  if (codigoImpreso && !gtinImpreso) advertencias.push(`Los dígitos bajo el código («${codigoImpreso}») no cuadran con su verificador: escanéalo en lugar de copiarlo.`);
  const confianza = typeof x.confianza === "number" ? Math.max(0, Math.min(1, x.confianza)) : null;
  if (confianza != null && confianza < 0.6) advertencias.push("La foto no se leyó con claridad: revisa cada campo.");

  return NextResponse.json({
    lote: texto(x.lote, 60)?.replace(/\s+/g, "").toUpperCase() ?? null,
    caducidadTexto,
    caducidad,
    precioMaximoPublico: importe(x.precioMaximoPublico),
    codigoImpreso,
    gtinImpreso,
    producto: texto(x.producto, 160),
    confianza,
    advertencias,
  });
});
