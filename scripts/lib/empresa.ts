import type { PrismaClient } from "@prisma/client";

/**
 * Resuelve la empresa objetivo de un script del pipeline desde el entorno.
 *
 *   COMPANY_ID=<id>   — directo (lo que pasa el orquestador, que ya lo conoce)
 *   RFC=<rfc>         — por RFC (cómodo para un humano), se busca en la base
 *
 * Sin ninguno de los dos: ERROR. Nunca hay empresa por default — estos scripts
 * ESCRIBEN, y escribir a la empresa equivocada por un default silencioso es
 * justo el accidente que no se puede permitir. El id de MARGOM dejó de estar
 * hardcodeado; ahora cada corrida dice a quién apunta.
 */
export async function resolverEmpresa(
  prisma: PrismaClient,
): Promise<{ id: string; rfc: string | null; razonSocial: string | null }> {
  const id = process.env.COMPANY_ID?.trim();
  const rfc = process.env.RFC?.trim();
  if (!id && !rfc) {
    throw new Error(
      "Falta la empresa: define COMPANY_ID=<id> o RFC=<rfc> en el entorno. " +
        "No hay empresa por default (estos scripts escriben).",
    );
  }
  const c = await prisma.company.findFirst({
    where: id ? { id } : { rfc },
    select: { id: true, rfc: true, razonSocial: true },
  });
  if (!c) throw new Error(`Empresa no encontrada para ${id ? `COMPANY_ID=${id}` : `RFC=${rfc}`}.`);
  return c;
}
