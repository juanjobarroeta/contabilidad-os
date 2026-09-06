/**
 * POST /api/hospital/episodios/[id]/asistente/transcribir — multipart { audio (webm/ogg/m4a/mp3/wav ≤ 25 MB), idioma?: es-MX }
 *   → { texto, duracionSeg, proveedor: "openai", modelo, asistencia: { origen: "DICTADO", … } }
 *
 * Sólo con HospConfig.sttProveedor = "openai" y OPENAI_API_KEY en el servidor;
 * si no, 409: el satélite dicta con el reconocimiento del navegador (Web
 * Speech API) y manda el texto a /estructurar. 409 también con
 * iaAsistencia = false. El texto es una PROPUESTA: nada se guarda aquí.
 */

import { NextResponse } from "next/server";
import { asegurarUsoIA, respuestaTopeIA } from "@/lib/ai/guardia";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error } from "@/lib/hospital/http";
import { requireModule, requireWriter } from "@/lib/authz";
import { episodioAsistente, exigirPoliticaAsistente } from "@/lib/hospital/asistente/autorizar";
import { STT_MAX_BYTES, mimeAudioAdmitido, transcribirAudio } from "@/lib/hospital/asistente/stt";

// Node para leer multipart binario con fiabilidad (como parse-csf).
export const runtime = "nodejs";
export const maxDuration = 120;

export const POST = withHospital(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const ep = await episodioAsistente(id);
  const { user } = await requireWriter(ep.companyId, req);
  await requireModule(ep.companyId, "HOSPITAL", req);
  await exigirPoliticaAsistente(ep, { stt: true });

  // La transcripción cuesta (OPENAI en CostEvent): pasa por los mismos topes que el modelo.
  const guardia = await asegurarUsoIA({ userId: user.id, companyId: ep.companyId });
  if (!guardia.ok) return respuestaTopeIA(guardia);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return error(`No se pudo leer el audio (Content-Type: ${req.headers.get("content-type") ?? "sin Content-Type"}); manda multipart/form-data con el campo 'audio'`);
  }
  const audio = form.get("audio");
  if (!(audio instanceof File)) return error("Sube el audio en el campo 'audio' del multipart");
  if (audio.size > STT_MAX_BYTES) return error("El audio excede el límite de 25 MB: graba en segmentos más cortos", 413);
  const mime = audio.type || "audio/webm";
  if (!mimeAudioAdmitido(mime)) return error(`Formato de audio no admitido (${mime}): usa webm, ogg, m4a, mp3 o wav`, 415);
  const idiomaCampo = form.get("idioma");
  const idioma = typeof idiomaCampo === "string" ? idiomaCampo : null;

  const buffer = Buffer.from(await audio.arrayBuffer());
  const t = await transcribirAudio(buffer, mime, idioma, { cost: { companyId: ep.companyId, userId: user.id, subtipo: "hospital.asistente.transcribir" } });
  const at = new Date().toISOString();

  bitacora(user, req, {
    companyId: ep.companyId,
    accion: "hospital.asistente.transcribir",
    entidad: "HospEpisodio",
    entidadId: ep.id,
    detalle: { folio: ep.folio, bytes: buffer.byteLength, mime, duracionSeg: t.duracionSeg, modelo: t.modelo, caracteres: t.texto.length },
  });

  return NextResponse.json({
    texto: t.texto,
    duracionSeg: t.duracionSeg,
    proveedor: t.proveedor,
    modelo: t.modelo,
    asistencia: { origen: "DICTADO", sttProveedor: t.proveedor, modelo: t.modelo, at },
  });
});
