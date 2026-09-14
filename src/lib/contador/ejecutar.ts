import { historiaDeEntidad } from "@/lib/decisiones";
import { saludActual } from "@/lib/salud/snapshot";

// ─────────────────────────────────────────────────────────────────────────────
// La ejecución de las herramientas propias de la pasada. `cerrar_pasada` NO se
// ejecuta aquí: el runner la intercepta porque termina el bucle.
// ─────────────────────────────────────────────────────────────────────────────

export async function ejecutarHerramientaPasada(
  nombre: string,
  input: Record<string, unknown>,
  companyId: string,
): Promise<string> {
  if (nombre === "leer_salud") {
    const s = await saludActual(companyId);
    if (!s) return JSON.stringify({ aviso: "Todavía no hay foto de salud de esta empresa.", dimensiones: [] });
    return JSON.stringify({
      dia: s.dia,
      estado: s.estado,
      dimensiones: s.dimensiones.map((d) => ({
        clave: d.clave,
        estado: d.estado,
        detalle: d.detalle,
        metricas: d.metricas,
      })),
      deltas: s.deltas,
    });
  }

  if (nombre === "leer_historia") {
    const entidad = typeof input.entidad === "string" ? input.entidad : "";
    const id = typeof input.id === "string" ? input.id : "";
    if (!entidad || !id) return JSON.stringify({ error: "Faltan entidad o id." });
    const eventos = await historiaDeEntidad(companyId, entidad, id);
    return JSON.stringify({
      eventos: eventos.map((e) => ({
        fecha: e.createdAt,
        motor: e.motor,
        actor: e.actor,
        accion: e.accion,
        razones: e.razones,
        resultado: e.resultado,
      })),
      resumen: eventos.length === 0 ? "Ningún motor ha decidido nada sobre esta entidad." : `${eventos.length} decisiones.`,
    });
  }

  return JSON.stringify({ error: `Herramienta de pasada desconocida: ${nombre}` });
}
