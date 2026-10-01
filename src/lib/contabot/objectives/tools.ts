import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { ORDEN_PASOS } from "@/lib/cierre/claves";

export const objectiveTools: Tool[] = [
  { name: "consultar_objetivos", description: "Consulta los objetivos asignados a ContaBot, su responsable, estado, bloqueos y evidencia. No completa ni modifica objetivos.",
    input_schema: { type: "object", properties: {} } },
  { name: "asignar_objetivo_cierre", description: "Asigna a ContaBot una revisión persistente de un mes terminado o un paso del cierre PM 601. Sólo si la persona pide explícitamente asignar o delegar esa revisión. Se ejecuta con los permisos del usuario y el límite diario de la empresa; no activa la responsabilidad mensual recurrente. No usar desde un objetivo automático.",
    input_schema: { type: "object", properties: {
      year: { type: "integer", minimum: 2000, maximum: 2100 }, month: { type: "integer", minimum: 1, maximum: 12 },
      scope: { type: "string", enum: ["cierre", ...ORDEN_PASOS] }, instructions: { type: "string", maxLength: 2000 },
    }, required: ["year", "month", "scope"] } },
];
