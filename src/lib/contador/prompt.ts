import { TITULO_SALUD } from "@/lib/salud/claves";
import type { DeltaSalud, DimensionSalud } from "@/lib/salud/evaluar";
import {
  esEstadoRenglon,
  MAX_RENGLONES,
  MAX_TEXTO,
  ORDEN_ESTADO,
  TITULO_ESTADO_RENGLON,
  type RenglonResumen,
  type ResumenCorrida,
} from "./claves";

// ─────────────────────────────────────────────────────────────────────────────
// LO QUE SE LE DICE AL CONTADOR, Y LO QUE SE LE EXIGE DE VUELTA. PURO.
//
// El copiloto de hoy responde preguntas; esto es otra cosa: nadie le preguntó
// nada. Por eso el prompt no describe capacidades, describe OBJETIVOS — entregar
// la contabilidad, proteger al cliente, cumplir la ley — y el orden entre ellos.
// Sin ese orden el modelo atiende lo que ve primero, que casi nunca es lo que
// más importa.
//
// La instrucción que más trabajo hace es la de NO REPORTAR: el sistema ya tiene
// un rail lleno de conteos que nadie lee. Un agente que cada mañana vuelve a
// contar los mismos 13,778 duplicados es ese rail otra vez, con más costo.
// ─────────────────────────────────────────────────────────────────────────────

export interface EmpresaPasada {
  razonSocial: string;
  rfc: string;
  regimenFiscal: string;
}

/** El system prompt de la pasada. PURO — `hoy` entra por parámetro. */
export function promptDelContador(empresa: EmpresaPasada, hoy: Date): string {
  const hoyIso = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(hoy);
  return `Eres el contador de cabecera de ${empresa.razonSocial} (RFC ${empresa.rfc}, régimen ${empresa.regimenFiscal}) dentro de Contabilidad OS. Hoy es ${hoyIso} en México.

Nadie te preguntó nada. Ésta es tu pasada: la revisión que un contador hace de su cliente sin que se la pidan.

## Tus tres objetivos, en este orden
1. **Entregar la contabilidad.** Que el mes se pueda cerrar y las declaraciones se puedan presentar a tiempo y con números correctos.
2. **Proteger al cliente.** Que no quede expuesto: deducciones sin respaldo, IVA acreditado sin prueba de pago, proveedores en el 69-B, conciliaciones que no cuadran.
3. **Cumplir la ley.** Que lo que se presente sea defendible, con su fundamento.

Cuando dos objetivos choquen, gana el de arriba. Si algo no sirve a ninguno, no es trabajo: no lo reportes.

## Cómo trabajas
- **Investiga antes de concluir.** Tienes las herramientas de datos de la empresa: úsalas. Una afirmación sobre esta empresa sin haber consultado el dato es una suposición, y aquí no sirven.
- **Causa, no síntoma.** «Hay 40 movimientos sin conciliar» no es un hallazgo; «no se ha cargado el estado de cuenta de agosto, por eso 40 movimientos están sin conciliar» sí lo es. Si no llegas a la causa, dilo y di qué te falta para llegar.
- **No repitas lo que ya está dicho.** Lo que tenga un compromiso abierto en el expediente o una solicitud abierta al cliente NO se vuelve a reportar: di en qué va y qué falta para cerrarlo. Un aviso repetido es lo que enseña a ignorar los avisos.
- **Escribe lo que aprendas.** Un hecho duradero del cliente va a \`registrar_hecho\`; lo que revisaste, decidiste o dejaste pendiente va a \`anotar_expediente\`. Lo que no quede escrito se pierde y mañana lo vuelves a descubrir desde cero.
- **Pide sólo lo que de verdad falta.** \`solicitar_al_cliente\` cuesta atención del cliente. Antes de abrir una, comprueba con \`consultar_solicitudes\` que no esté ya pedida.
- **Funda lo que afirmes de la norma.** Cualquier regla, tasa, plazo o requisito se busca con \`search_fiscal_knowledge\` o \`get_articulo\` antes de decirlo, y se cita. Nunca de memoria.

## Lo que NO haces
- No escribes en la contabilidad. Tus acciones son propuestas (\`proponer_*\`), que una persona confirma. Nunca digas que algo quedó hecho cuando sólo lo dejaste propuesto.
- No timbras, no pagas y no presentas nada al SAT. Esas las hace una persona desde la app.
- No inventas. Si un dato no está, el renglón correcto es que falta ese dato, no una estimación.

## Cómo terminas
Cuando termines de trabajar, llama \`cerrar_pasada\` con tus renglones. Es la ÚNICA salida que cuenta: lo que escribas como texto no lo lee nadie.

Un renglón por cosa que importa, con su causa y su acción. Si después de revisar no hay nada que valga la atención de una persona, cierra con \`sin_novedad: true\` y cero renglones — eso es una respuesta correcta y frecuente, y es mucho mejor que rellenar con observaciones tibias.`;
}

export interface ContextoPasada {
  dia: string;
  dimensiones: DimensionSalud[];
  deltas: DeltaSalud[];
  pendientes: { titulo: string; cuerpo: string; desdeDias: number }[];
  solicitudes: { titulo: string; periodo: string | null; desdeDias: number }[];
}

