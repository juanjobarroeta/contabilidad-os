// ─────────────────────────────────────────────────────────────────────────────
// El directorio del despacho: una persona se captura UNA vez y se reutiliza
// entre casos.
//
// Hasta la Fase 0, cada parte se capturaba dentro de su asunto: el mismo
// cliente en tres casos eran tres capturas distintas, y corregir un domicilio
// no se propagaba. Aquí vive quién es alguien (JuridicoCliente) y en
// JuridicoParte queda el PAPEL que juega en un caso (actor, arrendataria…).
//
// La deduplicación es la misma que ya usaban las partes: RFC, CURP o nombre
// normalizado. Nunca fusiona sola dos fichas distintas: propone y el abogado
// decide (`candidatos`).
// ─────────────────────────────────────────────────────────────────────────────
import { prisma } from "@/lib/prisma";
import { apuntar, type Actor } from "./bitacora";
import { alcance, despachoParaCrear } from "./despacho";
import { normalizarCurp, normalizarNombre, normalizarRfc, textoPlano } from "./asuntos";

export interface Cliente {
  id: string;
  tipoPersona: "fisica" | "moral";
  nombre: string;
  rfc: string | null;
  curp: string | null;
  domicilio: string | null;
  representante: string | null;
  email: string | null;
  telefono: string | null;
  notas: string | null;
  verificado: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type DatosCliente = Partial<Omit<Cliente, "id" | "createdAt" | "updatedAt">> & { nombre: string };

const CAMPOS = { id: true, tipoPersona: true, nombre: true, rfc: true, curp: true, domicilio: true, representante: true, email: true, telefono: true, notas: true, verificado: true, createdAt: true, updatedAt: true } as const;

function aCliente(f: { tipoPersona: string } & Omit<Cliente, "tipoPersona">): Cliente {
  return { ...f, tipoPersona: f.tipoPersona === "moral" ? "moral" : "fisica" };
}

/** Limpia lo que llega (el modelo a veces manda objetos) y normaliza RFC/CURP. */
export function normalizarDatosCliente(d: DatosCliente): DatosCliente & { nombreNormalizado: string } {
  const x = d as Record<string, unknown>;
  const limpio: Record<string, unknown> = { ...d };
  for (const k of ["nombre", "domicilio", "representante", "email", "telefono", "notas"] as const) {
    if (k in x) limpio[k] = textoPlano(x[k]);
  }
  const nombre = (textoPlano(d.nombre) ?? "").slice(0, 300);
  return {
    ...(limpio as DatosCliente),
    nombre,
    nombreNormalizado: normalizarNombre(nombre),
    rfc: normalizarRfc(d.rfc),
    curp: normalizarCurp(d.curp),
    tipoPersona: d.tipoPersona === "moral" ? "moral" : "fisica",
  };
}

/**
 * Fichas que PODRÍAN ser la misma persona: mismo RFC, misma CURP o mismo
 * nombre normalizado. No decide; devuelve para que alguien elija.
 */
export async function candidatos(userId: string, d: DatosCliente): Promise<Cliente[]> {
  const n = normalizarDatosCliente(d);
  if (!n.nombre && !n.rfc && !n.curp) return [];
  const filas = await prisma.juridicoCliente.findMany({
    where: {
      ...(await alcance(userId)),
      OR: [...(n.rfc ? [{ rfc: n.rfc }] : []), ...(n.curp ? [{ curp: n.curp }] : []), ...(n.nombreNormalizado ? [{ nombreNormalizado: n.nombreNormalizado }] : [])],
    },
    select: CAMPOS,
    take: 10,
  });
  return filas.map(aCliente);
}

export async function listarClientes(userId: string, opts: { busqueda?: string; limite?: number } = {}): Promise<Cliente[]> {
  const q = (opts.busqueda ?? "").trim();
  const filas = await prisma.juridicoCliente.findMany({
    where: {
      ...(await alcance(userId)),
      ...(q
        ? {
            OR: [
              { nombreNormalizado: { contains: normalizarNombre(q) } },
              { rfc: { contains: q.toUpperCase() } },
              { email: { contains: q, mode: "insensitive" as const } },
            ],
          }
        : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: Math.min(opts.limite ?? 50, 200),
    select: CAMPOS,
  });
  return filas.map(aCliente);
}

export async function obtenerCliente(id: string, userId: string): Promise<Cliente | null> {
  const f = await prisma.juridicoCliente.findFirst({ where: { id, ...(await alcance(userId)) }, select: CAMPOS });
  return f ? aCliente(f) : null;
}

/**
 * Alta. `verificado` lo pone quien captura a mano; lo que sale de un documento
 * entra sin verificar y se ve así en la UI hasta que alguien lo confirme.
 */
export async function crearCliente(userId: string, d: DatosCliente, actor: Actor, casoId?: string | null): Promise<Cliente> {
  const n = normalizarDatosCliente(d);
  if (!n.nombre || n.nombre.length < 2) throw new Error("El cliente necesita un nombre.");
  const f = await prisma.juridicoCliente.create({
    data: {
      userId,
      despachoId: await despachoParaCrear(userId),
      tipoPersona: n.tipoPersona ?? "fisica",
      nombre: n.nombre,
      nombreNormalizado: n.nombreNormalizado,
      rfc: n.rfc ?? null,
      curp: n.curp ?? null,
      domicilio: n.domicilio ?? null,
      representante: n.representante ?? null,
      email: n.email ?? null,
      telefono: n.telefono ?? null,
      notas: n.notas ?? null,
      verificado: d.verificado ?? false,
    },
    select: CAMPOS,
  });
  if (casoId) await apuntar({ casoId, actor, accion: "cliente.creado", entidad: "cliente", entidadId: f.id, resumen: `dio de alta a ${f.nombre} en el directorio`, datos: { rfc: f.rfc } });
  return aCliente(f);
}

/** Edición. Sólo los campos que llegan; lo demás se queda como está. */
export async function actualizarCliente(id: string, userId: string, d: Partial<DatosCliente>, actor: Actor, casoId?: string | null): Promise<Cliente> {
  const actual = await obtenerCliente(id, userId);
  if (!actual) throw new Error("Cliente no encontrado");
  const n = normalizarDatosCliente({ ...actual, ...d, nombre: d.nombre ?? actual.nombre });
  const f = await prisma.juridicoCliente.update({
    where: { id },
    data: {
      tipoPersona: n.tipoPersona ?? actual.tipoPersona,
      nombre: n.nombre,
      nombreNormalizado: n.nombreNormalizado,
      rfc: n.rfc ?? null,
      curp: n.curp ?? null,
      domicilio: n.domicilio ?? null,
      representante: n.representante ?? null,
      email: n.email ?? null,
      telefono: n.telefono ?? null,
      notas: n.notas ?? null,
      ...(d.verificado === undefined ? {} : { verificado: d.verificado }),
    },
    select: CAMPOS,
  });
  const cambiados = camposCambiados(actual, aCliente(f));
  if (casoId && cambiados.length) await apuntar({ casoId, actor, accion: "cliente.editado", entidad: "cliente", entidadId: id, resumen: `editó a ${f.nombre} (${cambiados.join(", ")})`, datos: { cambiados } });
  return aCliente(f);
}

/** Qué campos cambiaron entre dos fichas. Puro; alimenta la bitácora. */
export function camposCambiados(antes: Cliente, despues: Cliente): string[] {
  const out: string[] = [];
  for (const k of ["tipoPersona", "nombre", "rfc", "curp", "domicilio", "representante", "email", "telefono", "notas", "verificado"] as const) {
    if ((antes[k] ?? null) !== (despues[k] ?? null)) out.push(k);
  }
  return out;
}

/**
 * Liga una parte del caso con su ficha del directorio. Si no se pasa
 * `clienteId`, crea la ficha con los datos de la parte.
 */
export async function ligarParteACliente(parteId: string, userId: string, actor: Actor, clienteId?: string): Promise<{ clienteId: string; creado: boolean }> {
  const parte = await prisma.juridicoParte.findFirst({ where: { id: parteId, caso: await alcance(userId) }, select: { id: true, casoId: true, nombre: true, rfc: true, curp: true, tipoPersona: true, domicilio: true, representante: true, email: true, telefono: true, verificado: true } });
  if (!parte) throw new Error("Parte no encontrada");
  let id = clienteId ?? null;
  let creado = false;
  if (id) {
    if (!(await obtenerCliente(id, userId))) throw new Error("Cliente no encontrado");
  } else {
    const nuevo = await crearCliente(
      userId,
      { nombre: parte.nombre, tipoPersona: parte.tipoPersona === "moral" ? "moral" : "fisica", rfc: parte.rfc, curp: parte.curp, domicilio: parte.domicilio, representante: parte.representante, email: parte.email, telefono: parte.telefono, verificado: parte.verificado },
      actor,
      parte.casoId
    );
    id = nuevo.id;
    creado = true;
  }
  await prisma.juridicoParte.update({ where: { id: parteId }, data: { clienteId: id } });
  await apuntar({ casoId: parte.casoId, actor, accion: "parte.ligada_a_cliente", entidad: "parte", entidadId: parteId, resumen: `ligó a ${parte.nombre} con su ficha del directorio`, datos: { clienteId: id, creado } });
  return { clienteId: id!, creado };
}
