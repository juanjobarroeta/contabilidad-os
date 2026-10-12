/**
 * POST /api/hospital/cotizaciones/leer { companyId, archivoBase64, mime, pagadorId? }
 *   → { lectura: {hospital, procedimiento, total, …}, renglones: [{…, servicioId, candidatos}], propio, advertencias[] }
 *
 * Lee la cotización de OTRO hospital (PDF o foto) y la reprecia con el
 * tarifario propio: así se ve renglón por renglón qué cobramos nosotros por lo
 * mismo y cuánto margen hay para mejorar su precio.
 *
 * NO ESCRIBE NADA. La cotización propia la arma quien cotiza a partir de esta
 * lectura (POST /cotizaciones). El archivo no se guarda y va a la API de
 * Anthropic de forma efímera, con el gasto acotado por la guardia de IA.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { requireModule, requireWriter } from "@/lib/authz";
import { meteredCreate } from "@/lib/costos/anthropic";
import { asegurarUsoIA, respuestaTopeIA } from "@/lib/ai/guardia";
import { MODELO_LECTOR } from "@/lib/ai/modelos";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error, errorZod } from "@/lib/hospital/http";
import { r2 } from "@/lib/hospital/util";
import { emparejar, indexar, limpiarLectura, totalPropio, GRUPOS_COMPETENCIA, type ServicioTarifa } from "@/lib/hospital/cotizacion-competencia";

export const runtime = "nodejs";
export const maxDuration = 180;

const MAX_BYTES = 15 * 1024 * 1024;
const MIMES = ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/gif"] as const;

const schema = z.object({
  companyId: z.string().min(1),
  archivoBase64: z.string().min(1),
  mime: z.enum(MIMES),
  pagadorId: z.string().nullable().optional(),
});

const SYSTEM_PROMPT = `Eres analista de precios de un hospital privado en México. Te dan la COTIZACIÓN DE OTRO HOSPITAL (presupuesto de un procedimiento: hospitalización, quirófano, insumos, medicamentos, soluciones, servicios) y la pasas a datos para compararla.

REGLAS:
1. Devuelve SOLO un objeto JSON válido, sin markdown ni explicaciones.
2. Copia TODOS los renglones, en orden, aunque sean muchos y aunque la tabla siga en varias páginas. Los encabezados repetidos de cada página no son renglones.
3. descripcion: el texto del renglón tal cual (sin la cantidad). Si una descripción se parte en dos líneas, únelas en un solo renglón; una línea suelta sin cantidad casi siempre es la continuación del renglón anterior.
4. cantidad: el número de la columna de cantidad. Si no aparece, 1.
5. grupo: la sección en la que viene el renglón, normalizada a una de: ${GRUPOS_COMPETENCIA.join(", ")}. Si el documento no tiene secciones, infiérela por el tipo de concepto.
6. precioUnitario e importe: SOLO si el documento los trae por renglón; si no, null. Nunca los inventes ni los repartas.
7. total: el total o «precio aproximado» del documento, como número. totalIncluyeIva: true si el documento dice que incluye IVA, false si dice que no, null si no lo dice.
8. hospital: el nombre del hospital que emite la cotización si aparece (logo, encabezado, pie); si no, null.
9. procedimiento: el título del procedimiento cotizado, tal cual.
10. vigencia: la fecha de vigencia tal como aparece, o null.
11. notas: exclusiones y condiciones relevantes (qué NO incluye, restricciones), 1-3 líneas, o null.

SCHEMA:
{
  "hospital": string | null,
  "procedimiento": string | null,
  "total": number | null,
  "totalIncluyeIva": boolean | null,
  "vigencia": string | null,
  "notas": string | null,
  "renglones": [{ "cantidad": number, "descripcion": string, "grupo": string, "precioUnitario": number | null, "importe": number | null }]
}`;

export const POST = withHospital(async (req: Request) => {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);
  const { companyId, mime, pagadorId } = parsed.data;

  const { user } = await requireWriter(companyId, req);
  await requireModule(companyId, "HOSPITAL", req);

  if (pagadorId) {
    const p = await prisma.hospPagador.findUnique({ where: { id: pagadorId }, select: { companyId: true } });
    if (!p || p.companyId !== companyId) return error("pagadorId inválido");
  }

  const guardia = await asegurarUsoIA({ userId: user.id, companyId });
  if (!guardia.ok) return respuestaTopeIA(guardia);
  if (!process.env.ANTHROPIC_API_KEY) return error("La lectura de cotizaciones con IA no está configurada en este servidor", 503);

  const base64 = parsed.data.archivoBase64.replace(/^data:[^;]+;base64,/, "").replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/=]+$/.test(base64)) return error("archivoBase64 no es base64 válido");
  const bytes = Math.floor((base64.length * 3) / 4);
  if (bytes > MAX_BYTES) return error(`El archivo pesa ${(bytes / 1048576).toFixed(1)} MB; el máximo es 15 MB`, 413);

  let respuesta = "";
  try {
    const anthropic = new Anthropic();
    const archivo =
      mime === "application/pdf"
        ? ({ type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } } as const)
        : ({ type: "image", source: { type: "base64", media_type: mime, data: base64 } } as const);
    const msg = await meteredCreate(anthropic, { subtipo: "hospital.cotizacion.leer", userId: user.id, companyId }, {
      model: MODELO_LECTOR,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: [archivo, { type: "text", text: "Pasa esta cotización a datos siguiendo el schema exacto. Todos los renglones. Sólo JSON." }] }],
    });
    if (msg.stop_reason === "refusal") return error("El modelo no procesó el archivo", 422);
    if (msg.stop_reason === "max_tokens") return error("La cotización es demasiado larga para leerla de una vez; divídela en partes", 422);
    respuesta = msg.content.find((b) => b.type === "text")?.text ?? "";
  } catch (e) {
    console.error("[hospital.cotizacion.leer] error del modelo:", e instanceof Error ? e.message : e);
    return error("No se pudo leer la cotización", 502);
  }

  let lectura;
  try {
    lectura = limpiarLectura(JSON.parse(respuesta.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim()));
  } catch {
    return error("La lectura no devolvió datos legibles", 502);
  }
  if (lectura.renglones.length === 0) return error("No se encontraron renglones en el archivo: ¿es una cotización?", 422);

  // ── Repreciar con el tarifario propio ─────────────────────────────────────
  const servicios = await prisma.hospServicio.findMany({
    where: { companyId, activo: true },
    select: {
      id: true, clave: true, nombre: true, categoria: true, precioLista: true, ivaTasa: true,
      tarifas: pagadorId ? { where: { pagadorId }, select: { precio: true } } : false,
    },
  });
  const tarifa: ServicioTarifa[] = servicios.map((s) => ({
    id: s.id,
    clave: s.clave,
    nombre: s.nombre,
    categoria: s.categoria,
    precio: r2(Number(Array.isArray(s.tarifas) && s.tarifas[0] ? s.tarifas[0].precio : s.precioLista)),
    ivaTasa: s.ivaTasa == null ? null : Number(s.ivaTasa),
  }));
  const indice = indexar(tarifa);
  const porId = new Map(tarifa.map((s) => [s.id, s]));

  const renglones = lectura.renglones.map((r) => ({ ...r, ...emparejar(r.descripcion, indice) }));
  const propio = totalPropio(renglones.map((r) => ({ cantidad: r.cantidad, servicio: r.servicioId ? porId.get(r.servicioId) ?? null : null })));

  const advertencias: string[] = [];
  if (lectura.total == null) advertencias.push("No se leyó el total de la otra cotización: captúralo para comparar.");
  if (lectura.totalIncluyeIva === false) advertencias.push("La otra cotización dice que su total NO incluye IVA; el nuestro se muestra con IVA.");
  if (propio.sinPrecio > 0) advertencias.push(`${propio.sinPrecio} de ${renglones.length} renglones no se emparejaron con el tarifario: elige el servicio o quítalos para comparar parejo.`);

  bitacora(user, req, {
    companyId,
    accion: "hospital.cotizacion.leer",
    detalle: `Cotización externa leída · ${lectura.procedimiento ?? "sin procedimiento"} · ${renglones.length} renglones · total ${lectura.total ?? "?"}`,
  });

  return NextResponse.json({ lectura: { ...lectura, renglones: undefined }, renglones, propio, advertencias });
});