/**
 * El mensaje de usuario de la pasada. PURO.
 *
 * Le entrega el trabajo YA FILTRADO: lo que cambió, lo que está bloqueado y lo
 * que sigue esperando. Que el modelo tuviera que descubrir eso solo costaría
 * media docena de rondas de herramientas por empresa y por día.
 */
export function mensajeDePasada(c: ContextoPasada): string {
  const l: string[] = [`Es tu pasada del ${c.dia}.`, ""];

  const bloquean = c.dimensiones.filter((d) => d.estado === "bloquea");
  if (bloquean.length > 0) {
    l.push("## Bloqueando ahora mismo");
    for (const d of bloquean) l.push(`- ${d.titulo}: ${d.detalle}`);
    l.push("");
  }

  if (c.deltas.length > 0) {
    l.push("## Lo que cambió desde la última foto");
    for (const d of c.deltas) {
      const como = d.direccion === "nuevo" ? "nuevo" : `${d.de ?? "?"} → ${d.a}`;
      l.push(`- ${TITULO_SALUD[d.clave] ?? d.clave} (${como}): ${d.detalle}`);
    }
    l.push("");
  }

  const atencion = c.dimensiones.filter((d) => d.estado === "atencion");
  if (atencion.length > 0) {
    l.push("## Lo que sigue necesitando atención");
    for (const d of atencion) l.push(`- ${d.titulo}: ${d.detalle}`);
    l.push("");
  }

  if (c.pendientes.length > 0) {
    l.push("## Compromisos que ya están abiertos (NO los vuelvas a reportar)");
    for (const p of c.pendientes) l.push(`- ${p.titulo} (abierto hace ${p.desdeDias} días): ${p.cuerpo}`);
    l.push("");
  }

  if (c.solicitudes.length > 0) {
    l.push("## Ya pedido al cliente y sin llegar (NO lo vuelvas a pedir)");
    for (const s of c.solicitudes) {
      l.push(`- ${s.titulo}${s.periodo ? ` de ${s.periodo}` : ""}, pedido hace ${s.desdeDias} días`);
    }
    l.push("");
  }

  l.push(
    "Atiende primero lo que impide ENTREGAR, después lo que EXPONE al cliente, después la limpieza.",
    "Investiga antes de concluir y llega a la causa. Cuando termines, cierra con `cerrar_pasada`.",
  );
  return l.join("\n");
}

const acotar = (s: string) => (s.length > MAX_TEXTO ? `${s.slice(0, MAX_TEXTO - 1)}…` : s);

/**
 * Limpia y ordena lo que el modelo devolvió en `cerrar_pasada`. PURA.
 *
 * Se descarta el renglón sin causa o sin acción a propósito: un renglón que sólo
 * nombra un problema es exactamente el ruido que este trabajo existe para
 * eliminar, y dejarlo pasar porque «algo es algo» devuelve el rail viejo.
 */
export function normalizarResumen(input: unknown): ResumenCorrida {
  const obj = (input ?? {}) as Record<string, unknown>;
  const crudos = Array.isArray(obj.renglones) ? obj.renglones : [];

  const renglones: RenglonResumen[] = [];
  for (const r of crudos) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const titulo = typeof o.titulo === "string" ? o.titulo.trim() : "";
    const causa = typeof o.causa === "string" ? o.causa.trim() : "";
    const accion = typeof o.accion === "string" ? o.accion.trim() : "";
    if (!titulo || !causa || !accion) continue;
    renglones.push({
      estado: esEstadoRenglon(o.estado) ? o.estado : "pendiente",
      titulo: acotar(titulo),
      causa: acotar(causa),
      accion: acotar(accion),
      evidencia: Array.isArray(o.evidencia)
        ? (o.evidencia as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 20)
        : [],
      fundamento: typeof o.fundamento === "string" && o.fundamento.trim() ? o.fundamento.trim() : null,
    });
  }

  renglones.sort((a, b) => ORDEN_ESTADO[a.estado] - ORDEN_ESTADO[b.estado]);
  const cortados = renglones.slice(0, MAX_RENGLONES);

  // «Sin novedad» se DERIVA de que no quedó nada que contar. Si el modelo dice
  // que no hay novedad pero entregó renglones válidos, mandan los renglones:
  // el resumen debe describir lo que hay, no lo que el modelo creyó hacer.
  return { renglones: cortados, sinNovedad: cortados.length === 0 };
}

/** El resumen como texto, para el cuerpo de la nota del expediente. PURA. */
export function resumenEnTexto(r: ResumenCorrida): string {
  if (r.sinNovedad) return "Revisada y sin novedad: nada que requiera atención hoy.";
  return r.renglones
    .map((x) => {
      const partes = [
        `**${TITULO_ESTADO_RENGLON[x.estado]} — ${x.titulo}**`,
        `Causa: ${x.causa}`,
        `Acción: ${x.accion}`,
      ];
      if (x.fundamento) partes.push(`Fundamento: ${x.fundamento}`);
      if (x.evidencia.length > 0) partes.push(`Evidencia: ${x.evidencia.join(", ")}`);
      return partes.join("\n");
    })
    .join("\n\n");
}
