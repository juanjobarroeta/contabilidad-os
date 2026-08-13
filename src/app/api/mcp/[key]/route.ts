import { timingSafeEqual } from "node:crypto";
import { createMcpHandler } from "mcp-handler";
import { registrarToolsOperador, type McpServerLike } from "@/lib/mcp/operador";

// ─────────────────────────────────────────────────────────────────────────────
// /api/mcp/[key] — servidor MCP del OPERADOR (streamable HTTP).
//
// Conecta Claude (claude.ai → conectores personalizados, o Claude Desktop) a
// la operación de contabilidadOS: diagnóstico de empresas, barridos dirigidos,
// cancelaciones, crédito y costos — las tools viven en src/lib/mcp/operador.ts.
//
// AUTENTICACIÓN: la llave viaja EN LA RUTA (patrón webhook), porque los
// conectores remotos sin OAuth no mandan headers propios. Reglas:
//  - MCP_OPERADOR_KEYS: llaves separadas por coma. VARIAS a propósito — rotar
//    es agregar la nueva, migrar el conector y borrar la vieja, sin ventana
//    de corte (lección aprendida con CRON_SECRET).
//  - Sin la variable, la ruta responde 404: cerrada por default.
//  - Comparación en tiempo constante.
//  - Esto es SOLO para el operador: las tools ven todas las empresas. Nunca
//    dar esta URL a un cliente final.
// ─────────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const maxDuration = 300;

function llaveValida(key: string): boolean {
  const llaves = (process.env.MCP_OPERADOR_KEYS ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length >= 24); // llaves cortas no cuentan: sin atajos débiles
  const buf = Buffer.from(key);
  // Se recorren TODAS las llaves siempre (sin early-return) para no filtrar
  // por tiempo cuál posición coincidió.
  let ok = false;
  for (const llave of llaves) {
    const lbuf = Buffer.from(llave);
    if (lbuf.length === buf.length && timingSafeEqual(lbuf, buf)) ok = true;
  }
  return ok;
}

const handler = createMcpHandler(
  (server) => {
    registrarToolsOperador(server as unknown as McpServerLike);
  },
  {
    serverInfo: { name: "contabilidad-os-operador", version: "1.0.0" },
    instructions:
      "Operación de contabilidadOS. Empresas por RFC o id. Lecturas libres; empujar_cron y evaluar_credito ejecutan trabajo real (idempotente, con bitácora). sat-cancel-sync consume cuota vitalicia del SAT — prefiere sat-vigencia-sync para cancelaciones históricas.",
  },
);

async function conAuth(req: Request, params: Promise<{ key: string }>): Promise<Response> {
  const { key } = await params;
  if (!llaveValida(key)) {
    // 404 (no 401): la ruta ni siquiera existe para quien no tiene la llave.
    return new Response("Not found", { status: 404 });
  }
  return handler(req);
}

export async function POST(req: Request, ctx: { params: Promise<{ key: string }> }) {
  return conAuth(req, ctx.params);
}
export async function GET(req: Request, ctx: { params: Promise<{ key: string }> }) {
  return conAuth(req, ctx.params);
}
export async function DELETE(req: Request, ctx: { params: Promise<{ key: string }> }) {
  return conAuth(req, ctx.params);
}
